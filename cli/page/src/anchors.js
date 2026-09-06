/**
 * Responsive anchors: how a shape's box follows its parent's size.
 *
 * The model keeps WHERE a box sits and HOW BIG it is as separate statements,
 * because they are separate intentions. Entangling them is what made the
 * earlier two-anchors-per-axis scheme hard to author, and it is why a hand
 * resize used to be undone by the next resolve.
 *
 * Per axis:
 *
 *   position = anchor x parentSize + offset - pivot x size
 *     anchor  a fraction of the PARENT: 0 its start, 0.5 its middle, 1 its end
 *     pivot   a fraction of THIS BOX: which of its points lands on the anchor
 *     offset  pixels, applied after both
 *
 *   size comes from a mode:
 *     fixed     an exact number of pixels
 *     stretch   a fraction of the parent, plus sizeOffset pixels
 *     shrink    the smaller of a fixed size and the stretch size
 *     aspect    a multiple of the OTHER axis's resolved size
 *
 *   fit       on a stretch or shrink axis whose PARTNER is aspect: shrink
 *             this axis until the partner's box fits inside the parent,
 *             with fitOffset as the allowance. The flag lives on the axis
 *             being sized, so one axis never reaches across to size another.
 *
 *   min       a floor applied to whatever the mode produced
 *
 *   meta.clawAnchor = {
 *     x: { mode, anchor, pivot, offset, size, percent, sizeOffset, ratio, min, fit, fitOffset },
 *     y: { ...the same },
 *     text: 'scale' | 'fixed',
 *     base: { w, h, scale },
 *   }
 *
 * Resolution runs strictly outside in: a child needs its parent's settled box
 * before it can compute its own, so one pass down the shape tree is enough and
 * no solver is involved. Nothing here sizes a container from its children,
 * which would need the opposite order.
 *
 * Geometry facts this relies on, all verified against the real editor:
 *  - a child's x/y are in its parent's local space, and a container's own
 *    geometry starts at 0,0, so no transform math is needed
 *  - resizing a container does NOT move its children; that is entirely the
 *    job of this module
 *  - a text shape's props.w is its PRE-scale width: the rendered box is
 *    w * scale, so scaling text means writing `scale` and leaving `w` alone,
 *    which is also what preserves its line breaks
 */
import { overlayLabelOf, round, short } from './editor-utils.js'

export const AXES = ['x', 'y']
export const MODES = ['fixed', 'stretch', 'shrink', 'aspect']

/** Which size fields each mode reads. Drives the editor and the validation. */
export const MODE_FIELDS = {
	fixed: ['size'],
	stretch: ['percent', 'sizeOffset'],
	shrink: ['size', 'percent', 'sizeOffset'],
	aspect: ['ratio'],
}

/** Shapes whose box is set through props.w / props.h. */
const SIZED_TYPES = new Set(['geo', 'image', 'frame', 'embed', 'video'])
/**
 * Shapes built from points rather than a width and height. They have no size
 * to assign, but tldraw can scale them, which is the only way a rule can size
 * one. Scaling happens about the shape's centre, so the position has to be
 * re-applied afterwards.
 */
const SCALED_TYPES = new Set(['line', 'draw', 'highlight'])

/**
 * Depth of an in-progress resolve.
 *
 * Every geometry write the resolver makes happens inside this, so the live
 * editing handler can tell "the rule moved this shape" from "a person moved
 * this shape" and only rebase the second. Without it, editing a rule in the
 * panel resolved the shape and the handler immediately wrote the RESULT back
 * into the rule as though it had been dragged there. With `fit` active that
 * result is the capped size, so the cap silently became the rule and the
 * original number was gone for good.
 */
let resolving = 0
export const isResolving = () => resolving > 0

const finite = (v, fallback = null) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const round100 = (n) => Math.round(n * 100) / 100
const clamp01 = (v) => Math.min(1, Math.max(0, v))

/** The anchor rule on a shape, or null. */
export function ruleOf(shape) {
	const r = shape?.meta?.clawAnchor
	return r && typeof r === 'object' && !Array.isArray(r) ? r : null
}

/** Does any shape on the page carry a rule? Cheap gate for the auto-resolve pass. */
export function documentHasAnchors(editor) {
	return editor.getCurrentPageShapes().some((s) => ruleOf(s))
}

