/**
 * Headless host page: the real tldraw editor wrapped in a small `window.host`
 * API that the CLI drives via page.evaluate(). Nothing here reimplements
 * tldraw — parsing, migration, rendering, and serialization are all the
 * editor's own code paths.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import * as TL from 'tldraw'
import { useSync } from '@tldraw/sync'
import 'tldraw/tldraw.css'

const { Tldraw } = TL

/**
 * Three modes, one bundle:
 *  - standalone: the host page (file://, no params) - load/serialize a
 *    document per request via window.host. Used by the test harness.
 *  - executor: standalone + a WebSocket RPC client. The app's hidden frame
 *    loads /executor-page?executor=1 and services the core's document calls
 *    (load/project/render/applyOps/serialize) — the system's only "headless"
 *    editor, running visibly inside the app process.
 *  - sync: a live multiplayer peer. Entered when the URL is /f/<roomId>
 *    (humans, served by the core) or has ?room=<id> (the test harness).
 *    The room owns persistence in this mode.
 */
const EXECUTOR = new URLSearchParams(location.search).get('executor') != null

// Reserved custom color slots (tldraw's own color-picker example pattern):
// the names live in the style enum from startup — here AND in the sync
// server — so documents using them always validate; the actual hex values
// come from document meta (clawTheme.colors) and slots without a value stay
// hidden in the picker. NOTE: canvases using these are claw-only (vanilla
// tldraw rejects unknown enum values).
export const CUSTOM_COLOR_SLOTS = Array.from({ length: 8 }, (_, i) => `custom-${i + 1}`)
// Slot registration must go through the `themes` option (of <Tldraw> AND
// useSync): store creation calls registerColorsFromThemes, which REMOVES any
// enum value not declared by a theme definition — ad-hoc addValues gets
// stripped. This extra definition is never activated; it exists purely to
// declare the slots. Actual values come from document meta via applyClawTheme.
// tldraw's registerColorsFromThemes STRIPS enum values not present in the
// theme definitions it's given — and parseTldrawJsonFile (used by every
// executor load) internally creates a store with default themes only, wiping
// our slots from the shared enum. Re-assert after anything that parses.
function ensureCustomSlots() {
	for (const styleProp of [
		TL.DefaultColorStyle,
		TL.DefaultLabelColorStyle,
		TL.geoShapeProps?.labelColor,
		TL.arrowShapeProps?.labelColor,
	]) {
		try {
			styleProp?.addValues?.(...CUSTOM_COLOR_SLOTS)
			// make the slots UNREMOVABLE: internal store creations (e.g. inside
			// parseTldrawJsonFile) re-run registerColorsFromThemes with default
			// themes, which strips unknown values BEFORE validating incoming
			// records - a after-the-fact re-add can't save that parse
			if (styleProp.removeValues && !styleProp.__clawGuarded) {
				const orig = styleProp.removeValues.bind(styleProp)
				styleProp.removeValues = (...vals) =>
					orig(...vals.filter((v) => !CUSTOM_COLOR_SLOTS.includes(v)))
				styleProp.__clawGuarded = true
			}
		} catch {}
	}
}
ensureCustomSlots()

const CLAW_THEMES = (() => {
	try {
		// a COMPLETE definition (clone of the default) so nothing downstream
		// trips on missing fields; only the extra color slots differ
		const def = JSON.parse(JSON.stringify(TL.DEFAULT_THEME))
		def.id = 'claw'
		const placeholder = () => ({ solid: '#888888', semi: '#dddddd', pattern: '#bbbbbb', fill: '#888888' })
		for (const mode of ['light', 'dark']) {
			for (const s of CUSTOM_COLOR_SLOTS) def.colors[mode][s] = placeholder()
		}
		return { claw: def }
	} catch (err) {
		console.warn('claw theme registration unavailable', err)
		return undefined
	}
})()

function syncParams() {
	if (EXECUTOR) return null
	const params = new URLSearchParams(location.search)
	let room = params.get('room')
	if (!room && location.pathname.startsWith('/f/')) {
		room = location.pathname.slice(3).split('/')[0]
	}
	if (!room) return null
	const wsBase = location.protocol.startsWith('http')
		? `ws://${location.host}`
		: `ws://127.0.0.1:${params.get('host')}`
	return {
		uri: `${wsBase}/connect/${room}`,
		name: params.get('name') ?? 'Designer',
		color: params.get('color') ?? '#4465e9',
	}
}

