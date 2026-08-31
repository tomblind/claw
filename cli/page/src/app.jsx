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
import lz from 'lz-string'
import { getIndexAbove, getIndexBelow, getIndexBetween } from '@tldraw/utils'
import 'tldraw/tldraw.css'
import {
	CUSTOM_COLOR_SLOTS,
	CUSTOM_FONT_SLOTS,
	extractCustomStyles,
	restoreCustomStyles,
	BASE_GEO_BY_ROUNDED,
	ROUNDED_GEO_BY_BASE,
} from '../../lib/custom-slots.mjs'
import { canvasBg, editorBg, mixHex, reportError } from './common.js'
import { foreignObjectTextToSvgText } from './figma-svg.js'
import { filletedPolygonPath, ROUNDABLE_VERTICES } from './rounded.js'
import { containingFrame, lintDocument, shapePlaintext } from './lint.js'
import { plainText, resolveShape, round, short } from './editor-utils.js'
import { applyOps, isWaypointShape, rich, unchainArrow, walkChain } from './ops.js'
import {
	applyClawTheme,
	captureTranslations,
	clawThemePatch,
	CLAW_THEMES,
	colorHexOf,
	ensureCustomSlots,
	fontFamilyOf,
	fontLabelOf,
} from './theme.js'
import {
	clawDisplayValues,
	gradientCss,
	gradientDefFor,
	gradientMidpoint,
	gradientPointsOf,
	isGradientSlot,
	paintGradients,
	withClawGradientExport,
} from './gradients.js'

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
// (slot lists live in cli/lib/custom-slots.mjs, shared with the sync server,
// alongside the file-boundary transform that keeps saved .tldr files valid
// for other tldraw editors. Fonts render straight from theme.fonts[value] -
// getFontFamily on screen, getThemeFontFaces for export embedding.)
// Slot registration must go through the `themes` option (of <Tldraw> AND
// useSync): store creation calls registerColorsFromThemes, which REMOVES any
// enum value not declared by a theme definition — ad-hoc addValues gets
// stripped. This extra definition is never activated; it exists purely to
// declare the slots. Actual values come from document meta via applyClawTheme.
// tldraw's registerColorsFromThemes STRIPS enum values not present in the
// theme definitions it's given — and parseTldrawJsonFile (used by every
// executor load) internally creates a store with default themes only, wiping
// our slots from the shared enum. Re-assert after anything that parses.
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



// ---------------------------------------------------------------------------
// per-document theming: the document's meta.clawTheme defines extra palette
// colors (custom-1..custom-8) and extra fonts (font slots custom-1..custom-4).
// Strictly additive — the 13 standard colors and 4 standard fonts are
// deliberately untouchable, so they mean the same thing in every tldraw app.
// Applied through tldraw's own ThemeManager, so exports/renders pick it up too.
// ---------------------------------------------------------------------------
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

function inspectShapeDetail(editor, query) {
	const s = resolveShape(editor, query)
	const b = editor.getShapePageBounds(s.id)
	let palette = null
	let themeFonts = null
	try {
		const theme = editor.getCurrentTheme()
		palette = theme.colors[editor.getColorMode?.() ?? 'light']
		themeFonts = theme.fonts
	} catch {}
	const props = {}
	for (const [k, v] of Object.entries(s.props ?? {})) {
		if (k !== 'richText') props[k] = v
	}
	const resolveColor = (name) =>
		name == null
			? undefined
			: palette?.[name]
				? { name, solid: palette[name].solid, semi: palette[name].semi }
				: { name }
	const frame = containingFrame(editor, s)
	return {
		id: s.id,
		type: s.type,
		name: s.meta?.clawName ?? s.props?.name ?? null,
		text: shapePlaintext(editor, s) || null,
		frame: frame ? frame.props?.name || frame.id.slice(6, 14) : null,
		bounds: b
			? { x: Math.round(b.minX), y: Math.round(b.minY), w: Math.round(b.w), h: Math.round(b.h) }
			: null,
		rotation: s.rotation || 0,
		opacity: s.opacity ?? 1,
		props,
		resolved: {
			color: resolveColor(s.props?.color),
			labelColor: resolveColor(s.props?.labelColor),
			font: s.props?.font
				? { name: s.props.font, family: themeFonts?.[s.props.font]?.fontFamily ?? null }
				: undefined,
		},
	}
}

/** Shapes an export covers: the whole page, or one screen and its contents. */
function idsForExport(editor, frame) {
	if (!frame) return editor.getCurrentPageShapes().map((s) => s.id)
	const target = resolveShape(editor, frame)
	const tb = editor.getShapePageBounds(target.id)
	// arrows are stricter: one cross-canvas connector would drag the export
	// bounds out to the whole canvas
	const inflated = { x: tb.x - 64, y: tb.y - 64, w: tb.w + 128, h: tb.h + 128 }
	const ids = editor
		.getCurrentPageShapes()
		.filter((s) => {
			const b = editor.getShapePageBounds(s.id)
			if (!boundsIntersect(tb, b)) return false
			if (s.type !== 'arrow') return true
			return boundsContains(inflated, b)
		})
		.map((s) => s.id)
	if (!ids.includes(target.id)) ids.push(target.id)
	return ids
}

