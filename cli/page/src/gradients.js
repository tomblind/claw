/**
 * Gradient colour slots: the model, the paint, and the export path.
 *
 * A gradient lives on a colour SLOT (two colours plus linear/radial), so
 * editing the slot restyles every shape using it; each shape owns only the
 * GEOMETRY, as fractions of its own box, which is what survives a resize.
 *
 * The paint is split by how the pixels are produced, and that split is why it
 * works everywhere: vector shapes get their resolved fill/stroke replaced with
 * a reference to their own gradient definition (via tldraw's display-values
 * hook, which canvas AND export both read), while text is html and has to clip
 * a css gradient to its glyphs. See reference/format-notes.md.
 */
import React from 'react'
import * as TL from 'tldraw'
import { editorBg, mixHex, reportError } from './common.js'

/**
 * Gradient slots. A custom colour slot may hold a gradient instead of a hex:
 *   { gradient: 'linear' | 'radial', from: '#hex', to: '#hex' }
 * The slot owns the COLOURS (change it once, every shape using it follows);
 * each shape owns the GEOMETRY, as fractions of its own box in
 * meta.clawGradient = { from: {x, y}, to: {x, y} } - fractions so a gradient
 * keeps its look when the shape is resized.
 */
export const isGradientSlot = (val) => !!val && typeof val === 'object' && typeof val.gradient === 'string'
export const gradientIdFor = (shapeId, prop) => 'claw-grad-' + String(shapeId).replace(/[^\w-]/g, '') + '-' + prop
/** the gradient definition a shape's colour slot resolves to, if any */
export const gradientDefFor = (editor, shape, prop) => {
	const spec = editor.getDocumentSettings?.()?.meta?.clawTheme ?? null
	const val = spec?.colors?.[shape?.props?.[prop]]
	return isGradientSlot(val) ? val : null
}
export const gradientMidpoint = (val) => mixHex(val.from ?? '#000000', val.to ?? '#ffffff', 0.5)
export const DEFAULT_GRADIENT_POINTS = {
	linear: { from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 } },
	radial: { from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 } },
}
export const gradientPointsOf = (shape, kind) => {
	const d = DEFAULT_GRADIENT_POINTS[kind] ?? DEFAULT_GRADIENT_POINTS.linear
	const m = shape?.meta?.clawGradient
	const pt = (p, fb) => ({
		x: Number.isFinite(Number(p?.x)) ? Number(p.x) : fb.x,
		y: Number.isFinite(Number(p?.y)) ? Number(p.y) : fb.y,
	})
	return { from: pt(m?.from, d.from), to: pt(m?.to, d.to) }
}

/**
 * Paint gradient slots onto the canvas.
 *
 * tldraw resolves a colour slot to ONE css colour and paints fill, stroke and
 * text with it, so a gradient cannot travel through the theme itself. Instead
 * each shape using a gradient slot gets its own gradient definition (in
 * object-bounding-box units, which is exactly what fractional control points
 * are) plus a css rule pointing that shape's paint at it: svg fill/stroke for
 * shapes, background-clip for html text. Rebuilt when the shapes or the theme
 * change, and a no-op when nothing on the page uses a gradient.
 */