/** Normalized view of one axis of a rule, with defaults filled in. */
export function axisSpec(rule, axis, shape = null) {
	const raw = rule?.[axis]
	if (!raw || typeof raw !== 'object') return null
	// a scaled text block keeps its proportions, so it can never fill its box
	// on both axes; centring the slack it leaves is the symmetric default
	const scaledText = shape?.type === 'text' && (rule.text ?? 'scale') === 'scale'
	return {
		mode: MODES.includes(raw.mode) ? raw.mode : 'stretch',
		anchor: finite(raw.anchor, 0),
		pivot: clamp01(finite(raw.pivot, scaledText ? 0.5 : 0)),
		offset: finite(raw.offset, 0),
		size: Math.max(0, finite(raw.size, 0)),
		percent: finite(raw.percent, 1),
		sizeOffset: finite(raw.sizeOffset, 0),
		ratio: finite(raw.ratio, null),
		// Floors default to nothing. A line has zero extent across its own
		// thickness and that is legitimate, so forcing every axis to at least
		// 1px left such a shape permanently a pixel away from its own rule.
		// Shapes that need a real size still get one: writeBox floors those at
		// 1 when it sets props.w / props.h.
		min: Math.max(0, finite(raw.min, 0)),
		fit: raw.fit === true,
		fitOffset: finite(raw.fitOffset, 0),
	}
}

/** Can this axis's `fit` flag do anything? Only against an aspect partner. */
export function fitApplies(spec, otherSpec) {
	return !!(
		spec?.fit &&
		(spec.mode === 'stretch' || spec.mode === 'shrink') &&
		otherSpec?.mode === 'aspect' &&
		otherSpec.ratio > 0
	)
}

/**
 * The largest size this axis may take before its aspect partner stops fitting
 * inside the parent, or null when nothing constrains it.
 *
 * The partner's box is `ratio x size` long and sits at
 * `anchor x extent + offset - pivot x length`, so both of its edges move as
 * this axis grows. Each edge gives a bound on the size:
 *
 *   leading edge   anchor x extent + offset - pivot x ratio x size >= lo
 *   trailing edge  anchor x extent + offset + (1 - pivot) x ratio x size <= hi
 *
 * An edge whose coefficient is zero does not move with the size, so shrinking
 * cannot bring it inside and that bound is skipped rather than failing the
 * whole thing. A box pinned hard to the top with padding asked for is the
 * normal case of that: its top edge is where it is, and only its bottom edge
 * can be helped.
 */
export function fitLimit(spec, otherSpec, otherExtent) {
	if (!fitApplies(spec, otherSpec)) return null
	const r = otherSpec.ratio
	const lo = -spec.fitOffset
	const hi = otherExtent + spec.fitOffset
	const at = otherSpec.anchor * otherExtent + otherSpec.offset
	const bounds = []
	if (otherSpec.pivot > 0) bounds.push((at - lo) / (otherSpec.pivot * r))
	if (otherSpec.pivot < 1) bounds.push((hi - at) / ((1 - otherSpec.pivot) * r))
	if (!bounds.length) return null
	return Math.min(...bounds)
}

/**
 * The box a container offers its children.
 *
 * Frames and boxes carry their size in props. A group does not - its size is
 * whatever its contents span - so fall back to its rendered bounds.
 */
export function innerBox(container, editor = null) {
	const w = finite(container?.props?.w, null)
	const h = finite(container?.props?.h, null)
	if (w != null && h != null) return { w, h }
	const b = editor && container ? editor.getShapePageBounds(container.id) : null
	return { w: w ?? finite(b?.w, 0) ?? 0, h: h ?? finite(b?.h, 0) ?? 0 }
}

/**
 * Where a shape sits inside its parent, and how big it is, both measured from
 * rendered page bounds.
 *
 * `shape.x` is NOT usable here. For most types it is the top-left in parent
 * space, but a group keeps PAGE coordinates while parented to a frame and
 * compensates with an offset on its geometry, so reading it treated a group as
 * though the whole board were its parent. Page bounds are the one measure that
 * means the same thing for every type.
 */
export function localBox(editor, shape, parent = null) {
	const b = editor.getShapePageBounds(shape.id)
	const origin = parent ? editor.getShapePageBounds(parent.id) : null
	return {
		x: finite(b?.x, 0) ?? 0,
		y: finite(b?.y, 0) ?? 0,
		w: Math.max(0, finite(b?.w, 0) ?? 0),
		h: Math.max(0, finite(b?.h, 0) ?? 0),
		// page-space origin of the parent, so a resolved position can be turned
		// back into a move without caring what space the shape stores
		originX: finite(origin?.x, 0) ?? 0,
		originY: finite(origin?.y, 0) ?? 0,
	}
}

/** The same box expressed relative to the parent, which is what rules speak. */
export function relativeBox(editor, shape, parent) {
	const b = localBox(editor, shape, parent)
	return { x: b.x - b.originX, y: b.y - b.originY, w: b.w, h: b.h }
}

/** The size a mode asks for, before the floor is applied. */
function rawSize(spec, parentExtent, other) {
	if (spec.mode === 'fixed') return spec.size
	if (spec.mode === 'stretch') return spec.percent * parentExtent + spec.sizeOffset
	if (spec.mode === 'shrink') {
		return Math.min(spec.size, spec.percent * parentExtent + spec.sizeOffset)
	}
	if (!(spec.ratio > 0)) {
		throw new Error('aspect mode needs a positive `ratio` (a multiple of the other axis)')
	}
	return (other ?? 0) * spec.ratio
}

