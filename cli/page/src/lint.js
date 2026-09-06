/**
 * Heuristic visual lint: the problems an agent would otherwise burn a render
 * on, reported as text. These are likelihood flags, not certainties - the
 * checks trade precision for costing ~nothing.
 */
import * as TL from 'tldraw'
import {
	anchorParent,
	AXES,
	axisSpec,
	collapseExtent,
	innerBox,
	relativeBox,
	resolveShapeRule,
	sizeIsDriven,
	ruleOf,
} from './anchors.js'

export const shapePlaintext = (editor, s) => {
	try {
		if (s.props?.richText && typeof TL.renderPlaintextFromRichText === 'function') {
			return TL.renderPlaintextFromRichText(editor, s.props.richText).trim()
		}
	} catch {}
	return String(s.props?.text ?? '').trim()
}

export const containingFrame = (editor, s) => {
	let cur = s
	while (cur?.parentId && String(cur.parentId).startsWith('shape:')) {
		const p = editor.getShape(cur.parentId)
		if (!p) return null
		if (p.type === 'frame') return p
		cur = p
	}
	return null
}

/**
 * Heuristic visual lint: the problems an agent would otherwise burn a render
 * on, reported as text. These are likelihood flags, not certainties - the
 * checks trade precision for costing ~nothing.
 */
