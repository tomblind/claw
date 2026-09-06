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
import {
	anchorParent,
	installLiveAnchors,
	localBox,
	presetRule,
	resolveAnchorReport,
	resolveContainer,
	ruleOf,
	ruleText,
} from './anchors.js'
import { canvasBg, editorBg, mixHex, reportError } from './common.js'
import { foreignObjectTextToSvgText } from './figma-svg.js'
import { filletedPolygonPath, ROUNDABLE_VERTICES } from './rounded.js'
import { containingFrame, lintDocument, shapePlaintext } from './lint.js'
import { overlayLabelOf, plainText, resolveShape, round, short } from './editor-utils.js'
import { projectDocument } from './projection.js'
import { ClawColorControls, ClawFontControls } from './dialogs.jsx'
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
	useClawTheme,
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

/**
 * Serialize the document to .tldr text with tldraw's own writer.
 *
 * memory -> file: custom style slots are swapped for standard fallbacks plus
 * meta.clawStyle, so the saved file opens in any tldraw editor. No catch here:
 * writing custom-N to disk would silently break that guarantee.
 */
async function serializeDocument(editor) {
	const text = await TL.serializeTldrawJson(editor)
	const file = JSON.parse(text)
	if (Array.isArray(file.records)) extractCustomStyles(file.records)
	return JSON.stringify(file)
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
	const rule = ruleOf(s)
	return {
		id: s.id,
		type: s.type,
		name: s.meta?.clawName ?? s.props?.name ?? null,
		text: shapePlaintext(editor, s) || null,
		frame: frame ? frame.props?.name || frame.id.slice(6, 14) : null,
		anchor: rule ? { text: ruleText(rule, s), rule } : null,
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
	/**
	 * What an EMPTY document serializes to, captured here at mount while the
	 * editor is provably still empty. `new` builds every fresh canvas from it.
	 *
	 * It must not be captured later, on demand: the core asks for it when the
	 * executor connects, and an executor reconnects with its document intact
	 * whenever the core restarts while the app window stays open (`claw stop`,
	 * or the deploy cycle). Serializing at that moment captured whatever canvas
	 * was last loaded, and every subsequent `claw new` silently wrote those
	 * shapes into the new file.
	 */
	const emptyTemplate = serializeDocument(editor).catch(() => null)
	window.host = {
		/** The empty-document template, captured at mount. See above. */
		async emptyTemplate() {
			return await emptyTemplate
		},

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
			return await serializeDocument(editor)
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

		/**
		 * Resolve anchored shapes and report the boxes, optionally at container
		 * sizes the document does not currently have. This is the cheap way to
		 * check a responsive layout: text, not a render, and nothing is written
		 * back (the executor reloads the document for the next call).
		 */
		async resolveAnchors({ container = null, sizes = [] } = {}) {
			const target = container ? resolveShape(editor, String(container)) : null
			return resolveAnchorReport(editor, { container: target, sizes })
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
		} else {
			// Human editing only: the op path resolves anchors itself, and a
			// second resolver running inside the executor would fight it.
			installLiveAnchors(editor)
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
					<ClawAnchorControls />
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
			<div className="tlui-style-panel__section">
				<ClawAnchorControls />
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
/**
 * A shape whose size is decided by an anchor rule cannot be resized by hand.
 *
 * There is no single right answer to what a drag should change: on a stretch
 * axis it has to land in the size offset, which then grows oddly with the
 * parent, and on a fitted axis the cap can undo it the moment it is applied.
 * Rather than pick one and be wrong half the time, the handles are withdrawn
 * and the numbers in the panel are the way to change a size.
 *
 * Moving is untouched, because a drag there has exactly one meaning: it moves
 * the position offset, and nothing else in the rule has to change.
 *
 * This only withdraws the interactive handles. The resolver, the `resize` op
 * and `claw layout` all write through updateShape, which does not consult it.
 */
function withAnchorLock(Util) {
	return class extends Util {
		canResize(shape) {
			return shape?.meta?.clawAnchor ? false : super.canResize(shape)
		}
	}
}

const CLAW_SHAPE_UTILS = [
	withAnchorLock(withClawGradientExport(withClawTextOutline(TL.TextShapeUtil))),
	withAnchorLock(
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
	withAnchorLock(TL.FrameShapeUtil.configure({ showColors: true })),
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

// ---- smooth text outline (user preference, on by default) ------------------
// tldraw's halo is six stamped copies of the glyphs - lumpy at the diagonals.
// The smooth variant is a real vector stroke painted behind the fill
// (-webkit-text-stroke + paint-order), width zoom-compensated the same way
// tldraw compensates its shadow offsets.
//
// Claw defaults to the smooth outline, so only an explicit '0' turns it off.
// That keeps the choice of anyone who already switched it off, and it applies
// to the headless executor too, so an agent's render matches the canvas.
const SMOOTH_TEXT_KEY = 'claw-smooth-text'
function isSmoothText() {
	try {
		return localStorage.getItem(SMOOTH_TEXT_KEY) !== '0'
	} catch {
		return true
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
/* The anchor controls live in the ~150px style panel, so the number fields
   have to give up their spinner arrows: the arrows alone are wider than the
   space a three-character value needs. */
.claw-anchor input {
	appearance: textfield;
	-moz-appearance: textfield;
	min-width: 0;
	font-size: 11px;
	padding: 1px 3px;
	/* right-aligned so the digits line up down the column, and narrow: the
	   panel is ~150px and two of these share a row with two glyphs */
	text-align: right;
	flex: 0 0 36px;
	width: 36px;
	background: var(--tl-color-panel);
	color: var(--tl-color-text-1);
	border: 1px solid var(--tl-color-muted-1);
	border-radius: 4px;
}
.claw-anchor input::-webkit-outer-spin-button,
.claw-anchor input::-webkit-inner-spin-button {
	appearance: none;
	margin: 0;
}
.claw-anchor select {
	min-width: 0;
	width: 100%;
	font-size: 11px;
	padding: 1px 2px;
	background: var(--tl-color-panel);
	color: var(--tl-color-text-1);
	border: 1px solid var(--tl-color-muted-1);
	border-radius: 4px;
}
.claw-anchor button {
	font-size: 11px;
	padding: 2px 4px;
	cursor: pointer;
	background: var(--tl-color-panel);
	color: var(--tl-color-text-1);
	border: 1px solid var(--tl-color-muted-1);
	border-radius: 4px;
}
.claw-anchor button:hover { background: var(--tl-color-muted-2); }
.claw-anchor-key {
	font-size: 11px;
	color: var(--tl-color-text-1);
	text-align: center;
	flex: 0 0 12px;
}
.claw-anchor-icon {
	font-size: 11px;
	color: var(--tl-color-text-3);
	text-align: center;
	flex: 0 0 14px;
	cursor: help;
}
/* the Fixed Text switch */
.claw-anchor-switch {
	position: relative;
	width: 34px;
	height: 18px;
	border-radius: 9px;
	background: var(--tl-color-muted-1);
	border: none;
	padding: 0;
	flex: 0 0 auto;
	transition: background 120ms;
}
.claw-anchor-switch[data-on='true'] { background: var(--tl-color-selected); }
.claw-anchor-switch::after {
	content: '';
	position: absolute;
	top: 2px;
	left: 2px;
	width: 14px;
	height: 14px;
	border-radius: 50%;
	background: var(--tl-color-panel);
	transition: transform 120ms;
}
.claw-anchor-switch[data-on='true']::after { transform: translateX(16px); }
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

/**
 * One number field in the anchor rows.
 *
 * It keeps what you typed while you type it. A plain controlled number input
 * cannot: an intermediate value like "-" or "." is reported as an empty
 * string, so committing on every keystroke wrote 0 and re-rendered the field
 * out from under you, which made a negative offset impossible to enter. The
 * draft holds the raw text, only parseable values reach the rule, and blur
 * discards anything that never became a number.
 */
function AnchorNumber({ value, step, title, testId, onCommit }) {
	const [draft, setDraft] = React.useState(null)
	const shown = draft ?? (value ?? '')
	return (
		<input
			type="text"
			inputMode="decimal"
			step={step}
			title={title}
			value={shown}
			placeholder="0"
			data-testid={testId}
			onChange={(e) => {
				const raw = e.target.value
				setDraft(raw)
				if (/^-?(\d+\.?\d*|\.\d+)$/.test(raw)) onCommit(Number(raw))
			}}
			onBlur={() => setDraft(null)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') e.currentTarget.blur()
			}}
		/>
	)
}

/**
 * Responsive anchors in the style panel.
 *
 * Layout follows design/claw-responsive-objects.tldr ("Toolbar Additions"):
 * the three position numbers are shared rows at the top, each carrying its x
 * and y, then one section per axis for what decides that axis's size. Only
 * the fields the selected mode reads are shown, so the section is two rows for
 * stretch and one for fixed or aspect.
 *
 * Single-letter keys and small glyphs, because the panel is ~150px wide and
 * every label costs space a number needs; what each one means lives in its
 * tooltip.
 */
const MODE_OPTIONS = [
	['fixed', 'Fixed'],
	['stretch', 'Stretch'],
	['shrink', 'Shrink'],
	['aspect', 'Aspect'],
]
/**
 * Glyph, label and step per size field. The glyphs are the project's agreed
 * symbol set (design/claw-responsive-objects.tldr), and the label is the whole
 * tooltip: the panel is a reference for someone who already knows the model,
 * not a place to explain it.
 */
const SIZE_FIELDS = {
	percent: ['⟜', 'Percent', 0.05],
	sizeOffset: ['⇥', 'Size Offset', 1],
	size: ['↔', 'Size', 1],
	ratio: ['x', 'Ratio', 0.05],
}
/**
 * Which field sits in which slot, per mode: a fixed grid of rows and columns
 * so a field never moves when the mode changes. `null` leaves a slot empty and
 * a row with nothing in it is dropped, which is what keeps a mode down to the
 * fields it actually reads.
 */
const SIZE_SLOTS = {
	fixed: [[null, null], [null, 'size'], [null, null]],
	stretch: [['percent', 'sizeOffset'], [null, null], [null, null]],
	shrink: [['percent', 'sizeOffset'], [null, 'size'], [null, null]],
	aspect: [[null, null], [null, null], [null, 'ratio']],
}
/** The three shared position rows: glyph, field, label, step. */
const POSITION_ROWS = [
	['⌖', 'anchor', 'Anchor', 0.05],
	['⊙', 'pivot', 'Pivot', 0.05],
	['⇲', 'offset', 'Offset', 1],
]

function ClawAnchorControls() {
	const editor = TL.useEditor()
	const useVal = typeof TL.useValue === 'function' ? TL.useValue : (_n, fn) => fn()
	const state = useVal(
		'claw anchors',
		() => {
			const shapes = editor.getSelectedShapes().filter((s) => anchorParent(editor, s))
			if (!shapes.length) return null
			return {
				count: shapes.length,
				allDynamic: shapes.every((s) => ruleOf(s)),
				rule: shapes.length === 1 ? ruleOf(shapes[0]) : null,
				// the text switch only means something for a shape that HAS text:
				// its own, or the separate overlay label a fixed-size box carries
				hasText: shapes.some(
					(s) => s.type === 'text' || !!overlayLabelOf(editor, s) || !!shapePlaintext(editor, s)
				),
			}
		},
		[editor]
	)
	// nothing selected that sits inside a screen: a rule would have no parent
	// box to follow, so the control would only mislead
	if (!state) return null

	const eligible = () => editor.getSelectedShapes().filter((s) => anchorParent(editor, s))
	const write = (shape, rule) => {
		const parent = anchorParent(editor, shape)
		if (!parent) return
		editor.updateShape({
			id: shape.id,
			type: shape.type,
			meta: { ...(shape.meta ?? {}), clawAnchor: rule },
		})
		resolveContainer(editor, parent, { apply: true })
	}
	/**
	 * Turning it on starts from the box the author already drew, pinned where
	 * it sits: the shape does not move, and every rule from there is a matter
	 * of changing a mode or a number. Turning it off drops the rule.
	 */
	const toggleDynamic = () => {
		const turnOn = !state.allDynamic
		editor.run(() => {
			for (const shape of eligible()) {
				if (!turnOn) {
					write(shape, null)
					continue
				}
				if (ruleOf(shape)) continue
				const parent = anchorParent(editor, shape)
				if (parent) write(shape, presetRule(editor, shape, parent, 'fixed'))
			}
		})
	}
	const patchAxis = (axis, field, value) => {
		editor.run(() => {
			for (const shape of eligible()) {
				const rule = ruleOf(shape)
				if (!rule) continue
				const next = { ...(rule[axis] ?? {}), [field]: value }
				// Seed the number a mode needs from the box as drawn, so switching
				// mode is never a silent no-op waiting for a second edit.
				if (field === 'mode') {
					const b = localBox(editor, shape)
					const size = axis === 'x' ? b.w : b.h
					const other = axis === 'x' ? b.h : b.w
					if ((value === 'fixed' || value === 'shrink') && !(next.size > 0)) {
						next.size = Math.round(size)
					}
					if (value === 'aspect' && !(next.ratio > 0)) {
						next.ratio = other > 0 ? Math.round((size / other) * 100) / 100 : 1
					}
				}
				write(shape, { ...rule, [axis]: next })
			}
		})
	}
	const setTextMode = () => {
		editor.run(() => {
			for (const shape of eligible()) {
				const rule = ruleOf(shape)
				if (!rule) continue
				write(shape, { ...rule, text: rule.text === 'fixed' ? 'scale' : 'fixed' })
			}
		})
	}

	const Icon = TL.TldrawUiIcon
	const rule = state.rule
	const rowStyle = { display: 'flex', alignItems: 'center', gap: 3, padding: '1px 0' }
	const num = (axis, field, step, title) => {
		const a = rule?.[axis] ?? {}
		return (
			<AnchorNumber
				key={`${axis}-${field}`}
				value={a[field]}
				step={step}
				title={title}
				testId={`claw-anchor-${axis}-${field}`}
				onCommit={(v) => patchAxis(axis, field, v)}
			/>
		)
	}
	// one row per position number, carrying both axes
	const positionRow = ([glyph, field, label, step]) => (
		<div key={field} style={rowStyle}>
			<span className="claw-anchor-icon" title={label}>
				{glyph}
			</span>
			<span className="claw-anchor-key" title={label}>
				x
			</span>
			{num('x', field, step, label)}
			<span style={{ flex: 1 }} />
			<span className="claw-anchor-key" title={label}>
				y
			</span>
			{num('y', field, step, label)}
		</div>
	)
	const axisSection = (axis) => {
		const a = rule?.[axis] ?? {}
		const mode = a.mode ?? 'stretch'
		const other = rule?.[axis === 'x' ? 'y' : 'x'] ?? {}
		// the flag can only do something against an aspect partner, and a
		// checkbox that cannot act is worse than no checkbox
		const canFit =
			(mode === 'stretch' || mode === 'shrink') && other.mode === 'aspect' && other.ratio > 0
		return (
			<div key={axis} style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4 }}>
				<div style={{ fontSize: 10, color: 'var(--tl-color-text-3)' }}>
					{axis === 'x' ? 'Width' : 'Height'}
				</div>
				<div style={rowStyle}>
					<select
						value={mode}
						title="Size Mode"
						data-testid={`claw-anchor-${axis}-mode`}
						onChange={(e) => patchAxis(axis, 'mode', e.target.value)}
					>
						{MODE_OPTIONS.map(([v, label]) => (
							<option key={v} value={v}>
								{label}
							</option>
						))}
					</select>
				</div>
				{SIZE_SLOTS[mode].map((slots, i) =>
					slots.some(Boolean) ? (
						<div key={`size${i}`} style={rowStyle}>
							{slots.map((field, col) => {
								if (!field) return <span key={col} style={{ flex: 1 }} />
								const [glyph, tip, step] = SIZE_FIELDS[field]
								return (
									<React.Fragment key={col}>
										<span className="claw-anchor-icon" title={tip}>
											{glyph}
										</span>
										{num(axis, field, step, tip)}
										{col === 0 && <span style={{ flex: 1 }} />}
									</React.Fragment>
								)
							})}
						</div>
					) : null
				)}
				{canFit && (
					<div style={rowStyle}>
						<input
							type="checkbox"
							checked={a.fit === true}
							title="Aspect Fit"
							data-testid={`claw-anchor-${axis}-fit`}
							onChange={(e) => patchAxis(axis, 'fit', e.target.checked)}
							style={{ margin: 0 }}
						/>
						<span style={{ fontSize: 11 }}>Fit</span>
						<span style={{ flex: 1 }} />
						{a.fit === true && (
							<>
								<span className="claw-anchor-icon" title="Aspect Size Offset">
									{'⇥'}
								</span>
								{num(axis, 'fitOffset', 1, 'Aspect Size Offset')}
							</>
						)}
					</div>
				)}
			</div>
		)
	}

	return (
		<div className="claw-anchor" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
			<TL.TldrawUiButton
				type="normal"
				data-testid="claw-anchor-dynamic"
				onClick={toggleDynamic}
				title="Follow the screen when it is resized"
				style={{ justifyContent: 'flex-start', gap: 6 }}
			>
				{Icon ? (
					<Icon small icon={state.allDynamic ? 'toggle-on' : 'toggle-off'} label="Dynamic Layout" />
				) : null}
				<span style={{ fontSize: 11 }}>Dynamic Layout</span>
			</TL.TldrawUiButton>
			{rule && state.count === 1 && (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 8px 2px' }}>
					{POSITION_ROWS.map(positionRow)}
					{axisSection('x')}
					{axisSection('y')}
				</div>
			)}
			{state.allDynamic && state.hasText && (
				<TL.TldrawUiButton
					type="normal"
					data-testid="claw-anchor-text-fixed"
					onClick={setTextMode}
					title="Keep the text at its authored size and let it re-wrap, instead of scaling it with the box"
					style={{ justifyContent: 'flex-start', gap: 6 }}
				>
					{Icon ? (
						<Icon small icon={rule?.text === 'fixed' ? 'toggle-on' : 'toggle-off'} label="Fixed Text" />
					) : null}
					<span style={{ fontSize: 11 }}>Fixed Text</span>
				</TL.TldrawUiButton>
			)}
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