let lastGradientKey = null
export function paintGradients(editor) {
	try {
		const spec = editor.getDocumentSettings?.()?.meta?.clawTheme ?? null
		const bySlot = new Map(Object.entries(spec?.colors ?? {}).filter(([, v]) => isGradientSlot(v)))
		const entries = []
		if (bySlot.size) {
			for (const shape of editor.getCurrentPageShapes()) {
				for (const v of gradientVariantsFor(editor, shape)) {
					if (v.suffix === 'color') continue // added with the colour prop below
					entries.push({
						id: shape.id,
						prop: v.suffix,
						asText: false,
						def: v.def,
						colors: v,
						points: gradientPointsOf(shape, v.def.gradient),
					})
				}
				for (const prop of ['color', 'labelColor']) {
					const def = bySlot.get(shape.props?.[prop])
					if (!def) continue
					// how the paint reaches the pixels decides the technique: a text
					// SHAPE paints its glyphs through `color` as html, while a geo's
					// `color` paints svg and its `labelColor` paints html
					const asText = prop === 'labelColor' || shape.type === 'text' || shape.type === 'note'
					entries.push({
						id: shape.id,
						prop,
						asText,
						def,
						box: asText ? editor.getShapeGeometry(shape)?.bounds : null,
						outline: shape.meta?.clawText?.outline,
						points: gradientPointsOf(shape, def.gradient),
					})
				}
			}
		}
		const key = JSON.stringify(entries)
		if (key === lastGradientKey) return
		lastGradientKey = key
		document.getElementById('claw-gradient-defs')?.remove()
		document.getElementById('claw-gradient-css')?.remove()
		if (!entries.length) return
		const defs = []
		const rules = []
		let needOutlineFilter = false
		for (const entry of entries) {
			const { id, prop, asText, def, points } = entry
			const gid = gradientIdFor(id, prop)
			defs.push(gradientDefMarkup(id, prop, def, points, entry.colors ?? null))
			const sel = `[data-shape-id="${id}"]`
			if (!asText) {
				// vector shapes need no css: their resolved fill/stroke already
				// points at this definition (see clawDisplayValues), which is what
				// makes exports gradient-fill too. The definition below is what
				// that reference resolves against on the canvas.
			} else {
				const css = gradientTextCss(def, points, entry.box)
				// html text takes a gradient by clipping a background to the glyphs;
				// the outline halo would paint over it, so it goes off here
				rules.push(
					`${sel} .tl-rich-text-wrapper { background-image: ${css}; -webkit-background-clip: text; background-clip: text; }`
				)
				// every descendant paints its own opaque colour, which would cover
				// the clipped gradient - they all have to become transparent so only
				// the wrapper's clipped background shows through the glyphs
				// gradient text paints by clipping a background to the glyphs, so its
				// own fill is transparent. Any text outline then sits ON TOP of the
				// letterforms and eats inward - the stamped halo (text-shadow) and
				// the smooth variant (-webkit-text-stroke) both have to go.
				rules.push(
					`${sel} .tl-rich-text-wrapper, ${sel} .tl-rich-text-wrapper * { color: transparent !important;` +
						` text-shadow: none !important; -webkit-text-stroke: 0 !important; paint-order: normal !important; }`
				)
				if (entry.outline !== 'off') {
					needOutlineFilter = true
					rules.push(`${sel} .tl-rich-text-wrapper { filter: url(#${GRADIENT_OUTLINE_ID}); }`)
				}
			}
		}
		if (needOutlineFilter) {
			const bg = editorBg(editor)
			defs.push(gradientOutlineFilterMarkup(GRADIENT_OUTLINE_ID, bg))
		}
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
		svg.id = 'claw-gradient-defs'
		svg.setAttribute('aria-hidden', 'true')
		svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
		svg.innerHTML = `<defs>${defs.join('')}</defs>`
		document.body.appendChild(svg)
		const style = document.createElement('style')
		style.id = 'claw-gradient-css'
		style.textContent = rules.join(String.fromCharCode(10))
		document.head.appendChild(style)
	} catch (err) {
		reportError('gradients', err)
	}
}


export const GRADIENT_OUTLINE_ID = 'claw-text-outline'
/**
 * Outline markup for gradient text: dilate the glyph shape once, flood it with
 * the background colour and merge the original on top. A chain of css
 * drop-shadows cannot do this - each one shadows the RESULT of the previous
 * one, so eight of them compound into a hugely thick outline instead of a
 * uniform 1px ring.
 */
export const gradientOutlineFilterMarkup = (id, color, radius = 1) =>
	`<filter id="${id}" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">` +
	`<feMorphology in="SourceAlpha" operator="dilate" radius="${radius}" result="claw-d"/>` +
	`<feFlood flood-color="${color}" result="claw-c"/>` +
	`<feComposite in="claw-c" in2="claw-d" operator="in" result="claw-o"/>` +
	`<feMerge><feMergeNode in="claw-o"/><feMergeNode in="SourceGraphic"/></feMerge>` +
	`</filter>`