export function lintDocument(editor) {
	const issues = []
	const add = (kind, detail) => issues.push({ kind, detail })
	const shapes = editor.getCurrentPageShapes()
	const boundsCache = new Map()
	const pb = (id) => {
		if (!boundsCache.has(id)) boundsCache.set(id, editor.getShapePageBounds(id) ?? null)
		return boundsCache.get(id)
	}
	const describe = (s) => {
		const nm = s.meta?.clawName ?? s.props?.name
		const t = nm ?? shapePlaintext(editor, s).slice(0, 24)
		return t ? `${s.type} "${t}" (${s.id.slice(6, 14)})` : `${s.type} (${s.id.slice(6, 14)})`
	}
	const frameName = (f) => (f ? f.props?.name || f.id.slice(6, 14) : 'page')
	const BOXY = new Set(['geo', 'image', 'note', 'video', 'embed'])
	const overlapArea = (a, b) => {
		const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)
		const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY)
		return w > 0 && h > 0 ? w * h : 0
	}

	// children poking out of their frame
	for (const s of shapes) {
		if (s.type === 'arrow') continue
		const parent = String(s.parentId ?? '').startsWith('shape:') ? editor.getShape(s.parentId) : null
		if (!parent || parent.type !== 'frame') continue
		const cb = pb(s.id)
		const fb = pb(parent.id)
		if (!cb || !fb) continue
		const out = Math.max(fb.minX - cb.minX, fb.minY - cb.minY, cb.maxX - fb.maxX, cb.maxY - fb.maxY)
		if (out > 2) {
			add('outside-frame', `${describe(s)} extends ${Math.round(out)}px outside frame "${frameName(parent)}"`)
		}
	}

	// sibling boxes overlapping (text and arrows excluded - overlap is their job)
	const byParent = new Map()
	for (const s of shapes) {
		if (!BOXY.has(s.type)) continue
		const key = s.parentId ?? 'page'
		if (!byParent.has(key)) byParent.set(key, [])
		byParent.get(key).push(s)
	}
	for (const sibs of byParent.values()) {
		for (let i = 0; i < sibs.length; i++) {
			for (let j = i + 1; j < sibs.length; j++) {
				const a = pb(sibs[i].id)
				const b = pb(sibs[j].id)
				if (!a || !b) continue
				const aArea = a.w * a.h
				const bArea = b.w * b.h
				const smaller = Math.min(aArea, bArea)
				const larger = Math.max(aArea, bArea)
				const ov = overlapArea(a, b)
				const frac = smaller > 0 ? ov / smaller : 0
				// a clearly-smaller shape fully inside a bigger one is component
				// nesting (icon in a row, switch in a card) - intentional, skip.
				// Near-identical fully-overlapping rects are accidental duplicates.
				if (frac >= 0.95 && smaller < larger * 0.8) continue
				if (frac > 0.25) {
					add(
						'overlap',
						`${describe(sibs[i])} overlaps ${describe(sibs[j])} by ${Math.round(frac * 100)}% in "${frameName(containingFrame(editor, sibs[i]))}"`
					)
				}
			}
		}
	}

	// text labels wider than the box they sit on (the fixed-chip pattern);
	// remember the pairs for the contrast check below
	const labelHosts = []
	for (const s of shapes) {
		if (s.type !== 'text') continue
		const tb = pb(s.id)
		if (!tb) continue
		const cx = (tb.minX + tb.maxX) / 2
		const cy = (tb.minY + tb.maxY) / 2
		let host = null
		for (const g of shapes) {
			if (!BOXY.has(g.type)) continue
			const gb = pb(g.id)
			if (!gb || cx < gb.minX || cx > gb.maxX || cy < gb.minY || cy > gb.maxY) continue
			if (!host || gb.w * gb.h < pb(host.id).w * pb(host.id).h) host = g
		}
		if (!host) continue
		labelHosts.push({ text: s, host })
		const hb = pb(host.id)
		if (tb.w > hb.w + 2) {
			add('label-overflow', `label ${describe(s)} is ${Math.round(tb.w - hb.w)}px wider than its box ${describe(host)}`)
		}
	}

	// unbound arrows: frozen geometry that will not follow its screens - the
	// single biggest cause of spaghetti flow canvases. Chain parts are exempt
	// (deliberately unbound); short intra-frame annotation arrows are too.
	for (const s of shapes) {
		// string meta.claw = chain part (deliberately unbound); object values
		// are legacy style payloads and don't exempt anything
		if (s.type !== 'arrow' || typeof s.meta?.claw === 'string') continue
		let bindings = []
		try {
			bindings = editor.getBindingsFromShape(s.id, 'arrow')
		} catch {}
		if (bindings.length >= 2) continue
		const b = pb(s.id)
		const insideOneFrame =
			b && frameOfPoint(b.minX, b.minY) != null && frameOfPoint(b.minX, b.minY) === frameOfPoint(b.maxX, b.maxY)
		if (insideOneFrame && b.w < 400 && b.h < 400) continue // local annotation
		add(
			'unbound-arrow',
			`arrow ${describe(s)} has ${bindings.length ? 'only one bound end' : 'no bindings'} - it will not follow screens when anything moves; recreate it with connect`
		)
	}
	function frameOfPoint(x, y) {
		for (const f of shapes) {
			if (f.type !== 'frame') continue
			const fb = pb(f.id)
			if (fb && x >= fb.minX && x <= fb.maxX && y >= fb.minY && y <= fb.maxY) return f.id
		}
		return null
	}

	// connected arrows cutting through unrelated frames
	const frameRects = shapes
		.filter((f) => f.type === 'frame')
		.map((f) => ({ f, b: pb(f.id) }))
		.filter((x) => x.b)
	const segHitsRect = (p1, p2, r) => {
		if (Math.max(p1.x, p2.x) < r.minX || Math.min(p1.x, p2.x) > r.maxX) return false
		if (Math.max(p1.y, p2.y) < r.minY || Math.min(p1.y, p2.y) > r.maxY) return false
		// sampled interior test - robust enough for a lint
		for (let t = 0; t <= 1; t += 0.05) {
			const x = p1.x + (p2.x - p1.x) * t
			const y = p1.y + (p2.y - p1.y) * t
			if (x > r.minX + 2 && x < r.maxX - 2 && y > r.minY + 2 && y < r.maxY - 2) return true
		}
		return false
	}
	const arrowPagePts = (arrowId) => {
		try {
			const geo = editor.getShapeGeometry(arrowId)
			const xf = editor.getShapePageTransform(arrowId)
			return geo.vertices.map((v) => xf.applyToPoint(v))
		} catch {
			return null
		}
	}
	const ptsInsideLen = (pts, r) => {
		let inside = 0
		for (let i = 0; i < pts.length - 1; i++) {
			const a = pts[i]
			const b = pts[i + 1]
			const segLen = Math.hypot(b.x - a.x, b.y - a.y)
			const steps = 20
			for (let t = 0; t < steps; t++) {
				const x = a.x + ((b.x - a.x) * t) / steps
				const y = a.y + ((b.y - a.y) * t) / steps
				if (x > r.minX && x < r.maxX && y > r.minY && y < r.maxY) inside += segLen / steps
			}
		}
		return inside
	}
	// logical arrows: plain bound arrows, PLUS whole chains (head meta carries
	// from/to; the chain's segments live beside the head in its group)
	const logicalArrows = []
	for (const s of shapes) {
		if (s.type !== 'arrow') continue
		if (s.meta?.claw === 'chainseg') continue
		if (s.meta?.claw === 'chainhead') {
			const members = shapes.filter(
				(m) => m.parentId === s.parentId && m.type === 'arrow'
			)
			const pts = members.flatMap((m) => arrowPagePts(m.id) ?? [])
			const ends = [s.meta.from, s.meta.to]
				.map((id) => {
					const t = editor.getShape(id)
					return t ? (t.type === 'frame' ? t.id : (containingFrame(editor, t)?.id ?? null)) : null
				})
				.filter(Boolean)
			if (pts.length) logicalArrows.push({ s, pts, endFrames: new Set(ends), segmented: true })
			continue
		}
		let endFrames
		try {
			endFrames = new Set(
				editor
					.getBindingsFromShape(s.id, 'arrow')
					.map((b) => editor.getShape(b.toId))
					.filter(Boolean)
					.map((t) => (t.type === 'frame' ? t.id : (containingFrame(editor, t)?.id ?? null)))
					.filter(Boolean)
			)
		} catch {
			continue
		}
		if (!endFrames.size) continue
		const pts = arrowPagePts(s.id)
		if (pts) logicalArrows.push({ s, pts, endFrames, segmented: false })
	}
	for (const { s, pts, endFrames, segmented } of logicalArrows) {
		for (const { f, b } of frameRects) {
			if (endFrames.has(f.id)) continue
			let hit = false
			// segmented chains: check pairs within, tolerate the jumps between
			// member polylines by skipping pairs far apart
			for (let i = 0; i < pts.length - 1 && !hit; i++) {
				if (segmented && Math.abs(pts[i].x - pts[i + 1].x) > 2 && Math.abs(pts[i].y - pts[i + 1].y) > 2) continue
				hit = segHitsRect(pts[i], pts[i + 1], b)
			}
			if (hit) add('arrow-through', `arrow ${describe(s)} cuts through frame "${frameName(f)}"`)
		}
		// own-frame traversal: crossing the strip between a control and its
		// frame edge is fine; sailing through the frame is not
		for (const fid of endFrames) {
			const b = pb(fid)
			if (!b) continue
			const inside = ptsInsideLen(pts, b)
			if (inside > 260) {
				add(
					'through-own-frame',
					`arrow ${describe(s)} travels ${Math.round(inside)}px inside its own frame "${frameName(editor.getShape(fid))}" - reroute it out the nearest edge`
				)
			}
		}
	}

	// anchor rules: the mistakes that only show up at a size the author has
	// not dragged the container to yet
	const anchoredParents = new Map()
	for (const s of shapes) {
		const rule = ruleOf(s)
		if (!rule) continue
		const parent = anchorParent(editor, s)
		if (!parent) {
			add(
				'anchor-no-parent',
				`${describe(s)} has an anchor rule but sits on the page, not inside a screen - there is no parent box for it to follow`
			)
			continue
		}
		anchoredParents.set(parent.id, (anchoredParents.get(parent.id) ?? 0) + 1)
		const specs = { x: axisSpec(rule, 'x', s), y: axisSpec(rule, 'y', s) }
		if (specs.x?.mode === 'aspect' && specs.y?.mode === 'aspect') {
			add(
				'anchor-both-aspect',
				`${describe(s)} is aspect mode on both axes - neither axis has a size to derive from`
			)
		}
		for (const axis of AXES) {
			const spec = specs[axis]
			if (!spec) continue
			if (!sizeIsDriven(s) && spec.mode !== 'fixed') {
				add(
					'anchor-group-size',
					`${describe(s)} asks for ${spec.mode} on ${axis}, but a group is sized by its contents - the rule can only position it`
				)
			}
			const collapse = collapseExtent(spec)
			if (collapse != null) {
				const parentExtent = axis === 'x' ? innerBox(parent, editor).w : innerBox(parent, editor).h
				if (collapse > parentExtent * 0.5) {
					add(
						'anchor-collapses',
						`${describe(s)} hits its minimum ${axis === 'x' ? 'width' : 'height'} of ${spec.min} once "${frameName(parent)}" is under ${Math.round(collapse)}px ${axis === 'x' ? 'wide' : 'tall'}, and overflows below that`
					)
				}
			}
		}
		// the stored geometry should already be what the rule produces; when it
		// is not, something moved the shape without the rule being updated
		try {
			const expected = resolveShapeRule(editor, s, rule, parent, { apply: false })
			const now = relativeBox(editor, s, parent)
			if (expected && !expected.error) {
				const drift = Math.max(
					Math.abs(expected.box.x - now.x),
					Math.abs(expected.box.y - now.y),
					Math.abs(expected.box.w - now.w),
					Math.abs(expected.box.h - now.h)
				)
				if (drift > 2) {
					add(
						'anchor-stale',
						`${describe(s)} sits ${Math.round(drift)}px from where its anchor rule puts it - it was moved without the rule following (run an apply, or re-anchor it)`
					)
				}
			}
		} catch (err) {
			add('anchor-invalid', `${describe(s)}: ${err.message}`)
		}
	}
	// a container where only some children respond to a resize is nearly
	// always an oversight, so name the ones that will stay put
	for (const [parentId, count] of anchoredParents) {
		const parent = editor.getShape(parentId)
		if (!parent) continue
		const kids = editor
			.getSortedChildIdsForParent(parentId)
			.map((cid) => editor.getShape(cid))
			.filter((c) => c && c.type !== 'arrow' && !ruleOf(c))
		// a box's own overlay label is carried by the box, not anchored itself
		const stray = kids.filter((c) => !(c.type === 'text' && parent.type === 'geo'))
		if (count && stray.length) {
			add(
				'anchor-partial',
				`"${frameName(parent)}" has ${count} anchored child(ren) and ${stray.length} without a rule (${stray.slice(0, 3).map(describe).join(', ')}${stray.length > 3 ? ', …' : ''}) - those will not move when it resizes`
			)
		}
	}

	// unreadable label-on-fill combinations
	const lum = (hex) => {
		const m = /^#?([0-9a-f]{6})/i.exec(String(hex))
		if (!m) return null
		const n = parseInt(m[1], 16)
		const ch = (v) => {
			v /= 255
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
		}
		return 0.2126 * ch(n >> 16) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255)
	}
	let palette = null
	try {
		palette = editor.getCurrentTheme().colors[editor.getColorMode?.() ?? 'light']
	} catch {}
	if (palette) {
		const contrastCheck = (inkName, bgName, subject) => {
			const li = lum(palette[inkName]?.solid)
			const lb = lum(palette[bgName]?.semi)
			if (li == null || lb == null) return
			const c = (Math.max(li, lb) + 0.05) / (Math.min(li, lb) + 0.05)
			if (c < 1.6) {
				add('low-contrast', `${subject}: "${inkName}" text on "${bgName}" fill reads at ${c.toFixed(1)}:1`)
			}
		}
		// geo shapes carrying their own label
		for (const s of shapes) {
			if (s.type !== 'geo' || s.props?.fill !== 'solid' || !shapePlaintext(editor, s)) continue
			contrastCheck(s.props.labelColor ?? 'black', s.props.color, describe(s))
		}
		// overlay labels centered on a solid-filled box (the fixed-chip pattern)
		for (const { text, host } of labelHosts) {
			if (host.type !== 'geo' || host.props?.fill !== 'solid') continue
			contrastCheck(text.props?.color ?? 'black', host.props.color, `label ${describe(text)} on ${describe(host)}`)
		}
	}

	return { issues, shapes: shapes.length }
}

/** Full resolved detail for one shape - the "focused" level of context. */