/**
 * One axis of one shape. `other` is the already-resolved size of the opposite
 * axis, which aspect mode derives from; it is null when the mode does not need
 * it.
 */
export function computeAxis(spec, parentExtent, { other = null, fitCap = null } = {}) {
	const wanted = rawSize(spec, parentExtent, other)
	const capped = fitCap != null ? Math.min(wanted, fitCap) : wanted
	const size = Math.max(spec.min, capped)
	const pos = spec.anchor * parentExtent + spec.offset - spec.pivot * size
	return {
		pos,
		size,
		clampedTo: size > capped + 0.001 ? spec.min : null,
		fitted: fitCap != null && capped < wanted - 0.001,
	}
}

/**
 * The parent size at which an axis first hits its floor, or null when it never
 * does. This turns "it collapses at some point" into a number the author can
 * be told before they drag anything.
 */
export function collapseExtent(spec) {
	// only a size that shrinks WITH the parent can collapse as the parent narrows
	if (!spec || (spec.mode !== 'stretch' && spec.mode !== 'shrink')) return null
	if (!(spec.percent > 0)) return null
	const at = (spec.min - spec.sizeOffset) / spec.percent
	return at > 0 ? at : null
}

/** A group's size comes from its contents; a rule can only position it. */
export const sizeIsDriven = (shape) => shape?.type !== 'group'

/** Does this shape hold anything the resolver should walk into? */
export function hasAnyChildren(editor, shape) {
	try {
		return editor.getSortedChildIdsForParent(shape.id).some((cid) => {
			const c = editor.getShape(cid)
			return c && c.type !== 'arrow'
		})
	} catch {
		return false
	}
}

/**
 * Put a shape's rendered box where the rule says, respecting what its type
 * allows to be set.
 *
 * Position is applied as a MOVE from where the shape currently renders, not as
 * an assignment to `x`/`y`, because those are not the top-left for every type
 * (see localBox). A group has no size of its own either, so it is scaled
 * around its top-left instead.
 */
function writeBox(editor, shape, box, { scale = null, wrapWidth = null, parent = null } = {}) {
	const current = localBox(editor, shape, parent)
	const dx = box.x + current.originX - current.x
	const dy = box.y + current.originY - current.y
	// A group has no size of its own - it is whatever its contents span - and
	// tldraw only resizes one by scaling its children through a resize
	// session, which is a zoom rather than a layout. So a rule positions a
	// group and never sizes it; `groupSizeIsFixed` reports that to lint.
	if (shape.type === 'group') {
		editor.updateShape({ id: shape.id, type: shape.type, x: shape.x + dx, y: shape.y + dy })
		return
	}
	if (SCALED_TYPES.has(shape.type)) {
		// an axis with no extent (a perfectly straight line) cannot be scaled
		// into one, so it is left alone rather than divided by zero
		const sx = current.w > 0.01 ? Math.max(0.01, box.w / current.w) : 1
		const sy = current.h > 0.01 ? Math.max(0.01, box.h / current.h) : 1
		if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) {
			editor.resizeShape(shape.id, { x: sx, y: sy })
		}
		const moved = editor.getShape(shape.id)
		const after = localBox(editor, moved, parent)
		editor.updateShape({
			id: shape.id,
			type: shape.type,
			x: moved.x + (box.x + after.originX - after.x),
			y: moved.y + (box.y + after.originY - after.y),
		})
		return
	}
	const props = {}
	if (SIZED_TYPES.has(shape.type)) {
		props.w = Math.max(1, box.w)
		props.h = Math.max(1, box.h)
	}
	if (shape.type === 'text') {
		// only the wrap width can be set; height is always derived from the
		// laid-out text. Scale mode leaves the width alone entirely - that is
		// what keeps the line breaks identical.
		if (wrapWidth != null) {
			props.w = Math.max(1, wrapWidth)
			props.autoSize = false
		}
		if (scale != null) props.scale = Math.max(0.01, scale)
	}
	// notes are a fixed square: position them, never size them
	editor.updateShape({
		id: shape.id,
		type: shape.type,
		x: shape.x + dx,
		y: shape.y + dy,
		...(Object.keys(props).length ? { props } : {}),
	})
}

/**
 * The pre-scale width to write on a text shape whose box is being set. Only
 * fixed-size text takes one: scaled text keeps its authored wrap width so its
 * line breaks never change.
 */
function wrapWidthFor(shape, solvedX, scaledText) {
	if (shape.type !== 'text' || scaledText || !solvedX) return null
	return solvedX.size / (finite(shape.props?.scale, 1) ?? 1)
}

/** Place a smaller drawn box inside its resolved box, by pivot. */
const pivotWithin = (pos, boxSize, drawnSize, pivot) => pos + (boxSize - drawnSize) * pivot

/**
 * Scale the overlay label of a box and re-centre it. The label's design scale
 * is recorded the first time, so repeated resolves compound nothing: the
 * factor is always measured from that recorded base.
 */
