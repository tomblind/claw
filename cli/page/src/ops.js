/**
 * The op executor: every mutation an agent can ask for, applied through the
 * real editor.
 *
 * Ops are validated in the CLI (lib/ops.mjs) before they arrive, so the work
 * here is semantics, not shape-checking. Two invariants worth keeping in
 * mind while editing:
 *  - a batch is all-or-nothing; on failure the caller reloads the document,
 *    so partially-applied state must never be observable afterwards
 *  - tldraw MERGES `meta` on update, so clearing a metadata key means
 *    writing null, not omitting it
 */
import React from 'react'
import * as TL from 'tldraw'
import lz from 'lz-string'
import { getIndexAbove, getIndexBelow, getIndexBetween } from '@tldraw/utils'
import {
	BASE_GEO_BY_ROUNDED,
	CUSTOM_COLOR_SLOTS,
	CUSTOM_FONT_SLOTS,
	ROUNDED_GEO_BY_BASE,
} from '../../lib/custom-slots.mjs'
import { reportError } from './common.js'
import { plainText, resolveShape, round, short } from './editor-utils.js'
import { applyClawTheme, ensureCustomSlots } from './theme.js'
import { containingFrame, shapePlaintext } from './lint.js'

// ---------------------------------------------------------------------------
// ops executor
// ---------------------------------------------------------------------------

/** Inline marks tldraw's rich text supports (StarterKit + Highlight). */
export const TEXT_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight']

/**
 * A fixed chip is a box plus a SEPARATE overlay label, so text ops have to
 * target the label rather than the box (retexting the box would add a second
 * label inside it and grow the box).
 */
export function textTargetOf(editor, shape) {
	if (shape.type === 'geo' && !shapePlaintext(editor, shape)) {
		const overlay = editor
			.getSortedChildIdsForParent(shape.id)
			.map((cid) => editor.getShape(cid))
			.find((c) => c?.type === 'text')
		if (overlay) return { target: overlay, chipBox: shape }
	}
	return { target: shape, chipBox: null }
}

/** Re-centre a chip's overlay label after its text or styling changed width. */
export function recenterChipLabel(editor, chipBox, label) {
	const bb = editor.getShapePageBounds(chipBox.id)
	const lb = editor.getShapePageBounds(label.id)
	const shape = editor.getShape(label.id)
	if (!bb || !lb || !shape) return
	editor.updateShape({
		id: label.id,
		type: 'text',
		x: shape.x + (bb.x + bb.w / 2 - (lb.x + lb.w / 2)),
		y: shape.y + (bb.y + bb.h / 2 - (lb.y + lb.h / 2)),
	})
}

/**
 * Add or remove inline marks on a rich-text document, optionally only on the
 * runs covering a substring. Works on the document JSON (the same shape tldraw
 * stores) so it needs no editing session: text nodes are split at range
 * boundaries and each covered slice gets the new mark set.
 */
function applyRichTextMarks(doc, { marks = {}, match = null, all = false, clear = false }) {
	let hits = 0
	const mergeMarks = (existing) => {
		if (clear) return []
		const next = existing.filter((mk) => marks[mk.type] !== false)
		for (const [type, on] of Object.entries(marks)) {
			if (on && !next.some((mk) => mk.type === type)) next.push({ type })
		}
		return next
	}
	const transformTextParent = (node) => {
		const runs = (node.content ?? []).map((child) =>
			child.type === 'text' ? { text: child.text ?? '', marks: child.marks ?? [] } : { node: child }
		)
		const plain = runs.map((r) => r.text ?? '').join('')
		const ranges = []
		if (match) {
			let from = 0
			for (;;) {
				const at = plain.indexOf(match, from)
				if (at === -1) break
				ranges.push([at, at + match.length])
				from = at + match.length
				if (!all) break
			}
			if (!ranges.length) return node
		} else {
			if (!plain.length) return node
			ranges.push([0, plain.length])
		}
		hits += ranges.length
		const covered = (i) => ranges.some(([a, b]) => i >= a && i < b)
		const out = []
		let pos = 0
		for (const run of runs) {
			if (run.text == null) {
				out.push(run.node)
				continue
			}
			let start = 0
			while (start < run.text.length) {
				const state = covered(pos + start)
				let end = start + 1
				while (end < run.text.length && covered(pos + end) === state) end++
				const nextMarks = state ? mergeMarks(run.marks) : run.marks
				out.push({
					type: 'text',
					text: run.text.slice(start, end),
					...(nextMarks.length ? { marks: nextMarks } : {}),
				})
				start = end
			}
			pos += run.text.length
		}
		// merge neighbouring runs that ended up with identical marks, so
		// repeated formatting can't fragment the text indefinitely
		const merged = []
		for (const run of out) {
			const prev = merged[merged.length - 1]
			const sameMarks =
				prev?.type === 'text' &&
				run.type === 'text' &&
				JSON.stringify((prev.marks ?? []).map((m) => m.type).sort()) ===
					JSON.stringify((run.marks ?? []).map((m) => m.type).sort())
			if (sameMarks) prev.text += run.text
			else merged.push({ ...run })
		}
		return { ...node, content: merged }
	}
	const walk = (node) => {
		if (!node?.content?.length) return node
		if (node.content.some((c) => c.type === 'text')) return transformTextParent(node)
		return { ...node, content: node.content.map(walk) }
	}
	return { doc: walk(doc), hits }
}

export const rich = (text) =>
	typeof TL.toRichText === 'function'
		? TL.toRichText(String(text))
		: {
				type: 'doc',
				content: String(text)
					.split('\n')
					.map((line) => ({
						type: 'paragraph',
						content: line ? [{ type: 'text', text: line }] : [],
					})),
			}

const KIND_DEFAULTS = {
	card: { type: 'geo', geo: 'rectangle', color: 'blue', fill: 'semi', w: null, h: 120 },
	button: { type: 'geo', geo: 'rectangle', color: 'green', fill: 'semi', w: 200, h: 56 },
	box: { type: 'geo', geo: 'rectangle', color: 'black', fill: 'none', w: 160, h: 100 },
	// w/h here are for placement math; text and note shapes size themselves
	// (notes are fixed 200x200, text auto-sizes), so these are not set as props.
	label: { type: 'text', w: 160, h: 32 },
	note: { type: 'note', w: 200, h: 200 },
	image: { type: 'image', w: null, h: null }, // sized from the asset itself
}

/**
 * Resolve an image op's pixels: inline `svg` markup or a `dataUrl` (the CLI
 * inlines `src` file paths before ops arrive). Returns {dataUrl, w, h} with
 * intrinsic size — SVG from viewBox/width/height, raster by decoding it.
 */