// assets pasted/dropped by users are inlined as data URLs (single-machine
// tool; keeps the server asset-storage-free)
const inlineAssets = {
	upload: async (_asset, file) => {
		const src = await new Promise((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve(reader.result)
			reader.onerror = () => reject(reader.error)
			reader.readAsDataURL(file)
		})
		return { src }
	},
	resolve: (asset) => asset.props.src,
}

function reportError(stage, err) {
	window.hostError = `${stage}: ${err?.message ?? err}`
}

// ---------------------------------------------------------------------------
// per-document theming: the document's meta.clawTheme remaps the 13 standard
// color names and the 4 font slots (names stay standard, so the file opens in
// any tldraw — vanilla apps just show default colors/fonts). Applied through
// tldraw's own ThemeManager, so exports/renders pick it up too.
// ---------------------------------------------------------------------------
let PRISTINE_THEME = null
let lastAppliedTheme = '__unset__'

const mixHex = (hex, other, t) => {
	const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
	const [a, b] = [p(hex), p(other)]
	return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

function applyClawTheme(editor, { force = false } = {}) {
	try {
		if (typeof editor.getTheme !== 'function' || typeof editor.updateThemes !== 'function') return
		PRISTINE_THEME ??= JSON.parse(JSON.stringify(editor.getTheme('default')))
		const spec = editor.getDocumentSettings?.()?.meta?.clawTheme ?? null
		const key = JSON.stringify(spec)
		if (!force && key === lastAppliedTheme) return
		lastAppliedTheme = key
		const next = JSON.parse(JSON.stringify(PRISTINE_THEME))
		for (const [name, val] of Object.entries(spec?.colors ?? {})) {
			for (const mode of ['light', 'dark']) {
				let base = next.colors?.[mode]?.[name]
				// custom slots have no default entry - synthesize one from a template
				if (!base && CUSTOM_COLOR_SLOTS.includes(name) && next.colors?.[mode]) {
					base = JSON.parse(JSON.stringify(next.colors[mode].black ?? {}))
					next.colors[mode][name] = base
				}
				if (!base || typeof base !== 'object') continue
				if (typeof val === 'string') {
					const bg = mode === 'light' ? '#ffffff' : '#101011'
					Object.assign(base, {
						solid: val,
						semi: mixHex(val, bg, 0.7),
						pattern: mixHex(val, bg, 0.45),
					})
					if ('fill' in base) base.fill = val
				} else {
					Object.assign(base, val[mode] ?? val)
				}
			}
		}
		// fonts resolve through the --tl-font-* CSS vars at render time, so the
		// remap must land there too (the theme def alone only drives loading)
		const rootStyle = document.documentElement.style
		for (const slot of ['draw', 'sans', 'serif', 'mono']) rootStyle.removeProperty(`--tl-font-${slot}`)
		document.getElementById('claw-theme-fonts')?.remove()
		let fontFaceCss = ''
		for (const [slot, val] of Object.entries(spec?.fonts ?? {})) {
			const base = next.fonts?.[slot]
			if (!base) continue
			if (typeof val === 'string') {
				base.fontFamily = val
				base.faces = []
				rootStyle.setProperty(`--tl-font-${slot}`, val)
			} else if (val?.family) {
				base.fontFamily = `'${val.family}'`
				rootStyle.setProperty(`--tl-font-${slot}`, `'${val.family}', sans-serif`)
				if (val.url) {
					base.faces = [
						{ family: val.family, src: { url: val.url, format: val.format ?? 'woff2' }, weight: 'normal' },
					]
					fontFaceCss += `@font-face{font-family:'${val.family}';src:url('${val.url}');font-display:swap}\n`
				} else {
					base.faces = []
				}
			}
		}
		if (fontFaceCss) {
			const el = document.createElement('style')
			el.id = 'claw-theme-fonts'
			el.textContent = fontFaceCss
			document.head.appendChild(el)
		}
		editor.updateThemes({ ...editor.getThemes(), default: next })
	} catch (err) {
		reportError('theme', err)
	}
}

/** PNG export via whichever API this tldraw version ships. */
async function toPngBlob(editor, ids, opts) {
	if (typeof editor.toImage === 'function') {
		const result = await editor.toImage(ids, { format: 'png', ...opts })
		return result?.blob ?? result
	}
	if (typeof TL.exportToBlob === 'function') {
		return await TL.exportToBlob({ editor, ids, format: 'png', opts })
	}
	throw new Error('no PNG export API found on this tldraw version')
}

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result).split(',', 2)[1])
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(blob)
	})
}