function scaleOverlayLabel(editor, shape, factor) {
	const label = overlayLabelOf(editor, shape)
	if (!label || !(factor > 0)) return
	const recorded = finite(label.meta?.clawBase?.scale, null)
	const baseScale = recorded ?? finite(label.props?.scale, 1) ?? 1
	if (recorded == null) {
		editor.updateShape({
			id: label.id,
			type: 'text',
			meta: { ...(label.meta ?? {}), clawBase: { scale: baseScale } },
		})
	}
	editor.updateShape({
		id: label.id,
		type: 'text',
		props: { scale: Math.max(0.01, baseScale * factor) },
	})
	const box = editor.getShapePageBounds(shape.id)
	const lb = editor.getShapePageBounds(label.id)
	const fresh = editor.getShape(label.id)
	if (!box || !lb || !fresh) return
	editor.updateShape({
		id: label.id,
		type: 'text',
		x: fresh.x + (box.x + box.w / 2 - (lb.x + lb.w / 2)),
		y: fresh.y + (box.y + box.h / 2 - (lb.y + lb.h / 2)),
	})
}

/**
 * Resolve one shape against its parent's box and write the result. Returns a
 * record of what it computed whether or not anything moved.
 */
export function resolveShapeRule(editor, shape, rule, parent, { apply = true, parentSize = null } = {}) {
	if (apply) resolving++
	try {
		return resolveShapeRuleInner(editor, shape, rule, parent, { apply, parentSize })
	} finally {
		if (apply) resolving--
	}
}

function resolveShapeRuleInner(editor, shape, rule, parent, { apply, parentSize }) {
	const specs = { x: axisSpec(rule, 'x', shape), y: axisSpec(rule, 'y', shape) }
	if (!specs.x && !specs.y) return null
	if (specs.x?.mode === 'aspect' && specs.y?.mode === 'aspect') {
		throw new Error('both axes are aspect mode - one axis needs a size to derive from')
	}
	const box = relativeBox(editor, shape, parent)
	// `parentSize` answers "where would this land if the screen were N wide"
	// without touching the document - what `claw resolve --sizes` reports
	const parentBox = parentSize ?? innerBox(parent, editor)
	const scaledText = shape.type === 'text' && (rule.text ?? 'scale') === 'scale'

	// the aspect axis needs the other one settled first
	const order = specs.x?.mode === 'aspect' ? ['y', 'x'] : ['x', 'y']
	const solved = { x: null, y: null }
	const notes = []
	for (const axis of order) {
		const spec = specs[axis]
		if (!spec) continue
		const otherAxis = axis === 'x' ? 'y' : 'x'
		// `fit` reads only STATIC facts about the partner - that it is aspect,
		// its ratio, and where it is anchored - so it needs no resolved value
		// from it and the single outside-in pass still holds
		const fitCap = fitLimit(spec, specs[otherAxis], otherAxis === 'x' ? parentBox.w : parentBox.h)
		solved[axis] = computeAxis(spec, axis === 'x' ? parentBox.w : parentBox.h, {
			other: solved[otherAxis]?.size,
			fitCap,
		})
		if (solved[axis].clampedTo != null) {
			notes.push(`${axis} clamped to its minimum of ${solved[axis].clampedTo}`)
		}
		if (solved[axis].fitted) notes.push(`${axis} shrank to fit its aspect partner`)
	}

	const target = {
		x: solved.x ? solved.x.pos : box.x,
		y: solved.y ? solved.y.pos : box.y,
		w: solved.x ? solved.x.size : box.w,
		h: solved.y ? solved.y.size : box.h,
	}
	// An axis with no extent cannot be scaled into one, so report the size the
	// shape will really have. Otherwise a flat line looks permanently off its
	// own rule and every geometry change looks like someone dragged it.
	if (SCALED_TYPES.has(shape.type)) {
		if (solved.x && box.w <= 0.01) target.w = box.w
		if (solved.y && box.h <= 0.01) target.h = box.h
	}
	// a group keeps the size its contents give it, so the pivot has to work
	// against that rather than against a size it will never take
	if (shape.type === 'group') {
		if (solved.x) target.x = solved.x.pos + (solved.x.size - box.w) * specs.x.pivot
		if (solved.y) target.y = solved.y.pos + (solved.y.size - box.h) * specs.y.pivot
		target.w = box.w
		target.h = box.h
	}

	// Text that scales is drawn like a uniformly scaled picture of its design
	// layout: one factor, identical line breaks, and whatever slack the other
	// axis has distributed by its pivot.
	const base = rule.base ?? null
	let scale = null
	let factor = null
	if (base && base.w > 0 && base.h > 0) {
		factor = Math.min(target.w / base.w, target.h / base.h)
	}
	if (scaledText && factor != null) {
		scale = Math.max(0.01, (finite(base.scale, 1) ?? 1) * factor)
		const drawnW = base.w * factor
		const drawnH = base.h * factor
		target.x = pivotWithin(target.x, target.w, drawnW, specs.x?.pivot ?? 0.5)
		target.y = pivotWithin(target.y, target.h, drawnH, specs.y?.pivot ?? 0.5)
		target.w = drawnW
		target.h = drawnH
	}

	if (apply) {
		writeBox(editor, shape, target, {
			scale,
			wrapWidth: wrapWidthFor(shape, solved.x, scaledText),
			parent,
		})
		if (!scaledText && (rule.text ?? 'scale') === 'scale' && factor != null) {
			scaleOverlayLabel(editor, shape, factor)
		}
	}

	return {
		id: shape.id,
		type: shape.type,
		box: { x: round(target.x), y: round(target.y), w: round(target.w), h: round(target.h) },
		before: { x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) },
		changed:
			Math.abs(target.x - box.x) > 0.5 ||
			Math.abs(target.y - box.y) > 0.5 ||
			Math.abs(target.w - box.w) > 0.5 ||
			Math.abs(target.h - box.h) > 0.5,
		scale,
		notes,
	}
}