function setupHost(editor) {
	const inSyncRoom = syncParams() != null
	window.host = {
		/** Parse + migrate a .tldr file with tldraw's own loader, then load it. */
		async load(json) {
			if (inSyncRoom) {
				throw new Error('load() is standalone-only: a sync room owns its document')
			}
			// file -> memory: custom style slots come back out of meta.claw (the
			// file itself carries only vanilla-safe fallback values). If the text
			// isn't parseable JSON, fall through and let tldraw report it.
			try {
				const file = JSON.parse(json)
				if (Array.isArray(file.records)) {
					restoreCustomStyles(file.records)
					json = JSON.stringify(file)
				}
			} catch {}
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

		/**
		 * Export to SVG. tldraw puts every piece of shape text inside an SVG
		 * <foreignObject> (HTML embedded in SVG), and Figma's importer ignores
		 * those, so a stock export arrives in Figma with all the shapes and none
		 * of the words. With `figmaText`, each foreignObject is replaced by real
		 * SVG <text> elements measured from the browser's own layout, which Figma
		 * imports as editable text layers.
		 */
		async exportSvg({ frame = null, figmaText = true, padding = 32, scale = 1 } = {}) {
			const ids = idsForExport(editor, frame)
			if (!ids.length) throw new Error('nothing to export — document has no shapes')
			const result = await editor.getSvgString(ids, { background: true, padding, scale })
			if (!result?.svg) throw new Error('tldraw produced no SVG for this selection')
			if (!figmaText) return { svg: result.svg, converted: 0 }
			return foreignObjectTextToSvgText(result.svg)
		},

		/** Serialize the current document back to .tldr text (tldraw's own writer). */
		async serialize() {
			const text = await TL.serializeTldrawJson(editor)
			// memory -> file: swap custom style slots for standard fallbacks +
			// meta.claw, so the saved file opens in any tldraw editor. No catch:
			// writing custom-N to disk would silently break that guarantee.
			const file = JSON.parse(text)
			if (Array.isArray(file.records)) extractCustomStyles(file.records)
			return JSON.stringify(file)
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

		/** Heuristic visual checks - text-only stand-in for render-eyeballing. */
		async lint() {
			return lintDocument(editor)
		},

		/** Full resolved detail for one shape (focused level of context). */
		async inspect(query) {
			return inspectShapeDetail(editor, query)
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
// projection
// ---------------------------------------------------------------------------

const CONTAINER_TYPES = new Set(['frame', 'group', 'geo', 'image', 'video', 'embed', 'note'])
const CONTAIN_THRESHOLD = 0.9
const NEAR_THRESHOLD = 120
const INSIDE_TOLERANCE = 2

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

/**
 * Insecure-context clipboard shim. navigator.clipboard exists only on secure
 * origins (https, localhost), so a canvas opened over the LAN
 * (http://192.168...) has no async clipboard API at all. tldraw's copy
 * handler suppresses the native copy event and then finds no API to write
 * with, so Ctrl+C silently writes NOTHING - and the context menu hides
 * Paste, which genuinely cannot work without the API. The native copy/cut
 * events can still write the real clipboard synchronously, so this
 * capture-phase handler runs before tldraw's and writes the exact payload
 * tldraw would have written; tldraw's own paste handler already falls back
 * to the event data when the async API is missing, so Ctrl+V then works.
 */
function installInsecureClipboardShim(editor) {
	if (navigator.clipboard) return
	const doc = editor.getContainerDocument?.() ?? document
	const write = (e, cut) => {
		try {
			if (!e.clipboardData) return
			if (editor.getSelectedShapeIds().length === 0) return
			if (editor.getEditingShapeId() !== null) return
			const content = editor.getContentFromCurrentPage(editor.getSelectedShapeIds())
			if (!content) return
			const { assets, ...otherData } = content
			// the same wire format tldraw's own copy produces, so any tldraw
			// (including a secure-context tab) can paste it
			const payload = JSON.stringify({
				type: 'application/tldraw',
				kind: 'content',
				version: 3,
				data: {
					assets: assets || [],
					otherCompressed: lz.compressToBase64(JSON.stringify(otherData)),
				},
			})
			const text =
				content.shapes
					.map((s) => {
						try {
							return editor.getShapeUtil(s).getText(s)
						} catch {
							return null
						}
					})
					.filter(Boolean)
					.join(' ') || ' '
			e.clipboardData.setData('text/html', `<div data-tldraw>${payload}</div>`)
			e.clipboardData.setData('text/plain', text)
			e.preventDefault()
			e.stopImmediatePropagation()
			if (cut) editor.deleteShapes(editor.getSelectedShapeIds())
		} catch {
			// fall through to tldraw's handler (which will no-op, but never break)
		}
	}
	doc.addEventListener('copy', (e) => write(e, false), { capture: true })
	doc.addEventListener('cut', (e) => write(e, true), { capture: true })
}

function onMount(editor) {
	try {
		window.__editor = editor
		setupHost(editor)
		installInsecureClipboardShim(editor)
		ensureStaticCss()
		applyClawStyleDefaults(editor)
		if (isSmoothText()) editor.getContainer()?.classList.add('claw-smooth-text')
		applyClawTheme(editor)
		// live retheme: a `theme` op lands in document meta and every connected
		// tab restyles without reloading
		if (typeof TL.react === 'function') {
			TL.react('claw-theme', () => {
				editor.getDocumentSettings() // tracked; retheme when meta changes
				applyClawTheme(editor)
			})
			TL.react('claw-gradients', () => {
				editor.getDocumentSettings()
				editor.getCurrentPageShapes() // tracked: shapes, colours, control points
				paintGradients(editor)
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
 * Claw style panel: tldraw's own pickers recomposed (mirroring the structure
 * of DefaultStylePanelContent) so claw's palette controls sit exactly where
 * they belong - "Customize colors…" right under the color grid, "Customize
 * fonts…" right under the font row. The builtin pickers are theme-driven and
 * grow apply-buttons for defined custom slots on their own; managing slots
 * (add / edit / remove) lives in dedicated dialogs. Everything writes
 * document meta (so it syncs, persists, and undoes like any edit) and pushes
 * the theme.
 */
const FONT_CANDIDATES = [
	'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara',
	'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
	'Franklin Gothic Medium', 'Gabriola', 'Garamond', 'Georgia', 'Impact',
	'Lucida Console', 'Palatino Linotype', 'Segoe Print', 'Segoe Script',
	'Segoe UI', 'Sitka Text', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
	'Verdana', 'serif', 'sans-serif', 'monospace', 'cursive',
]
const GENERIC_FAMILIES = new Set([
	'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
	'ui-serif', 'ui-sans-serif', 'ui-monospace',
])
let fontMeasureCtx = null
const familyAvailable = (name) => {
	const n = String(name).trim().replace(/^['"]|['"]$/g, '')
	if (!n) return false
	if (GENERIC_FAMILIES.has(n.toLowerCase())) return true
	// document.fonts.check() lies (true for any unknown family), so measure:
	// a real family changes text metrics vs at least one generic baseline
	try {
		fontMeasureCtx ??= document.createElement('canvas').getContext('2d')
		const sample = 'mmmmmmmmmmlliWQ@0123'
		const width = (font) => {
			fontMeasureCtx.font = `16px ${font}`
			return fontMeasureCtx.measureText(sample).width
		}
		return (
			width(`"${n}", monospace`) !== width('monospace') ||
			width(`"${n}", serif`) !== width('serif')
		)
	} catch {
		return false
	}
}
const stackAvailable = (stack) => String(stack).split(',').some(familyAvailable)

const FONT_FORMATS = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' }
const formatFromUrl = (u) => FONT_FORMATS[/\.(woff2|woff|ttf|otf)(\?|$)/i.exec(u)?.[1]?.toLowerCase()]

/**
 * Turn whatever URL the user pasted into a loadable font-file URL. Google
 * Fonts (and Bunny etc.) hand out CSS links ("css2?family=..."), so if the
 * URL looks like a stylesheet, fetch it, parse its @font-face rules, and
 * pick the best face: the requested family (or the first one), latin
 * subset, upright, regular weight. Direct font-file URLs pass through.
 */
async function resolveWebfontUrl(url, requestedFamily) {
	const looksCss = /\.css(\?|#|$)|\/css2?\?/i.test(url)
	if (!looksCss) {
		if (!requestedFamily) throw new Error('give the font a family name')
		return { family: requestedFamily, url, format: formatFromUrl(url) }
	}
	const res = await fetch(url).catch(() => null)
	if (!res?.ok) throw new Error(`could not fetch the stylesheet (${res?.status ?? 'network error'})`)
	const css = await res.text()
	const faces = []
	const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*{([^}]*)}/g
	let m
	while ((m = re.exec(css))) {
		const body = m[2]
		const fam = /font-family:\s*['"]?([^'";]+)/.exec(body)?.[1]?.trim()
		const src = /url\((['"]?)([^)'"]+)\1\)/.exec(body)?.[2]
		if (!fam || !src) continue
		faces.push({
			subset: m[1] ?? '',
			family: fam,
			url: src,
			weight: /font-weight:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? '',
			style: /font-style:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? 'normal',
		})
	}
	if (!faces.length) throw new Error('no @font-face rules in that stylesheet')
	const families = [...new Set(faces.map((f) => f.family))]
	let family = requestedFamily
	if (family) {
		const match = families.find((f) => f.toLowerCase() === family.toLowerCase())
		if (!match) {
			throw new Error(`that stylesheet has: ${families.join(', ')} — put one of those in the name field`)
		}
		family = match
	} else {
		family = families[0]
	}
	const cands = faces.filter((f) => f.family === family)
	const upright = cands.filter((f) => f.style === 'normal')
	const regular = upright.filter((f) => !f.weight || /(^|\s)400(\s|$)|100 900|normal/.test(f.weight))
	const pool = regular.length ? regular : upright.length ? upright : cands
	const pick = pool.find((f) => f.subset === 'latin') ?? pool[0]
	return { family, url: pick.url, format: formatFromUrl(pick.url) ?? 'woff2' }
}

/**
 * Style-picker tooltips: tldraw labels picker buttons via translation keys
 * ("font-style.custom-1"), which have no entry for custom slots and show
 * raw. The translation map is a plain object read at render time, so we
 * write friendly entries into it (hex for colors, family for fonts)
 * whenever the theme changes; the pickers re-render on the same change.
 */
function useClawTheme(editor) {
	const useVal = typeof TL.useValue === 'function' ? TL.useValue : (_name, fn) => fn()
	return useVal(
		'claw theme',
		() => editor.getDocumentSettings?.()?.meta?.clawTheme ?? null,
		[editor]
	)
}

const dialogRowStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }
const dialogHintStyle = { color: 'var(--tl-color-text-3)', fontSize: 11, padding: '4px 0' }

function ColorCustomizeDialog() {
	const editor = TL.useEditor()
	const clawTheme = useClawTheme(editor)
	const colors = clawTheme?.colors ?? {}
	const defined = CUSTOM_COLOR_SLOTS.filter((s) => s in colors)
	// an explicit edit session per slot: live-preview while the native picker
	// is open, then OK keeps the value and Cancel restores `before` (null
	// before = the slot was just added, so Cancel removes it again)
	const [editing, setEditing] = React.useState(null) // {slot, before, isNew, hex}
	const editRef = React.useRef(null) // {slot, timer} for the live input stream

	const endEdit = (keep, ed = editing) => {
		if (!ed) return
		clearTimeout(editRef.current?.timer)
		try {
			if (keep) {
				clawThemePatch(editor, 'colors', ed.slot, ed.hex)
				if (ed.isNew && TL.DefaultColorStyle) {
					editor.setStyleForSelectedShapes?.(TL.DefaultColorStyle, ed.slot)
					editor.setStyleForNextShapes?.(TL.DefaultColorStyle, ed.slot)
				}
			} else {
				clawThemePatch(editor, 'colors', ed.slot, ed.before)
			}
		} catch (err) {
			reportError('edit-color', err)
		}
		editRef.current = null
		setEditing(null)
	}
	const startEdit = (slot, isNew) => {
		if (editing) endEdit(true)
		const hex = isNew ? '#4f6df5' : colorHexOf(colors[slot])
		editRef.current = { slot, timer: null }
		setEditing({ slot, before: isNew ? null : colors[slot], isNew, hex })
		if (isNew) {
			try {
				clawThemePatch(editor, 'colors', slot, hex)
			} catch (err) {
				reportError('add-color', err)
			}
		}
	}
	const onLive = (hex) => {
		// fires per interaction while the native picker is open - always the
		// slot fixed at session start (a new slot per event once filled all
		// slots in one drag), debounced so dragging rethemes the canvas live
		const edit = editRef.current
		if (!edit) return
		setEditing((e) => (e ? { ...e, hex } : e))
		clearTimeout(edit.timer)
		edit.timer = setTimeout(() => {
			try {
				clawThemePatch(editor, 'colors', edit.slot, hex)
			} catch (err) {
				reportError('edit-color', err)
			}
		}, 80)
	}
	return (
		<>
			<TL.TldrawUiDialogHeader>
				<TL.TldrawUiDialogTitle>Custom colors</TL.TldrawUiDialogTitle>
				<TL.TldrawUiDialogCloseButton />
			</TL.TldrawUiDialogHeader>
			<TL.TldrawUiDialogBody style={{ minWidth: 300 }}>
				{defined.length === 0 && (
					<div style={dialogHintStyle}>
						No custom colors yet — add up to {CUSTOM_COLOR_SLOTS.length}. They join the color
						picker for everyone in this canvas.
					</div>
				)}
				{defined.map((slot) => {
					const isEditing = editing?.slot === slot
					const def = colors[slot]
					if (isGradientSlot(def) && !isEditing) {
						// a gradient slot edits in place: two stops and a type, with no
						// native picker session (there is no single colour to preview)
						const patch = (next) => {
							try {
								clawThemePatch(editor, 'colors', slot, { ...def, ...next })
							} catch (err) {
								reportError('edit-gradient', err)
							}
						}
						return (
							<div key={slot} style={dialogRowStyle}>
								<span
									title={`${def.gradient} gradient`}
									style={{
										width: 22,
										height: 22,
										borderRadius: 4,
										background: gradientCss(def),
										border: '1px solid var(--tl-color-muted-1)',
										flexShrink: 0,
									}}
								/>
								<input
									type="color"
									aria-label="gradient start"
									data-testid={`claw-grad-from-${slot}`}
									value={def.from}
									onChange={(e) => patch({ from: e.target.value })}
									style={{ width: 26, height: 22, padding: 0, border: 'none', background: 'none' }}
								/>
								<input
									type="color"
									aria-label="gradient end"
									data-testid={`claw-grad-to-${slot}`}
									value={def.to}
									onChange={(e) => patch({ to: e.target.value })}
									style={{ width: 26, height: 22, padding: 0, border: 'none', background: 'none' }}
								/>
								<TL.TldrawUiButton
									type="normal"
									title="Switch between linear and radial"
									data-testid={`claw-grad-type-${slot}`}
									onClick={() => patch({ gradient: def.gradient === 'radial' ? 'linear' : 'radial' })}
								>
									<TL.TldrawUiButtonLabel>{def.gradient}</TL.TldrawUiButtonLabel>
								</TL.TldrawUiButton>
								<TL.TldrawUiButton
									type="normal"
									title="Back to a single colour"
									data-testid={`claw-grad-solid-${slot}`}
									onClick={() => {
										try {
											clawThemePatch(editor, 'colors', slot, gradientMidpoint(def))
										} catch (err) {
											reportError('edit-gradient', err)
										}
									}}
								>
									<TL.TldrawUiButtonLabel>Solid</TL.TldrawUiButtonLabel>
								</TL.TldrawUiButton>
								<TL.TldrawUiButton
									type="normal"
									title="Shapes using it go grey until it's re-added"
									data-testid={`claw-color-remove-${slot}`}
									onClick={() => {
										try {
											clawThemePatch(editor, 'colors', slot, null)
										} catch (err) {
											reportError('remove-color', err)
										}
									}}
								>
									<TL.TldrawUiButtonLabel>Remove</TL.TldrawUiButtonLabel>
								</TL.TldrawUiButton>
							</div>
						)
					}
					return (
						<div key={slot} style={dialogRowStyle}>
							{isEditing ? (
								<>
									{/* same swatch look as the idle row; the native input is an
									    invisible overlay so the OS picker anchors right here
									    instead of the window corner (and the box keeps its shape) */}
									<span style={{ position: 'relative', width: 22, height: 22, flexShrink: 0 }}>
										<span
											style={{
												position: 'absolute',
												inset: 0,
												borderRadius: 4,
												background: editing.hex,
												border: '1px solid var(--tl-color-muted-1)',
											}}
										/>
										<input
											type="color"
											data-testid="claw-color-input"
											defaultValue={editing.hex}
											// open the OS picker after layout (double rAF) so it
											// anchors to this element's real position - clicking
											// at commit time anchors to 0,0 (top-left)
											ref={(el) => {
												if (el && !el.__clawOpened) {
													el.__clawOpened = true
													requestAnimationFrame(() =>
														requestAnimationFrame(() => {
															try {
																el.click()
															} catch {}
														})
													)
												}
											}}
											onChange={(e) => onLive(e.target.value)}
											style={{
												position: 'absolute',
												inset: 0,
												width: '100%',
												height: '100%',
												opacity: 0,
												padding: 0,
												border: 'none',
												cursor: 'pointer',
											}}
										/>
									</span>
									<span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}>{editing.hex}</span>
									<TL.TldrawUiButton type="primary" data-testid="claw-color-ok" onClick={() => endEdit(true)}>
										<TL.TldrawUiButtonLabel>OK</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
									<TL.TldrawUiButton type="normal" data-testid="claw-color-cancel" onClick={() => endEdit(false)}>
										<TL.TldrawUiButtonLabel>Cancel</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
								</>
							) : (
								<>
									<button
										title={`Edit ${slot}`}
										data-testid={`claw-color-swatch-${slot}`}
										onClick={() => startEdit(slot, false)}
										style={{
											width: 22,
											height: 22,
											borderRadius: 4,
											background: colorHexOf(colors[slot]),
											border: '1px solid var(--tl-color-muted-1)',
											flexShrink: 0,
											cursor: 'pointer',
											padding: 0,
										}}
									/>
									<span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}>
										{colorHexOf(colors[slot])}
									</span>
									<TL.TldrawUiButton
										type="normal"
										data-testid={`claw-color-edit-${slot}`}
										onClick={() => startEdit(slot, false)}
									>
										<TL.TldrawUiButtonLabel>Edit</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
									<TL.TldrawUiButton
										type="normal"
										title="Turn this colour into a gradient"
										data-testid={`claw-color-gradient-${slot}`}
										onClick={() => {
											const from = colorHexOf(colors[slot])
											try {
												clawThemePatch(editor, 'colors', slot, {
													gradient: 'linear',
													from,
													to: mixHex(from, '#ffffff', 0.55),
												})
											} catch (err) {
												reportError('edit-gradient', err)
											}
										}}
									>
										<TL.TldrawUiButtonLabel>Gradient</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
									<TL.TldrawUiButton
										type="normal"
										title="Shapes using it go grey until it's re-added"
										data-testid={`claw-color-remove-${slot}`}
										onClick={() => {
											try {
												clawThemePatch(editor, 'colors', slot, null)
											} catch (err) {
												reportError('remove-color', err)
											}
										}}
									>
										<TL.TldrawUiButtonLabel>Remove</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
								</>
							)}
						</div>
					)
				})}
			</TL.TldrawUiDialogBody>
			<TL.TldrawUiDialogFooter className="tlui-dialog__footer__actions">
				<span style={{ ...dialogHintStyle, marginRight: 'auto' }}>
					{defined.length}/{CUSTOM_COLOR_SLOTS.length} slots used
				</span>
				<TL.TldrawUiButton
					type="primary"
					data-testid="claw-color-add"
					disabled={!!editing || defined.length >= CUSTOM_COLOR_SLOTS.length}
					onClick={() => {
						const free = CUSTOM_COLOR_SLOTS.find((s) => !(s in colors))
						if (free) startEdit(free, true)
					}}
				>
					<TL.TldrawUiButtonLabel>＋ Add color</TL.TldrawUiButtonLabel>
				</TL.TldrawUiButton>
			</TL.TldrawUiDialogFooter>
		</>
	)
}

function ClawColorControls() {
	const dialogs = typeof TL.useDialogs === 'function' ? TL.useDialogs() : null
	if (!dialogs) return null
	return (
		<TL.TldrawUiButton
			type="menu"
			data-testid="claw-customize-colors"
			onClick={() => dialogs.addDialog({ component: ColorCustomizeDialog })}
		>
			<TL.TldrawUiButtonLabel>Customize colors…</TL.TldrawUiButtonLabel>
		</TL.TldrawUiButton>
	)
}

function FontCustomizeDialog() {
	const editor = TL.useEditor()
	const clawTheme = useClawTheme(editor)
	const fonts = clawTheme?.fonts ?? {}
	const defined = CUSTOM_FONT_SLOTS.filter((s) => s in fonts)
	// form: {slot: 'custom-N' (editing) | null (adding), family, url, error, busy}
	const [form, setForm] = React.useState(null)
	const [listOpen, setListOpen] = React.useState(false)
	// full installed-font list where the Local Font Access API exists (needs
	// the user gesture we're inside); curated availability-checked list
	// otherwise - browsers expose nothing more without it
	const [fontOptions, setFontOptions] = React.useState(null)
	const loadOptions = () => {
		if (fontOptions) return
		;(async () => {
			let fams = null
			try {
				if (typeof window.queryLocalFonts === 'function') {
					// race it: without a permission UI (headless, some webviews)
					// the promise can hang forever instead of rejecting
					const local = await Promise.race([
						window.queryLocalFonts(),
						new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
					])
					fams = [...new Set(local.map((f) => f.family))].sort((a, b) => a.localeCompare(b))
				}
			} catch {}
			if (!fams?.length) fams = FONT_CANDIDATES.filter(familyAvailable)
			setFontOptions(fams)
		})()
	}
	const openForm = (init) => {
		setForm(init)
		setListOpen(false)
		loadOptions()
	}
	const familyOk = form?.family.trim() ? stackAvailable(form.family) : null

	const submit = async () => {
		if (!form || form.busy) return
		let family = form.family.trim().replace(/^['"]|['"]$/g, '')
		let url = form.url.trim()
		let format
		if (!family && !url) return
		const slot = form.slot ?? CUSTOM_FONT_SLOTS.find((s) => !(s in fonts))
		if (!slot) {
			window.alert(`All ${CUSTOM_FONT_SLOTS.length} custom font slots are in use`)
			return
		}
		try {
			if (url) {
				setForm({ ...form, busy: true, error: null })
				// people paste Google Fonts CSS links ("css2?family=..."), not
				// font files - resolve those to the actual font-file URL first
				const resolved = await resolveWebfontUrl(url, family)
				family = resolved.family
				url = resolved.url
				format = resolved.format
				// prove the webfont actually loads before committing it
				const face = new FontFace(family, `url("${url}")`)
				await Promise.race([
					face.load(),
					new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 8000)),
				])
				document.fonts.add(face)
			} else if (!stackAvailable(family)) {
				setForm({ ...form, error: 'Not found on this device - pick from the list or add a webfont URL' })
				return
			}
			clawThemePatch(editor, 'fonts', slot, url ? { family, url, ...(format ? { format } : {}) } : family)
			if (form.slot == null && TL.DefaultFontStyle) {
				editor.setStyleForSelectedShapes?.(TL.DefaultFontStyle, slot)
				editor.setStyleForNextShapes?.(TL.DefaultFontStyle, slot)
			}
			setForm(null)
		} catch (err) {
			setForm({ ...form, busy: false, error: `Could not load webfont: ${err?.message ?? err}` })
		}
	}
	const inputKeys = (e) => {
		e.stopPropagation()
		if (e.key === 'Enter') submit()
		if (e.key === 'Escape') setForm(null)
	}
	return (
		<>
			<TL.TldrawUiDialogHeader>
				<TL.TldrawUiDialogTitle>Custom fonts</TL.TldrawUiDialogTitle>
				<TL.TldrawUiDialogCloseButton />
			</TL.TldrawUiDialogHeader>
			<TL.TldrawUiDialogBody style={{ minWidth: 300 }}>
				{defined.length === 0 && !form && (
					<div style={dialogHintStyle}>
						No custom fonts yet — add up to {CUSTOM_FONT_SLOTS.length}. They join the font row
						for everyone in this canvas.
					</div>
				)}
				{defined.map((slot) => (
					<div key={slot} style={dialogRowStyle}>
						<span
							style={{
								fontFamily: fontFamilyOf(fonts[slot]),
								fontSize: 16,
								width: 26,
								textAlign: 'center',
								flexShrink: 0,
							}}
						>
							Aa
						</span>
						<span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
							{fontLabelOf(fonts[slot])}
							{typeof fonts[slot] === 'object' && fonts[slot]?.url ? (
								<span style={{ color: 'var(--tl-color-text-3)' }}> · webfont</span>
							) : null}
						</span>
						<TL.TldrawUiButton
							type="normal"
							data-testid={`claw-font-edit-${slot}`}
							onClick={() =>
								openForm({
									slot,
									family: fontLabelOf(fonts[slot]),
									url: typeof fonts[slot] === 'object' ? (fonts[slot].url ?? '') : '',
									error: null,
									busy: false,
								})
							}
						>
							<TL.TldrawUiButtonLabel>Edit</TL.TldrawUiButtonLabel>
						</TL.TldrawUiButton>
						<TL.TldrawUiButton
							type="normal"
							title="Shapes using it fall back to the default font until it's re-added"
							data-testid={`claw-font-remove-${slot}`}
							onClick={() => {
								try {
									clawThemePatch(editor, 'fonts', slot, null)
								} catch (err) {
									reportError('remove-font', err)
								}
							}}
						>
							<TL.TldrawUiButtonLabel>Remove</TL.TldrawUiButtonLabel>
						</TL.TldrawUiButton>
					</div>
				))}
				{form && (
					<div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0 0' }}>
						<div style={{ fontSize: 12, fontWeight: 600 }}>
							{form.slot ? `Edit ${form.slot}` : 'New font'}
						</div>
						<div style={{ position: 'relative' }}>
							<div style={{ display: 'flex', gap: 4 }}>
								<input
									className="tlui-input"
									placeholder="Font name or CSS stack"
									autoFocus
									value={form.family}
									// open the list on typing, not on focus - focus-open made the
									// dropdown blanket the edit form the instant it appeared
									onChange={(e) => {
										setForm({ ...form, family: e.target.value, error: null })
										setListOpen(true)
									}}
									onKeyDown={(e) => {
										if (e.key === 'Escape' && listOpen) {
											e.stopPropagation()
											setListOpen(false)
											return
										}
										inputKeys(e)
									}}
									style={{ flex: 1, border: '1px solid var(--tl-color-muted-1)', borderRadius: 6, padding: '4px 8px' }}
								/>
								<TL.TldrawUiButton
									type="normal"
									title="Browse fonts"
									data-testid="claw-font-list-toggle"
									onClick={() => setListOpen((o) => !o)}
								>
									<TL.TldrawUiButtonLabel>▾</TL.TldrawUiButtonLabel>
								</TL.TldrawUiButton>
							</div>
							{listOpen && (
								<div
									data-testid="claw-font-options"
									style={{
										position: 'absolute',
										top: '100%',
										left: 0,
										right: 0,
										zIndex: 10,
										marginTop: 2,
										maxHeight: 220,
										overflowY: 'auto',
										background: 'var(--tl-color-panel)',
										border: '1px solid var(--tl-color-muted-1)',
										borderRadius: 6,
										boxShadow: '0 4px 16px rgba(0,0,0,.25)',
									}}
								>
									{(fontOptions ?? []).map((name) => (
										<button
											key={name}
											data-testid="claw-font-option"
											onMouseDown={(e) => {
												e.preventDefault()
												setForm({ ...form, family: name, error: null })
												setListOpen(false)
											}}
											style={{
												display: 'block',
												width: '100%',
												textAlign: 'left',
												padding: '4px 8px',
												border: 'none',
												background: form.family === name ? 'var(--tl-color-muted-2)' : 'transparent',
												color: 'var(--tl-color-text-1)',
												fontFamily: `"${name}"`,
												fontSize: 14,
												cursor: 'pointer',
											}}
										>
											{name}
										</button>
									))}
									{!fontOptions && <div style={{ ...dialogHintStyle, padding: '4px 8px' }}>Loading fonts…</div>}
								</div>
							)}
						</div>
						<input
							className="tlui-input"
							placeholder="Webfont or Google Fonts URL (optional)"
							value={form.url}
							onChange={(e) => setForm({ ...form, url: e.target.value, error: null })}
							onKeyDown={inputKeys}
							style={{ border: '1px solid var(--tl-color-muted-1)', borderRadius: 6, padding: '4px 8px' }}
						/>
						<div style={{ fontSize: 11, color: form.error ? 'var(--tl-color-warning)' : 'var(--tl-color-text-3)', minHeight: 14 }}>
							{form.error ??
								(form.busy
									? 'Loading webfont…'
									: form.url.trim()
										? 'Webfont: renders on every device'
										: familyOk == null
											? 'Pick a font, or type any installed one'
											: familyOk
												? '✓ available on this device (webfont URL renders everywhere)'
												: '⚠ not found on this device')}
						</div>
						<div style={{ display: 'flex', gap: 4 }}>
							<TL.TldrawUiButton
								type="primary"
								data-testid="claw-font-form-confirm"
								disabled={form.busy}
								onClick={submit}
							>
								<TL.TldrawUiButtonLabel>{form.slot ? 'Save' : 'Add'}</TL.TldrawUiButtonLabel>
							</TL.TldrawUiButton>
							<TL.TldrawUiButton type="normal" onClick={() => setForm(null)}>
								<TL.TldrawUiButtonLabel>Cancel</TL.TldrawUiButtonLabel>
							</TL.TldrawUiButton>
						</div>
					</div>
				)}
			</TL.TldrawUiDialogBody>
			<TL.TldrawUiDialogFooter className="tlui-dialog__footer__actions">
				<span style={{ ...dialogHintStyle, marginRight: 'auto' }}>
					{defined.length}/{CUSTOM_FONT_SLOTS.length} slots used
				</span>
				<TL.TldrawUiButton
					type="primary"
					data-testid="claw-font-add"
					disabled={!!form || defined.length >= CUSTOM_FONT_SLOTS.length}
					onClick={() => openForm({ slot: null, family: '', url: '', error: null, busy: false })}
				>
					<TL.TldrawUiButtonLabel>＋ Add font</TL.TldrawUiButtonLabel>
				</TL.TldrawUiButton>
			</TL.TldrawUiDialogFooter>
		</>
	)
}

function ClawFontControls() {
	const dialogs = typeof TL.useDialogs === 'function' ? TL.useDialogs() : null
	if (!dialogs) return null
	return (
		<TL.TldrawUiButton
			type="menu"
			data-testid="claw-customize-fonts"
			onClick={() => dialogs.addDialog({ component: FontCustomizeDialog })}
		>
			<TL.TldrawUiButtonLabel>Customize fonts…</TL.TldrawUiButtonLabel>
		</TL.TldrawUiButton>
	)
}

const PANEL_PARTS = [
	'StylePanelColorPicker', 'StylePanelOpacityPicker', 'StylePanelFillPicker',
	'StylePanelDashPicker', 'StylePanelSizePicker', 'StylePanelFontPicker',
	'StylePanelTextAlignPicker', 'StylePanelLabelAlignPicker',
	'StylePanelGeoShapePicker', 'StylePanelArrowKindPicker',
	'StylePanelArrowheadPicker', 'StylePanelSplinePicker',
]
const HAS_PANEL_PARTS = PANEL_PARTS.every((n) => typeof TL[n] === 'function')

function CustomStylePanel(props) {
	const editor = TL.useEditor()
	const relevant = typeof TL.useRelevantStyles === 'function' ? TL.useRelevantStyles() : undefined
	// capture the live translation map and keep custom-slot tooltip labels
	// fresh (parent renders before the pickers, so they read patched entries)
	const translation = typeof TL.useCurrentTranslation === 'function' ? TL.useCurrentTranslation() : null
	const clawTheme = useClawTheme(editor)
	if (translation?.messages) {
		captureTranslations(translation.messages, clawTheme)
	}
	const colorRelevant = relevant?.get?.(TL.DefaultColorStyle) !== undefined
	const fontRelevant = relevant?.get?.(TL.DefaultFontStyle) !== undefined
	if (!HAS_PANEL_PARTS) {
		// tldraw version drift: stock panel, controls appended at the bottom
		return (
			<TL.DefaultStylePanel {...props}>
				<TL.DefaultStylePanelContent styles={relevant} />
				<div className="tlui-style-panel__section">
					{colorRelevant && <ClawColorControls />}
					{fontRelevant && <ClawFontControls />}
					<ClawTextOutlineControl />
					<ClawCornerRadiusControl />
				</div>
			</TL.DefaultStylePanel>
		)
	}
	return (
		<TL.DefaultStylePanel {...props}>
			<div className="tlui-style-panel__section">
				<TL.StylePanelColorPicker />
				{colorRelevant && <ClawColorControls />}
				<TL.StylePanelOpacityPicker />
			</div>
			<div className="tlui-style-panel__section">
				<TL.StylePanelFillPicker />
				<TL.StylePanelDashPicker />
				<TL.StylePanelSizePicker />
			</div>
			<div className="tlui-style-panel__section">
				<TL.StylePanelFontPicker />
				{fontRelevant && <ClawFontControls />}
				<ClawTextOutlineControl />
				<TL.StylePanelTextAlignPicker />
				<TL.StylePanelLabelAlignPicker />
			</div>
			<div className="tlui-style-panel__section">
				<ClawCornerRadiusControl />
				<TL.StylePanelGeoShapePicker />
				<TL.StylePanelArrowKindPicker />
				<TL.StylePanelArrowheadPicker />
				<TL.StylePanelSplinePicker />
			</div>
		</TL.DefaultStylePanel>
	)
}
/**
 * Per-shape text outline control. tldraw's text halo (six offset text-shadow
 * copies in the background color) is a per-UTIL option (showTextOutline), not
 * a per-shape one. These wrappers read `meta.clawText.outline === 'off'` and
 * flip the util option around the synchronous component()/toSvg() calls, so
 * both the live canvas AND exports honor it. The meta travels with the file
 * and other tldraw editors ignore it. Extensible: clawText is an object so
 * widths/styles can join later.
 */
function withClawTextOutline(Util) {
	return class extends Util {
		component(shape) {
			if (shape.meta?.clawText?.outline !== 'off') return super.component(shape)
			const prev = this.options.showTextOutline
			this.options.showTextOutline = false
			try {
				return super.component(shape)
			} finally {
				this.options.showTextOutline = prev
			}
		}
		toSvg(shape, ctx) {
			if (shape.meta?.clawText?.outline !== 'off') return super.toSvg(shape, ctx)
			const prev = this.options.showTextOutline
			this.options.showTextOutline = false
			try {
				return super.toSvg(shape, ctx)
			} finally {
				this.options.showTextOutline = prev
			}
		}
	}
}
const CLAW_SHAPE_UTILS = [
	withClawGradientExport(withClawTextOutline(TL.TextShapeUtil)),
	withClawGradientExport(
		withClawTextOutline(
			TL.GeoShapeUtil.configure({
				getCustomDisplayValues: (editor, shape) => clawDisplayValues(editor, shape),
				customGeoTypes: Object.fromEntries(
				Object.entries(ROUNDED_GEO_BY_BASE).map(([base, rounded]) => [
					rounded,
					{
						snapType: 'polygon',
						icon: `geo-${base}`,
						getPath: (w, h, shape) =>
							filletedPolygonPath(
								ROUNDABLE_VERTICES[base](w, h),
								Math.max(0, Number(shape.meta?.clawRadius) || 0),
								shape.props.fill !== 'none'
							),
					},
				])
				),
			})
		)
	),
	withClawGradientExport(
		withClawTextOutline(
			TL.ArrowShapeUtil.configure({
				getCustomDisplayValues: (editor, shape) => clawDisplayValues(editor, shape),
			})
		)
	),
	// frames carry a real color prop, but tldraw keeps it off the style system
	// until this option turns it on (it then registers the colour style, so the
	// style panel, the `style` op and claw's custom colour slots all reach it)
	TL.FrameShapeUtil.configure({ showColors: true }),
]

/**
 * Claw draws diagrams, not doodles: shapes start with a solid edge and a sans
 * label rather than tldraw's hand-sketched "draw" styles. Only tldraw's own
 * default is replaced - anything else is a deliberate choice and is left
 * alone. (Agent ops already default the same way.)
 */
function applyClawStyleDefaults(editor) {
	try {
		const swap = [
			[TL.DefaultDashStyle, 'draw', 'solid'],
			[TL.DefaultFontStyle, 'draw', 'sans'],
		]
		for (const [style, tldrawDefault, want] of swap) {
			if (!style) continue
			if (editor.getStyleForNextShape(style) === tldrawDefault) {
				editor.setStyleForNextShapes(style, want)
			}
		}
		// grid on by default. View preferences are saved per document, so this
		// only applies to a canvas with nothing saved yet: turning the grid off
		// is remembered rather than re-forced on every open.
		let seenBefore = false
		try {
			seenBefore = SYNC ? localStorage.getItem(sessionKey()) != null : false
		} catch {}
		if (!seenBefore && !editor.getInstanceState().isGridMode) {
			editor.updateInstanceState({ isGridMode: true })
		}
	} catch (err) {
		reportError('style-defaults', err)
	}
}

// ---- smooth text outline (user preference) ---------------------------------
// tldraw's halo is six stamped copies of the glyphs - lumpy at the diagonals.
// The smooth variant is a real vector stroke painted behind the fill
// (-webkit-text-stroke + paint-order), width zoom-compensated the same way
// tldraw compensates its shadow offsets.
const SMOOTH_TEXT_KEY = 'claw-smooth-text'
function isSmoothText() {
	try {
		return localStorage.getItem(SMOOTH_TEXT_KEY) === '1'
	} catch {
		return false
	}
}
function setSmoothText(editor, on) {
	try {
		localStorage.setItem(SMOOTH_TEXT_KEY, on ? '1' : '0')
	} catch {}
	editor.getContainer()?.classList.toggle('claw-smooth-text', on)
}
function ensureStaticCss() {
	if (document.getElementById('claw-static-css')) return
	const el = document.createElement('style')
	el.id = 'claw-static-css'
	el.textContent = `
.claw-smooth-text .tl-text__outline {
	text-shadow: none !important;
	-webkit-text-stroke: calc(min(0.5, 1 / var(--tl-zoom, 1)) * 4px) var(--tl-color-background);
	paint-order: stroke fill;
}
`
	document.head.appendChild(el)
}

/** Corner rounding for the selected boxes (px), beside the style pickers. */
function ClawCornerRadiusControl() {
	const editor = TL.useEditor()
	const useVal = typeof TL.useValue === 'function' ? TL.useValue : (_n, fn) => fn()
	const state = useVal(
		'claw corner radius',
		() => {
			const boxes = editor
				.getSelectedShapes()
				.filter((s) => s.type === 'geo' && (ROUNDED_GEO_BY_BASE[s.props.geo] || BASE_GEO_BY_ROUNDED[s.props.geo]))
			if (!boxes.length) return null
			return { radius: Math.round(Number(boxes[0].meta?.clawRadius) || 0) }
		},
		[editor]
	)
	if (!state) return null
	const setRadius = (value) => {
		const radius = Math.max(0, Math.min(200, Math.round(value)))
		const boxes = editor
			.getSelectedShapes()
			.filter((s) => s.type === 'geo' && (ROUNDED_GEO_BY_BASE[s.props.geo] || BASE_GEO_BY_ROUNDED[s.props.geo]))
		editor.updateShapes(
			boxes.map((s) => {
				const base = BASE_GEO_BY_ROUNDED[s.props.geo] ?? s.props.geo
				return {
					id: s.id,
					type: 'geo',
					meta: { ...s.meta, clawRadius: radius },
					props: { geo: radius ? ROUNDED_GEO_BY_BASE[base] : base },
				}
			})
		)
	}
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 8px' }}>
			<span style={{ fontSize: 11, color: 'var(--tl-color-text-3)', minWidth: 52 }}>Corners</span>
			<input
				type="range"
				min="0"
				max="60"
				step="1"
				value={state.radius}
				data-testid="claw-corner-radius"
				onChange={(e) => setRadius(Number(e.target.value))}
				style={{ flex: 1, minWidth: 0 }}
			/>
			<span style={{ fontSize: 11, minWidth: 22, textAlign: 'right' }}>{state.radius}</span>
		</div>
	)
}

/** "Text outline: on/off" toggle for the selection, next to the style pickers. */
function ClawTextOutlineControl() {
	const editor = TL.useEditor()
	const useVal = typeof TL.useValue === 'function' ? TL.useValue : (_n, fn) => fn()
	const state = useVal(
		'claw text outline',
		() => {
			const shapes = editor
				.getSelectedShapes()
				.filter((s) => s.type === 'text' || s.type === 'geo' || s.type === 'arrow')
			if (!shapes.length) return null
			return {
				allOff: shapes.every((s) => s.meta?.clawText?.outline === 'off'),
			}
		},
		[editor]
	)
	if (!state) return null
	const toggle = () => {
		const shapes = editor
			.getSelectedShapes()
			.filter((s) => s.type === 'text' || s.type === 'geo' || s.type === 'arrow')
		const next = state.allOff ? 'on' : 'off'
		editor.updateShapes(
			shapes.map((s) => ({
				id: s.id,
				type: s.type,
				meta: { ...s.meta, clawText: { ...(s.meta?.clawText ?? {}), outline: next } },
			}))
		)
	}
	const Icon = TL.TldrawUiIcon
	return (
		<TL.TldrawUiButton
			type="normal"
			data-testid="claw-text-outline"
			onClick={toggle}
			title="Toggle the text outline (background halo) for the selected shapes"
			style={{ justifyContent: 'flex-start', gap: 6 }}
		>
			{Icon ? (
				<Icon small icon={state.allOff ? 'toggle-off' : 'toggle-on'} label="Text outline" />
			) : null}
			<span style={{ fontSize: 11 }}>Text outline</span>
		</TL.TldrawUiButton>
	)
}

/**
 * Name a download after the canvas it came from. A live room's id is the
 * base64url of the file's absolute path, so the .tldr's own filename is
 * recoverable here; standalone documents fall back to their document name.
 */
function canvasBaseName(editor) {
	try {
		const room = new URLSearchParams(location.search).get('room') ??
			(location.pathname.startsWith('/f/') ? location.pathname.slice(3).split('/')[0] : null)
		if (room) {
			const path = atob(room.replace(/-/g, '+').replace(/_/g, '/'))
			const leaf = path.split(/[\\/]/).pop()
			if (leaf) return leaf.replace(/\.tldr$/i, '').replace(/[^\w.-]+/g, '-') || 'canvas'
		}
	} catch {}
	const named = (editor.getDocumentSettings?.()?.name ?? '').trim()
	return (named || 'canvas').replace(/\.tldr$/i, '').replace(/[^\w.-]+/g, '-') || 'canvas'
}

/**
 * "SVG for Figma" in the Export submenu, beside tldraw's own SVG and PNG
 * items. Figma ignores the <foreignObject> elements tldraw puts text in, so
 * this runs the same conversion `claw export` uses and downloads the result.
 */
function ClawFigmaExportItem() {
	const editor = TL.useEditor()
	const [busy, setBusy] = React.useState(false)
	const run = async () => {
		if (busy) return
		setBusy(true)
		try {
			const { svg } = await window.host.exportSvg({ figmaText: true })
			const file = new File([svg], `${canvasBaseName(editor)}.figma.svg`, { type: 'image/svg+xml' })
			TL.downloadFile(file)
		} catch (err) {
			reportError('figma export', err)
		} finally {
			setBusy(false)
		}
	}
	return (
		<TL.TldrawUiMenuItem
			id="claw-export-figma"
			label="claw.export-figma"
			readonlyOk
			disabled={busy}
			onSelect={run}
		/>
	)
}

/** Export submenu rebuilt so the Figma item sits with the other export items. */
function ClawExportSubmenu() {
	const actions = typeof TL.useActions === 'function' ? TL.useActions() : {}
	if (!actions['export-all-as-svg'] && !actions['export-all-as-png']) return null
	return (
		<TL.TldrawUiMenuSubmenu id="export-all-as" label="context-menu.export-all-as" size="small">
			<TL.TldrawUiMenuGroup id="export-all-as-group">
				<TL.TldrawUiMenuActionItem actionId="export-all-as-svg" />
				<TL.TldrawUiMenuActionItem actionId="export-all-as-png" />
				<ClawFigmaExportItem />
			</TL.TldrawUiMenuGroup>
			<TL.TldrawUiMenuGroup id="export-all-as-bg">
				<TL.ToggleTransparentBgMenuItem />
			</TL.TldrawUiMenuGroup>
		</TL.TldrawUiMenuSubmenu>
	)
}

// main menu: the default menu rebuilt so the smooth-text checkbox sits INSIDE
// the Preferences submenu with the other view preferences
// components may be plain functions OR React.memo/forwardRef wrappers
// (objects) - DefaultMainMenu is memo-wrapped, so a typeof-function check
// wrongly falls back to the stock menu
const isComponent = (v) => v != null && (typeof v === 'function' || typeof v === 'object')
const HAS_MENU_PARTS = [
	'DefaultMainMenu', 'EditSubmenu', 'ViewSubmenu', 'ExportFileContentSubMenu',
	'ExtrasGroup', 'ToggleSnapModeItem', 'ToggleToolLockItem', 'ToggleGridItem',
	'ToggleWrapModeItem', 'ToggleFocusModeItem', 'ToggleEdgeScrollingItem',
	'ToggleDynamicSizeModeItem', 'TogglePasteAtCursorItem', 'ToggleDebugModeItem',
	'AccessibilityMenu', 'InputModeMenu', 'ColorSchemeMenu', 'LanguageMenu',
	'TldrawUiMenuGroup', 'TldrawUiMenuSubmenu', 'TldrawUiMenuCheckboxItem',
	'TldrawUiMenuItem', 'TldrawUiMenuActionItem', 'ToggleTransparentBgMenuItem',
].every((k) => isComponent(TL[k]))

function ClawMainMenu() {
	const editor = TL.useEditor()
	const translation = typeof TL.useCurrentTranslation === 'function' ? TL.useCurrentTranslation() : null
	if (translation?.messages) {
		translation.messages['claw.smooth-text'] = 'Smooth text outline'
		translation.messages['claw.export-figma'] = 'SVG for Figma'
	}
	const [smooth, setSmooth] = React.useState(isSmoothText)
	const toggle = () => {
		const next = !smooth
		setSmooth(next)
		setSmoothText(editor, next)
	}
	if (!HAS_MENU_PARTS) {
		// tldraw version drift: stock menu plus claw's items at the bottom
		return (
			<TL.DefaultMainMenu>
				<TL.DefaultMainMenuContent />
				<TL.TldrawUiMenuGroup id="claw">
					<ClawFigmaExportItem />
					<TL.TldrawUiMenuCheckboxItem
						id="claw-smooth-text"
						toggle
						readonlyOk
						checked={smooth}
						onSelect={toggle}
						label="claw.smooth-text"
					/>
				</TL.TldrawUiMenuGroup>
			</TL.DefaultMainMenu>
		)
	}
	return (
		<TL.DefaultMainMenu>
			<TL.EditSubmenu />
			<TL.ViewSubmenu />
			<ClawExportSubmenu />
			<TL.ExtrasGroup />
			<TL.TldrawUiMenuGroup id="preferences">
				<TL.TldrawUiMenuSubmenu id="preferences" label="menu.preferences">
					<TL.TldrawUiMenuGroup id="preferences-actions">
						<TL.ToggleSnapModeItem />
						<TL.ToggleToolLockItem />
						<TL.ToggleGridItem />
						<TL.ToggleWrapModeItem />
						<TL.ToggleFocusModeItem />
						<TL.ToggleEdgeScrollingItem />
						<TL.ToggleDynamicSizeModeItem />
						<TL.TogglePasteAtCursorItem />
						<TL.ToggleDebugModeItem />
						<TL.TldrawUiMenuCheckboxItem
							id="claw-smooth-text"
							toggle
							readonlyOk
							checked={smooth}
							onSelect={toggle}
							label="claw.smooth-text"
						/>
					</TL.TldrawUiMenuGroup>
					<TL.TldrawUiMenuGroup id="user-interface-submenus">
						<TL.AccessibilityMenu />
						<TL.InputModeMenu />
						<TL.ColorSchemeMenu />
					</TL.TldrawUiMenuGroup>
				</TL.TldrawUiMenuSubmenu>
				<TL.LanguageMenu />
			</TL.TldrawUiMenuGroup>
		</TL.DefaultMainMenu>
	)
}

const APP_COMPONENTS = { StylePanel: CustomStylePanel, MainMenu: ClawMainMenu }

function StandaloneApp() {
	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw onMount={onMount} components={APP_COMPONENTS} themes={CLAW_THEMES} shapeUtils={CLAW_SHAPE_UTILS} />
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
			<Tldraw store={store} onMount={onMount} components={APP_COMPONENTS} themes={CLAW_THEMES} shapeUtils={CLAW_SHAPE_UTILS} />
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