export function gradientTextCss(def, points, box) {
	const W = Math.max(1, box?.w || 1)
	const H = Math.max(1, box?.h || 1)
	if (def.gradient === 'radial') {
		// matches the svg version: an objectBoundingBox radius r describes an
		// ellipse of r*width by r*height, which is what these percentages mean
		const r = Math.max(0.01, Math.hypot(points.to.x - points.from.x, points.to.y - points.from.y))
		const pct = (n) => Math.round(n * 1000) / 10
		return `radial-gradient(ellipse ${pct(r)}% ${pct(r)}% at ${pct(points.from.x)}% ${pct(points.from.y)}%, ${def.from} 0%, ${def.to} 100%)`
	}
	// The control points set WHERE the gradient starts and stops, not just its
	// direction. A css gradient line runs through the box centre at the given
	// angle with length |W*sin| + |H*cos|, so each control point becomes a stop
	// offset by projecting it onto that line.
	const p0 = { x: points.from.x * W, y: points.from.y * H }
	const p1 = { x: points.to.x * W, y: points.to.y * H }
	const dx = p1.x - p0.x
	const dy = p1.y - p0.y
	if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return `linear-gradient(${def.from}, ${def.to})`
	const rad = Math.atan2(dx, -dy) // css angles measure clockwise from "up"
	const deg = Math.round((((rad * 180) / Math.PI + 360) % 360) * 10) / 10
	const u = { x: Math.sin(rad), y: -Math.cos(rad) }
	const L = Math.abs(W * Math.sin(rad)) + Math.abs(H * Math.cos(rad))
	const start = { x: W / 2 - (u.x * L) / 2, y: H / 2 - (u.y * L) / 2 }
	const at = (p) => Math.round((((p.x - start.x) * u.x + (p.y - start.y) * u.y) / L) * 1000) / 10
	return `linear-gradient(${deg}deg, ${def.from} ${at(p0)}%, ${def.to} ${at(p1)}%)`
}

/** css for a gradient slot's preview swatch */
export const gradientCss = (def) =>
	def.gradient === 'radial'
		? `radial-gradient(circle at 50% 50%, ${def.from}, ${def.to})`
		: `linear-gradient(to bottom, ${def.from}, ${def.to})`

/** One meta write for add/edit/remove of a custom slot (value null = remove). */

/**
 * A fill style is not just "on": tldraw resolves each one to a DIFFERENT
 * palette key of the same colour (solid uses the colour's pale `semi` value,
 * lined-fill its own lighter one, and so on), which is what makes the fill
 * styles look different from each other. A gradient has to mirror those
 * strengths or every fill style renders identically.
 *
 * `semi` and `pattern` deliberately keep tldraw's own treatment: semi is
 * colour-independent by design, and pattern draws a hatch that a flat
 * gradient would erase. Both still take the gradient on their outline.
 */
export const GRADIENT_FILL_STRENGTH = { fill: 0, solid: 0.7, 'lined-fill': 0.15 }
export function gradientVariantsFor(editor, shape) {
	const def = gradientDefFor(editor, shape, 'color')
	if (!def) return []
	const out = [{ suffix: 'color', from: def.from, to: def.to, def }]
	const t = GRADIENT_FILL_STRENGTH[shape.props?.fill]
	if (t != null) {
		const bg = editorBg(editor)
		out.push({
			suffix: 'fill',
			from: t ? mixHex(def.from, bg, t) : def.from,
			to: t ? mixHex(def.to, bg, t) : def.to,
			def,
		})
	}
	return out
}

/** svg markup for one shape's gradient, used on canvas and inside exports */
export function gradientDefMarkup(shapeId, prop, def, points, colors = null) {
	const gid = gradientIdFor(shapeId, prop)
	const c = colors ?? def
	const stops = `<stop offset="0" stop-color="${c.from}"/><stop offset="1" stop-color="${c.to}"/>`
	if (def.gradient === 'radial') {
		const r = Math.max(0.01, Math.hypot(points.to.x - points.from.x, points.to.y - points.from.y))
		return `<radialGradient id="${gid}" gradientUnits="objectBoundingBox" cx="${points.from.x}" cy="${points.from.y}" r="${r}">${stops}</radialGradient>`
	}
	return `<linearGradient id="${gid}" gradientUnits="objectBoundingBox" x1="${points.from.x}" y1="${points.from.y}" x2="${points.to.x}" y2="${points.to.y}">${stops}</linearGradient>`
}

/**
 * Point a shape's resolved fill/stroke at its own gradient. This runs for BOTH
 * the live canvas and svg/png export, because tldraw funnels every consumer
 * through getDisplayValues - so an export gradient-fills with no post
 * processing of the exported markup.
 */
export function clawDisplayValues(editor, shape) {
	const variants = gradientVariantsFor(editor, shape)
	if (!variants.length) return {}
	const out = { strokeColor: `url(#${gradientIdFor(shape.id, 'color')})` }
	if (variants.some((v) => v.suffix === 'fill')) {
		out.fillColor = `url(#${gradientIdFor(shape.id, 'fill')})`
	}
	return out
}