/**
 * Resolve every anchored descendant of a container, outermost first: a nested
 * container settles its own box before its children read it.
 */
export function resolveContainer(editor, container, { apply = true } = {}) {
	if (!apply) return resolveContainerInner(editor, container, { apply })
	resolving++
	try {
		return runDerived(editor, () => resolveContainerInner(editor, container, { apply }))
	} finally {
		resolving--
	}
}

/**
 * Run the resolver's writes outside undo history.
 *
 * Resolved geometry is DERIVED: it is a function of the rules and the
 * container's size, so it can always be recomputed and never needs restoring.
 * Recording it made undo restore half of a resolve - a child put back while
 * its container stayed where it was - and a rebase reading that mid-state saw
 * a shape wildly off its rule and wrote the discrepancy in as an offset.
 *
 * Keeping it out of history means an undo restores only what a person did, and
 * the next resolve derives everything else from the rules again.
 */
function runDerived(editor, fn) {
	if (typeof editor.run !== 'function') return fn()
	let out
	editor.run(() => {
		out = fn()
	}, { history: 'ignore' })
	return out
}

function resolveContainerInner(editor, container, { apply }) {
	const out = []
	let ids = []
	try {
		ids = editor.getSortedChildIdsForParent(container.id)
	} catch {
		return out
	}
	for (const cid of ids) {
		const child = editor.getShape(cid)
		if (!child || child.type === 'arrow') continue
		const rule = ruleOf(child)
		if (rule) {
			try {
				const r = resolveShapeRule(editor, child, rule, container, { apply })
				if (r) out.push(r)
			} catch (err) {
				out.push({ id: child.id, type: child.type, error: err.message })
			}
		}
		const fresh = editor.getShape(cid)
		if (fresh && hasAnyChildren(editor, fresh)) {
			out.push(...resolveContainer(editor, fresh, { apply }))
		}
	}
	return out
}

/** Resolve every top-level container on the page. */
export function resolveAll(editor, { apply = true } = {}) {
	const out = []
	for (const s of editor.getCurrentPageShapes()) {
		if (String(s.parentId).startsWith('shape:')) continue // reached through its parent
		if (!hasAnyChildren(editor, s)) continue
		out.push(...resolveContainer(editor, s, { apply }))
	}
	return out
}

/** The shape a rule resolves against, or null when there is nothing to follow. */
export function anchorParent(editor, shape) {
	if (!String(shape.parentId).startsWith('shape:')) return null
	return editor.getShape(shape.parentId) ?? null
}

/**
 * Rewrite a rule so it describes the shape's CURRENT box, keeping its anchor,
 * pivot and mode. This is what moving or resizing by hand means: the author
 * changed where the thing sits or how big it is, not how it responds.
 *
 * Because position and size are separate statements, a hand resize updates the
 * number its mode actually reads (the pixel size, the stretch adjustment, or
 * the ratio) instead of being undone by the next resolve.
 */
export function rebaseOffsets(editor, shape, parent) {
	const rule = ruleOf(shape)
	if (!rule || !parent) return null
	const box = relativeBox(editor, shape, parent)
	const parentBox = innerBox(parent, editor)
	const next = { ...rule }
	for (const axis of AXES) {
		const spec = axisSpec(rule, axis, shape)
		if (!spec) continue
		const extent = axis === 'x' ? parentBox.w : parentBox.h
		const pos = axis === 'x' ? box.x : box.y
		const size = axis === 'x' ? box.w : box.h
		const other = axis === 'x' ? box.h : box.w
		const patch = { ...rule[axis] }
		// position: the offset absorbs the move, the anchor and pivot stay put
		patch.offset = round100(pos - spec.anchor * extent + spec.pivot * size)
		// size: whichever number this mode reads
		if (spec.mode === 'fixed' || spec.mode === 'shrink') patch.size = round100(size)
		else if (spec.mode === 'stretch') patch.sizeOffset = round100(size - spec.percent * extent)
		else if (spec.mode === 'aspect' && other > 0) patch.ratio = round100(size / other)
		next[axis] = patch
	}
	next.base = baseOf(editor, shape, box)
	editor.updateShape({
		id: shape.id,
		type: shape.type,
		meta: { ...(shape.meta ?? {}), clawAnchor: next },
	})
	return next
}