async function resolveImage(args) {
	let dataUrl = args.dataUrl ?? null
	let w = args.size?.w
	let h = args.size?.h
	if (args.svg != null) {
		const svg = String(args.svg)
		dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
		if (w == null || h == null) {
			const vb = svg.match(/viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/)
			const wm = svg.match(/\bwidth\s*=\s*["']([\d.]+)/)
			const hm = svg.match(/\bheight\s*=\s*["']([\d.]+)/)
			const iw = wm ? Number(wm[1]) : vb ? Number(vb[1]) : null
			const ih = hm ? Number(hm[1]) : vb ? Number(vb[2]) : null
			if (iw && ih) {
				// keep aspect if only one dimension was given
				w ??= h != null ? (h * iw) / ih : iw
				h ??= (w * ih) / iw
			}
		}
	}
	if (!dataUrl) {
		throw new Error('image needs `svg` (inline markup) or `src` (file path, inlined by the CLI)')
	}
	if (w == null || h == null) {
		const probe = await new Promise((resolvePx, rejectPx) => {
			const img = new Image()
			img.onload = () => resolvePx({ iw: img.naturalWidth, ih: img.naturalHeight })
			img.onerror = () => rejectPx(new Error('image failed to decode - bad data or unsupported format'))
			img.src = dataUrl
		})
		const iw = probe.iw || 320
		const ih = probe.ih || 240
		w ??= h != null ? (h * iw) / ih : iw
		h ??= (w * ih) / iw
	}
	return { dataUrl, w: Math.round(w), h: Math.round(h) }
}

// ---------------------------------------------------------------------------
// waypoint chains: a route with >2 bends can't be one tldraw arrow (two
// anchors + one adjustable middle segment is the ceiling), so layout renders
// it as the original arrow plus invisible 8px waypoint dots and bound
// segment arrows — plain tldraw shapes, so any tldraw can still open the
// file. The projection stitches a chain back into ONE logical transition.
// ---------------------------------------------------------------------------

const bindingsOf = (editor, arrow) => {
	const out = { start: null, end: null }
	for (const b of editor.getBindingsFromShape(arrow, 'arrow')) {
		out[b.props?.terminal === 'start' ? 'start' : 'end'] = b
	}
	return out
}
export const isWaypointShape = (editor, id) => editor.getShape(id)?.meta?.claw === 'waypoint'

export function walkChain(editor, head) {
	const waypoints = []
	const segments = []
	let cur = head
	for (let guard = 0; guard < 64; guard++) {
		const endB = bindingsOf(editor, cur).end
		const toId = endB?.toId
		if (!toId || !isWaypointShape(editor, toId)) {
			return { waypoints, segments, tail: cur, finalBinding: endB }
		}
		waypoints.push(toId)
		const next = editor
			.getCurrentPageShapes()
			.find((s) => s.type === 'arrow' && s.meta?.claw === 'chainseg' && bindingsOf(editor, s).start?.toId === toId)
		if (!next) return { waypoints, segments, tail: cur, finalBinding: null }
		segments.push(next)
		cur = next
	}
	return { waypoints, segments, tail: cur, finalBinding: null }
}

/** Collapse a chain back into its head arrow, rebound to the true target. */
export function unchainArrow(editor, head) {
	// legacy form (waypoint dots + bound segments)
	const { waypoints, segments, tail, finalBinding } = walkChain(editor, head)
	if (waypoints.length) {
		const finalTarget =
			finalBinding?.toId && !isWaypointShape(editor, finalBinding.toId) ? finalBinding.toId : null
		const finalProps = finalBinding ? { ...finalBinding.props, terminal: 'end' } : null
		editor.deleteShapes([...segments.map((s) => s.id), ...waypoints])
		if (finalTarget) {
			editor.createBinding({ type: 'arrow', fromId: head.id, toId: finalTarget, props: finalProps })
		}
		editor.updateShape({ id: head.id, type: 'arrow', props: { arrowheadEnd: 'arrow' } })
		return
	}
	// group form: head carries meta {claw:'chainhead', from, to}; siblings are
	// unbound segment arrows; the parent group is the selection unit
	if (head.meta?.claw !== 'chainhead') return
	const groupId = String(head.parentId).startsWith('shape:') ? head.parentId : null
	const from = head.meta.from
	const to = head.meta.to
	if (groupId) {
		const members = editor
			.getCurrentPageShapes()
			.filter((s) => s.parentId === groupId && s.id !== head.id)
		if (typeof editor.ungroupShapes === 'function') editor.ungroupShapes([groupId])
		editor.deleteShapes(members.map((s) => s.id))
	}
	const freshHead = editor.getShape(head.id)
	// meta must stay JSON-serializable: OMIT the chain keys (undefined is rejected)
	const { claw: _c, from: _f, to: _t, ...cleanMeta } = freshHead.meta ?? {}
	editor.updateShape({
		id: head.id,
		type: 'arrow',
		props: { arrowheadEnd: 'arrow' },
		meta: cleanMeta,
	})
	// restore real bindings so the plain arrow follows its screens again
	for (const [terminal, toId] of [
		['start', from],
		['end', to],
	]) {
		if (!toId || !editor.getShape(toId)) continue
		const existing = bindingsOf(editor, editor.getShape(head.id))[terminal]
		if (existing) continue
		editor.createBinding({
			type: 'arrow',
			fromId: head.id,
			toId,
			props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
		})
	}
}

export async function applyOps(editor, ops) {
	ensureCustomSlots() // defensive: anything that parsed a file may have stripped them
	// sanitize numeric geometry before anything executes: reject non-finite
	// numbers loudly, round float noise (2 decimals - fractional anchors like
	// 0.25 survive), clamp positions and sizes to sane canvas ranges
	const sanitizeGeom = (obj, opIdx) => {
		if (!obj || typeof obj !== 'object') return
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v === 'number') {
				if (!Number.isFinite(v)) throw new Error(`op ${opIdx}: "${k}" is not a finite number`)
				// 3 decimals: an elbow mid rounded to 2 shifts its lane by up to
				// ~1% of the arrow span (6px on a 600px run), which breaks exact
				// lane fusion between arrows meant to overlap
				const r = Math.round(v * 1000) / 1000
				if (k === 'x' || k === 'y') obj[k] = Math.max(-100000, Math.min(100000, r))
				else if (k === 'w' || k === 'h') obj[k] = Math.max(0.01, Math.min(20000, r))
				else obj[k] = r
			} else if (v && typeof v === 'object') {
				sanitizeGeom(v, opIdx)
			}
		}
	}
	ops.forEach((op, i) => sanitizeGeom(op, i + 1))
	const report = []
	const aliases = new Map() // name given in add_screen -> shape id
	const stackY = new Map() // screenId -> next y offset for at:"top" stacking
	// full record ids the batch touched, by category (informational)
	const touched = { created: [], updated: [], deleted: [] }
	// shapes deleted by unchain_all in THIS batch: a layout batch computed
	// against the pre-unchain document may still carry moves for them
	const swept = new Set()

	/** Resolve an op reference: batch alias, id, short id, frame name, label text. */
	const ref = (q) => {
		const s = String(q)
		if (aliases.has(s)) return editor.getShape(aliases.get(s))
		try {
			return resolveShape(editor, s)
		} catch {
			// last resort: unique match on shape text
			const lower = s.toLowerCase()
			const byText = editor
				.getCurrentPageShapes()
				.filter((sh) => (plainText(editor, sh) ?? '').toLowerCase() === lower)
			if (byText.length === 1) return byText[0]
			throw new Error(`cannot resolve "${s}" to a unique shape (id, frame name, or label)`)
		}
	}
	const pageBoundsOf = (shape) => editor.getShapePageBounds(shape.id)

	for (let i = 0; i < ops.length; i++) {
		const op = ops[i]
		const kind = Object.keys(op)[0]
		const args = op[kind]
		try {
			switch (kind) {
				case 'add_screen': {
					const id = TL.createShapeId()
					let x = args.at?.x
					let y = args.at?.y
					let w = args.size?.w
					let h = args.size?.h
					if (args.near != null) {
						const near = ref(args.near)
						const nb = pageBoundsOf(near)
						x ??= nb.x + nb.w + 120
						y ??= nb.y
						w ??= Math.round(nb.w)
						h ??= Math.round(nb.h)
					}
					w ??= 320
					h ??= 568
					if (x == null || y == null) {
						// auto-place: continue the existing screen grid (wrap to a new
						// row after 5), so batch-authored canvases lay out sanely with
						// no placement arithmetic in the ops file
						const frames = editor
							.getCurrentPageShapes()
							.filter((s) => s.type === 'frame' && s.id !== id)
							.map((s) => editor.getShapePageBounds(s.id))
							.filter(Boolean)
						if (!frames.length) {
							x ??= 0
							y ??= 0
						} else {
							const rowY = Math.max(...frames.map((b) => b.y))
							const row = frames.filter((b) => Math.abs(b.y - rowY) < 2)
							if (row.length >= 5) {
								x ??= Math.min(...frames.map((b) => b.x))
								y ??= rowY + Math.max(...row.map((b) => b.h)) + 160
							} else {
								x ??= Math.max(...row.map((b) => b.x + b.w)) + 120
								y ??= rowY
							}
						}
					}
					editor.createShape({
						id,
						type: 'frame',
						x,
						y,
						meta: { clawName: String(args.name ?? 'Screen') },
						props: { w, h, name: String(args.name ?? 'Screen'), ...(args.color != null ? { color: String(args.color) } : {}) },
					})
					aliases.set(String(args.name), id)
					touched.created.push(id)
					report.push(`add_screen ${args.name} -> ${short(id)} (frame ${w}x${h} @${round(x)},${round(y)})`)
					break
				}

				case 'add': {
					const spec = KIND_DEFAULTS[args.kind ?? 'box']
					if (!spec) throw new Error(`unknown kind "${args.kind}" (card|button|label|note|box|image)`)
					const screen = args.screen != null ? ref(args.screen) : null
					const sb = screen ? pageBoundsOf(screen) : null

					// images carry their own intrinsic size; resolve before placement math
					const image = args.kind === 'image' ? await resolveImage(args) : null
					let w = image ? image.w : (args.size?.w ?? (spec.w === null && sb ? Math.round(sb.w - 40) : spec.w))
					let h = image ? image.h : (args.size?.h ?? spec.h)
					// zero/negative dimensions poison the whole batch — clamp and note
					if (w != null && w < 1) {
						report.push(`(op ${i + 1}: w=${w} clamped to 1)`)
						w = 1
					}
					if (h != null && h < 1) {
						report.push(`(op ${i + 1}: h=${h} clamped to 1)`)
						h = 1
					}
					// FIXED CHIP: a geo with text AND an explicit height would auto-grow
					// past its size (tldraw enforces a text min-height on every client),
					// so build it as an unlabeled box + a centered overlay label instead
					const fixedChip = spec.type === 'geo' && args.text != null && args.size?.h != null

					// page-space placement
					let px
					let py
					const at = args.at ?? 'top'
					if (typeof at === 'object') {
						px = (sb ? sb.x : 0) + at.x
						py = (sb ? sb.y : 0) + at.y
					} else if (sb) {
						const ew = w ?? 160
						const eh = h ?? 40
						px = sb.x + (sb.w - ew) / 2
						if (at === 'center') py = sb.y + (sb.h - eh) / 2
						else if (at === 'bottom') py = sb.y + sb.h - eh - 16
						else {
							const yOff = stackY.get(screen.id) ?? 16
							py = sb.y + yOff
							stackY.set(screen.id, yOff + eh + 12)
						}
					} else {
						throw new Error('add without `screen` needs `at: {x, y}` (page coordinates)')
					}

					const id = TL.createShapeId()
					const base = {
						id,
						x: px,
						y: py,
						...(args.name ? { meta: { clawName: String(args.name) } } : {}),
					}
					// parent into real frames so tldraw owns the containment
					if (screen && screen.type === 'frame') {
						base.parentId = screen.id
						base.x = px - pageBoundsOf(screen).x
						base.y = py - pageBoundsOf(screen).y
					}
					const styleProps = {
						...(args.color ? { color: args.color } : {}),
						// sans by default: tldraw's 'draw' font reads hand-sketched,
						// wrong for UI mockups (pass font explicitly to override)
						font: args.font ?? 'sans',
						...(args.textSize ? { size: args.textSize } : {}),
					}
					if (image) {
						const assetId = TL.AssetRecordType.createId()
						editor.createAssets([
							{
								id: assetId,
								typeName: 'asset',
								type: 'image',
								props: {
									src: image.dataUrl,
									w: image.w,
									h: image.h,
									name: String(args.name ?? 'image'),
									isAnimated: false,
									mimeType: image.dataUrl.slice(5, image.dataUrl.indexOf(';')),
									fileSize: image.dataUrl.length,
								},
								meta: {},
							},
						])
						editor.createShape({ ...base, type: 'image', props: { assetId, w, h } })
					} else if (spec.type === 'geo') {
						const radius = Math.max(0, Number(args.radius) || 0)
						editor.createShape({
							...base,
							...(radius ? { meta: { ...(base.meta ?? {}), clawRadius: radius } } : {}),
							type: 'geo',
							props: {
								geo: (radius && ROUNDED_GEO_BY_BASE[spec.geo]) || spec.geo,
								w: w ?? 160,
								h: h ?? 100,
								dash: 'solid',
								color: args.color ?? spec.color,
								fill: spec.fill,
								font: args.font ?? 'sans',
								...(args.textSize ? { size: args.textSize } : {}),
								...(!fixedChip && args.text != null ? { richText: rich(args.text) } : {}),
							},
						})
						if (fixedChip) {
							// overlay label, PARENTED TO THE BOX (moving/rowing/deleting the
							// box carries it) and centered by real glyph bounds
							const labelId = TL.createShapeId()
							editor.createShape({
								id: labelId,
								parentId: id,
								x: 0,
								y: 0,
								type: 'text',
								props: {
									richText: rich(args.text),
									font: args.font ?? 'sans',
									size: args.textSize ?? 's',
									color: args.labelColor ?? 'black',
									textAlign: 'middle',
								},
							})
							const bb = editor.getShapePageBounds(id)
							const lb = editor.getShapePageBounds(labelId)
							const lShape = editor.getShape(labelId)
							editor.updateShape({
								id: labelId,
								type: 'text',
								x: lShape.x + (bb.x + bb.w / 2 - (lb.x + lb.w / 2)),
								y: lShape.y + (bb.y + bb.h / 2 - (lb.y + lb.h / 2)),
							})
							touched.created.push(labelId)
						}
					} else if (spec.type === 'text') {
						editor.createShape({
							...base,
							type: 'text',
							props: { richText: rich(args.text ?? ''), ...styleProps },
						})
					} else {
						editor.createShape({
							...base,
							type: 'note',
							props: { richText: rich(args.text ?? ''), ...styleProps },
						})
					}
					if (args.name) aliases.set(String(args.name), id)
					touched.created.push(id)
					report.push(
						`add ${args.kind ?? 'box'}${args.text ? ` ${JSON.stringify(String(args.text).slice(0, 30))}` : ''} -> ${short(id)}${screen ? ` in ${short(screen.id)}` : ''}`
					)
					break
				}

				case 'set_text': {
					const { target, chipBox } = textTargetOf(editor, ref(args.id))
					editor.updateShape({
						id: target.id,
						type: target.type,
						props: { richText: rich(args.text) },
					})
					if (chipBox) recenterChipLabel(editor, chipBox, target)
					touched.updated.push(target.id)
					report.push(
						`set_text ${short(target.id)}${chipBox ? ` (chip label of ${short(chipBox.id)})` : ''} -> ${JSON.stringify(String(args.text).slice(0, 40))}`
					)
					break
				}

				case 'move': {
					if (swept.has(String(args.id))) {
						report.push(`move ${args.id} skipped (swept by unchain_all)`)
						break
					}
					const target = ref(args.id)
					let nx = target.x
					let ny = target.y
					if (args.by) {
						nx += args.by.dx ?? 0
						ny += args.by.dy ?? 0
					} else if (args.to) {
						// `to` is page-space; convert to parent-space when framed
						const pb = pageBoundsOf(target)
						nx = target.x + (args.to.x - pb.x)
						ny = target.y + (args.to.y - pb.y)
					} else throw new Error('move needs `to: {x,y}` or `by: {dx,dy}`')
					editor.updateShape({ id: target.id, type: target.type, x: nx, y: ny })
					touched.updated.push(target.id)
					report.push(`move ${short(target.id)} -> @${round(nx)},${round(ny)}`)
					break
				}

				case 'resize': {
					const target = ref(args.id)
					if (!('w' in (target.props ?? {}))) {
						throw new Error(`resize: ${target.type} shapes have no w/h props`)
					}
					const rw = args.w != null ? Math.max(1, args.w) : null
					const rh = args.h != null ? Math.max(1, args.h) : null
					if (target.type === 'text') {
						// a fixed width on a text shape turns on WRAPPING (autoSize off);
						// height stays derived from the wrapped content
						editor.updateShape({
							id: target.id,
							type: 'text',
							props: { ...(rw != null ? { w: rw, autoSize: false } : { autoSize: true }) },
						})
						touched.updated.push(target.id)
						report.push(
							rw != null
								? `resize ${short(target.id)} -> text wraps at ${rw}px`
								: `resize ${short(target.id)} -> text auto-size restored`
						)
						break
					}
					editor.updateShape({
						id: target.id,
						type: target.type,
						props: {
							...(rw != null ? { w: rw } : {}),
							...(rh != null ? { h: rh } : {}),
						},
					})
					touched.updated.push(target.id)
					report.push(`resize ${short(target.id)} -> ${rw ?? target.props.w}x${rh ?? target.props.h}`)
					break
				}

				case 'row': {
					const shapes = (args.ids ?? []).map(ref)
					if (shapes.length < 2) throw new Error('row needs 2+ ids')
					const gap = args.gap ?? 12
					// anchor = first shape; the rest line up after it, vertically centered
					const first = pageBoundsOf(shapes[0])
					let cursor = first.x + first.w
					const midY = first.y + first.h / 2
					for (let r = 1; r < shapes.length; r++) {
						const s = shapes[r]
						const b = pageBoundsOf(s)
						const dx = cursor + gap - b.x
						const dy = midY - (b.y + b.h / 2)
						editor.updateShape({ id: s.id, type: s.type, x: s.x + dx, y: s.y + dy })
						cursor = b.x + dx + b.w
						touched.updated.push(s.id)
					}
					report.push(`row ${shapes.length} shape(s), gap ${gap}, centered on ${short(shapes[0].id)}`)
					break
				}

				case 'theme': {
					const settings = editor.getDocumentSettings()
					const meta = { ...(settings.meta ?? {}) }
					if (args.reset) {
						delete meta.clawTheme
					} else {
						const badColors = Object.keys(args.colors ?? {}).filter(
							(n) => !CUSTOM_COLOR_SLOTS.includes(n)
						)
						if (badColors.length) {
							throw new Error(
								`theme colors accepts only custom-1..custom-${CUSTOM_COLOR_SLOTS.length}, not: ${badColors.join(', ')}. The 13 standard tldraw colors are not remappable - claw keeps them meaning the same thing everywhere.`
							)
						}
						const badFonts = Object.keys(args.fonts ?? {}).filter(
							(n) => !CUSTOM_FONT_SLOTS.includes(n)
						)
						if (badFonts.length) {
							throw new Error(
								`theme fonts accepts only custom-1..custom-${CUSTOM_FONT_SLOTS.length}, not: ${badFonts.join(', ')}. The 4 standard fonts (draw sans serif mono) are not replaceable - add a new slot instead.`
							)
						}
						const prev = meta.clawTheme ?? {}
						meta.clawTheme = {
							...prev,
							...(args.colors ? { colors: { ...(prev.colors ?? {}), ...args.colors } } : {}),
							...(args.fonts ? { fonts: { ...(prev.fonts ?? {}), ...args.fonts } } : {}),
						}
					}
					editor.updateDocumentSettings({ meta })
					applyClawTheme(editor, { force: true })
					report.push(
						args.reset
							? 'theme -> reset to tldraw defaults'
							: `theme -> ${Object.keys(args.colors ?? {}).length} custom color(s), ${Object.keys(args.fonts ?? {}).length} font slot(s) set (stored in the document; shapes using custom-N make the file claw-only)`
					)
					break
				}

				case 'clear': {
					const target = ref(args.id)
					if (target.type !== 'frame') throw new Error('clear only applies to frames')
					const kids = editor
						.getSortedChildIdsForParent(target.id)
						.map((cid) => editor.getShape(cid))
						.filter((s) => s && s.type !== 'arrow')
					if (kids.length) editor.deleteShapes(kids.map((s) => s.id))
					for (const k of kids) touched.deleted.push(k.id)
					report.push(`clear ${short(target.id)} -> ${kids.length} children removed (frame + arrows kept)`)
					break
				}

				case 'connect': {
					const from = ref(args.from)
					const to = ref(args.to)
					const fb = pageBoundsOf(from)
					const tb = pageBoundsOf(to)
					const fc = { x: fb.x + fb.w / 2, y: fb.y + fb.h / 2 }
					const tc = { x: tb.x + tb.w / 2, y: tb.y + tb.h / 2 }
					// Frame-to-frame connects (screen transitions) default to elbow
					// arrows: tldraw routes them orthogonally around shapes, which
					// stays legible where straight center-to-center lines turn into
					// spaghetti. `kind` overrides (arc | elbow).
					const elbow =
						args.kind != null
							? args.kind === 'elbow'
							: from.type === 'frame' && to.type === 'frame'
					const id = TL.createShapeId()
					editor.createShape({
						id,
						type: 'arrow',
						x: fc.x,
						y: fc.y,
						props: {
							start: { x: 0, y: 0 },
							end: { x: tc.x - fc.x, y: tc.y - fc.y },
							color: args.color ?? 'green',
							dash: 'solid',
							...(elbow ? { kind: 'elbow' } : {}),
							...(args.label != null ? { richText: rich(args.label) } : {}),
						},
					})
					for (const [terminal, targetId] of [
						['start', from.id],
						['end', to.id],
					]) {
						editor.createBinding({
							type: 'arrow',
							fromId: id,
							toId: targetId,
							props: {
								terminal,
								normalizedAnchor: { x: 0.5, y: 0.5 },
								isExact: false,
								isPrecise: false,
								...(elbow ? { snap: 'edge' } : {}),
							},
						})
					}
					touched.created.push(id)
					report.push(
						`connect ${short(from.id)} -> ${short(to.id)}${args.label ? ` ${JSON.stringify(args.label)}` : ''} (${elbow ? 'elbow ' : ''}arrow ${short(id)}, bound both ends)`
					)
					break
				}

				case 'fix_crossings': {
					// editor-verified collision repair: for every bound arrow whose
					// REAL rendered path cuts through a frame it isn't connected to,
					// sweep the elbow's middle segment until the geometry actually
					// clears; anything a mid nudge can't fix stays put for lint.
					// Runs as layout's last op - a verifier, not a second router:
					// the planner is the single author of anchors.
					const frames = editor.getCurrentPageShapes().filter((s) => s.type === 'frame')
					const frameIdOf = (t) =>
						t == null ? null : t.type === 'frame' ? t.id : (containingFrame(editor, t)?.id ?? null)
					const crossings = (arrowId, endFrames) => {
						let pts
						try {
							const g = editor.getShapeGeometry(arrowId)
							const xf = editor.getShapePageTransform(arrowId)
							pts = g.vertices.map((v) => xf.applyToPoint(v))
						} catch {
							return []
						}
						const hits = []
						for (const f of frames) {
							if (endFrames.has(f.id)) continue
							const r = editor.getShapePageBounds(f.id)
							if (!r) continue
							let hit = false
							for (let i = 0; i < pts.length - 1 && !hit; i++) {
								for (let t = 0; t <= 1 && !hit; t += 0.05) {
									const x = pts[i].x + (pts[i + 1].x - pts[i].x) * t
									const y = pts[i].y + (pts[i + 1].y - pts[i].y) * t
									if (x > r.minX + 2 && x < r.maxX - 2 && y > r.minY + 2 && y < r.maxY - 2) hit = true
								}
							}
							if (hit) hits.push(f.id)
						}
						// own-frame traversal beyond the exit allowance is a defect
						// too: an arrow may cross the strip between its control and
						// the frame edge, not sail through the whole frame
						for (const fid of endFrames) {
							const r = editor.getShapePageBounds(fid)
							if (!r) continue
							let inside = 0
							for (let i = 0; i < pts.length - 1; i++) {
								const a = pts[i]
								const b = pts[i + 1]
								const steps = 20
								const segLen = Math.hypot(b.x - a.x, b.y - a.y)
								for (let s = 0; s < steps; s++) {
									const x = a.x + ((b.x - a.x) * s) / steps
									const y = a.y + ((b.y - a.y) * s) / steps
									if (x > r.minX && x < r.maxX && y > r.minY && y < r.maxY) inside += segLen / steps
								}
							}
							if (inside > 220) hits.push(fid)
						}
						return hits
					}
					let fixed = 0
					const stuck = []
					for (const a of editor.getCurrentPageShapes()) {
						if (a.type !== 'arrow' || typeof a.meta?.claw === 'string') continue
						const binds = editor.getBindingsFromShape(a.id, 'arrow')
						if (binds.length < 2) continue
						const endFrames = new Set(
							binds.map((b) => frameIdOf(editor.getShape(b.toId))).filter(Boolean)
						)
						if (!crossings(a.id, endFrames).length) continue
						// cheapest fix first: slide the elbow's middle segment and
						// re-check the REAL geometry - most crossings clear this way
						// and stay ordinary single arrows
						{
							const before = editor.getShape(a.id)
							const orig = {
								kind: before.props.kind,
								elbowMidPoint: before.props.elbowMidPoint,
							}
							let cleared = false
							for (const m of [0.5, 0.35, 0.65, 0.2, 0.8, 0.12, 0.88]) {
								editor.updateShape({
									id: a.id,
									type: 'arrow',
									props: { kind: 'elbow', elbowMidPoint: m },
								})
								if (!crossings(a.id, endFrames).length) {
									cleared = true
									break
								}
							}
							if (cleared) {
								fixed++
								touched.updated.push(a.id)
								continue
							}
							editor.updateShape({ id: a.id, type: 'arrow', props: orig })
						}
						// the planner's side-faithful model and lane calibration make the
						// planner the single author of anchors; when a mid sweep can't
						// clear a crossing here, the arrow stays put and lint reports it
						// (an earlier repair vocabulary here once rewrote a correct
						// route into a far-side loop)
						stuck.push(short(a.id))
					}
					report.push(
						`fix_crossings -> ${fixed} arrow(s) cleared by a mid nudge${stuck.length ? `; ${stuck.length} left for lint: ${stuck.join(', ')}` : ''}`
					)
					break
				}

				case 'unchain_all': {
					// restore every chain to a plain bound arrow, then sweep debris
					// (headless groups/segments from older or interrupted chains) -
					// this is what makes `claw layout` re-runnable on any canvas
					const heads = editor
						.getCurrentPageShapes()
						.filter((s) => s.type === 'arrow' && s.meta?.claw === 'chainhead')
					for (const h of heads) unchainArrow(editor, h)
					const debris = editor
						.getCurrentPageShapes()
						.filter(
							(s) =>
								s.meta?.claw === 'chainseg' || (s.type === 'group' && s.meta?.claw === 'chain')
						)
					if (debris.length) editor.deleteShapes(debris.map((s) => s.id))
					for (const s of debris) {
						swept.add(s.id)
						swept.add(short(s.id))
					}
					touched.updated.push(...heads.map((h) => h.id))
					report.push(
						`unchain_all -> ${heads.length} chain(s) restored to plain arrows${debris.length ? `, ${debris.length} orphan fragment(s) swept` : ''}`
					)
					break
				}

				case 'chain': {
					if (swept.has(String(args.id))) {
						report.push(`chain ${args.id} skipped (swept by unchain_all)`)
						break
					}
					const target = ref(args.id)
					if (target.type !== 'arrow') throw new Error('chain only applies to arrows')
					unchainArrow(editor, target)
					const pts = args.points ?? []
					if (!pts.length) {
						touched.updated.push(target.id)
						report.push(`chain ${short(target.id)} -> unchained (plain arrow)`)
						break
					}
					const b0 = bindingsOf(editor, editor.getShape(target.id))
					if (!b0.start || !b0.end) throw new Error('chain requires an arrow bound at both ends')
					const fromId = b0.start.toId
					const toId = b0.end.toId
					const boundsOfShape = (sid) => editor.getShapePageBounds(sid)
					const pt = (sid, a) => {
						const bb = boundsOfShape(sid)
						return { x: bb.x + (a?.x ?? 0.5) * bb.w, y: bb.y + (a?.y ?? 0.5) * bb.h }
					}
					const rawPath = [pt(fromId, args.fromAnchor), ...pts, pt(toId, args.toAnchor)]
					// Orthogonalize: anchor points rarely coincide exactly with ELK's
					// route endpoints (child-bound endpoints, hub footprints), which
					// would make bridge segments diagonal. Insert an elbow at every
					// diagonal hop — side anchors exit/enter horizontally, top/bottom
					// anchors vertically — then merge collinear runs.
					const sideways = (a) => a == null || a.x === 0 || a.x === 1
					const bent = []
					for (let i = 0; i < rawPath.length; i++) {
						const b = rawPath[i]
						const a = bent[bent.length - 1]
						if (a && Math.abs(a.x - b.x) > 1 && Math.abs(a.y - b.y) > 1) {
							const horizontalFirst =
								i === 1 ? sideways(args.fromAnchor) : i === rawPath.length - 1 ? !sideways(args.toAnchor) : true
							bent.push(horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y })
						}
						bent.push(b)
					}
					const path = [bent[0]]
					for (let i = 1; i < bent.length - 1; i++) {
						const a = path[path.length - 1]
						const b = bent[i]
						const c = bent[i + 1]
						const collinear =
							(Math.abs(a.x - b.x) < 1 && Math.abs(b.x - c.x) < 1) ||
							(Math.abs(a.y - b.y) < 1 && Math.abs(b.y - c.y) < 1)
						if (!collinear) path.push(b)
					}
					path.push(bent[bent.length - 1])
					// unbind: the chain is a free-standing group; recorded-transition
					// semantics live in meta on the head (projection reads it there)
					for (const b of [b0.start, b0.end]) {
						if (typeof editor.deleteBinding === 'function') editor.deleteBinding(b.id)
						else editor.deleteBindings([b])
					}
					const headShape = editor.getShape(target.id)
					const chainDash = target.props.dash === 'draw' ? 'solid' : target.props.dash
					editor.updateShape({
						id: target.id,
						type: 'arrow',
						x: path[0].x,
						y: path[0].y,
						meta: { ...headShape.meta, claw: 'chainhead', from: fromId, to: toId },
						props: {
							start: { x: 0, y: 0 },
							end: { x: path[1].x - path[0].x, y: path[1].y - path[0].y },
							arrowheadEnd: 'none',
							kind: 'arc',
							bend: 0,
							dash: chainDash,
						},
					})
					const segIds = []
					for (let s = 1; s < path.length - 1; s++) {
						const segId = TL.createShapeId()
						editor.createShape({
							id: segId,
							type: 'arrow',
							x: path[s].x,
							y: path[s].y,
							meta: { claw: 'chainseg' },
							props: {
								start: { x: 0, y: 0 },
								end: { x: path[s + 1].x - path[s].x, y: path[s + 1].y - path[s].y },
								color: target.props.color,
								size: target.props.size,
								dash: chainDash,
								kind: 'arc',
								bend: 0,
								arrowheadStart: 'none',
								arrowheadEnd: s === path.length - 2 ? 'arrow' : 'none',
							},
						})
						segIds.push(segId)
						touched.created.push(segId)
					}
					// one group = one selectable, movable unit that edits like an
					// arrow with extra bends (double-click to adjust a segment)
					const groupId = TL.createShapeId()
					editor.groupShapes([target.id, ...segIds], { groupId })
					editor.updateShape({ id: groupId, type: 'group', meta: { claw: 'chain' } })
					touched.updated.push(target.id)
					report.push(`chain ${short(target.id)} -> group of ${segIds.length + 1} segment(s)`)
					break
				}

				case 'route': {
					if (swept.has(String(args.id))) {
						report.push(`route ${args.id} skipped (swept by unchain_all)`)
						break
					}
					const target = ref(args.id)
					if (target.type !== 'arrow') throw new Error('route only applies to arrows')
					const bindings = { start: null, end: null }
					for (const b of editor.getBindingsFromShape(target, 'arrow')) {
						bindings[b.props?.terminal === 'start' ? 'start' : 'end'] = b
					}
					for (const [which, anchor] of [
						['start', args.fromAnchor],
						['end', args.toAnchor],
					]) {
						if (anchor == null) continue
						const b = bindings[which]
						if (!b) throw new Error(`route: arrow has no bound ${which} terminal`)
						editor.updateBinding({
							id: b.id,
							type: 'arrow',
							props: {
								...b.props,
								normalizedAnchor: { x: anchor.x, y: anchor.y },
								snap: 'edge-point',
								isPrecise: true,
							},
						})
					}
					const patch = {}
					if (args.kind != null) patch.kind = args.kind
					if (args.bend != null) patch.bend = args.bend
					if (args.mid != null) patch.elbowMidPoint = Math.max(0.05, Math.min(0.95, args.mid))
					if (args.labelAt != null) patch.labelPosition = Math.max(0.05, Math.min(0.95, args.labelAt))
					// routed arrows are diagram edges: sketchy "draw" dash becomes
					// solid (explicit dashed/dotted styles are respected)
					if (target.props.dash === 'draw') patch.dash = 'solid'
					if (Object.keys(patch).length) {
						editor.updateShape({ id: target.id, type: 'arrow', props: patch })
					}
					// laneX/laneY: calibrate the midpoint against REAL geometry so the
					// lane lands on the exact requested position. tldraw normalizes
					// elbowMidPoint over its own span, so a planner-solved mid drifts
					// a few px - differently per arrow - and runs meant to coincide
					// (or stay apart) drift. Lane position is linear in the midpoint,
					// so two measurements give the exact value.
					if (args.laneX != null || args.laneY != null) {
						const wantVertical = args.laneX != null
						const wantPos = wantVertical ? args.laneX : args.laneY
						const laneOf = (id) => {
							try {
								const g = editor.getShapeGeometry(id)
								const xf = editor.getShapePageTransform(id)
								const pts = g.vertices.map((v) => xf.applyToPoint(v))
								let best = null
								for (let i = 0; i < pts.length - 1; i++) {
									const p = pts[i]
									const q = pts[i + 1]
									const isV = Math.abs(p.x - q.x) < 2
									if (isV !== wantVertical) continue
									const len = wantVertical ? Math.abs(p.y - q.y) : Math.abs(p.x - q.x)
									const pos = wantVertical ? (p.x + q.x) / 2 : (p.y + q.y) / 2
									if (!best || len > best.len) best = { pos, len }
								}
								return best ? best.pos : null
							} catch {
								return null
							}
						}
						const setMid = (m) =>
							editor.updateShape({
								id: target.id,
								type: 'arrow',
								props: { elbowMidPoint: Math.max(0.05, Math.min(0.95, Math.round(m * 10000) / 10000)) },
							})
						const m0 = editor.getShape(target.id).props.elbowMidPoint ?? 0.5
						const x0 = laneOf(target.id)
						if (x0 != null && Math.abs(x0 - wantPos) > 1) {
							const m1 = m0 > 0.5 ? m0 - 0.15 : m0 + 0.15
							setMid(m1)
							const x1 = laneOf(target.id)
							if (x1 != null && Math.abs(x1 - x0) > 0.5) {
								setMid(m0 + ((wantPos - x0) * (m1 - m0)) / (x1 - x0))
								const xf = laneOf(target.id)
								// keep the calibrated value only if it actually improved
								if (xf == null || Math.abs(xf - wantPos) >= Math.abs(x0 - wantPos)) setMid(m0)
							} else {
								setMid(m0)
							}
						}
					}
					touched.updated.push(target.id)
					report.push(
						`route ${short(target.id)}${args.mid != null ? ` mid=${args.mid}` : ''}${args.fromAnchor ? ` from@${args.fromAnchor.x},${args.fromAnchor.y}` : ''}${args.toAnchor ? ` to@${args.toAnchor.x},${args.toAnchor.y}` : ''}`
					)
					break
				}

				case 'style': {
					const target = ref(args.id)
					// shape-level opacity is not a prop
					if (args.opacity != null) {
						editor.updateShape({ id: target.id, type: target.type, opacity: args.opacity })
					}
					const patch = {}
					const skipped = []
					for (const key of ['font', 'size', 'color', 'fill', 'dash', 'align', 'verticalAlign', 'geo', 'labelColor', 'kind', 'bend']) {
						if (args[key] == null) continue
						if (key in (target.props ?? {})) patch[key] = args[key]
						else skipped.push(key)
					}
					if (args.radius != null) {
						if (target.type !== 'geo') throw new Error('radius applies to geo shapes')
						const radius = Math.max(0, Number(args.radius) || 0)
						// the shape may be changing geo in this same op; round whatever
						// it ends up as
						const asked = patch.geo ?? target.props.geo
						const base = BASE_GEO_BY_ROUNDED[asked] ?? asked
						if (radius && !ROUNDED_GEO_BY_BASE[base]) {
							throw new Error(
								`"${base}" has no corners to round (rounding covers ${Object.keys(ROUNDED_GEO_BY_BASE).join(', ')})`
							)
						}
						patch.geo = radius ? ROUNDED_GEO_BY_BASE[base] : base
						editor.updateShape({
							id: target.id,
							type: 'geo',
							meta: { ...(target.meta ?? {}), clawRadius: radius },
						})
					}
					if (Object.keys(patch).length) {
						editor.updateShape({ id: target.id, type: target.type, props: patch })
					}
					touched.updated.push(target.id)
					report.push(
						`style ${short(target.id)} -> ${JSON.stringify(patch)}${args.opacity != null ? ` opacity=${args.opacity}` : ''}${skipped.length ? `  (not applicable to ${target.type}: ${skipped.join(', ')})` : ''}`
					)
					break
				}

				case 'center': {
					const target = ref(args.id)
					const on = ref(args.on)
					const tb = pageBoundsOf(target)
					const ob = pageBoundsOf(on)
					const axis = args.axis ?? 'both'
					const dx = axis !== 'y' ? ob.x + ob.w / 2 - (tb.x + tb.w / 2) : 0
					const dy = axis !== 'x' ? ob.y + ob.h / 2 - (tb.y + tb.h / 2) : 0
					editor.updateShape({ id: target.id, type: target.type, x: target.x + dx, y: target.y + dy })
					touched.updated.push(target.id)
					report.push(`center ${short(target.id)} on ${short(on.id)} (moved ${Math.round(dx)},${Math.round(dy)})`)
					break
				}

				case 'align': {
					const shapes = (args.ids ?? []).map(ref)
					if (shapes.length < (args.to != null ? 1 : 2)) {
						throw new Error('align needs 2+ ids, or 1+ ids with `to`')
					}
					const edge = args.edge ?? 'left'
					const posOf = (b) => {
						const table = {
							left: b.x,
							right: b.x + b.w,
							top: b.y,
							bottom: b.y + b.h,
							centerX: b.x + b.w / 2,
							centerY: b.y + b.h / 2,
						}
						if (!(edge in table)) throw new Error(`unknown edge "${edge}" (left|right|top|bottom|centerX|centerY)`)
						return table[edge]
					}
					const anchor = posOf(pageBoundsOf(args.to != null ? ref(args.to) : shapes[0]))
					const horizontal = edge === 'left' || edge === 'right' || edge === 'centerX'
					for (const s of shapes) {
						const d = anchor - posOf(pageBoundsOf(s))
						if (Math.abs(d) < 0.5) continue
						editor.updateShape({
							id: s.id,
							type: s.type,
							x: s.x + (horizontal ? d : 0),
							y: s.y + (horizontal ? 0 : d),
						})
						touched.updated.push(s.id)
					}
					report.push(`align ${shapes.length} shape(s) ${edge}${args.to != null ? ` to ${short(ref(args.to).id)}` : ''}`)
					break
				}

				case 'distribute': {
					const shapes = (args.ids ?? []).map(ref)
					if (shapes.length < 2) throw new Error('distribute needs 2+ ids')
					const axis = args.axis ?? 'y'
					const gap = args.gap ?? 12
					const sorted = shapes
						.map((s) => ({ s, b: pageBoundsOf(s) }))
						.sort((a, b) => (axis === 'y' ? a.b.y - b.b.y : a.b.x - b.b.x))
					let cursor = axis === 'y' ? sorted[0].b.y + sorted[0].b.h : sorted[0].b.x + sorted[0].b.w
					for (let i = 1; i < sorted.length; i++) {
						const { s, b } = sorted[i]
						const d = cursor + gap - (axis === 'y' ? b.y : b.x)
						if (Math.abs(d) >= 0.5) {
							editor.updateShape({
								id: s.id,
								type: s.type,
								x: s.x + (axis === 'x' ? d : 0),
								y: s.y + (axis === 'y' ? d : 0),
							})
							touched.updated.push(s.id)
						}
						cursor = axis === 'y' ? b.y + d + b.h : b.x + d + b.w
					}
					report.push(`distribute ${shapes.length} shape(s) along ${axis}, gap ${gap}`)
					break
				}

				case 'delete': {
					// Idempotent: a target that no longer resolves is a success, not an
					// error. Deleting a group's children dissolves the group itself, so
					// batches that then delete the group by id would otherwise fail —
					// and an errored batch rolls back EVERYTHING (all-or-nothing).
					let target
					try {
						target = ref(args.id)
					} catch {
						report.push(`delete ${args.id}: already gone (skipped)`)
						break
					}
					// deleting a chained arrow takes its whole chain with it
					if (target.type === 'arrow') {
						const { waypoints, segments } = walkChain(editor, target)
						if (waypoints.length) editor.deleteShapes([...segments.map((s) => s.id), ...waypoints])
						if (target.meta?.claw === 'chainhead' && String(target.parentId).startsWith('shape:')) {
							editor.deleteShape(target.parentId) // the group, children included
							touched.deleted.push(target.id)
							report.push(`delete ${short(target.id)} (chained arrow, group removed)`)
							break
						}
					}
					editor.deleteShape(target.id)
					touched.deleted.push(target.id)
					report.push(`delete ${short(target.id)} (${target.type})`)
					break
				}

				case 'gradient': {
					// per-shape geometry for a gradient slot: fractions of the shape's
					// own box, so the look survives a resize
					const target = ref(args.id)
					const frac = (p, what) => {
						const x = Number(p?.x)
						const y = Number(p?.y)
						if (!Number.isFinite(x) || !Number.isFinite(y)) {
							throw new Error(`gradient "${what}" needs {x, y} as fractions of the shape (0-1)`)
						}
						return { x: Math.max(-1, Math.min(2, x)), y: Math.max(-1, Math.min(2, y)) }
					}
					if (args.reset) {
						// tldraw MERGES meta on update, so omitting the key leaves the old
						// value in place - it has to be explicitly nulled (the file
						// transform drops nulls, so nothing is left behind on disk)
						editor.updateShape({
							id: target.id,
							type: target.type,
							meta: { ...(target.meta ?? {}), clawGradient: null },
						})
						touched.updated.push(target.id)
						report.push(`gradient ${short(target.id)} -> reset to default placement`)
						break
					}
					if (args.from == null || args.to == null) {
						throw new Error('gradient needs "from" and "to" ({x, y} fractions), or "reset": true')
					}
					editor.updateShape({
						id: target.id,
						type: target.type,
						meta: {
							...(target.meta ?? {}),
							clawGradient: { from: frac(args.from, 'from'), to: frac(args.to, 'to') },
						},
					})
					touched.updated.push(target.id)
					report.push(
						`gradient ${short(target.id)} -> from ${args.from.x},${args.from.y} to ${args.to.x},${args.to.y}`
					)
					break
				}

				case 'format': {
					// Inline styling for text: whole shape, or just the runs covering
					// a substring. Marks live in the rich-text document itself, so
					// this is portable - any tldraw editor renders them.
					const { target, chipBox } = textTargetOf(editor, ref(args.id))
					const marks = {}
					for (const m of TEXT_MARKS) if (args[m] != null) marks[m] = !!args[m]
					const clear = !!args.clear
					if (!clear && !Object.keys(marks).length) {
						throw new Error(`format needs at least one of ${TEXT_MARKS.join(', ')} (or clear:true)`)
					}
					const current = editor.getShape(target.id)?.props?.richText
					const doc = current ?? rich(shapePlaintext(editor, target) ?? '')
					const { doc: next, hits } = applyRichTextMarks(doc, {
						marks,
						match: args.match != null ? String(args.match) : null,
						all: !!args.all,
						clear,
					})
					if (args.match != null && hits === 0) {
						throw new Error(`format: no text matching ${JSON.stringify(String(args.match))} in ${short(target.id)}`)
					}
					editor.updateShape({ id: target.id, type: target.type, props: { richText: next } })
					// bold/italic change the glyph widths, so a chip label that was
					// centred is no longer centred
					if (chipBox) recenterChipLabel(editor, chipBox, target)
					touched.updated.push(target.id)
					const applied = clear ? 'cleared' : Object.entries(marks).map(([k, v]) => (v ? k : `no-${k}`)).join(' ')
					report.push(
						`format ${short(target.id)}${chipBox ? ` (chip label of ${short(chipBox.id)})` : ''} -> ${applied}${args.match != null ? ` on ${hits} match(es) of ${JSON.stringify(String(args.match))}` : ''}`
					)
					break
				}

				case 'rotate': {
					// Degrees, clockwise, around the shape's own center. tldraw stores
					// radians and rotating via the raw `rotation` prop would pivot
					// around the shape's top-left corner, visibly moving it - so this
					// goes through rotateShapesBy, which pivots around the center.
					if ((args.id == null) === (args.ids == null)) {
						throw new Error('rotate needs either "id" (one shape) or "ids" (a set)')
					}
					if ((args.by == null) === (args.to == null)) {
						throw new Error('rotate needs either "by" (turn from here) or "to" (absolute angle), in degrees')
					}
					const deg = Number(args.by ?? args.to)
					if (!Number.isFinite(deg)) throw new Error(`rotate: "${args.by != null ? 'by' : 'to'}" must be a number of degrees`)
					const list = (args.ids ?? [args.id]).map((r) => ref(r))
					for (const sh of list) {
						if (sh.type !== 'arrow') continue
						if (editor.getBindingsFromShape(sh.id, 'arrow').length) {
							throw new Error(
								`${short(sh.id)} is a bound arrow: its shape follows its endpoints, so rotating it has no meaning (move or re-route the arrow instead)`
							)
						}
					}
					const toRad = (d) => (d * Math.PI) / 180
					const norm = (d) => Math.round((((d % 360) + 360) % 360) * 100) / 100
					if (args.by != null && list.length > 1) {
						// a set turns as one unit, around the center of the whole group
						editor.rotateShapesBy(list.map((sh) => sh.id), toRad(deg))
					} else {
						for (const sh of list) {
							const current = (editor.getShape(sh.id)?.rotation ?? 0) * (180 / Math.PI)
							const delta = args.by != null ? deg : deg - current
							editor.rotateShapesBy([sh.id], toRad(delta))
						}
					}
					touched.updated.push(...list.map((sh) => sh.id))
					const angles = list
						.map((sh) => `${short(sh.id)}@${norm((editor.getShape(sh.id)?.rotation ?? 0) * (180 / Math.PI))}deg`)
						.join(' ')
					report.push(`rotate ${args.by != null ? `by ${deg}` : `to ${deg}`}deg -> ${angles}`)
					break
				}

				case 'order': {
					// Z-order: which shape draws on top where they overlap. tldraw
					// orders SIBLINGS by a fractional index, so everything here is
					// relative to the other shapes in the same parent (screen).
					const target = ref(args.id)
					const to = String(args.to ?? 'front')
					if (args.ref != null && to !== 'above' && to !== 'below') {
						throw new Error('"ref" only applies with to:"above" or to:"below"')
					}
					if (to === 'above' || to === 'below') {
						if (args.ref == null) throw new Error(`to:"${to}" needs "ref" (the shape to sit ${to})`)
						const anchor = ref(args.ref)
						if (anchor.id === target.id) throw new Error('a shape cannot be ordered against itself')
						if (anchor.parentId !== target.parentId) {
							throw new Error(
								'z-order is relative to siblings: both shapes must sit in the same screen (or both on the page)'
							)
						}
						// place between the anchor and its neighbour on that side, so
						// the move lands exactly adjacent instead of at the extreme
						// already in z-order: getSortedChildIdsForParent sorts by index
						const siblings = editor
							.getSortedChildIdsForParent(anchor.parentId)
							.map((id) => editor.getShape(id))
							.filter((sh) => sh && sh.id !== target.id)
						const at = siblings.findIndex((sh) => sh.id === anchor.id)
						const neighbor = to === 'above' ? siblings[at + 1] : siblings[at - 1]
						const index = neighbor
							? getIndexBetween(
									to === 'above' ? anchor.index : neighbor.index,
									to === 'above' ? neighbor.index : anchor.index
								)
							: to === 'above'
								? getIndexAbove(anchor.index)
								: getIndexBelow(anchor.index)
						editor.updateShape({ id: target.id, type: target.type, index })
						touched.updated.push(target.id)
						report.push(`order ${short(target.id)} -> ${to} ${short(anchor.id)}`)
						break
					}
					const fn = {
						front: 'bringToFront',
						back: 'sendToBack',
						forward: 'bringForward',
						backward: 'sendBackward',
					}[to]
					if (!fn) {
						throw new Error(`order "to" must be front | back | forward | backward | above | below, got "${to}"`)
					}
					editor[fn]([target.id])
					touched.updated.push(target.id)
					report.push(`order ${short(target.id)} -> ${to}`)
					break
				}

				case 'rename': {
					const target = ref(args.id)
					if (target.type !== 'frame') {
						throw new Error('rename only applies to frames; for other shapes use set_text')
					}
					editor.updateShape({ id: target.id, type: 'frame', props: { name: String(args.name) } })
					touched.updated.push(target.id)
					report.push(`rename ${short(target.id)} -> ${JSON.stringify(args.name)}`)
					break
				}

				default:
					throw new Error(`unknown op "${kind}"`)
			}
		} catch (err) {
			throw new Error(`op ${i + 1} (${kind}): ${err.message}`)
		}
	}
	// Invariant: connected (bound) arrows render above every screen — a
	// transition vanishing behind a frame is never wanted. bringToFront can't
	// do this: tldraw's ArrowBindingUtil clamps a bound arrow to sit BELOW the
	// next non-arrow sibling above its bound shapes. But that clamp
	// early-returns when no non-arrow sibling is above the arrow, so placing
	// arrows above the topmost non-arrow page child is a stable fixed point.
	if (typeof TL.getIndicesBetween === 'function') {
		const pageId = editor.getCurrentPageId()
		// page-wide, not just page children: binding creation can parent an
		// arrow into a frame before our neutered hooks are in play
		const bound = editor
			.getCurrentPageShapes()
			.filter((s) => s.type === 'arrow' && editor.getBindingsFromShape(s, 'arrow').length)
		if (bound.length) {
			const stray = bound.filter((a) => a.parentId !== pageId)
			if (stray.length) editor.reparentShapes(stray.map((a) => a.id), pageId)
			const kids = editor
				.getSortedChildIdsForParent(pageId)
				.map((sid) => editor.getShape(sid))
				.filter(Boolean)
			const arrowIds = new Set(bound.map((a) => a.id))
			const topNonArrow = kids.filter((s) => !arrowIds.has(s.id)).map((s) => s.index).sort().pop()
			const fresh = kids.filter((s) => arrowIds.has(s.id))
			if (topNonArrow && fresh.some((a) => a.index < topNonArrow)) {
				const indices = TL.getIndicesBetween(topNonArrow, undefined, fresh.length)
				editor.updateShapes(fresh.map((a, i) => ({ id: a.id, type: 'arrow', index: indices[i] })))
			}
		}
	}
	return { report, touched }
}