/**
 * Carry the shape's own gradient into exports, and give a gradient shape two
 * draggable control points.
 *
 * Handles are tldraw's own mechanism (the line tool uses them), so dragging,
 * snapping and undo all come for free. Handle positions are shape-local
 * pixels, while claw stores control points as FRACTIONS of the shape's box -
 * the conversion happens in both directions here, which is what keeps a
 * gradient looking the same after a resize.
 */
export const withClawGradientExport = (Util) =>
	class extends Util {
		getHandles(shape) {
			const inherited = super.getHandles?.(shape) ?? []
			const def = gradientDefFor(this.editor, shape, 'color')
			if (!def) return inherited
			const box = this.editor.getShapeGeometry(shape)?.bounds
			const w = box?.w
			const h = box?.h
			if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return inherited
			const pts = gradientPointsOf(shape, def.gradient)
			return [
				...inherited,
				{ id: 'claw-grad-from', type: 'vertex', canSnap: false, index: 'a1', x: pts.from.x * w, y: pts.from.y * h },
				{ id: 'claw-grad-to', type: 'vertex', canSnap: false, index: 'a2', x: pts.to.x * w, y: pts.to.y * h },
			]
		}
		onHandleDrag(shape, info) {
			const { handle } = info
			if (handle?.id !== 'claw-grad-from' && handle?.id !== 'claw-grad-to') {
				return super.onHandleDrag?.(shape, info)
			}
			const def = gradientDefFor(this.editor, shape, 'color')
			if (!def) return undefined
			const box = this.editor.getShapeGeometry(shape)?.bounds
			const w = box?.w || 1
			const h = box?.h || 1
			const pts = gradientPointsOf(shape, def.gradient)
			const moved = { x: handle.x / w, y: handle.y / h }
			const next = handle.id === 'claw-grad-from' ? { from: moved, to: pts.to } : { from: pts.from, to: moved }
			return {
				...shape,
				meta: { ...(shape.meta ?? {}), clawGradient: next },
			}
		}
		toSvg(shape, ctx) {
			const variants = gradientVariantsFor(this.editor, shape)
			const inner = super.toSvg(shape, ctx)
			if (!variants.length) return inner
			const points = gradientPointsOf(shape, variants[0].def.gradient)
			let markup = variants
				.map((v) => gradientDefMarkup(shape.id, v.suffix, v.def, points, v))
				.join('')
			// text exports as html inside the svg, which never sees the page's
			// stylesheet - so a gradient text shape carries its own scoped rule
			// along with its definition
			const textDef = gradientDefFor(this.editor, shape, shape.type === 'text' ? 'color' : 'labelColor')
			let scope = null
			const outlineBg = editorBg(this.editor)
			if (textDef) {
				const css = gradientTextCss(textDef, points, this.editor.getShapeGeometry(shape)?.bounds)
				// every declaration needs !important: tldraw inlines the element's
				// full computed style, and an inline style beats a rule. Scoped to
				// this shape's own group so two gradient labels don't collide.
				scope = `claw-gt-${String(shape.id).replace(/[^\w-]/g, '')}`
				if (shape.meta?.clawText?.outline !== 'off') {
					markup += gradientOutlineFilterMarkup(`${scope}-outline`, outlineBg)
				}
				markup +=
					`<style>` +
					`.${scope} .tl-rich-text > div { background-image: ${css} !important;` +
					` -webkit-background-clip: text !important; background-clip: text !important; }` +
					`.${scope} .tl-rich-text > div, .${scope} .tl-rich-text > div *, .${scope} .tl-rich-text {` +
					` color: transparent !important; text-shadow: none !important;` +
					` -webkit-text-stroke: 0 !important; paint-order: normal !important; }` +
					(shape.meta?.clawText?.outline === 'off'
						? ''
						: `.${scope} .tl-rich-text { filter: url(#${scope}-outline); }`) +
					`</style>`
			}
			return React.createElement(
				React.Fragment,
				null,
				React.createElement('defs', { key: 'claw-grad', dangerouslySetInnerHTML: { __html: markup } }),
				scope ? React.createElement('g', { key: 'claw-gt', className: scope }, inner) : inner
			)
		}
	}