/**
 * Is this shape somewhere its own rule does not put it?
 *
 * A resolve leaves a shape exactly where its rule says, and rebasing from that
 * position is a fixed point: it writes back the numbers it started with. So a
 * rebase is only ever meaningful when something OTHER than the resolver moved
 * the shape, which is precisely a hand drag. Checking first means an automated
 * pass - a resize, an undo, a redo, a remote edit - can never quietly rewrite
 * a rule from geometry that is mid-flight.
 */
export function isOffRule(editor, shape, parent) {
	const rule = ruleOf(shape)
	if (!rule || !parent) return false
	let expected
	try {
		expected = resolveShapeRule(editor, shape, rule, parent, { apply: false })
	} catch {
		return false
	}
	if (!expected || expected.error) return false
	const now = relativeBox(editor, shape, parent)
	return (
		Math.abs(expected.box.x - now.x) > 0.5 ||
		Math.abs(expected.box.y - now.y) > 0.5 ||
		Math.abs(expected.box.w - now.w) > 0.5 ||
		Math.abs(expected.box.h - now.h) > 0.5
	)
}

/** The design box text scaling measures from. */
export function baseOf(editor, shape, box = null) {
	const b = box ?? localBox(editor, shape)
	return {
		w: round100(b.w),
		h: round100(b.h),
		scale: shape.type === 'text' ? round100(finite(shape.props?.scale, 1) ?? 1) : 1,
	}
}

/**
 * The presets, with the sentence that says what each one does. Every preset is
 * measured against the box the author already drew, so placing a shape by eye
 * and then saying how it should behave is the normal flow.
 */
export const PRESETS = [
	['fill', 'Fill', 'Spans the whole screen, edge to edge, on both axes.'],
	['fixed', 'Pin', 'Keeps its current size, pinned to the nearest edge.'],
	['center', 'Centre', 'Keeps its current size and stays centred.'],
	['top-bar', 'Top bar', 'Full width, keeps its height, pinned to the top.'],
	['bottom-bar', 'Bottom bar', 'Full width, keeps its height, pinned to the bottom.'],
	['stretch-x', 'Span wide', 'Grows with the width, keeping the left and right gaps you drew.'],
	['stretch-y', 'Span tall', 'Grows with the height, keeping the top and bottom gaps you drew.'],
]

/** Build a rule from a preset, measured against the shape as it is now. */
export function presetRule(editor, shape, parent, preset, { inset = 0 } = {}) {
	const box = relativeBox(editor, shape, parent)
	const p = innerBox(parent, editor)
	const dims = (axis) => ({
		extent: axis === 'x' ? p.w : p.h,
		lo: axis === 'x' ? box.x : box.y,
		size: axis === 'x' ? box.w : box.h,
	})
	// keep the size, pinned to whichever end of the parent it sits nearer
	const pin = (axis, edge = null) => {
		const { extent, lo, size } = dims(axis)
		const far = edge === 'end' || (edge == null && extent > 0 && lo + size / 2 > extent / 2)
		return {
			mode: 'fixed',
			size: round100(size),
			anchor: far ? 1 : 0,
			pivot: far ? 1 : 0,
			offset: round100(far ? lo + size - extent : lo),
		}
	}
	// span the parent at a uniform inset
	const fill = () => ({
		mode: 'stretch',
		percent: 1,
		sizeOffset: round100(-inset * 2),
		anchor: 0,
		pivot: 0,
		offset: inset,
	})
	// span the parent, keeping the gaps the shape has right now
	const stretch = (axis) => {
		const { extent, lo, size } = dims(axis)
		return {
			mode: 'stretch',
			percent: 1,
			sizeOffset: round100(size - extent),
			anchor: 0,
			pivot: 0,
			offset: round100(lo),
		}
	}
	// keep the size, centred
	const centre = (axis) => {
		const { extent, lo, size } = dims(axis)
		return {
			mode: 'fixed',
			size: round100(size),
			anchor: 0.5,
			pivot: 0.5,
			offset: round100(lo + size / 2 - extent / 2),
		}
	}
	const byPreset = {
		fill: () => ({ x: fill(), y: fill() }),
		fixed: () => ({ x: pin('x'), y: pin('y') }),
		center: () => ({ x: centre('x'), y: centre('y') }),
		'stretch-x': () => ({ x: stretch('x'), y: pin('y') }),
		'stretch-y': () => ({ x: pin('x'), y: stretch('y') }),
		'top-bar': () => ({ x: fill(), y: pin('y', 'start') }),
		'bottom-bar': () => ({ x: fill(), y: pin('y', 'end') }),
	}
	const build = byPreset[preset]
	if (!build) {
		throw new Error(`unknown preset "${preset}" (${PRESETS.map(([id]) => id).join(' | ')})`)
	}
	return { ...build(), base: baseOf(editor, shape, box) }
}