/** Find a shape by full id, short id (prefix), or frame-name / label text. */
function resolveShape(editor, query) {
	const q = String(query)
	const shapes = editor.getCurrentPageShapes()
	const byId = shapes.find((s) => s.id === q || s.id === `shape:${q}`)
	if (byId) return byId
	const lower = q.toLowerCase()
	const byName = shapes.filter((s) => (s.props?.name ?? '').toLowerCase() === lower)
	if (byName.length === 1) return byName[0]
	// names given to ops persist on the shape (meta.clawName) and resolve
	// across batches and sessions
	const byClawName = shapes.filter((s) => s.meta?.clawName === q)
	if (byClawName.length === 1) return byClawName[0]
	const byPrefix = shapes.filter((s) => s.id.slice(6).startsWith(q))
	if (byPrefix.length === 1) return byPrefix[0]
	throw new Error(`no unique shape matching "${q}"`)
}

function setupHost(editor) {
	const inSyncRoom = syncParams() != null
	window.host = {
		/** Parse + migrate a .tldr file with tldraw's own loader, then load it. */
		async load(json) {
			if (inSyncRoom) {
				throw new Error('load() is standalone-only: a sync room owns its document')
			}
			const parsed = TL.parseTldrawJsonFile({ schema: editor.store.schema, json })
			if (!parsed.ok) {
				throw new Error(`tldraw could not parse the file: ${JSON.stringify(parsed.error)}`)
			}
			TL.loadSnapshot(editor.store, TL.getSnapshot(parsed.value))
				ensureCustomSlots() // parseTldrawJsonFile strips them (see above)
				applyClawTheme(editor) // each document carries its own theme
			const shapes = editor.getCurrentPageShapes()
			return { pages: editor.getPages().length, shapes: shapes.length }
		},

		/**
		 * Render to PNG (base64). No `frame` renders the whole page. With `frame`,
		 * exports the target plus every shape whose page bounds intersect it —
		 * covering both real frames and screens drawn as plain rectangles.
		 */
		async render({ frame = null, around = null, pad = 48, scale = null, maxWidth = 2000, padding = 32 } = {}) {
			// tight crop around one shape (chip/row/tile) — the cheap self-check
			// render: no whitespace, no cross-canvas connectors
			if (around) {
				const target = resolveShape(editor, around)
				const tb = editor.getShapePageBounds(target.id)
				const box = { x: tb.x - pad, y: tb.y - pad, w: tb.w + pad * 2, h: tb.h + pad * 2 }
				const ids = editor
					.getCurrentPageShapes()
					.filter((s) => {
						const b = editor.getShapePageBounds(s.id)
						if (!boundsIntersect(box, b)) return false
						if (s.type !== 'arrow') return true
						return boundsContains(box, b)
					})
					.map((s) => s.id)
				if (!ids.includes(target.id)) ids.push(target.id)
				const blob = await toPngBlob(editor, ids, {
					background: true,
					padding: 0,
					scale: scale ?? 1,
					...(typeof TL.Box === 'function' ? { bounds: new TL.Box(box.x, box.y, box.w, box.h) } : {}),
				})
				return await blobToBase64(blob)
			}
			let ids
			if (frame) {
				const target = resolveShape(editor, frame)
				const tb = editor.getShapePageBounds(target.id)
				// Content: anything overlapping the target. Arrows are stricter — a
				// cross-canvas connector "intersects" the screen it starts at, and one
				// such arrow expands the export bounds to the whole canvas. Include an
				// arrow only if it lies (almost) entirely within the screen region.
				const inflated = { x: tb.x - 64, y: tb.y - 64, w: tb.w + 128, h: tb.h + 128 }
				ids = editor
					.getCurrentPageShapes()
					.filter((s) => {
						const b = editor.getShapePageBounds(s.id)
						if (!boundsIntersect(tb, b)) return false
						if (s.type !== 'arrow') return true
						return boundsContains(inflated, b)
					})
					.map((s) => s.id)
				if (!ids.includes(target.id)) ids.push(target.id)
			} else {
				ids = editor.getCurrentPageShapes().map((s) => s.id)
			}
			if (!ids.length) throw new Error('nothing to render — document has no shapes')

			// Explicit --scale wins; otherwise fit within maxWidth so a big canvas
			// doesn't produce a needlessly huge PNG (context cost is area-based).
			// tldraw exports at 2x pixel ratio, hence the divisor.
			const EXPORT_PIXEL_RATIO = 2
			let effectiveScale = scale
			if (!effectiveScale) {
				let minX = Infinity
				let maxX = -Infinity
				for (const id of ids) {
					const b = editor.getShapePageBounds(id)
					if (!b) continue
					minX = Math.min(minX, b.x)
					maxX = Math.max(maxX, b.x + b.w)
				}
				const width = Number.isFinite(minX) ? maxX - minX + padding * 2 : maxWidth
				effectiveScale = Math.min(1, maxWidth / (Math.max(width, 1) * EXPORT_PIXEL_RATIO))
			}

			const blob = await toPngBlob(editor, ids, {
				background: true,
				padding,
				scale: effectiveScale,
			})
			return await blobToBase64(blob)
		},

		/** Serialize the current document back to .tldr text (tldraw's own writer). */
		async serialize() {
			return await TL.serializeTldrawJson(editor)
		},

		/**
		 * One structured projection of the whole document, computed from real
		 * editor state: page bounds via getShapePageBounds, arrow bindings via
		 * the binding records tldraw itself migrated, plus the two inferences
		 * the editor can't make (rectangles-as-screens, unsnapped arrows).
		 */
		async project() {
			return projectDocument(editor)
		},

		/**
		 * Apply a batch of ops through real editor APIs. Everything an op
		 * doesn't mention is untouched by construction — there is no
		 * regeneration step that could destroy user styling.
		 */
		async applyOps(ops) {
			return applyOps(editor, ops)
		},

		/** diagnostics for the live executor (claw-internal) */
		async debug() {
			let createTest = 'ok'
			const testId = TL.createShapeId()
			try {
				editor.createShape({ id: testId, type: 'geo', x: -9999, y: -9999, props: { w: 4, h: 4, color: 'custom-1' } })
				editor.deleteShape(testId)
			} catch (err) {
				createTest = String(err?.message ?? err).slice(0, 120)
			}
			// replicate the exact ops path: serialize -> load -> applyOps
			let opsPathTest = 'ok'
			try {
				const txt = await window.host.serialize()
				await window.host.load(txt)
				await applyOps(editor, [
					{ add: { kind: 'box', at: { x: -9999, y: -9999 }, size: { w: 4, h: 4 }, color: 'custom-1', name: '__cc' } },
					{ delete: { id: '__cc' } },
				])
			} catch (err) {
				opsPathTest = String(err?.message ?? err).slice(0, 140)
			}
			return {
				userAgent: navigator.userAgent.slice(0, 120),
				themes: typeof editor.getThemes === 'function' ? Object.keys(editor.getThemes()) : null,
				clawThemesDefined: !!CLAW_THEMES,
				colorValues: TL.DefaultColorStyle?.values ? [...TL.DefaultColorStyle.values] : null,
				createTest,
				opsPathTest,
			}
		},
	}
	window.hostReady = true
}