/**
 * Resolve anchored shapes and report the resulting boxes, optionally at
 * container sizes the document does not currently have. The document is
 * restored afterwards, so this reads as a preview: nothing about it is a
 * durable edit, and the caller can ask for several sizes in one pass.
 */
export function resolveAnchorReport(editor, { container = null, sizes = [] } = {}) {
	// the whole preview is resolver bookkeeping - it resizes the container,
	// resolves, and puts everything back - so none of it is a hand edit
	resolving++
	try {
		return resolveAnchorReportInner(editor, { container, sizes })
	} finally {
		resolving--
	}
}

function resolveAnchorReportInner(editor, { container, sizes }) {
	const targets = []
	if (container) {
		targets.push(container)
	} else {
		for (const s of editor.getCurrentPageShapes()) {
			if (String(s.parentId).startsWith('shape:')) continue
			if (!hasAnyChildren(editor, s)) continue
			if (anchoredDescendants(editor, s).length) targets.push(s)
		}
	}
	const out = { containers: [], warnings: [] }
	for (const target of targets) {
		const anchored = anchoredDescendants(editor, target)
		if (!anchored.length) {
			out.warnings.push(`${labelOf(target)} has no anchored shapes inside it - nothing to resolve`)
			continue
		}
		const design = innerBox(target, editor)
		const entry = {
			id: target.id,
			name: labelOf(target),
			design: { w: round(design.w), h: round(design.h) },
			sizes: [],
		}
		const restore = captureSubtree(editor, target)
		const wanted = sizes.length ? sizes : [design]
		for (const size of wanted) {
			const w = Math.max(1, finite(size.w, design.w) ?? design.w)
			const h = Math.max(1, finite(size.h, design.h) ?? design.h)
			editor.updateShape({ id: target.id, type: target.type, props: { w, h } })
			const results = resolveContainer(editor, editor.getShape(target.id), { apply: true })
			entry.sizes.push({
				w: round(w),
				h: round(h),
				shapes: results.map((r) => ({
					...r,
					name: labelOf(editor.getShape(r.id)),
					overflow: r.box ? overflowOf(r.box, { w, h }) : null,
				})),
			})
			applyCapture(editor, restore)
		}
		out.containers.push(entry)
	}
	return out
}

/** How far a resolved box pokes outside its container, on its worst side. */
function overflowOf(box, parent) {
	const over = Math.max(-box.x, -box.y, box.x + box.w - parent.w, box.y + box.h - parent.h)
	return over > 1 ? Math.round(over) : null
}

const labelOf = (shape) =>
	shape?.meta?.clawName ?? shape?.props?.name ?? (shape ? short(shape.id).slice(0, 8) : '?')

/** Every anchored shape inside a container, at any depth. */
export function anchoredDescendants(editor, container) {
	const out = []
	const walk = (shape) => {
		let ids = []
		try {
			ids = editor.getSortedChildIdsForParent(shape.id)
		} catch {
			return
		}
		for (const cid of ids) {
			const child = editor.getShape(cid)
			if (!child || child.type === 'arrow') continue
			if (ruleOf(child)) out.push(child)
			walk(child)
		}
	}
	walk(container)
	return out
}

/** Snapshot the geometry of a container and everything under it. */
function captureSubtree(editor, container) {
	const rows = []
	const walk = (shape) => {
		rows.push({
			id: shape.id,
			type: shape.type,
			x: shape.x,
			y: shape.y,
			w: finite(shape.props?.w, null),
			h: finite(shape.props?.h, null),
			scale: finite(shape.props?.scale, null),
			autoSize: typeof shape.props?.autoSize === 'boolean' ? shape.props.autoSize : null,
		})
		let ids = []
		try {
			ids = editor.getSortedChildIdsForParent(shape.id)
		} catch {
			return
		}
		for (const cid of ids) {
			const child = editor.getShape(cid)
			if (child) walk(child)
		}
	}
	walk(container)
	return rows
}

function applyCapture(editor, rows) {
	for (const row of rows) {
		const shape = editor.getShape(row.id)
		if (!shape) continue
		const props = {}
		if (row.w != null) props.w = row.w
		if (row.h != null) props.h = row.h
		if (row.scale != null) props.scale = row.scale
		if (row.autoSize != null) props.autoSize = row.autoSize
		editor.updateShape({
			id: row.id,
			type: row.type,
			x: row.x,
			y: row.y,
			...(Object.keys(props).length ? { props } : {}),
		})
	}
}

// ---------------------------------------------------------------------------
// live editing
// ---------------------------------------------------------------------------