// ---------------------------------------------------------------------------
// ops executor
// ---------------------------------------------------------------------------

const rich = (text) =>
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
const isWaypointShape = (editor, id) => editor.getShape(id)?.meta?.claw === 'waypoint'

function walkChain(editor, head) {
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
function unchainArrow(editor, head) {
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

async function applyOps(editor, ops) {
	ensureCustomSlots() // defensive: anything that parsed a file may have stripped them
	const report = []
	const aliases = new Map() // name given in add_screen -> shape id
	const stackY = new Map() // screenId -> next y offset for at:"top" stacking
	// full record ids the batch touched, by category (informational)
	const touched = { created: [], updated: [], deleted: [] }

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
						props: { w, h, name: String(args.name ?? 'Screen') },
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
						...(args.font ? { font: args.font } : {}),
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
						editor.createShape({
							...base,
							type: 'geo',
							props: {
								geo: spec.geo,
								w: w ?? 160,
								h: h ?? 100,
								dash: 'solid',
								color: args.color ?? spec.color,
								fill: spec.fill,
								...(args.font ? { font: args.font } : {}),
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
					const target = ref(args.id)
					editor.updateShape({
						id: target.id,
						type: target.type,
						props: { richText: rich(args.text) },
					})
					touched.updated.push(target.id)
					report.push(`set_text ${short(target.id)} -> ${JSON.stringify(String(args.text).slice(0, 40))}`)
					break
				}

				case 'move': {
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
							: `theme -> ${Object.keys(args.colors ?? {}).length} color(s), ${Object.keys(args.fonts ?? {}).length} font slot(s) remapped (stored in the document; claw clients render it, other tldraw apps show defaults)`
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

				case 'chain': {
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
					if (args.mid != null) patch.elbowMidPoint = Math.max(0.05, Math.min(0.95, args.mid))
					if (args.labelAt != null) patch.labelPosition = Math.max(0.05, Math.min(0.95, args.labelAt))
					// routed arrows are diagram edges: sketchy "draw" dash becomes
					// solid (explicit dashed/dotted styles are respected)
					if (target.props.dash === 'draw') patch.dash = 'solid'
					if (Object.keys(patch).length) {
						editor.updateShape({ id: target.id, type: 'arrow', props: patch })
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

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

const CONTAINER_TYPES = new Set(['frame', 'group', 'geo', 'image', 'video', 'embed', 'note'])
const CONTAIN_THRESHOLD = 0.9
const NEAR_THRESHOLD = 120
const INSIDE_TOLERANCE = 2

const short = (id) => String(id).replace(/^shape:/, '')
const round = (n) => Math.round(n)

function plainText(editor, shape) {
	const p = shape.props ?? {}
	if (typeof p.text === 'string' && p.text.length) return p.text
	if (p.richText) {
		if (typeof TL.renderPlaintextFromRichText === 'function') {
			try {
				const t = TL.renderPlaintextFromRichText(editor, p.richText)
				if (t?.trim().length) return t
			} catch {}
		}
		// fallback: walk the tiptap tree
		const walk = (n) => {
			if (!n) return ''
			if (typeof n.text === 'string') return n.text
			if (Array.isArray(n.content)) return n.content.map(walk).join('')
			return ''
		}
		const blocks = Array.isArray(p.richText.content) ? p.richText.content : [p.richText]
		const t = blocks.map(walk).join('\n').trim()
		if (t.length) return t
	}
	return undefined
}

function projectDocument(editor) {
	const pages = editor.getPages()
	const currentPageId = editor.getCurrentPageId()
	const out = { v: 1, pages: [], warnings: [] }

	for (const page of pages) {
		if (page.id !== editor.getCurrentPageId()) editor.setCurrentPage(page.id)
		out.pages.push(projectPage(editor, page, out.warnings))
	}
	if (editor.getCurrentPageId() !== currentPageId) editor.setCurrentPage(currentPageId)
	return out
}

function projectPage(editor, page, warnings) {
	const allRaw =
		typeof editor.getCurrentPageShapesSorted === 'function'
			? editor.getCurrentPageShapesSorted()
			: [...editor.getCurrentPageShapes()].sort((a, b) =>
					String(a.index).localeCompare(String(b.index))
				)
	// waypoint dots, chain segments, and chain groups are rendering plumbing,
	// not content: chains are stitched back into their head arrow below
	const all = allRaw.filter(
		(s) =>
			s.meta?.claw !== 'waypoint' &&
			s.meta?.claw !== 'chainseg' &&
			!(s.type === 'group' && s.meta?.claw === 'chain')
	)

	const bounds = new Map()
	for (const s of all) bounds.set(s.id, editor.getShapePageBounds(s.id))

	// ---- effective containment: real parents, else geometry -----------------
	const parentOf = new Map()
	const inferredContainers = new Set()
	const inferredMembership = new Set() // children whose containment is geometric, not real
	const pageLevel = []
	for (const s of all) {
		if (String(s.parentId).startsWith('shape:')) parentOf.set(s.id, s.parentId)
		else pageLevel.push(s)
	}
	const area = (b) => (b ? b.w * b.h : 0)
	for (const inner of pageLevel) {
		if (inner.type === 'arrow') continue
		const ib = bounds.get(inner.id)
		if (!ib || area(ib) <= 0) continue
		let best = null
		let bestArea = Infinity
		for (const outer of pageLevel) {
			if (outer.id === inner.id || !CONTAINER_TYPES.has(outer.type)) continue
			const ob = bounds.get(outer.id)
			if (!ob || area(ob) <= area(ib)) continue
			const ix = Math.max(0, Math.min(ib.x + ib.w, ob.x + ob.w) - Math.max(ib.x, ob.x))
			const iy = Math.max(0, Math.min(ib.y + ib.h, ob.y + ob.h) - Math.max(ib.y, ob.y))
			if ((ix * iy) / area(ib) < CONTAIN_THRESHOLD) continue
			if (area(ob) < bestArea) {
				best = outer
				bestArea = area(ob)
			}
		}
		if (best) {
			parentOf.set(inner.id, best.id)
			inferredContainers.add(best.id)
			inferredMembership.add(inner.id)
		}
	}
	const rootOf = (id) => {
		let cur = id
		const seen = new Set()
		while (!seen.has(cur)) {
			seen.add(cur)
			const p = parentOf.get(cur)
			if (!p) break
			cur = p
		}
		return cur
	}

	// ---- arrow terminals: recorded bindings, else geometric inference -------
	const nonArrows = all.filter((s) => s.type !== 'arrow')
	const resolveLoose = (point) => {
		let inside = null
		let insideArea = Infinity
		let nearest = null
		let nearestD = Infinity
		for (const s of nonArrows) {
			const b = bounds.get(s.id)
			if (!b || b.w <= 0) continue
			const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.w))
			const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.h))
			const d = Math.hypot(dx, dy)
			if (d <= INSIDE_TOLERANCE) {
				if (area(b) < insideArea) {
					inside = s
					insideArea = area(b)
				}
			} else if (d < nearestD) {
				nearest = s
				nearestD = d
			}
		}
		if (inside) return { id: short(inside.id), how: 'inside', d: 0 }
		if (nearest && nearestD <= NEAR_THRESHOLD) {
			return { id: short(nearest.id), how: 'near', d: Math.round(nearestD) }
		}
		return null
	}

	const arrows = []
	let looseArrows = 0
	for (const s of all) {
		if (s.type !== 'arrow') continue
		const entry = { id: short(s.id), label: plainText(editor, s) ?? null, start: null, end: null }
		const recorded = { start: null, end: null }
		// a chain head carries its true endpoints in meta (the chain itself is
		// unbound); that record is as authoritative as a binding — we wrote it
		if (s.meta?.claw === 'chainhead') {
			if (editor.getShape(s.meta.from)) recorded.start = s.meta.from
			if (editor.getShape(s.meta.to)) recorded.end = s.meta.to
		}
		for (const binding of editor.getBindingsFromShape(s, 'arrow')) {
			recorded[binding.props?.terminal === 'start' ? 'start' : 'end'] = binding.toId
		}
		// legacy waypoint chains: the true end is at the tail of the chain
		if (recorded.end && isWaypointShape(editor, recorded.end)) {
			const { finalBinding } = walkChain(editor, s)
			recorded.end =
				finalBinding?.toId && !isWaypointShape(editor, finalBinding.toId) ? finalBinding.toId : null
		}
		const transform = editor.getShapePageTransform(s.id)
		for (const which of ['start', 'end']) {
			if (recorded[which]) {
				entry[which] = { id: short(recorded[which]), how: 'bound', d: 0 }
			} else {
				const local = s.props?.[which] ?? { x: 0, y: 0 }
				const pt = transform ? transform.applyToPoint(local) : local
				entry[which] = resolveLoose(pt)
			}
		}
		if (entry.start?.how !== 'bound' || entry.end?.how !== 'bound') looseArrows++
		if (entry.start && entry.end) {
			entry.rootStart = short(rootOf(`shape:${entry.start.id}`))
			entry.rootEnd = short(rootOf(`shape:${entry.end.id}`))
			entry.sameRoot = entry.rootStart === entry.rootEnd
		}
		arrows.push(entry)
	}
	if (looseArrows) {
		warnings.push(
			`${looseArrows} of ${arrows.length} arrows have endpoint(s) not snapped to a shape — ` +
				`inferred from geometry and labelled as inferred`
		)
	}

	// ---- shapes --------------------------------------------------------------
	const shapes = all
		.filter((s) => s.type !== 'arrow')
		.map((s) => {
			const b = bounds.get(s.id)
			const text = plainText(editor, s)
			return {
				id: short(s.id),
				type: s.type,
				geo: s.props?.geo ?? undefined,
				name: s.props?.name ?? undefined,
				text: text ?? undefined,
				note: s.meta?.note ?? undefined,
				x: b ? round(b.x) : null,
				y: b ? round(b.y) : null,
				w: b ? round(b.w) : null,
				h: b ? round(b.h) : null,
				parent: parentOf.has(s.id) ? short(parentOf.get(s.id)) : null,
				parentInferred: inferredMembership.has(s.id) || undefined,
				container: s.type === 'frame' || s.type === 'group' || inferredContainers.has(s.id),
				containerInferred: inferredContainers.has(s.id) && s.type !== 'frame' && s.type !== 'group',
			}
		})

	return { id: page.id, name: page.name ?? 'Page', shapes, arrows }
}

function boundsIntersect(a, b) {
	if (!a || !b) return false
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function boundsContains(outer, inner) {
	if (!outer || !inner) return false
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.w <= outer.x + outer.w &&
		inner.y + inner.h <= outer.y + outer.h
	)
}

/**
 * Executor RPC: connect back to the core that served this page and service
 * its document calls. One call at a time (the core serializes them); replies
 * echo the call id with either `result` or `error`. Reconnects forever —
 * the core may restart while the app window stays open.
 */
function startExecutor() {
	const url = `ws://${location.host}/executor`
	const connect = () => {
		const ws = new WebSocket(url)
		ws.onmessage = async (e) => {
			let msg
			try {
				msg = JSON.parse(e.data)
			} catch {
				return
			}
			try {
				const fn = window.host?.[msg.method]
				if (typeof fn !== 'function') throw new Error(`unknown executor method "${msg.method}"`)
				const result = await fn(...(msg.args ?? []))
				ws.send(JSON.stringify({ id: msg.id, result }))
			} catch (err) {
				try {
					ws.send(JSON.stringify({ id: msg.id, error: String(err?.message ?? err) }))
				} catch {}
			}
		}
		ws.onclose = () => setTimeout(connect, 1000)
		ws.onerror = () => {} // onclose fires after; avoid unhandled error noise
	}
	connect()
}

/**
 * tldraw's ArrowBindingUtil clamps every bound arrow's z-index to sit just
 * above its two bound shapes and BELOW any other shape — so a transition
 * crossing an unrelated screen always renders behind it. In the executor we
 * own the document's z-order (the end-of-batch raise in applyOps), so neuter
 * the clamp hooks here. Executor-only: user tabs keep stock behavior, and
 * sync replicates our indexes as plain data.
 */
function neutralizeArrowZClamp(editor) {
	try {
		const util = editor.getBindingUtil('arrow')
		for (const k of ['onAfterCreate', 'onAfterChange', 'onAfterChangeFromShape', 'onAfterChangeToShape']) {
			util[k] = undefined
		}
	} catch (err) {
		reportError('arrow-z-patch', err) // degrade: arrows may hide behind screens
	}
}

function onMount(editor) {
	try {
		window.__editor = editor
		setupHost(editor)
		applyClawTheme(editor)
		// live retheme: a `theme` op lands in document meta and every connected
		// tab restyles without reloading
		if (typeof TL.react === 'function') {
			TL.react('claw-theme', () => {
				editor.getDocumentSettings() // tracked; retheme when meta changes
				applyClawTheme(editor)
			})
		}
		if (EXECUTOR) {
			neutralizeArrowZClamp(editor)
			startExecutor()
		}
		if (SYNC) persistSessionState(editor)
	} catch (err) {
		reportError('mount', err)
	}
}

/**
 * Per-document view preferences (grid, tool locks, camera…) are session-scope
 * in tldraw — a sync store doesn't persist them, so they'd reset every time
 * the tab reopens. Save them to localStorage keyed by room (debounced);
 * restore happens in SyncApp BEFORE the editor mounts.
 */
function persistSessionState(editor) {
	if (
		typeof TL.createSessionStateSnapshotSignal !== 'function' ||
		typeof TL.react !== 'function'
	) {
		return // tldraw version drift: degrade to non-persistent, don't break
	}
	const signal = TL.createSessionStateSnapshotSignal(editor.store)
	let timer = null
	TL.react('persist session state', () => {
		const snapshot = signal.get()
		if (!snapshot) return
		clearTimeout(timer)
		timer = setTimeout(() => {
			try {
				localStorage.setItem(sessionKey(), JSON.stringify(snapshot))
			} catch {}
		}, 500)
	})
}

/**
 * "+ Add color" in the style panel: picks a hex with the native color dialog,
 * writes it into the next free custom slot in document meta (so it syncs,
 * persists, and undoes like any edit), pushes the theme, and applies the new
 * color to the current selection.
 */
function CustomStylePanel(props) {
	const editor = TL.useEditor()
	const inputRef = React.useRef(null)
	const relevant = typeof TL.useRelevantStyles === 'function' ? TL.useRelevantStyles() : undefined
	const addColor = (hex) => {
		try {
			const settings = editor.getDocumentSettings()
			const meta = { ...(settings.meta ?? {}) }
			const colors = { ...(meta.clawTheme?.colors ?? {}) }
			const free = CUSTOM_COLOR_SLOTS.find((s) => !(s in colors))
			if (!free) {
				window.alert(`All ${CUSTOM_COLOR_SLOTS.length} custom color slots are in use`)
				return
			}
			colors[free] = hex
			meta.clawTheme = { ...(meta.clawTheme ?? {}), colors }
			editor.updateDocumentSettings({ meta })
			applyClawTheme(editor, { force: true })
			if (TL.DefaultColorStyle) {
				editor.setStyleForSelectedShapes?.(TL.DefaultColorStyle, free)
				editor.setStyleForNextShapes?.(TL.DefaultColorStyle, free)
			}
		} catch (err) {
			reportError('add-color', err)
		}
	}
	return (
		<TL.DefaultStylePanel {...props}>
			<TL.DefaultStylePanelContent styles={relevant} />
			<div className="tlui-style-panel__section">
				<TL.TldrawUiButton
					type="menu"
					data-testid="claw-add-color"
					onClick={() => inputRef.current?.click()}
				>
					<TL.TldrawUiButtonLabel>＋ Add color</TL.TldrawUiButtonLabel>
				</TL.TldrawUiButton>
				<input
					ref={inputRef}
					type="color"
					style={{ display: 'none' }}
					onChange={(e) => addColor(e.target.value)}
				/>
			</div>
		</TL.DefaultStylePanel>
	)
}
const APP_COMPONENTS = { StylePanel: CustomStylePanel }

function StandaloneApp() {
	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw onMount={onMount} components={APP_COMPONENTS} themes={CLAW_THEMES} />
		</div>
	)
}

// useSync re-initializes when its inputs change identity, so everything it
// receives must be render-stable: module-level constants, never literals
// created inside the component (that way lies an infinite re-render loop).
const SYNC = syncParams()
const SYNC_USER_INFO = SYNC ? { id: userId(), name: SYNC.name, color: SYNC.color } : null

function SyncApp() {
	const store = useSync({
		uri: SYNC.uri,
		assets: inlineAssets,
		userInfo: SYNC_USER_INFO,
		themes: CLAW_THEMES,
	})
	// Session state (grid, camera, tool prefs) must be restored into the store
	// BEFORE the editor mounts — the editor writes fresh instance state on
	// mount, clobbering anything loaded afterwards. Hold rendering until done.
	const [restored, setRestored] = React.useState(false)
	React.useEffect(() => {
		if (store.status === 'error') {
			reportError('sync', store.error ?? 'sync connection error')
			return
		}
		if (store.status !== 'synced-remote' || restored) return
		try {
			const saved = localStorage.getItem(sessionKey())
			window.__restoreDebug = { status: store.status, savedFound: !!saved }
			if (saved && typeof TL.loadSessionStateSnapshotIntoStore === 'function') {
				// forceOverwrite: the sync store pre-creates an instance record,
				// and without it the restore silently defers to those defaults
				TL.loadSessionStateSnapshotIntoStore(store.store, JSON.parse(saved), {
					forceOverwrite: true,
				})
				window.__restoreDebug.loaded = true
			}
		} catch (err) {
			window.__restoreDebug = { error: String(err?.message ?? err) }
		}
		setRestored(true)
	}, [store.status, restored])
	// Nothing renders until restore has run: mounting the editor first would
	// clobber the loaded session state with fresh defaults. (Errors fall
	// through so the connection-failed UI can show.)
	if (!restored && store.status !== 'error') return null
	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw store={store} onMount={onMount} components={APP_COMPONENTS} themes={CLAW_THEMES} />
		</div>
	)
}

function sessionKey() {
	return `tldr-session-${SYNC.uri.split('/connect/')[1] ?? 'room'}`
}

function userId() {
	try {
		let id = localStorage.getItem('tldr-user-id')
		if (!id) {
			id = `user-${Math.random().toString(36).slice(2, 10)}`
			localStorage.setItem('tldr-user-id', id)
		}
		return id
	} catch {
		return `user-${Math.random().toString(36).slice(2, 10)}`
	}
}

window.addEventListener('error', (e) => reportError('window', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason))

createRoot(document.getElementById('root')).render(SYNC ? <SyncApp /> : <StandaloneApp />)