/**
 * Keep anchored shapes true while a person edits the canvas by hand.
 *
 * Two behaviours, and they are opposites on purpose:
 *  - resizing a CONTAINER re-resolves everything anchored inside it, so
 *    dragging a screen's handle is how the author tests their rules
 *  - moving or resizing an ANCHORED SHAPE rewrites its own numbers instead,
 *    so direct manipulation always wins rather than being snapped back
 *
 * A resize is an ordinary edit: the new size is the new size, and undo puts it
 * back like any other change. Nothing here is a temporary preview mode.
 *
 * Writes are collected and flushed once per frame, outside the change handler
 * that triggered them, because resolving writes shapes and a re-entrant write
 * inside tldraw's own change pass is asking for trouble. Only `user` changes
 * are acted on, so in a shared room the person doing the dragging resolves and
 * the others just receive the result.
 */
export function installLiveAnchors(editor) {
	if (typeof editor?.sideEffects?.registerAfterChangeHandler !== 'function') return () => {}
	const pendingContainers = new Set()
	const pendingRebases = new Set()
	let scheduled = false
	let flushing = false

	const flush = () => {
		scheduled = false
		if (flushing) return
		const containers = [...pendingContainers]
		const rebases = [...pendingRebases]
		pendingContainers.clear()
		pendingRebases.clear()
		if (!containers.length && !rebases.length) return
		flushing = true
		try {
			for (const id of rebases) {
				const shape = editor.getShape(id)
				if (!shape || !ruleOf(shape)) continue
				const parent = anchorParent(editor, shape)
				// only a shape that has actually drifted off its rule was moved
				// by a person; everything else is the resolver's own work
				if (parent && isOffRule(editor, shape, parent)) {
					rebaseOffsets(editor, shape, parent)
				}
			}
			for (const id of containers) {
				const container = editor.getShape(id)
				if (container) resolveContainer(editor, container, { apply: true })
			}
		} catch {
			// a malformed rule must never break canvas interaction
		} finally {
			flushing = false
		}
	}
	const schedule = () => {
		if (scheduled) return
		scheduled = true
		const raf = editor.timers?.requestAnimationFrame ?? requestAnimationFrame
		raf(flush)
	}

	// Belt and braces on the resize lock. Withdrawing the handles (canResize on
	// the shape utils) stops the normal drag, but this refuses the size change
	// at the store instead of trusting every interaction path to consult that.
	// The resolver is exempt, since it is the thing that owns these sizes.
	const stopHandResize = editor.sideEffects.registerBeforeChangeHandler
		? editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next, source) => {
				if (flushing || isResolving()) return next
				if (source && source !== 'user') return next
				if (!ruleOf(next)) return next
				const sizeChanged = prev.props?.w !== next.props?.w || prev.props?.h !== next.props?.h
				if (!sizeChanged) return next
				return { ...next, props: { ...next.props, w: prev.props?.w, h: prev.props?.h } }
			})
		: () => {}

	const stopWatching = editor.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
		// a write the resolver made is the rule being applied, not a hand edit
		if (flushing || isResolving()) return
		if (source && source !== 'user') return
		const sizeChanged = prev.props?.w !== next.props?.w || prev.props?.h !== next.props?.h
		const movedOrSized = prev.x !== next.x || prev.y !== next.y || sizeChanged
		if (!movedOrSized) return
		if (sizeChanged && hasAnyChildren(editor, next)) pendingContainers.add(next.id)
		if (ruleOf(next)) pendingRebases.add(next.id)
		if (pendingContainers.size || pendingRebases.size) schedule()
	})

	return () => {
		stopHandResize()
		stopWatching()
	}
}

/** Compact one-line description of a rule, for outline and inspect. */
export function ruleText(rule, shape = null) {
	const bits = []
	const pct = (v) => `${round100(v * 100)}%`
	const signed = (v) => (v === 0 ? '' : v > 0 ? ` + ${round100(v)}` : ` - ${round100(-v)}`)
	for (const axis of AXES) {
		const spec = axisSpec(rule, axis, shape)
		if (!spec) continue
		let size
		if (spec.mode === 'fixed') size = `${round100(spec.size)}px`
		else if (spec.mode === 'stretch') size = `${pct(spec.percent)}${signed(spec.sizeOffset)}`
		else if (spec.mode === 'shrink') {
			size = `${round100(spec.size)}px shrinking to ${pct(spec.percent)}${signed(spec.sizeOffset)}`
		} else size = `${round100(spec.ratio ?? 0)} x other`
		bits.push(`${axis} ${size} @ ${pct(spec.anchor)}${signed(spec.offset)} pivot ${round100(spec.pivot)}`)
		if (fitApplies(spec, axisSpec(rule, axis === 'x' ? 'y' : 'x', shape))) {
			bits.push(`fit-${axis}${signed(spec.fitOffset)}`)
		}
		if (spec.min > 1) bits.push(`min-${axis} ${spec.min}`)
	}
	if ((rule.text ?? 'scale') === 'fixed') bits.push('text fixed')
	return bits.join('  ')
}
