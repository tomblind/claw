// Feature regression suite: the op vocabulary, the claw-only concepts
// (rounded shapes, colour/font slots, gradients, text outline) and the file
// boundary that keeps them portable.
//
// usage: node features-e2e.mjs        (uses the running app, or starts it)
//
// Three sections, in cost order:
//   1. in-page   - one browser, one document, pure editor assertions
//   2. file      - portability round trips through real .tldr text
//   3. live room - a synced canvas, the ONLY place record validation runs
//
// Section 3 exists because a claw-only enum value has to be registered in the
// editor page AND the sync room's schema; a standalone test cannot catch the
// mismatch, and shipping one disconnected every client with INVALID_RECORD.
import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { findBrowser } from './lib/browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TMP = process.env.TEMP ?? '/tmp'
const PAGE = `file:///${join(here, 'page', 'dist', 'index.html').replace(/\\/g, '/')}`

const results = []
let failures = 0
const check = (name, ok, detail = '') => {
	results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
	if (!ok) {
		failures++
		process.exitCode = 1
	}
}
const claw = (...args) =>
	execFileSync(process.execPath, [join(here, 'claw.mjs'), ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})

const GRADIENT = { gradient: 'linear', from: '#7c3aed', to: '#22d3ee' }
const RADIAL = { gradient: 'radial', from: '#4ade80', to: '#0369a1' }
const CONVEX = [
	'rectangle', 'triangle', 'diamond', 'pentagon',
	'hexagon', 'octagon', 'rhombus', 'rhombus-2', 'trapezoid',
]

const browser = await chromium.launch({ executablePath: findBrowser(), headless: true })

// ---------------------------------------------------------------------------
// 1. in-page: op semantics and paint, asserted from editor state
// ---------------------------------------------------------------------------
{
	const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
	const pageErrors = []
	page.on('pageerror', (e) => pageErrors.push(String(e.message)))
	await page.goto(PAGE)
	await page.waitForFunction(() => !!window.__editor, null, { timeout: 30000 })

	const out = await page.evaluate(
		async ({ GRADIENT, RADIAL, CONVEX }) => {
			const ed = window.__editor
			const named = (n) => ed.getCurrentPageShapes().find((s) => s.meta?.clawName === n)
			const wait = (ms) => new Promise((r) => setTimeout(r, ms))
			const res = {}

			// --- z-order ---------------------------------------------------------
			await window.host.applyOps([
				{ add_screen: { name: 'Z', size: { w: 600, h: 400 } } },
				...['A', 'B', 'C'].map((n, i) => ({
					add: { screen: 'Z', kind: 'box', name: n, at: { x: 20 + i * 40, y: 20 } },
				})),
			])
			const frame = ed.getCurrentPageShapes().find((s) => s.type === 'frame')
			const stack = () =>
				ed
					.getSortedChildIdsForParent(frame.id)
					.map((id) => ed.getShape(id)?.meta?.clawName)
					.filter(Boolean)
					.join('')
			res.orderInitial = stack()
			await window.host.applyOps([{ order: { id: 'A', to: 'front' } }])
			res.orderFront = stack()
			await window.host.applyOps([{ order: { id: 'A', to: 'back' } }])
			res.orderBack = stack()
			await window.host.applyOps([{ order: { id: 'A', to: 'above', ref: 'B' } }])
			res.orderAbove = stack()

			// --- rotate: angles, and the centre must not drift -------------------
			const centre = (n) => {
				const b = ed.getShapePageBounds(named(n).id)
				return `${Math.round(b.center.x)},${Math.round(b.center.y)}`
			}
			const deg = (n) => Math.round((((named(n).rotation ?? 0) * 180) / Math.PI) * 10) / 10
			const c0 = centre('A')
			await window.host.applyOps([{ rotate: { id: 'A', by: 15 } }])
			await window.host.applyOps([{ rotate: { id: 'A', by: 15 } }])
			res.rotateAccumulated = deg('A')
			await window.host.applyOps([{ rotate: { id: 'A', to: 90 } }])
			res.rotateAbsolute = deg('A')
			res.rotateCentreHeld = centre('A') === c0
			await window.host.applyOps([{ rotate: { id: 'A', to: 0 } }])

			// --- text formatting -------------------------------------------------
			await window.host.applyOps([
				{ add: { screen: 'Z', kind: 'label', name: 'T', text: 'Score 1200 of 1200', at: { x: 20, y: 200 } } },
				{ format: { id: 'T', match: '1200', bold: true } },
				{ format: { id: 'T', match: '1200', italic: true, all: true } },
			])
			const runs = () => {
				const doc = named('T').props.richText
				const acc = []
				const walk = (node) => {
					for (const c of node.content ?? []) {
						if (c.type === 'text') acc.push(`${c.text}[${(c.marks ?? []).map((m) => m.type).join('+')}]`)
						else walk(c)
					}
				}
				walk(doc)
				return acc.join(' ')
			}
			res.formatRuns = runs()
			await window.host.applyOps([{ format: { id: 'T', clear: true } }])
			res.formatCleared = runs()

			// --- rounded corners on every convex shape ---------------------------
			const rounded = []
			for (const geo of CONVEX) {
				await window.host.applyOps([
					{ add: { screen: 'Z', kind: 'box', name: `g-${geo}`, at: { x: 300, y: 20 }, size: { w: 120, h: 100 } } },
					{ style: { id: `g-${geo}`, geo, radius: 18 } },
				])
				const s = named(`g-${geo}`)
				const verts = ed.getShapeGeometry(s.id)?.vertices ?? []
				rounded.push({
					geo,
					applied: s.props.geo,
					radius: s.meta.clawRadius,
					points: verts.length,
					finite: verts.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y)),
				})
			}
			res.rounded = rounded
			// an absurd radius must degrade, not self-intersect or go non-finite
			await window.host.applyOps([{ style: { id: 'g-triangle', radius: 400 } }])
			const wild = ed.getShapeGeometry(named('g-triangle').id)?.vertices ?? []
			res.extremeRadiusSane = wild.length > 0 && wild.every((v) => Number.isFinite(v.x))

			// --- frame colour -----------------------------------------------------
			await window.host.applyOps([
				{ add_screen: { name: 'Tinted', color: 'light-blue', at: { x: 700, y: 0 } } },
				{ add_screen: { name: 'Plain', at: { x: 700, y: 620 } } },
				{ style: { id: 'Plain', color: 'light-green' } },
			])
			res.frameColours = ed
				.getCurrentPageShapes()
				.filter((s) => s.type === 'frame' && s.props.name !== 'Z')
				.map((f) => `${f.props.name}=${f.props.color}`)
				.sort()
				.join(' ')

			// --- gradients: paint, fill styles, text ------------------------------
			await window.host.applyOps([
				{ theme: { colors: { 'custom-1': GRADIENT, 'custom-2': RADIAL, 'custom-3': '#4f87ee' } } },
				{ add: { screen: 'Z', kind: 'card', name: 'GFill', at: { x: 20, y: 260 }, size: { w: 160, h: 80 } } },
				{ style: { id: 'GFill', color: 'custom-1', fill: 'fill' } },
				{ add: { screen: 'Z', kind: 'box', name: 'GLine', at: { x: 200, y: 260 }, size: { w: 160, h: 80 } } },
				{ style: { id: 'GLine', color: 'custom-1', fill: 'none' } },
				{ add: { screen: 'Z', kind: 'label', name: 'GText', text: 'gradient', at: { x: 380, y: 280 } } },
				{ style: { id: 'GText', color: 'custom-1' } },
			])
			await wait(600)
			const paintOf = (n, sel) => {
				const el = document.querySelector(`[data-shape-id="${named(n).id}"] ${sel}`)
				return el ? getComputedStyle(el) : null
			}
			res.gradFill = paintOf('GFill', '.tl-svg-container path:not([fill="none"])')?.fill ?? ''
			res.gradStroke = paintOf('GLine', '.tl-svg-container path[stroke]')?.stroke ?? ''
			const textCs = paintOf('GText', '.tl-rich-text-wrapper')
			res.gradTextBg = textCs?.backgroundImage ?? ''
			res.gradTextClip = textCs?.webkitBackgroundClip ?? textCs?.backgroundClip ?? ''
			res.gradTextTransparent = /rgba\([^)]*,\s*0\)/.test(textCs?.color ?? '')
			// the outline must be present but must NOT be a technique that paints
			// over the clipped gradient
			res.gradTextOutline = (textCs?.filter ?? '').includes('url(')
			res.gradTextNoShadow = (textCs?.textShadow ?? 'none') === 'none'

			// fill styles must resolve to DIFFERENT paints, not one gradient
			const fillRefs = {}
			for (const fill of ['fill', 'solid', 'lined-fill']) {
				await window.host.applyOps([{ style: { id: 'GFill', fill } }])
				await wait(250)
				const def = document.querySelector(
					`#claw-gradient-defs #claw-grad-${named('GFill').id.replace(/[^\w-]/g, '')}-fill`
				)
				fillRefs[fill] = [...(def?.querySelectorAll('stop') ?? [])]
					.map((s) => s.getAttribute('stop-color'))
					.join(',')
			}
			res.fillStopsDistinct = new Set(Object.values(fillRefs)).size === 3
			res.fillStops = fillRefs

			// control points: fractions, and a resize must not change them
			await window.host.applyOps([
				{ gradient: { id: 'GFill', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } } },
			])
			const before = JSON.stringify(named('GFill').meta.clawGradient)
			ed.updateShape({ id: named('GFill').id, type: 'geo', props: { w: 300, h: 60 } })
			res.gradientPointsSurviveResize = JSON.stringify(named('GFill').meta.clawGradient) === before
			// reset must actually clear (updateShape MERGES meta)
			await window.host.applyOps([{ gradient: { id: 'GFill', reset: true } }])
			res.gradientResetCleared = named('GFill').meta.clawGradient == null
			// handles appear on a gradient shape, and only there
			const handlesOf = (n) => {
				const s = named(n)
				return (ed.getShapeUtil(s).getHandles?.(s) ?? []).map((h) => h.id)
			}
			res.gradientHandles = handlesOf('GFill').filter((h) => h.startsWith('claw-grad')).length
			res.plainHandles = handlesOf('A').filter((h) => h.startsWith('claw-grad')).length
			res.textHandles = handlesOf('GText').filter((h) => h.startsWith('claw-grad')).length

			// --- exports ----------------------------------------------------------
			const figma = await window.host.exportSvg({ figmaText: true })
			res.figmaNoForeignObject = !figma.svg.includes('<foreignObject')
			res.figmaNoInvisibleText = !/<text[^>]*fill="rgba\([^)]*,\s*0\)"/.test(figma.svg)
			res.figmaGradientText = /<text[^>]*fill="url\(#claw-grad-/.test(figma.svg)
			const rawSvg = await window.host.exportSvg({ figmaText: false })
			res.svgHasGradientDefs = /<(linear|radial)Gradient/.test(rawSvg.svg)
			res.serialized = await window.host.serialize()
			return res
		},
		{ GRADIENT, RADIAL, CONVEX }
	)

	check('order: creation order is the initial stack', out.orderInitial === 'ABC', out.orderInitial)
	check('order: to front', out.orderFront === 'BCA', out.orderFront)
	check('order: to back', out.orderBack === 'ABC', out.orderBack)
	// from ABC (A at the back), putting A directly above B gives B A C
	check('order: above a reference shape', out.orderAbove === 'BAC', out.orderAbove)
	check('rotate: relative turns accumulate', out.rotateAccumulated === 30, `${out.rotateAccumulated}deg`)
	check('rotate: absolute angle', out.rotateAbsolute === 90, `${out.rotateAbsolute}deg`)
	check('rotate: centre does not drift', out.rotateCentreHeld)
	check(
		'format: marks land on the matched runs only',
		out.formatRuns === 'Score [] 1200[bold+italic]  of [] 1200[italic]',
		out.formatRuns
	)
	check('format: clear collapses back to one run', out.formatCleared === 'Score 1200 of 1200[]', out.formatCleared)
	for (const r of out.rounded) {
		check(
			`radius: ${r.geo} rounds`,
			r.applied === `rounded-${r.geo}` && r.radius === 18 && r.points > 3 && r.finite,
			`geo=${r.applied} pts=${r.points}`
		)
	}
	check('radius: an extreme radius stays well-formed', out.extremeRadiusSane)
	check('frame colour: at creation and via style', out.frameColours === 'Plain=light-green Tinted=light-blue', out.frameColours)
	check('gradient: fill paints from the shape gradient', out.gradFill.includes('url("#claw-grad-'), out.gradFill)
	check('gradient: outline paints from the shape gradient', out.gradStroke.includes('url("#claw-grad-'), out.gradStroke)
	check('gradient: text clips a gradient to the glyphs', out.gradTextBg.includes('gradient') && out.gradTextClip === 'text')
	check('gradient: text fill is transparent (the clip shows through)', out.gradTextTransparent)
	check('gradient: text keeps an outline, drawn behind', out.gradTextOutline)
	check('gradient: text drops the technique that paints over it', out.gradTextNoShadow)
	check('gradient: each fill style gets its own stops', out.fillStopsDistinct, JSON.stringify(out.fillStops))
	check('gradient: control points survive a resize', out.gradientPointsSurviveResize)
	check('gradient: reset clears the control points', out.gradientResetCleared)
	check('gradient: two handles on a gradient shape', out.gradientHandles === 2, String(out.gradientHandles))
	check('gradient: text shapes get handles too', out.textHandles === 2, String(out.textHandles))
	check('gradient: no handles on a plain shape', out.plainHandles === 0, String(out.plainHandles))
	check('export: figma svg has no embedded html text', out.figmaNoForeignObject)
	check('export: figma svg has no invisible text', out.figmaNoInvisibleText)
	check('export: figma gradient text carries the gradient', out.figmaGradientText)
	check('export: raw svg carries gradient definitions', out.svgHasGradientDefs)
	check('page raised no errors', pageErrors.length === 0, pageErrors[0] ?? '')

	// The two customize dialogs are the only UI with no assertions elsewhere,
	// and a broken import in them stays invisible until a user clicks the
	// button. Opening each one proves the module mounts and reads the document.
	// A selected shape is what puts the style panel on screen, and Escape does
	// not dismiss a tldraw dialog, so each dialog gets a fresh page.
	const showPanel = async () => {
		await page.evaluate(() => {
			const ed = window.__editor
			if (!ed.getCurrentPageShapes().length) {
				ed.createShape({ type: 'geo', x: 60, y: 60, props: { w: 160, h: 100, geo: 'rectangle' } })
			}
			ed.selectAll()
		})
		await page.waitForTimeout(400)
	}
	const openDialog = async (label) => {
		await showPanel()
		await page.getByRole('button', { name: label }).click()
		await page.waitForTimeout(500)
		const seen = await page.evaluate(() => {
			const body = document.querySelector('.tlui-dialog__body')
			const rows = body
				? [...body.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Remove').length
				: 0
			const theme = window.__editor.getDocumentSettings()?.meta?.clawTheme ?? {}
			return {
				open: !!body,
				rows,
				colors: Object.keys(theme.colors ?? {}).length,
				fonts: Object.keys(theme.fonts ?? {}).length,
			}
		})
		await page.reload()
		await page.waitForFunction(() => !!window.__editor, null, { timeout: 30000 })
		return seen
	}
	const colorDialog = await openDialog('Customize colors…')
	check(
		'dialog: customize colours lists one row per document slot',
		colorDialog.open && colorDialog.rows === colorDialog.colors && colorDialog.colors > 0,
		`rows ${colorDialog.rows} of ${colorDialog.colors} slots`
	)
	// the document has colour slots from the ops above but no font slot, and a
	// dialog with zero rows would pass without proving anything
	await page.evaluate(() => {
		const ed = window.__editor
		const theme = ed.getDocumentSettings()?.meta?.clawTheme ?? {}
		ed.updateDocumentSettings({
			meta: { ...ed.getDocumentSettings().meta, clawTheme: { ...theme, fonts: { 'custom-1': { family: 'Georgia' } } } },
		})
	})
	const fontDialog = await openDialog('Customize fonts…')
	check(
		'dialog: customize fonts lists one row per document slot',
		fontDialog.open && fontDialog.rows === fontDialog.fonts,
		`rows ${fontDialog.rows} of ${fontDialog.fonts} slots`
	)

	// The smooth text outline is Claw's default: tldraw's own halo is six
	// stamped copies of the glyphs, the smooth one is a real vector stroke.
	// Nothing sets the preference here, so this is what a first run looks like.
	const outline = await page.evaluate(async () => {
		await window.host.applyOps([
			{ add_screen: { name: 'S', size: { w: 400, h: 300 } } },
			{ add: { screen: 'S', kind: 'label', name: 'Plain', text: 'Outline', at: { x: 20, y: 20 } } },
			{ add: { screen: 'S', kind: 'label', name: 'NoOutline', text: 'Bare', at: { x: 20, y: 80 } } },
		])
		const ed = window.__editor
		const byName = (n) => ed.getCurrentPageShapes().find((sh) => sh.meta?.clawName === n)
		await new Promise((r) => setTimeout(r, 400))
		const read = () => {
			const halos = [...document.querySelectorAll('.tl-text__outline')]
			return {
				count: halos.length,
				strokes: halos.map((el) => getComputedStyle(el).webkitTextStrokeWidth),
				shadows: halos.map((el) => getComputedStyle(el).textShadow),
			}
		}
		const before = read()
		const bare = byName('NoOutline')
		ed.updateShape({ id: bare.id, type: bare.type, meta: { ...bare.meta, clawText: { outline: 'off' } } })
		await new Promise((r) => setTimeout(r, 400))
		const after = read()
		return {
			classOn: !!ed.getContainer()?.classList.contains('claw-smooth-text'),
			before,
			after,
		}
	})
	check('smooth text outline is on without setting the preference', outline.classOn)
	check(
		'smooth outline paints a real stroke, not the stamped halo',
		outline.before.count === 2 &&
			outline.before.strokes.every((w) => parseFloat(w) > 0) &&
			outline.before.shadows.every((sh) => sh === 'none'),
		`${outline.before.count} outlines, stroke ${outline.before.strokes[0] ?? 'none'}`
	)
	check(
		'a shape can still turn its own outline off',
		outline.after.count === outline.before.count - 1,
		`${outline.before.count} -> ${outline.after.count}`
	)

	// Responsive anchors. Every number below is hand-computed from the rule,
	// so a regression in the resolver shows up as a wrong box rather than as
	// "something moved". Frame F is 400x600 at design size.
	const anch = await page.evaluate(async () => {
		const ed = window.__editor
		const find = (nm) => ed.getCurrentPageShapes().find((s) => s.meta?.clawName === nm)
		const box = (nm) => {
			const s = find(nm)
			if (!s) return null
			const b = ed.getShapeGeometry(s.id).bounds
			return { x: Math.round(s.x), y: Math.round(s.y), w: Math.round(b.w), h: Math.round(b.h) }
		}
		const labelScale = (nm) => {
			const s = find(nm)
			if (!s) return null
			const kid = ed
				.getSortedChildIdsForParent(s.id)
				.map((c) => ed.getShape(c))
				.find((c) => c?.type === 'text')
			return kid?.props?.scale ?? null
		}
		const res = {}
		await window.host.applyOps([
			{ add_screen: { name: 'Fit', at: { x: 2000, y: 0 }, size: { w: 400, h: 600 } } },
			{ add: { screen: 'Fit', kind: 'box', at: { x: 10, y: 10 }, size: { w: 380, h: 60 }, name: 'FitBar' } },
			{ add: { screen: 'Fit', kind: 'box', at: { x: 20, y: 100 }, size: { w: 360, h: 100 }, name: 'FitTile' } },
			{ add: { screen: 'Fit', kind: 'box', at: { x: 280, y: 450 }, size: { w: 110, h: 40 }, name: 'FitMini' } },
			{ add: { screen: 'Fit', kind: 'button', text: 'GO', at: { x: 20, y: 250 }, size: { w: 160, h: 60 }, name: 'FitBtn' } },
			{ add: { screen: 'Fit', kind: 'label', text: 'Words', at: { x: 20, y: 520 }, name: 'FitWords' } },
			// full width, fixed height, pinned to the top
			{ anchor: { id: 'FitBar', preset: 'top-bar' } },
			// full width at a 20px inset, height derived from that width at 2:1
			{
				anchor: {
					id: 'FitTile',
					x: { mode: 'stretch', percent: 1, sizeOffset: -40, offset: 20 },
					y: { mode: 'aspect', ratio: 0.5, offset: 100 },
				},
			},
			// half the parent's width, capped at 200 and floored at 100, hung
			// off the right edge by its own right edge
			{
				anchor: {
					id: 'FitMini',
					x: { mode: 'shrink', size: 200, percent: 0.5, sizeOffset: -10, min: 100, anchor: 1, pivot: 1, offset: -10 },
					y: { mode: 'fixed', size: 40, anchor: 1, pivot: 1, offset: -110 },
				},
			},
			// half the width, fixed height: text must NOT scale, because a bar
			// that keeps its height has no room to grow into
			{
				anchor: {
					id: 'FitBtn',
					x: { mode: 'stretch', percent: 0.5, sizeOffset: -40, offset: 20 },
					y: { mode: 'fixed', size: 60, offset: 250 },
				},
			},
			{ anchor: { id: 'FitWords', preset: 'fixed', text: 'fixed' } },
		])
		res.design = {
			bar: box('FitBar'),
			tile: box('FitTile'),
			mini: box('FitMini'),
			btn: box('FitBtn'),
			words: box('FitWords'),
			btnLabel: labelScale('FitBtn'),
		}
		// double the width: stretch and aspect follow
		await window.host.applyOps([{ resize: { id: 'Fit', w: 800 } }])
		res.wide = {
			bar: box('FitBar'),
			tile: box('FitTile'),
			mini: box('FitMini'),
			btn: box('FitBtn'),
			words: box('FitWords'),
			btnLabel: labelScale('FitBtn'),
		}
		// below FitMini's floor
		await window.host.applyOps([{ resize: { id: 'Fit', w: 200 } }])
		res.narrow = { mini: box('FitMini') }
		// a move inside the same batch as a resize must rebase from the box the
		// shape ENDS UP with, not the stale one it had at the old parent size
		const moved = await window.host.applyOps([
			{ resize: { id: 'Fit', w: 400 } },
			{ move: { id: 'FitTile', by: { dx: 0, dy: 30 } } },
		])
		res.afterMove = { tile: box('FitTile'), report: moved.report }
		res.rule = find('FitTile')?.meta?.clawAnchor ?? null
		res.preview = await window.host.resolveAnchors({
			container: 'Fit',
			sizes: [{ w: 400, h: 600 }, { w: 900, h: 600 }],
		})
		res.previewRestored = box('FitBar')
		// A screen that grows on BOTH axes: this is where text scaling engages,
		// and it is the game-HUD case (everything gets bigger together).
		await window.host.applyOps([
			{ add_screen: { name: 'Hud', at: { x: 3000, y: 0 }, size: { w: 200, h: 200 } } },
			{ add: { screen: 'Hud', kind: 'button', text: 'PLAY', at: { x: 20, y: 20 }, size: { w: 160, h: 60 }, name: 'HudBtn' } },
			{ add: { screen: 'Hud', kind: 'label', text: 'Score', at: { x: 20, y: 140 }, name: 'HudText' } },
			{ anchor: { id: 'HudBtn', preset: 'fill', inset: 20 } },
			{
				anchor: {
					id: 'HudText',
					x: { mode: 'stretch', percent: 1, sizeOffset: -40, offset: 20 },
					y: { mode: 'stretch', percent: 0.5, sizeOffset: -10, anchor: 0.5, offset: 0 },
				},
			},
		])
		res.hudDesign = {
			btn: box('HudBtn'),
			btnLabel: labelScale('HudBtn'),
			text: box('HudText'),
			textScale: find('HudText')?.props?.scale ?? null,
			textWidth: find('HudText')?.props?.w ?? null,
		}
		await window.host.applyOps([{ resize: { id: 'Hud', w: 400, h: 400 } }])
		res.hudBig = {
			btn: box('HudBtn'),
			btnLabel: labelScale('HudBtn'),
			text: box('HudText'),
			textScale: find('HudText')?.props?.scale ?? null,
			textWidth: find('HudText')?.props?.w ?? null,
		}
		res.lint = (await window.host.lint()).issues.filter((i) => i.kind.startsWith('anchor'))
		res.serialized = await window.host.serialize()
		return res
	})
	const sameBox = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
	check(
		'anchor: top-bar spans the parent and keeps its height',
		sameBox(anch.design.bar, { x: 0, y: 10, w: 400, h: 60 }) &&
			sameBox(anch.wide.bar, { x: 0, y: 10, w: 800, h: 60 }),
		JSON.stringify(anch.wide.bar)
	)
	check(
		'anchor: aspect mode derives height from the resolved width',
		sameBox(anch.design.tile, { x: 20, y: 100, w: 360, h: 180 }) &&
			sameBox(anch.wide.tile, { x: 20, y: 100, w: 760, h: 380 }),
		JSON.stringify(anch.wide.tile)
	)
	check(
		'anchor: shrink grows with the parent until it reaches its fixed size',
		sameBox(anch.design.mini, { x: 200, y: 450, w: 190, h: 40 }) &&
			sameBox(anch.wide.mini, { x: 590, y: 450, w: 200, h: 40 }),
		JSON.stringify(anch.wide.mini)
	)
	check(
		'anchor: a minimum size stops the box collapsing',
		anch.narrow.mini?.w === 100,
		JSON.stringify(anch.narrow.mini)
	)
	check(
		'anchor: text does NOT scale when only one axis grows',
		anch.design.btnLabel === 1 && anch.wide.btnLabel === 1,
		`${anch.design.btnLabel} -> ${anch.wide.btnLabel}`
	)
	check(
		'anchor: a box label scales by the box factor when both axes grow',
		sameBox(anch.hudDesign.btn, { x: 20, y: 20, w: 160, h: 160 }) &&
			sameBox(anch.hudBig.btn, { x: 20, y: 20, w: 360, h: 360 }) &&
			Math.abs(anch.hudBig.btnLabel / anch.hudDesign.btnLabel - 360 / 160) < 0.01,
		`label ${anch.hudDesign.btnLabel} -> ${anch.hudBig.btnLabel}`
	)
	check(
		'anchor: scaled text keeps its wrap width, so its line breaks never change',
		anch.hudBig.textScale > anch.hudDesign.textScale &&
			anch.hudBig.textWidth === anch.hudDesign.textWidth,
		`scale ${anch.hudDesign.textScale} -> ${anch.hudBig.textScale}, width ${anch.hudDesign.textWidth} -> ${anch.hudBig.textWidth}`
	)
	check(
		'anchor: a pinned label holds its place when the screen grows',
		sameBox(anch.design.words, anch.wide.words) && anch.design.words?.x === 20,
		JSON.stringify(anch.wide.words)
	)
	check(
		'anchor: a move in the same batch as a resize rebases from the settled box',
		sameBox(anch.afterMove.tile, { x: 20, y: 130, w: 360, h: 180 }),
		JSON.stringify(anch.afterMove.tile)
	)
	check(
		'anchor: a move rewrites offsets and leaves anchors alone',
		anch.rule?.x?.mode === 'stretch' && anch.rule?.x?.percent === 1 && anch.rule?.y?.offset === 130,
		JSON.stringify(anch.rule?.y)
	)
	check(
		'resolve: previewing other sizes reports them and restores the document',
		anch.preview.containers?.[0]?.sizes?.length === 2 &&
			anch.preview.containers[0].sizes[1].shapes.some((s) => s.box.w === 900) &&
			sameBox(anch.previewRestored, { x: 0, y: 10, w: 400, h: 60 }),
		JSON.stringify(anch.previewRestored)
	)
	check(
		'lint: a minimum-size collapse is reported with the parent size it happens at',
		anch.lint.some((i) => i.kind === 'anchor-collapses' && /under 220px/.test(i.detail)),
		anch.lint.map((i) => i.kind).join(' ') || 'none'
	)
	// tldraw 5.3.0 clips a shape inside NESTED frames to a triangle when a
	// frame's edge is flush with its ancestor's, which "stretch to 100%"
	// produces constantly. Claw nudges each frame's clip outward by a hair per
	// level of nesting so the edges cross properly. If tldraw fixes the
	// intersection, this still passes; if the nudge regresses, it does not.
	const clips = await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'ClipOuter', at: { x: 11000, y: 0 }, size: { w: 700, h: 900 } } },
			{ add_screen: { name: 'ClipInner', at: { x: 12000, y: 0 }, size: { w: 700, h: 800 } } },
		])
		const outer = ed.getCurrentPageShapes().find((s) => s.props?.name === 'ClipOuter')
		const inner = ed.getCurrentPageShapes().find((s) => s.props?.name === 'ClipInner')
		// flush on the left and right: exactly what a full-width child looks like
		ed.reparentShapes([inner.id], outer.id)
		ed.updateShape({ id: inner.id, type: 'frame', x: 0, y: 50 })
		await window.host.applyOps([
			{ add: { screen: 'ClipInner', kind: 'box', at: { x: 10, y: 10 }, size: { w: 300, h: 200 }, name: 'ClipBox' } },
			// and one that genuinely hangs outside, to prove clipping still bites
			{ add: { screen: 'ClipInner', kind: 'box', at: { x: 600, y: 700 }, size: { w: 300, h: 300 }, name: 'ClipOut' } },
		])
		const { svg } = await window.host.exportSvg({ frame: 'ClipInner', figmaText: false })
		const corners = []
		for (const m of svg.matchAll(/<clipPath id="([^"]+)"[^>]*>(.*?)<\/clipPath>/gs)) {
			const d = (m[2].match(/d="([^"]+)"/) || [])[1] ?? ''
			corners.push((d.match(/[ML]/g) || []).length)
		}
		const outBox = ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'ClipOut')
		const masked = ed.getShapeMaskedPageBounds(outBox.id)
		const full = ed.getShapePageBounds(outBox.id)
		return {
			corners,
			// the overhanging box must still be trimmed by the frame
			clipped: masked ? Math.round(masked.w) < Math.round(full.w) : false,
		}
	})
	check(
		'clip: a shape in nested frames gets a four-corner clip, not a triangle',
		clips.corners.length > 0 && clips.corners.every((c) => c === 4),
		clips.corners.join(',')
	)
	check(
		'clip: a shape overhanging a nested frame is still clipped',
		clips.clipped,
		String(clips.clipped)
	)

	// Lines are built from points, not a width and height, so a rule can only
	// size one by scaling it. Scaling happens about the centre, so the position
	// has to be re-applied after.
	const lines = await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Lines', at: { x: 7000, y: 0 }, size: { w: 400, h: 400 } } },
		])
		const frame = ed.getCurrentPageShapes().find((s) => s.props?.name === 'Lines')
		const mk = (id, y, x2, y2) =>
			ed.createShape({
				id,
				type: 'line',
				parentId: frame.id,
				x: 40,
				y,
				meta: { clawName: id.slice(6) },
				props: {
					points: {
						a1: { id: 'a1', index: 'a1', x: 0, y: 0 },
						a2: { id: 'a2', index: 'a2', x: x2, y: y2 },
					},
				},
			})
		mk('shape:eflat', 60, 200, 0)
		mk('shape:ediag', 120, 200, 100)
		const rel = (id) => {
			const pb = ed.getShapePageBounds(id)
			const f = ed.getShapePageBounds(frame.id)
			return {
				x: Math.round(pb.x - f.x),
				y: Math.round(pb.y - f.y),
				w: Math.round(pb.w),
				h: Math.round(pb.h),
			}
		}
		const span = { mode: 'stretch', percent: 1, sizeOffset: -40, anchor: 0, pivot: 0, offset: 20 }
		await window.host.applyOps([
			{ anchor: { id: 'eflat', x: span } },
			{ anchor: { id: 'ediag', x: span } },
		])
		const at400 = { flat: rel('shape:eflat'), diag: rel('shape:ediag') }
		await window.host.applyOps([{ resize: { id: frame.id.slice(6), w: 800 } }])
		const at800 = { flat: rel('shape:eflat'), diag: rel('shape:ediag') }
		// a height rule a flat line cannot satisfy must leave it intact
		await window.host.applyOps([
			{
				anchor: {
					id: 'eflat',
					y: { mode: 'stretch', percent: 0.5, sizeOffset: 0, anchor: 0, pivot: 0, offset: 60 },
				},
			},
		])
		return { at400, at800, flatAfterHeightRule: rel('shape:eflat') }
	})
	check(
		'anchor: a line follows a stretch rule by scaling',
		sameBox(lines.at400.flat, { x: 20, y: 60, w: 360, h: 0 }) &&
			sameBox(lines.at800.flat, { x: 20, y: 60, w: 760, h: 0 }),
		JSON.stringify(lines.at800.flat)
	)
	check(
		'anchor: a diagonal line keeps the axis its rule does not touch',
		lines.at800.diag.w === 760 && lines.at800.diag.h === 100,
		JSON.stringify(lines.at800.diag)
	)
	check(
		'anchor: a flat line survives a height rule it cannot satisfy',
		sameBox(lines.flatAfterHeightRule, { x: 20, y: 60, w: 760, h: 0 }),
		JSON.stringify(lines.flatAfterHeightRule)
	)

	// Groups. A group keeps PAGE coordinates while parented to a frame and
	// compensates with an offset on its geometry, so reading shape.x treated
	// the whole board as its parent. Every box here is measured from rendered
	// page bounds relative to the frame, which is the one measure that means
	// the same thing for every shape type.
	const grouped = await page.evaluate(async () => {
		const ed = window.__editor
		// deliberately far from the origin: at 0,0 the bug is invisible
		await window.host.applyOps([
			{ add_screen: { name: 'Grp', at: { x: 6000, y: 400 }, size: { w: 400, h: 400 } } },
			{ add: { screen: 'Grp', kind: 'card', at: { x: 60, y: 80 }, size: { w: 120, h: 60 }, name: 'GA' } },
			{ add: { screen: 'Grp', kind: 'card', at: { x: 200, y: 80 }, size: { w: 120, h: 60 }, name: 'GB' } },
		])
		const find = (n) => ed.getCurrentPageShapes().find((s) => s.meta?.clawName === n)
		const frame = ed.getCurrentPageShapes().find((s) => s.props?.name === 'Grp')
		ed.select(find('GA').id, find('GB').id)
		ed.groupShapes(ed.getSelectedShapeIds())
		const group = ed.getCurrentPageShapes().find((s) => s.type === 'group')
		const gid = group.id.slice(6)
		const fid = frame.id.slice(6)
		const rel = () => {
			const b = ed.getShapePageBounds(group.id)
			const f = ed.getShapePageBounds(frame.id)
			return {
				x: Math.round(b.x - f.x),
				y: Math.round(b.y - f.y),
				w: Math.round(b.w),
				h: Math.round(b.h),
			}
		}
		const res = { drawn: rel() }
		await window.host.applyOps([{ anchor: { id: gid, preset: 'fixed' } }])
		res.pinned = rel()
		res.offset = ed.getShape(group.id).meta.clawAnchor.x.offset
		await window.host.applyOps([{ resize: { id: fid, w: 800 } }])
		res.pinnedWide = rel()
		await window.host.applyOps([{ anchor: { id: gid, x: { anchor: 1, pivot: 1, offset: -20 } } }])
		res.rightEdge = rel()
		res.lint = (await window.host.lint()).issues.filter((i) => i.kind === 'anchor-group-size')
		await window.host.applyOps([{ anchor: { id: gid, x: { mode: 'stretch', percent: 1 } } }])
		res.lintAfterStretch = (await window.host.lint()).issues.filter(
			(i) => i.kind === 'anchor-group-size'
		)
		return res
	})
	check(
		'anchor: a group measures against its frame, not the board',
		grouped.offset === 60 && sameBox(grouped.pinned, grouped.drawn),
		`offset ${grouped.offset}, ${JSON.stringify(grouped.pinned)}`
	)
	check(
		'anchor: a pinned group holds its place when the screen widens',
		sameBox(grouped.pinnedWide, { x: 60, y: 80, w: 260, h: 60 }),
		JSON.stringify(grouped.pinnedWide)
	)
	check(
		'anchor: a group hung off the right edge tracks it',
		sameBox(grouped.rightEdge, { x: 520, y: 80, w: 260, h: 60 }),
		JSON.stringify(grouped.rightEdge)
	)
	check(
		'lint: a size mode on a group is reported, since only position applies',
		grouped.lint.length === 0 && grouped.lintAfterStretch.length > 0,
		`${grouped.lint.length} then ${grouped.lintAfterStretch.length}`
	)

	// Fit: a stretch axis shrinks until its aspect partner sits inside the
	// parent. The partner's anchor and pivot decide which of its edges move,
	// so the bound depends on placement, not just size.
	const fit = await page.evaluate(async () => {
		const ed = window.__editor
		const box = () => {
			const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'AspectTile')
			const b = ed.getShapeGeometry(s.id).bounds
			return { x: Math.round(s.x), y: Math.round(s.y), w: Math.round(b.w), h: Math.round(b.h) }
		}
		await window.host.applyOps([
			{ add_screen: { name: 'AspectBox', at: { x: 5000, y: 0 }, size: { w: 400, h: 300 } } },
			{ add: { screen: 'AspectBox', kind: 'card', at: { x: 0, y: 0 }, size: { w: 100, h: 100 }, name: 'AspectTile' } },
			{
				anchor: {
					id: 'AspectTile',
					x: { mode: 'stretch', percent: 1, sizeOffset: 0, anchor: 0.5, pivot: 0.5 },
					y: { mode: 'aspect', ratio: 0.5625, anchor: 0.5, pivot: 0.5 },
				},
			},
		])
		const res = { roomy: box() }
		await window.host.applyOps([{ resize: { id: 'AspectBox', h: 150 } }])
		res.overflowing = box()
		await window.host.applyOps([{ anchor: { id: 'AspectTile', x: { fit: true } } }])
		res.fitted = box()
		await window.host.applyOps([{ anchor: { id: 'AspectTile', x: { fitOffset: -20 } } }])
		res.padded = box()
		// pivot 0 on the partner: its leading edge cannot move, so only the
		// trailing bound applies and shrinking is not wasted on the other
		await window.host.applyOps([
			{ anchor: { id: 'AspectTile', y: { anchor: 0, pivot: 0 }, x: { fitOffset: 0 } } },
		])
		res.topPinned = box()
		// no aspect partner: the flag has nothing to compute against
		await window.host.applyOps([{ anchor: { id: 'AspectTile', y: { mode: 'fixed', size: 500 } } }])
		res.inert = box()
		return res
	})
	check(
		'fit: an aspect partner that already fits is left alone',
		sameBox(fit.roomy, { x: 0, y: 37, w: 400, h: 225 }),
		JSON.stringify(fit.roomy)
	)
	check(
		'fit: without the flag the partner overflows',
		fit.overflowing.h === 225 && fit.overflowing.y < 0,
		JSON.stringify(fit.overflowing)
	)
	check(
		'fit: the sized axis shrinks until the partner exactly fits',
		sameBox(fit.fitted, { x: 67, y: 0, w: 266, h: 150 }),
		JSON.stringify(fit.fitted)
	)
	check(
		'fit: the allowance keeps a margin on both edges',
		sameBox(fit.padded, { x: 102, y: 20, w: 195, h: 110 }),
		JSON.stringify(fit.padded)
	)
	check(
		'fit: a bound the partner cannot satisfy by shrinking is skipped',
		sameBox(fit.topPinned, { x: 67, y: 0, w: 266, h: 150 }),
		JSON.stringify(fit.topPinned)
	)
	check(
		'fit: the flag is inert when the other axis is not aspect',
		fit.inert.w === 400,
		JSON.stringify(fit.inert)
	)

	// Two bugs that only show up on shapes the earlier cases happen to avoid.
	const edge = await page.evaluate(async () => {
		const ed = window.__editor
		const box = (n) => {
			const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === n)
			return { x: Math.round(s.x), y: Math.round(s.y) }
		}
		// a screen whose children are ALL text: the container scan used to skip
		// it, so its anchored label never resolved
		await window.host.applyOps([
			{ add_screen: { name: 'TextOnly', at: { x: 4000, y: 0 }, size: { w: 400, h: 400 } } },
			{ add: { screen: 'TextOnly', kind: 'label', text: 'Centred', at: { x: 10, y: 10 }, name: 'Solo' } },
			{
				anchor: {
					id: 'Solo',
					x: { mode: 'fixed', size: 90, anchor: 0.5, pivot: 0.5 },
					y: { mode: 'fixed', size: 32, anchor: 0.5, pivot: 0.5 },
					text: 'fixed',
				},
			},
		])
		const settled = box('Solo')
		// and moving a centre-aligned shape must not walk it on later resolves
		await window.host.applyOps([{ move: { id: 'Solo', by: { dx: 40, dy: 0 } } }])
		const moved = box('Solo')
		const trail = []
		for (let i = 0; i < 3; i++) {
			await window.host.applyOps([{ resolve: {} }])
			trail.push(box('Solo').x)
		}
		return { settled, moved, trail }
	})
	check(
		'anchor: a screen whose children are all text still resolves',
		edge.settled.x !== 10 && edge.settled.y !== 10,
		JSON.stringify(edge.settled)
	)
	check(
		'anchor: a centred shape stays where it is moved to, across repeated resolves',
		edge.trail.every((x) => x === edge.moved.x),
		`moved to ${edge.moved.x}, then ${edge.trail.join(',')}`
	)

	check(
		'portable: anchor rules travel in shape metadata',
		JSON.parse(anch.serialized).records.filter((r) => r.meta?.clawAnchor).length === 7,
		`${JSON.parse(anch.serialized).records.filter((r) => r.meta?.clawAnchor).length} of 7`
	)

	// -------------------------------------------------------------------------
	// 2. file: the boundary that keeps claw-only concepts portable
	// -------------------------------------------------------------------------
	const file = JSON.parse(out.serialized)
	const shapes = file.records.filter((r) => r.typeName === 'shape')
	const geos = shapes.filter((r) => r.type === 'geo')
	check(
		'portable: no claw-only geo value reaches the file',
		geos.every((g) => !String(g.props.geo).startsWith('rounded-')),
		geos.map((g) => g.props.geo).join(' ')
	)
	check(
		'portable: rounded shapes keep their radius in metadata',
		geos.filter((g) => g.meta?.clawRadius > 0).length === CONVEX.length,
		`${geos.filter((g) => g.meta?.clawRadius > 0).length} of ${CONVEX.length}`
	)
	check(
		'portable: no custom slot value reaches the file',
		shapes.every((r) => !String(r.props?.color ?? '').startsWith('custom-')),
		shapes.map((r) => r.props?.color).filter((c) => String(c).startsWith('custom-')).join(' ')
	)
	check(
		'portable: gradient shapes record the slot they used',
		shapes.some((r) => r.meta?.clawStyle?.color?.startsWith('custom-'))
	)
	check(
		'portable: a reset gradient leaves no null behind',
		shapes.every((r) => !(r.meta && 'clawGradient' in r.meta && r.meta.clawGradient === null))
	)

	// reload the saved text: everything claw-only must come back
	const restored = await page.evaluate(async (text) => {
		await window.host.load(text)
		const ed = window.__editor
		const geos = ed.getCurrentPageShapes().filter((s) => s.type === 'geo')
		return {
			rounded: geos.filter((s) => String(s.props.geo).startsWith('rounded-')).length,
			custom: ed
				.getCurrentPageShapes()
				.filter((s) => String(s.props?.color ?? '').startsWith('custom-')).length,
		}
	}, out.serialized)
	check('portable: rounding is restored on load', restored.rounded === CONVEX.length, `${restored.rounded}`)
	check('portable: custom slots are restored on load', restored.custom > 0, `${restored.custom}`)
	await page.close()
}

// ---------------------------------------------------------------------------
// 2b. live editing with real pointer input: anchors have to hold up under
// dragging, which is the whole point of them. Two opposite behaviours are
// checked here — resizing a container moves its anchored children, while
// dragging an anchored child rewrites its offsets instead of snapping back.
// ---------------------------------------------------------------------------
{
	const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
	const pageErrors = []
	page.on('pageerror', (e) => pageErrors.push(String(e.message)))
	await page.goto(PAGE)
	await page.waitForFunction(() => !!window.__editor && !!window.host, null, { timeout: 30000 })

	await page.evaluate(async () => {
		await window.host.applyOps([
			{ add_screen: { name: 'S', at: { x: 0, y: 0 }, size: { w: 300, h: 300 } } },
			{ add: { screen: 'S', kind: 'box', at: { x: 20, y: 20 }, size: { w: 260, h: 60 }, name: 'Bar' } },
			{ add: { screen: 'S', kind: 'button', at: { x: 20, y: 120 }, size: { w: 100, h: 60 }, name: 'Chip' } },
			{
				anchor: {
					id: 'Bar',
					x: { mode: 'stretch', percent: 1, sizeOffset: -40, offset: 20 },
					y: { mode: 'fixed', size: 60, offset: 20 },
				},
			},
			{ anchor: { id: 'Chip', preset: 'fixed' } },
		])
		// park the camera so page coordinates map 1:1 onto screen coordinates
		window.__editor.setCamera({ x: 200, y: 200, z: 1 }, { immediate: true })
		window.__editor.selectNone()
		return null
	})
	const liveBoxes = () =>
		page.evaluate(() => {
			const ed = window.__editor
			const find = (nm) => ed.getCurrentPageShapes().find((s) => s.meta?.clawName === nm)
			const b = (nm) => {
				const s = find(nm)
				const g = ed.getShapeGeometry(s.id).bounds
				return { x: Math.round(s.x), y: Math.round(s.y), w: Math.round(g.w), h: Math.round(g.h) }
			}
			const frame = ed.getCurrentPageShapes().find((s) => s.type === 'frame')
			return {
				frameW: Math.round(frame.props.w),
				Bar: b('Bar'),
				Chip: b('Chip'),
				chipRule: find('Chip').meta?.clawAnchor?.x ?? null,
			}
		})

	// drag the frame's bottom-right handle 200px to the right
	await page.evaluate(() => {
		const ed = window.__editor
		// select() returns the editor, which cannot cross the bridge
		ed.select(ed.getCurrentPageShapes().find((s) => s.type === 'frame').id)
		return null
	})
	await page.waitForTimeout(150)
	await page.mouse.move(500, 500)
	await page.mouse.down()
	await page.mouse.move(600, 500, { steps: 8 })
	await page.mouse.move(700, 500, { steps: 8 })
	await page.mouse.up()
	await page.waitForTimeout(400)
	const dragged = await liveBoxes()
	check(
		'live: dragging a screen wider moves its anchored children',
		dragged.frameW === 500 && dragged.Bar.w === 460 && dragged.Chip.x === 20,
		`frame ${dragged.frameW}, bar ${dragged.Bar.w}, chip x ${dragged.Chip.x}`
	)

	// drag the pinned child by hand
	await page.evaluate(() => {
		window.__editor.selectNone()
		return null
	})
	await page.mouse.move(270, 350)
	await page.mouse.down()
	await page.mouse.move(300, 370, { steps: 6 })
	await page.mouse.move(310, 370, { steps: 6 })
	await page.mouse.up()
	await page.waitForTimeout(400)
	const moved = await liveBoxes()
	check(
		'live: dragging an anchored shape rewrites its offsets, keeping its anchors',
		moved.Chip.x === 60 && moved.chipRule?.offset === 60 && moved.chipRule?.anchor === 0,
		`chip x ${moved.Chip.x}, offset ${moved.chipRule?.offset}`
	)

	// resize again: the hand-placed child must stay where it was put
	await page.evaluate(() => {
		const ed = window.__editor
		const frame = ed.getCurrentPageShapes().find((s) => s.type === 'frame')
		ed.updateShape({ id: frame.id, type: 'frame', props: { w: 700 } })
		return null
	})
	await page.waitForTimeout(400)
	const again = await liveBoxes()
	check(
		'live: a hand move survives the next resize',
		again.Chip.x === 60 && again.Bar.w === 660,
		`chip x ${again.Chip.x}, bar ${again.Bar.w}`
	)
	// A resize is an ordinary edit, so one undo has to put both the container
	// and the children the resolver moved back. If the resolver's writes landed
	// outside the drag's history entry, this would take two presses.
	await page.keyboard.press('Control+z')
	await page.waitForTimeout(300)
	const undone = await liveBoxes()
	check(
		'live: one undo reverts the resize and the children it moved',
		undone.frameW === 500 && undone.Bar.w === 460,
		`frame ${undone.frameW}, bar ${undone.Bar.w}`
	)
	// The style-panel controls are the only anchor UI, so they need to fit the
	// ~150px column and actually drive the rule. An unusable field here is the
	// difference between a feature and a decoration.
	await page.evaluate(() => {
		const ed = window.__editor
		ed.select(ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Bar').id)
		return null
	})
	await page.waitForTimeout(400)
	const toolbar = await page.evaluate(() => {
		const root = document.querySelector('.claw-anchor')
		if (!root) return null
		const box = root.getBoundingClientRect()
		const fields = {}
		let overflowing = 0
		let tiny = 0
		for (const el of root.querySelectorAll('input, select, button')) {
			const id = el.getAttribute('data-testid')
			const r = el.getBoundingClientRect()
			if (r.right > box.right + 1) overflowing++
			if (el.tagName === 'INPUT' && el.type === 'number' && r.width < 28) tiny++
			if (id) fields[id] = el.value
		}
		return { width: Math.round(box.width), fields, overflowing, tiny }
	})
	check(
		'panel: the anchor controls fit the style panel with usable number fields',
		toolbar && toolbar.overflowing === 0 && toolbar.tiny === 0,
		toolbar ? `${toolbar.width}px, ${toolbar.overflowing} overflowing, ${toolbar.tiny} too narrow` : 'no controls'
	)
	check(
		'panel: the fields show the rule that is actually stored',
		toolbar?.fields['claw-anchor-x-mode'] === 'stretch' &&
			toolbar?.fields['claw-anchor-x-percent'] === '1' &&
			toolbar?.fields['claw-anchor-x-sizeOffset'] === '-40' &&
			toolbar?.fields['claw-anchor-x-offset'] === '20',
		JSON.stringify(toolbar?.fields ?? null)
	)
	await page.fill('[data-testid="claw-anchor-x-offset"]', '40')
	await page.waitForTimeout(400)
	const typed = await page.evaluate(() => {
		const ed = window.__editor
		const bar = ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Bar')
		return { x: Math.round(bar.x), offset: bar.meta?.clawAnchor?.x?.offset ?? null }
	})
	check(
		'panel: typing an offset moves the shape',
		typed.x === 40 && typed.offset === 40,
		`x ${typed.x}, stored ${typed.offset}`
	)
	// the Dynamic Layout switch is the on/off for the whole feature
	const barBox = () =>
		page.evaluate(() => {
			const ed = window.__editor
			const bar = ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Bar')
			const b = ed.getShapeGeometry(bar.id).bounds
			return {
				x: Math.round(bar.x),
				y: Math.round(bar.y),
				w: Math.round(b.w),
				h: Math.round(b.h),
				rule: bar.meta?.clawAnchor ?? null,
			}
		})
	const before = await barBox()
	await page.click('[data-testid="claw-anchor-dynamic"]')
	await page.waitForTimeout(400)
	const off = await barBox()
	check('panel: the Dynamic Layout switch removes the rule', off.rule == null, JSON.stringify(off.rule))
	await page.click('[data-testid="claw-anchor-dynamic"]')
	await page.waitForTimeout(400)
	const on = await barBox()
	check(
		'panel: switching Dynamic Layout back on keeps the box exactly where it was',
		on.rule != null && on.x === off.x && on.y === off.y && on.w === off.w && on.h === off.h,
		`${off.w}x${off.h} @${off.x},${off.y} -> ${on.w}x${on.h} @${on.x},${on.y}`
	)
	check(
		'panel: turning it on pins the shape rather than stretching it',
		on.rule?.x?.mode === 'fixed' && on.rule?.y?.mode === 'fixed',
		JSON.stringify(on.rule?.x)
	)
	void before
	// Resizing an anchored shape is allowed exactly on an axis pinned to a plain
	// pixel size, because there the size the drag lands on simply becomes the
	// rule. An axis whose size is derived from the parent stays locked. The Pin
	// preset above left Bar fixed on both axes, so it is fully resizable here.
	const canResizeBar = () =>
		page.evaluate(() => {
			const ed = window.__editor
			const bar = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Bar')
			const frame = ed.getCurrentPageShapes().find((s) => s.type === 'frame')
			return { anchored: ed.getShapeUtil(bar).canResize(bar), screen: ed.getShapeUtil(frame).canResize(frame) }
		})
	const locks = await canResizeBar()
	check(
		'live: a shape pinned to a fixed size on both axes keeps its resize handles',
		locks.anchored === true && locks.screen === true,
		JSON.stringify(locks)
	)
	const readBar = () =>
		page.evaluate(() => {
			const s = window.__editor.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Bar')
			const b = window.__editor.getShapeGeometry(s.id).bounds
			return { w: Math.round(b.w), h: Math.round(b.h), rule: s.meta?.clawAnchor ?? null }
		})
	/** Drag Bar's bottom-right corner handle by (dx, dy) screen pixels. */
	const dragBarCorner = async (dx, dy) => {
		const corner = await page.evaluate(() => {
			const ed = window.__editor
			const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Bar')
			ed.select(s.id)
			const b = ed.getShapePageBounds(s.id)
			const p = ed.pageToScreen({ x: b.x + b.w, y: b.y + b.h })
			return { x: p.x, y: p.y }
		})
		await page.waitForTimeout(250)
		await page.mouse.move(corner.x - 2, corner.y - 2)
		await page.waitForTimeout(120)
		await page.mouse.move(corner.x, corner.y)
		await page.waitForTimeout(120)
		await page.mouse.down()
		await page.mouse.move(corner.x + dx / 2, corner.y + dy / 2, { steps: 8 })
		await page.mouse.move(corner.x + dx, corner.y + dy, { steps: 8 })
		await page.mouse.up()
		await page.waitForTimeout(400)
	}
	const pinnedBefore = await readBar()
	await dragBarCorner(90, 70)
	const pinnedAfter = await readBar()
	check(
		'live: dragging the corner of a fixed-size anchored shape resizes it',
		pinnedAfter.w > pinnedBefore.w + 10 && pinnedAfter.h > pinnedBefore.h + 10,
		`${pinnedBefore.w}x${pinnedBefore.h} -> ${pinnedAfter.w}x${pinnedAfter.h}`
	)
	// The drag has to land in the rule, not just in the geometry, or the next
	// resolve would put the old size straight back.
	check(
		'live: the drag writes the new size into the rule, so it survives a resolve',
		Math.abs((pinnedAfter.rule?.x?.size ?? 0) - pinnedAfter.w) <= 1 &&
			Math.abs((pinnedAfter.rule?.y?.size ?? 0) - pinnedAfter.h) <= 1,
		JSON.stringify({ w: pinnedAfter.w, h: pinnedAfter.h, rule: pinnedAfter.rule })
	)
	const stillThere = await page.evaluate(async () => {
		const ed = window.__editor
		const frame = ed.getCurrentPageShapes().find((s) => s.type === 'frame')
		ed.updateShape({ id: frame.id, type: 'frame', props: { w: frame.props.w + 40 } })
		return null
	})
	void stillThere
	await page.waitForTimeout(400)
	const afterResolve = await readBar()
	check(
		'live: the hand-dragged size survives the next screen resize',
		afterResolve.w === pinnedAfter.w && afterResolve.h === pinnedAfter.h,
		`${pinnedAfter.w}x${pinnedAfter.h} -> ${afterResolve.w}x${afterResolve.h}`
	)

	// One axis derived from the parent, the other pinned: the drag has to move
	// the pinned axis and leave the derived one exactly where the rule put it.
	await page.evaluate(() => {
		const ed = window.__editor
		ed.select(ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Bar').id)
		return null
	})
	await page.waitForTimeout(250)
	await page.selectOption('[data-testid="claw-anchor-x-mode"]', 'stretch')
	await page.waitForTimeout(400)
	// Switching to stretch does not write a `percent`, and a missing one means
	// 1, not 0. The faded number in an empty field has to be the number the
	// shape is really using, or the panel reports a size that is not happening.
	const emptyFields = await page.evaluate(() => {
		const read = (id) => {
			const el = document.querySelector(`[data-testid="${id}"]`)
			return el ? { value: el.value, placeholder: el.placeholder } : null
		}
		return { percent: read('claw-anchor-x-percent'), sizeOffset: read('claw-anchor-x-sizeOffset') }
	})
	check(
		'panel: an empty percent shows the 1 it is treated as, not a 0',
		emptyFields.percent?.value === '' && emptyFields.percent?.placeholder === '1',
		JSON.stringify(emptyFields.percent)
	)
	check(
		'panel: a field that really does default to zero still shows zero',
		emptyFields.sizeOffset?.value === '' && emptyFields.sizeOffset?.placeholder === '0',
		JSON.stringify(emptyFields.sizeOffset)
	)
	// keep the box inside the screen so its corner handle is somewhere the
	// pointer can actually reach
	await page.fill('[data-testid="claw-anchor-x-sizeOffset"]', '-80')
	await page.waitForTimeout(400)
	const mixedLocks = await canResizeBar()
	const mixedBefore = await readBar()
	await dragBarCorner(80, 60)
	const mixedAfter = await readBar()
	check(
		'live: a shape with one fixed axis keeps its handles',
		mixedLocks.anchored === true,
		JSON.stringify(mixedLocks)
	)
	check(
		'live: the drag sizes the fixed axis and the stretch axis holds',
		mixedAfter.h > mixedBefore.h + 10 && mixedAfter.w === mixedBefore.w,
		`${mixedBefore.w}x${mixedBefore.h} -> ${mixedAfter.w}x${mixedAfter.h}`
	)
	check(
		'live: the held axis keeps the number the author typed',
		mixedAfter.rule?.x?.sizeOffset === mixedBefore.rule?.x?.sizeOffset &&
			Math.abs((mixedAfter.rule?.y?.size ?? 0) - mixedAfter.h) <= 1,
		JSON.stringify({ x: mixedAfter.rule?.x, y: mixedAfter.rule?.y })
	)

	// Neither axis pinned: nothing a drag could mean, so the handles go away and
	// the store guard holds the size even if some other path tries.
	await page.selectOption('[data-testid="claw-anchor-y-mode"]', 'stretch')
	await page.waitForTimeout(400)
	await page.fill('[data-testid="claw-anchor-y-sizeOffset"]', '-40')
	await page.waitForTimeout(400)
	const derivedLocks = await canResizeBar()
	const derivedBefore = await readBar()
	await dragBarCorner(90, 70)
	const derivedAfter = await readBar()
	check(
		'live: a shape with no fixed axis has no resize handles',
		derivedLocks.anchored === false && derivedLocks.screen === true,
		JSON.stringify(derivedLocks)
	)
	check(
		'live: dragging the corner of a fully derived shape does not resize it',
		derivedAfter.w === derivedBefore.w && derivedAfter.h === derivedBefore.h,
		`${derivedBefore.w}x${derivedBefore.h} -> ${derivedAfter.w}x${derivedAfter.h}`
	)

	// Editing a rule in the panel must not feed the RESULT back into the rule.
	// With fit active the result is the capped size, so a rebase there turned
	// the cap into the rule and destroyed the number the author had typed.
	await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Feedback', at: { x: 0, y: 900 }, size: { w: 400, h: 300 } } },
			{ add: { screen: 'Feedback', kind: 'card', at: { x: 0, y: 0 }, size: { w: 100, h: 100 }, name: 'Fed' } },
			{
				anchor: {
					id: 'Fed',
					x: {
						mode: 'stretch', percent: 1, sizeOffset: -20,
						anchor: 0.5, pivot: 0.5, offset: 0, fit: true, fitOffset: -10,
					},
					y: { mode: 'aspect', ratio: 0.5, anchor: 0.5, pivot: 0.5, offset: 0 },
				},
			},
		])
		ed.select(ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Fed').id)
		return null
	})
	await page.waitForTimeout(400)
	const readFed = () =>
		page.evaluate(() => {
			const s = window.__editor.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Fed')
			const b = window.__editor.getShapeGeometry(s.id).bounds
			return { w: Math.round(b.w), sizeOffset: s.meta.clawAnchor.x.sizeOffset }
		})
	const fedStart = await readFed()
	await page.fill('[data-testid="claw-anchor-y-ratio"]', '0.75')
	await page.waitForTimeout(500)
	const fedBumped = await readFed()
	await page.fill('[data-testid="claw-anchor-y-ratio"]', '0.5')
	await page.waitForTimeout(500)
	const fedBack = await readFed()
	check(
		'panel: editing a rule does not write the resolved size back into it',
		fedBumped.sizeOffset === -20 && fedBack.sizeOffset === -20,
		`${fedStart.sizeOffset} -> ${fedBumped.sizeOffset} -> ${fedBack.sizeOffset}`
	)
	check(
		'panel: a fitted axis returns to full size when the ratio is put back',
		fedBack.w === fedStart.w && fedBumped.w < fedStart.w,
		`${fedStart.w} -> ${fedBumped.w} -> ${fedBack.w}`
	)
	// Testing a layout must be free: resize the screen, undo, and the rules
	// must be byte-identical. A rebase is only meaningful when something other
	// than the resolver moved a shape, so an automated pass must never rewrite
	// one from geometry that is mid-flight.
	const undoRules = await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Undo', at: { x: 8000, y: 0 }, size: { w: 400, h: 400 } } },
			{ add: { screen: 'Undo', kind: 'card', at: { x: 20, y: 20 }, size: { w: 360, h: 60 }, name: 'UBar' } },
			{ add: { screen: 'Undo', kind: 'card', at: { x: 40, y: 120 }, size: { w: 120, h: 60 }, name: 'UPin' } },
			{ anchor: { id: 'UBar', preset: 'fill', inset: 20 } },
			{ anchor: { id: 'UPin', preset: 'fixed' } },
		])
		const read = () =>
			JSON.stringify(
				['UBar', 'UPin'].map((n) => {
					const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === n)
					return s.meta.clawAnchor
				})
			)
		const frame = ed.getCurrentPageShapes().find((s) => s.props?.name === 'Undo')
		const before = read()
		ed.markHistoryStoppingPoint()
		ed.updateShape({ id: frame.id, type: 'frame', props: { w: 900 } })
		await new Promise((r) => setTimeout(r, 120))
		const wide = read()
		ed.undo()
		await new Promise((r) => setTimeout(r, 120))
		return {
			same: before === read(),
			unchangedDuringResize: before === wide,
			frameW: Math.round(ed.getShape(frame.id).props.w),
		}
	})
	check(
		'live: resizing a screen to test a layout does not touch the rules',
		undoRules.unchangedDuringResize,
		JSON.stringify(undoRules)
	)
	check(
		'live: undoing that resize restores the rules exactly',
		undoRules.same && undoRules.frameW === 400,
		JSON.stringify(undoRules)
	)
	// The case from daily-jigsaw: a board that fits inside its screen, holding
	// grid lines with zero thickness. Squeeze the screen until the fit binds,
	// then undo. Undo restores only what a person did; the resolver derives
	// the rest again, so no rule is rewritten from a half-restored state.
	const jigsaw = await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Game', at: { x: 9000, y: 0 }, size: { w: 720, h: 1280 } } },
			{ add_screen: { name: 'Board', at: { x: 9020, y: 80 }, size: { w: 680, h: 551 } } },
		])
		const game = ed.getCurrentPageShapes().find((s) => s.props?.name === 'Game')
		const board = ed.getCurrentPageShapes().find((s) => s.props?.name === 'Board')
		ed.reparentShapes([board.id], game.id)
		ed.updateShape({ id: board.id, type: 'frame', x: 20, y: 80 })
		// zero-thickness grid lines, evenly spaced, with no offsets at all
		for (let i = 0; i < 3; i++) {
			ed.createShape({
				id: `shape:jig${i}`,
				type: 'line',
				parentId: board.id,
				x: 0,
				y: 100 + i * 100,
				meta: { clawName: `jig${i}` },
				props: {
					points: {
						a1: { id: 'a1', index: 'a1', x: 0, y: 0 },
						a2: { id: 'a2', index: 'a2', x: 680, y: 0 },
					},
				},
			})
		}
		await window.host.applyOps([
			{
				anchor: {
					id: board.id.slice(6),
					x: { mode: 'stretch', percent: 1, sizeOffset: -40, anchor: 0.5, pivot: 0.5, offset: 0, fit: true, fitOffset: -40 },
					y: { mode: 'aspect', ratio: 0.81, anchor: 0, pivot: 0, offset: 80 },
				},
			},
			...[0, 1, 2].map((i) => ({
				anchor: {
					id: `jig${i}`,
					x: { mode: 'stretch', percent: 1 },
					y: { mode: 'fixed', size: 0, anchor: (i + 1) * 0.25 },
				},
			})),
		])
		const rules = () =>
			JSON.stringify(
				[0, 1, 2].map((i) => {
					const r = ed.getShape(`shape:jig${i}`).meta.clawAnchor
					return [r.x.offset ?? 0, r.x.sizeOffset ?? 0, r.y.offset ?? 0, r.y.sizeOffset ?? 0]
				})
			)
		const boardW = () => Math.round(ed.getShapePageBounds(board.id).w)
		const before = rules()
		const wBefore = boardW()
		ed.markHistoryStoppingPoint()
		ed.updateShape({ id: game.id, type: 'frame', props: { h: 500 } })
		await new Promise((r) => setTimeout(r, 200))
		const wSqueezed = boardW()
		ed.undo()
		await new Promise((r) => setTimeout(r, 200))
		return {
			same: before === rules(),
			fitEngaged: wSqueezed < wBefore,
			restored: boardW() === wBefore,
		}
	})
	check(
		'live: undo after a fit-driven resize leaves the grid rules untouched',
		jigsaw.fitEngaged && jigsaw.same && jigsaw.restored,
		JSON.stringify(jigsaw)
	)
	// Two shapes whose size does NOT live in props.w / props.h on the axis being
	// dragged. A text shape is sized by one scale factor, so its rule has to
	// follow a drag that changes nothing but `scale`. A fixed axis paired with
	// an aspect axis must take the drag into its own pixel size and leave the
	// ratio alone, rather than recomputing the ratio from a box whose other
	// axis just moved.
	await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Hand', at: { x: 0, y: 1400 }, size: { w: 400, h: 400 } } },
			{ add: { screen: 'Hand', kind: 'label', at: { x: 20, y: 20 }, text: 'Hello', name: 'Tx' } },
			{ add: { screen: 'Hand', kind: 'box', at: { x: 20, y: 200 }, size: { w: 160, h: 80 }, name: 'Asp' } },
			{ anchor: { id: 'Tx', preset: 'fixed' } },
			{
				anchor: {
					id: 'Asp',
					x: { mode: 'fixed', size: 160, anchor: 0, pivot: 0, offset: 20 },
					y: { mode: 'aspect', ratio: 0.5, anchor: 0, pivot: 0, offset: 200 },
				},
			},
		])
		ed.setCamera({ x: 200, y: -1200, z: 1 }, { immediate: true })
		ed.selectNone()
		return null
	})
	await page.waitForTimeout(500)
	const readNamed = (name) =>
		page.evaluate((nm) => {
			const ed = window.__editor
			const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === nm)
			const b = ed.getShapeGeometry(s.id).bounds
			return { w: Math.round(b.w), h: Math.round(b.h), rule: s.meta.clawAnchor }
		}, name)
	const dragNamedCorner = async (name, dx, dy) => {
		const c = await page.evaluate((nm) => {
			const ed = window.__editor
			const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === nm)
			ed.select(s.id)
			const b = ed.getShapePageBounds(s.id)
			const p = ed.pageToScreen({ x: b.x + b.w, y: b.y + b.h })
			return { x: p.x, y: p.y }
		}, name)
		await page.waitForTimeout(250)
		await page.mouse.move(c.x - 2, c.y - 2)
		await page.waitForTimeout(120)
		await page.mouse.move(c.x, c.y)
		await page.waitForTimeout(120)
		await page.mouse.down()
		await page.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 8 })
		await page.mouse.move(c.x + dx, c.y + dy, { steps: 8 })
		await page.mouse.up()
		await page.waitForTimeout(500)
	}
	// nudging the screen forces a resolve, which is what would undo a drag the
	// rule did not record
	const nudgeHandScreen = async () => {
		await page.evaluate(() => {
			const ed = window.__editor
			const f = ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Hand')
			ed.updateShape({ id: f.id, type: 'frame', props: { w: f.props.w + 20 } })
			return null
		})
		await page.waitForTimeout(500)
	}
	const txBefore = await readNamed('Tx')
	await dragNamedCorner('Tx', 70, 50)
	const txAfter = await readNamed('Tx')
	await nudgeHandScreen()
	const txResolved = await readNamed('Tx')
	check(
		'live: dragging pinned text scales it and the rule records the new box',
		txAfter.w > txBefore.w + 10 &&
			Math.abs((txAfter.rule?.x?.size ?? 0) - txAfter.w) <= 1 &&
			txAfter.rule?.base?.scale > 1,
		JSON.stringify({ before: txBefore.w, after: txAfter.w, rule: txAfter.rule })
	)
	check(
		'live: the scaled text keeps its new size through the next resolve',
		txResolved.w === txAfter.w && txResolved.h === txAfter.h,
		`${txAfter.w}x${txAfter.h} -> ${txResolved.w}x${txResolved.h}`
	)
	const aspBefore = await readNamed('Asp')
	await dragNamedCorner('Asp', 70, 50)
	const aspAfter = await readNamed('Asp')
	await nudgeHandScreen()
	const aspResolved = await readNamed('Asp')
	check(
		'live: dragging the fixed axis of an aspect pair leaves the ratio alone',
		aspAfter.w > aspBefore.w + 10 &&
			Math.abs((aspAfter.rule?.x?.size ?? 0) - aspAfter.w) <= 1 &&
			aspAfter.rule?.y?.ratio === aspBefore.rule?.y?.ratio,
		JSON.stringify({ before: aspBefore.w, after: aspAfter.w, rule: aspAfter.rule })
	)
	check(
		'live: the aspect axis then follows the new fixed size',
		Math.abs(aspResolved.h - aspResolved.w * 0.5) <= 1,
		`${aspResolved.w}x${aspResolved.h}`
	)

	// The corner radius has a slider for finding a value by eye and a field for
	// saying exactly which one. The field has to reach past the slider's own
	// end, flip the shape onto its rounded geo type, and take the track's end
	// with it so the thumb never sits at 60 under a number reading 120.
	await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Round', at: { x: 600, y: 1400 }, size: { w: 300, h: 300 } } },
			{ add: { screen: 'Round', kind: 'box', at: { x: 20, y: 20 }, size: { w: 200, h: 120 }, name: 'Rb' } },
		])
		ed.select(ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Rb').id)
		return null
	})
	await page.waitForTimeout(400)
	await page.fill('[data-testid="claw-corner-radius-value"]', '120')
	await page.waitForTimeout(400)
	const typedRadius = await page.evaluate(() => {
		const s = window.__editor.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Rb')
		const slider = document.querySelector('[data-testid="claw-corner-radius"]')
		return { radius: s.meta?.clawRadius ?? null, geo: s.props.geo, sliderMax: slider?.max, sliderValue: slider?.value }
	})
	check(
		'panel: typing a corner radius rounds the shape',
		typedRadius.radius === 120 && String(typedRadius.geo).startsWith('rounded-'),
		JSON.stringify(typedRadius)
	)
	check(
		'panel: the slider follows a value typed past its own end',
		typedRadius.sliderMax === '120' && typedRadius.sliderValue === '120',
		JSON.stringify(typedRadius)
	)
	// out of range clamps rather than being written through, and zero puts the
	// shape back on its square-cornered geo type
	await page.fill('[data-testid="claw-corner-radius-value"]', '900')
	await page.waitForTimeout(400)
	const clamped = await page.evaluate(() => {
		const s = window.__editor.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Rb')
		return s.meta?.clawRadius ?? null
	})
	await page.fill('[data-testid="claw-corner-radius-value"]', '0')
	await page.waitForTimeout(400)
	const zeroed = await page.evaluate(() => {
		const s = window.__editor.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Rb')
		return { radius: s.meta?.clawRadius ?? null, geo: s.props.geo }
	})
	check('panel: a corner radius past the maximum is clamped', clamped === 200, String(clamped))
	check(
		'panel: a corner radius of zero restores the square-cornered shape',
		zeroed.radius === 0 && !String(zeroed.geo).startsWith('rounded-'),
		JSON.stringify(zeroed)
	)
	// The field is only worth having if it did not cost the slider the width
	// that made it hard to drag in the first place, so the track gets its own
	// row and neither row may spill out of the ~150px panel.
	const cornerLayout = await page.evaluate(() => {
		const row = document.querySelector('.claw-corners')
		const track = document.querySelector('[data-testid="claw-corner-radius"]')
		const field = document.querySelector('[data-testid="claw-corner-radius-value"]')
		if (!row || !track || !field) return null
		const r = row.getBoundingClientRect()
		const t = track.getBoundingClientRect()
		const f = field.getBoundingClientRect()
		const pad = getComputedStyle(row)
		const content = r.width - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
		return {
			content: Math.round(content),
			track: Math.round(t.width),
			field: Math.round(f.width),
			overflowing: Math.round(Math.max(t.right, f.right) - (r.right - parseFloat(pad.paddingRight))),
		}
	})
	check(
		'panel: the corner slider keeps a full row and nothing spills out of the panel',
		cornerLayout &&
			cornerLayout.track >= cornerLayout.content - 1 &&
			cornerLayout.field >= 28 &&
			cornerLayout.overflowing <= 1,
		JSON.stringify(cornerLayout)
	)

	// Anchor and pivot as draggable handles. Both numbers are fractions, which
	// is the hard part of the model to picture, so they are also two points:
	// one on the screen, one on the box, with the offset as the gap between.
	// Dragging either leaves the box where it is and changes only how it moves
	// when the screen does.
	await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Handles', at: { x: 1200, y: 1400 }, size: { w: 400, h: 400 } } },
			{ add: { screen: 'Handles', kind: 'card', text: 'H', at: { x: 40, y: 40 }, size: { w: 160, h: 100 }, name: 'Hb' } },
			{ add: { screen: 'Handles', kind: 'box', at: { x: 40, y: 260 }, size: { w: 80, h: 60 }, name: 'Plain' } },
			{
				anchor: {
					id: 'Hb',
					x: { mode: 'fixed', size: 160, anchor: 0, pivot: 0, offset: 40 },
					y: { mode: 'fixed', size: 100, anchor: 0, pivot: 0, offset: 40 },
				},
			},
		])
		ed.setCamera({ x: -1000, y: -1200, z: 1 }, { immediate: true })
		ed.select(ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Hb').id)
		return null
	})
	await page.waitForTimeout(500)
	const handleIds = (name) =>
		page.evaluate((nm) => {
			const ed = window.__editor
			const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === nm)
			return (ed.getShapeHandles(s) ?? []).map((h) => h.id)
		}, name)
	const readHb = () =>
		page.evaluate(() => {
			const ed = window.__editor
			const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Hb')
			const b = ed.getShapePageBounds(s.id)
			const f = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Handles')
			return {
				box: { x: Math.round(b.x - f.x), y: Math.round(b.y - f.y), w: Math.round(b.w), h: Math.round(b.h) },
				rule: s.meta.clawAnchor,
			}
		})
	// drag one handle to a point given in the SCREEN frame's own coordinates
	const dragHandle = async (handleId, inFrameX, inFrameY) => {
		const pts = await page.evaluate(
			([id, fx, fy]) => {
				const ed = window.__editor
				const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Hb')
				const f = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Handles')
				const h = ed.getShapeHandles(s).find((x) => x.id === id)
				const from = ed.pageToScreen(ed.getShapePageTransform(s.id).applyToPoint(h))
				const to = ed.pageToScreen({ x: f.x + fx, y: f.y + fy })
				return { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } }
			},
			[handleId, inFrameX, inFrameY]
		)
		await page.mouse.move(pts.from.x, pts.from.y)
		await page.waitForTimeout(150)
		await page.mouse.down()
		await page.mouse.move((pts.from.x + pts.to.x) / 2, (pts.from.y + pts.to.y) / 2, { steps: 8 })
		await page.mouse.move(pts.to.x, pts.to.y, { steps: 8 })
		await page.mouse.up()
		await page.waitForTimeout(400)
	}
	const anchoredHandles = await handleIds('Hb')
	check(
		'handles: an anchored shape offers an anchor and a pivot handle',
		anchoredHandles.includes('claw-anchor') && anchoredHandles.includes('claw-pivot'),
		JSON.stringify(anchoredHandles)
	)
	// tldraw switches its handle overlay off for the length of a handle drag,
	// which for these two means the drag has nothing to look at: the box
	// deliberately does not move, so the markers are the whole picture. Check
	// they are still being drawn with the pointer still down.
	const drawnDuringDrag = await page.evaluate(async () => {
		const ed = window.__editor
		const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Hb')
		const h = ed.getShapeHandles(s).find((x) => x.id === 'claw-anchor')
		const from = ed.pageToScreen(ed.getShapePageTransform(s.id).applyToPoint(h))
		return { x: from.x, y: from.y }
	})
	await page.mouse.move(drawnDuringDrag.x, drawnDuringDrag.y)
	await page.waitForTimeout(150)
	await page.mouse.down()
	await page.mouse.move(drawnDuringDrag.x + 40, drawnDuringDrag.y + 40, { steps: 6 })
	await page.mouse.move(drawnDuringDrag.x + 70, drawnDuringDrag.y + 60, { steps: 6 })
	await page.waitForTimeout(200)
	const midDrag = await page.evaluate(() => {
		const ed = window.__editor
		const ids = ed.overlays.getCurrentOverlays().map((o) => o.props?.handle?.id ?? o.type)
		return { path: ed.getPath(), ids }
	})
	await page.mouse.up()
	await page.waitForTimeout(300)
	check(
		'handles: the markers stay on screen while one of them is being dragged',
		midDrag.path === 'select.dragging_handle' &&
			midDrag.ids.includes('claw-anchor') &&
			midDrag.ids.includes('claw-pivot'),
		JSON.stringify(midDrag)
	)
	// the drag above left the rule wherever it landed; put it back so the
	// checks below start from the shape as it was authored
	await page.evaluate(() => {
		const ed = window.__editor
		const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Hb')
		ed.updateShape({
			id: s.id,
			type: s.type,
			meta: {
				...s.meta,
				clawAnchor: {
					...s.meta.clawAnchor,
					x: { mode: 'fixed', size: 160, anchor: 0, pivot: 0, offset: 40 },
					y: { mode: 'fixed', size: 100, anchor: 0, pivot: 0, offset: 40 },
				},
			},
		})
		return null
	})
	await page.waitForTimeout(400)
	await page.evaluate(() => {
		const ed = window.__editor
		ed.select(ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Plain').id)
		return null
	})
	await page.waitForTimeout(300)
	const plainHandles = await handleIds('Plain')
	check(
		'handles: a shape with no rule offers none',
		plainHandles.length === 0,
		JSON.stringify(plainHandles)
	)
	await page.evaluate(() => {
		const ed = window.__editor
		ed.select(ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Hb').id)
		return null
	})
	await page.waitForTimeout(300)
	const hbStart = await readHb()
	// the middle of the screen: a handle within a few pixels of a half settles
	// onto it, so the drag lands on exactly 0.5 rather than 0.497
	await dragHandle('claw-anchor', 200, 200)
	const hbAnchored = await readHb()
	check(
		'handles: dragging the anchor to the middle of the screen sets it to a half',
		hbAnchored.rule?.x?.anchor === 0.5 && hbAnchored.rule?.y?.anchor === 0.5,
		JSON.stringify({ x: hbAnchored.rule?.x, y: hbAnchored.rule?.y })
	)
	check(
		'handles: dragging the anchor does not move the shape',
		hbAnchored.box.x === hbStart.box.x && hbAnchored.box.y === hbStart.box.y,
		`${JSON.stringify(hbStart.box)} -> ${JSON.stringify(hbAnchored.box)}`
	)
	// the box's own bottom-right corner, which is pivot 1,1 on both axes
	await dragHandle('claw-pivot', 200, 140)
	const hbPivoted = await readHb()
	check(
		'handles: dragging the pivot to the corner of the box sets it to 1',
		hbPivoted.rule?.x?.pivot === 1 && hbPivoted.rule?.y?.pivot === 1,
		JSON.stringify({ x: hbPivoted.rule?.x, y: hbPivoted.rule?.y })
	)
	check(
		'handles: dragging the pivot does not move the shape either',
		hbPivoted.box.x === hbStart.box.x && hbPivoted.box.y === hbStart.box.y,
		`${JSON.stringify(hbStart.box)} -> ${JSON.stringify(hbPivoted.box)}`
	)
	// What the two drags DID change is how the box moves when the screen does:
	// its bottom-right corner now tracks the middle of the screen.
	await page.evaluate(() => {
		const ed = window.__editor
		const f = ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Handles')
		ed.updateShape({ id: f.id, type: 'frame', props: { w: 600, h: 600 } })
		return null
	})
	await page.waitForTimeout(500)
	const hbWidened = await readHb()
	// the pivot is the bottom-right corner and the anchor is the middle of the
	// screen, so that corner lands on the middle plus the offset the drags left
	// behind: dead on it across, and the 60px above it the box already sat
	check(
		'handles: the dragged rule is what the shape follows on the next resize',
		hbWidened.box.x + hbWidened.box.w === 300 && hbWidened.box.y + hbWidened.box.h === 240,
		JSON.stringify(hbWidened.box)
	)
	// Claw's handle drawing REPLACES tldraw's overlay, so tldraw's own handles
	// have to come through it untouched.
	const arrowHandles = await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([{ connect: { from: 'Hb', to: 'Plain', label: 'x' } }])
		const arrow = ed.getCurrentPageShapes().find((s) => s.type === 'arrow')
		ed.select(arrow.id)
		return (ed.getShapeHandles(arrow) ?? []).map((h) => h.id)
	})
	check(
		'handles: an arrow keeps its own endpoint handles',
		arrowHandles.includes('start') && arrowHandles.includes('end'),
		JSON.stringify(arrowHandles)
	)
	// Notes and images carry a rule like anything else, and are the two types
	// that got a claw shape util for the first time to make their handles
	// draggable. A note's own side handles have to survive that.
	const otherTypes = await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add: { screen: 'Handles', kind: 'note', text: 'N', at: { x: 300, y: 380 }, name: 'Nt' } },
			{
				add: {
					screen: 'Handles',
					kind: 'image',
					at: { x: 40, y: 400 },
					size: { w: 60, h: 60 },
					svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#38f"/></svg>',
					name: 'Im',
				},
			},
			{ anchor: { id: 'Nt', preset: 'fixed' } },
			{ anchor: { id: 'Im', preset: 'fixed' } },
		])
		const out = {}
		for (const nm of ['Nt', 'Im']) {
			const sh = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === nm)
			ed.select(sh.id)
			out[nm] = { type: sh.type, handles: (ed.getShapeHandles(sh) ?? []).map((h) => h.id) }
		}
		return out
	})
	check(
		'handles: a note and an image with a rule get them too',
		otherTypes.Nt?.handles.includes('claw-anchor') &&
			otherTypes.Nt?.handles.includes('claw-pivot') &&
			otherTypes.Im?.handles.includes('claw-anchor') &&
			otherTypes.Im?.handles.includes('claw-pivot'),
		JSON.stringify(otherTypes)
	)
	check(
		'handles: a note keeps its own side handles alongside them',
		otherTypes.Nt?.handles.includes('top') && otherTypes.Nt?.handles.includes('bottom'),
		JSON.stringify(otherTypes.Nt)
	)

	// Insert character. The page loads off disk here, where a fetch cannot reach
	// the core that serves the table, so the table is handed over directly - the
	// same door an embedder serving the page itself would use.
	const charTable = JSON.parse(readFileSync(join(here, 'page', 'data', 'chars.json'), 'utf8'))
	const tableRows = await page.evaluate((d) => window.host.setChars(d), charTable)
	check('chars: the character table loads', tableRows > 4000, `${tableRows} rows`)
	await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Chars', at: { x: 1800, y: 1400 }, size: { w: 360, h: 260 } } },
			{ add: { screen: 'Chars', kind: 'label', at: { x: 20, y: 20 }, text: 'Hello', name: 'Cl' } },
			{ add: { screen: 'Chars', kind: 'button', text: 'Go', at: { x: 20, y: 90 }, size: { w: 120, h: 40 }, name: 'Cb' } },
			{ add: { screen: 'Chars', kind: 'label', at: { x: 20, y: 160 }, text: 'x', name: 'Ct' } },
			{
				add: {
					screen: 'Chars',
					kind: 'image',
					at: { x: 220, y: 20 },
					size: { w: 60, h: 60 },
					svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#38f"/></svg>',
					name: 'Ci',
				},
			},
		])
		ed.setCamera({ x: -1600, y: -1200, z: 1 }, { immediate: true })
		ed.select(ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Cl').id)
		return null
	})
	await page.waitForTimeout(400)
	// The style panel shows even with nothing selected, so the option has to
	// gate itself: offering to insert a character with nowhere to put it is
	// offering to do nothing to the drawing.
	const offered = {}
	// names go through as an ARGUMENT: the function is stringified into the
	// page, so nothing it closes over comes with it. select() also hands back
	// the editor, which cannot cross back, hence the explicit nulls.
	const optionFor = async (label, names, edit = false) => {
		await page.evaluate(
			([wanted, alsoEdit]) => {
				const ed = window.__editor
				if (!wanted.length) {
					ed.selectNone()
					return null
				}
				const ids = wanted.map(
					(n) => ed.getCurrentPageShapes().find((s) => s.meta?.clawName === n).id
				)
				ed.select(...ids)
				ed.setEditingShape(alsoEdit ? ids[0] : null)
				return null
			},
			[names, edit]
		)
		await page.waitForTimeout(300)
		offered[label] = (await page.$('[data-testid="claw-insert-char"]')) !== null
	}
	await optionFor('nothing', [])
	await optionFor('label', ['Cl'])
	await optionFor('button', ['Cb'])
	await optionFor('image', ['Ci'])
	await optionFor('two shapes', ['Cl', 'Cb'])
	await optionFor('editing', ['Cl'], true)
	await page.evaluate(() => {
		window.__editor.setEditingShape(null)
		return null
	})
	check(
		'chars: the insert option is offered only where a character can land',
		offered.label && offered.button && offered.editing &&
			!offered.nothing && !offered.image && !offered['two shapes'],
		JSON.stringify(offered)
	)
	// the shortcut is not gated: a deliberate key press with nothing selected
	// gets the clipboard, which is a fair answer where a dead button is not
	await page.evaluate(() => {
		window.__editor.selectNone()
		return null
	})
	await page.waitForTimeout(300)
	await page.keyboard.press('Control+Shift+E')
	await page.waitForTimeout(500)
	const shortcutUngated = (await page.$('[data-testid="claw-char-search"]')) !== null
	await page.keyboard.press('Escape')
	await page.waitForTimeout(300)
	check(
		'chars: the shortcut still opens it with nothing selected',
		shortcutUngated,
		String(shortcutUngated)
	)
	await page.evaluate(() => {
		const ed = window.__editor
		ed.select(ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Cl').id)
		return null
	})
	await page.waitForTimeout(300)
	// the shortcut, not the button: the moment you want a character is
	// mid-sentence, where reaching for the style panel means leaving the text
	await page.keyboard.press('Control+Shift+E')
	await page.waitForTimeout(400)
	check(
		'chars: the keyboard shortcut opens the picker',
		(await page.$('[data-testid="claw-char-search"]')) !== null
	)
	const searchChars = async (q) => {
		await page.fill('[data-testid="claw-char-search"]', q)
		await page.waitForTimeout(200)
		return page.evaluate(() =>
			Array.from(document.querySelectorAll('.claw-char')).map((b) => b.dataset.char)
		)
	}
	const byName = await searchChars('party popper')
	const byCode = await searchChars('tada')
	check(
		'chars: a character is found by its name and by its shortcode',
		byName[0] === '\u{1F389}' && byCode[0] === '\u{1F389}',
		JSON.stringify({ byName: byName.slice(0, 3), byCode: byCode.slice(0, 3) })
	)
	// The ranking is the whole feature. A generic word has to bring back the
	// plain glyph, not whichever emoji happens to have the shortest name: before
	// whole-word matching, "arrow" led with a bow and arrow and three keycaps.
	const arrows = await searchChars('arrow')
	check(
		'chars: a generic word brings back the plain glyphs first',
		['\u2190', '\u2191', '\u2192', '\u2193'].every((c) => arrows.slice(0, 8).includes(c)),
		arrows.slice(0, 8).join(' ')
	)
	// Half-remembered names have to work: nobody calls U+2190 "leftwards".
	// "left" is only a prefix of it and "smile" is not even that of "smiling",
	// so this needs the loose and the stem tiers, not just whole words.
	const fuzzy = {}
	for (const q of ['left arrow', 'smile face', 'magnify glass', 'thumb up']) {
		fuzzy[q] = (await searchChars(q)).slice(0, 6)
	}
	check(
		'chars: a half-remembered name still finds the character',
		fuzzy['left arrow'].includes('\u2190') &&
			fuzzy['smile face'].includes('\u263A') &&
			fuzzy['magnify glass'].includes('\u{1F50D}') &&
			fuzzy['thumb up'].includes('\u{1F44D}'),
		JSON.stringify(fuzzy)
	)
	// The dialog must not resize as results come and go: it jumps under the
	// pointer while the query is still being typed, which is horrible to use.
	const dialogSize = async (q) => {
		await page.fill('[data-testid="claw-char-search"]', q)
		await page.waitForTimeout(200)
		return page.evaluate(() => {
			const b = document.querySelector('.tlui-dialog__body').parentElement.getBoundingClientRect()
			return `${Math.round(b.width)}x${Math.round(b.height)}`
		})
	}
	const sizes = []
	for (const q of ['', 'a', 'arrow', 'zzzznotathing', 'left arrow']) sizes.push(await dialogSize(q))
	check(
		'chars: the dialog is the same size whatever the search returns',
		new Set(sizes).size === 1,
		sizes.join(' ')
	)
	// Tab reaches the grid; from there the arrows have to walk it, since Tab
	// alone steps one character at a time through hundreds of them.
	await page.fill('[data-testid="claw-char-search"]', 'left arrow')
	await page.waitForTimeout(250)
	await page.focus('[data-testid="claw-char-search"]')
	const walk = []
	for (const key of ['ArrowDown', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowUp']) {
		await page.keyboard.press(key)
		await page.waitForTimeout(120)
		walk.push(
			await page.evaluate(
				() => document.activeElement?.dataset?.char ?? document.activeElement?.dataset?.testid ?? '?'
			)
		)
	}
	check(
		'chars: the arrow keys walk the grid and step back out to the search box',
		walk.slice(0, 5).every((c) => c && c !== '?') &&
			new Set(walk.slice(0, 4)).size === 4 &&
			walk[4] === walk[0] &&
			walk[5] === 'claw-char-search',
		walk.join(' ')
	)

	// U+2E2E is outside the blocks the table carries, so this is the escape
	// hatch for every character the picker has never heard of, not a lookup
	const byPoint = await searchChars('U+2E2E')
	const nothing = await searchChars('zzzznotathing')
	check(
		'chars: a code point outside the table still resolves',
		byPoint[0] === '\u2E2E',
		JSON.stringify(byPoint.slice(0, 2))
	)
	check('chars: a query that matches nothing returns nothing', nothing.length === 0, `${nothing.length}`)

	// where a clicked character lands, in each of the cases it distinguishes
	await page.evaluate(() => {
		const ed = window.__editor
		const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Cl')
		ed.select(s.id)
		ed.setEditingShape(s.id)
		return null
	})
	await page.waitForTimeout(600)
	await searchChars('tada')
	await page.click('[data-char="\u{1F389}"]')
	await page.waitForTimeout(400)
	const atCaret = await page.evaluate(() => {
		const ed = window.__editor
		const rt = ed.getRichTextEditor()
		const text = rt ? rt.getText() : null
		ed.setEditingShape(null)
		return text
	})
	check(
		'chars: clicking inserts into the text being edited',
		atCaret === 'Hello\u{1F389}',
		JSON.stringify(atCaret)
	)
	// a chip's text lives on a separate label shape, the same redirect set_text
	// makes, so a selected button has to take the character on its label
	await page.evaluate(() => {
		const ed = window.__editor
		ed.select(ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Cb').id)
		return null
	})
	await page.waitForTimeout(300)
	await searchChars('rocket')
	await page.click('[data-char="\u{1F680}"]')
	await page.waitForTimeout(400)
	const onChip = await page.evaluate(() => {
		const ed = window.__editor
		const b = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Cb')
		const label = ed
			.getSortedChildIdsForParent(b.id)
			.map((i) => ed.getShape(i))
			.find((k) => k?.type === 'text')
		if (!label) return null
		return label.props.richText.content[0].content.map((n) => n.text).join('')
	})
	check(
		'chars: with a button selected the character goes on its label',
		onChip === 'Go\u{1F680}',
		JSON.stringify(onChip)
	)
	// reopening shows what was just used, so those two are the first rows
	await page.keyboard.press('Escape')
	await page.waitForTimeout(300)
	await page.click('[data-testid="claw-insert-char"]')
	await page.waitForTimeout(400)
	const recent = await page.evaluate(() =>
		Array.from(document.querySelectorAll('.claw-char')).map((b) => b.dataset.char)
	)
	check(
		'chars: the picker reopens showing what was last used',
		recent[0] === '\u{1F680}' && recent[1] === '\u{1F389}',
		recent.slice(0, 4).join(' ')
	)
	await page.keyboard.press('Escape')
	await page.waitForTimeout(300)

	// :shortcode: while typing, and the ordinary text it must leave alone
	await page.evaluate(() => {
		const ed = window.__editor
		const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Ct')
		ed.select(s.id)
		ed.setEditingShape(s.id)
		return null
	})
	await page.waitForTimeout(700)
	const typeInto = async (text) => {
		await page.evaluate(() => {
			const rt = window.__editor.getRichTextEditor()
			rt.commands.clearContent()
			rt.commands.focus()
			return null
		})
		await page.keyboard.type(text, { delay: 12 })
		await page.waitForTimeout(300)
		return page.evaluate(() => window.__editor.getRichTextEditor().getText())
	}
	const expanded = await typeInto('Party :tada: time')
	const plusOne = await typeInto(':+1:')
	const clockTime = await typeInto('meet at 10:30: sharp')
	const unknownCode = await typeInto('a :notarealcode: b')
	// put the shape dead centre, where a centred dialog would land right on top
	// of it, so the avoidance below is actually being asked to do something
	await page.evaluate(() => {
		const ed = window.__editor
		const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Ct')
		const b = ed.getShapePageBounds(s.id)
		ed.centerOnPoint({ x: b.midX, y: b.midY }, { immediate: true })
		return null
	})
	await page.waitForTimeout(400)
	// tldraw switches every shortcut off while a shape is being edited, which is
	// the one moment this one is most wanted, so claw watches the key itself
	// then. Opening the picker mid-word is the whole reason it has a shortcut.
	await page.keyboard.press('Control+Shift+E')
	await page.waitForTimeout(500)
	const openedWhileEditing = {
		dialog: (await page.$('[data-testid="claw-char-search"]')) !== null,
		stillEditing: await page.evaluate(() => window.__editor.getEditingShapeId() !== null),
	}
	// tldraw centres a dialog, which puts it straight over a shape being edited
	// in the middle of the screen - the one place the person is looking
	const placement = await page.evaluate(() => {
		const ed = window.__editor
		const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Ct')
		const bb = ed.getShapePageBounds(s.id)
		const a = ed.pageToScreen({ x: bb.minX, y: bb.minY })
		const b = ed.pageToScreen({ x: bb.maxX, y: bb.maxY })
		const d = document.querySelector('.tlui-dialog__content')?.getBoundingClientRect()
		if (!d) return null
		return {
			overlaps: !(b.x < d.left || a.x > d.right || b.y < d.top || a.y > d.bottom),
			onScreen: d.left >= 0 && d.top >= 0 && d.right <= innerWidth && d.bottom <= innerHeight,
			shape: [Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y)],
			dialog: [Math.round(d.left), Math.round(d.top), Math.round(d.right), Math.round(d.bottom)],
		}
	})
	check(
		'chars: the picker moves clear of the text it is going to write into',
		placement && !placement.overlaps && placement.onScreen,
		JSON.stringify(placement)
	)
	// Escape has to mean "close the picker", not "stop editing this shape".
	// tldraw reads it as the second, and the dialog is portalled out of the
	// container React listens on, so the key is caught on the window instead.
	await page.keyboard.press('Escape')
	await page.waitForTimeout(400)
	const afterEscape = await page.evaluate(() => ({
		dialog: !!document.querySelector('[data-testid="claw-char-search"]'),
		editing: window.__editor.getEditingShapeId() !== null,
	}))
	await page.keyboard.type(' on', { delay: 20 })
	await page.waitForTimeout(300)
	const resumed = await page.evaluate(
		() => window.__editor.getRichTextEditor()?.getText() ?? '(no editor)'
	)
	await page.evaluate(() => {
		window.__editor.setEditingShape(null)
		return null
	})
	check(
		'chars: the shortcut opens the picker mid-word, without leaving the text',
		openedWhileEditing.dialog && openedWhileEditing.stillEditing,
		JSON.stringify(openedWhileEditing)
	)
	check(
		'chars: escape closes the picker and leaves the text being edited',
		afterEscape.dialog === false && afterEscape.editing === true,
		JSON.stringify(afterEscape)
	)
	check(
		'chars: typing carries on where it left off once the picker is closed',
		resumed === 'a :notarealcode: b on',
		JSON.stringify(resumed)
	)
	check(
		'chars: a completed :shortcode: becomes its character as it is typed',
		expanded === 'Party \u{1F389} time' && plusOne === '\u{1F44D}',
		JSON.stringify({ expanded, plusOne })
	)
	check(
		'chars: text that merely contains colons is left alone',
		clockTime === 'meet at 10:30: sharp' && unknownCode === 'a :notarealcode: b',
		JSON.stringify({ clockTime, unknownCode })
	)

	// Redo on ctrl+Y, which is what it is in every other Windows application.
	// Both the key and what the menu advertises matter: only the first
	// alternative in a kbd string is the one drawn, so the order is the label.
	await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Redo', at: { x: 2400, y: 1400 }, size: { w: 300, h: 200 } } },
			{ add: { screen: 'Redo', kind: 'box', at: { x: 20, y: 20 }, size: { w: 80, h: 50 }, name: 'Rx' } },
		])
		ed.setCamera({ x: -2200, y: -1200, z: 1 }, { immediate: true })
		ed.selectNone()
		return null
	})
	await page.waitForTimeout(400)
	const rxCount = () =>
		page.evaluate(
			() => window.__editor.getCurrentPageShapes().filter((s) => s.meta?.clawName === 'Rx').length
		)
	await page.evaluate(() => {
		const ed = window.__editor
		ed.markHistoryStoppingPoint()
		ed.deleteShapes([ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Rx').id])
		return null
	})
	await page.waitForTimeout(300)
	await page.keyboard.press('Control+z')
	await page.waitForTimeout(400)
	const afterUndo = await rxCount()
	await page.keyboard.press('Control+y')
	await page.waitForTimeout(400)
	const afterCtrlY = await rxCount()
	await page.keyboard.press('Control+z')
	await page.waitForTimeout(400)
	await page.keyboard.press('Control+Shift+z')
	await page.waitForTimeout(400)
	const afterShiftZ = await rxCount()
	check(
		'redo: ctrl+Y redoes, and shift+ctrl+Z still does too',
		afterUndo === 1 && afterCtrlY === 0 && afterShiftZ === 0,
		JSON.stringify({ afterUndo, afterCtrlY, afterShiftZ })
	)
	// undo once more so the menu item below is enabled
	await page.keyboard.press('Control+z')
	await page.waitForTimeout(300)
	await page.click('[data-testid="main-menu.button"]')
	await page.waitForTimeout(400)
	await page.getByRole('menuitem', { name: 'Edit' }).click()
	await page.waitForTimeout(500)
	const redoRow = await page.evaluate(() => {
		const el = Array.from(document.querySelectorAll('[role=menuitem]')).find((e) =>
			/^Redo/.test((e.textContent || '').trim())
		)
		return el ? (el.textContent || '').trim().replace(/\s+/g, '') : null
	})
	await page.keyboard.press('Escape')
	await page.waitForTimeout(300)
	check(
		'redo: the Edit menu advertises ctrl+Y rather than shift+ctrl+Z',
		redoRow === 'RedoCtrl+Y',
		JSON.stringify(redoRow)
	)

	// The outline drawn round a shape should be the box its RULE gives it. For a
	// box the two are the same thing; for text they are not, because scaled text
	// is drawn as a scaled picture of its design layout and sits inside its box
	// rather than filling it. A full-width label used to outline the glyphs,
	// which is a box the rule never mentions.
	await page.evaluate(async () => {
		const ed = window.__editor
		await window.host.applyOps([
			{ add_screen: { name: 'Bounds', at: { x: 3000, y: 1400 }, size: { w: 400, h: 340 } } },
			{ add: { screen: 'Bounds', kind: 'box', at: { x: 20, y: 20 }, size: { w: 200, h: 60 }, radius: 18, name: 'Brnd' } },
			{ add: { screen: 'Bounds', kind: 'label', at: { x: 20, y: 120 }, text: 'Hello', name: 'Btx' } },
			{ add: { screen: 'Bounds', kind: 'label', at: { x: 20, y: 250 }, text: 'Free', name: 'Bfree' } },
			{ anchor: { id: 'Brnd', preset: 'fixed' } },
			{
				anchor: {
					id: 'Btx',
					x: { mode: 'stretch', percent: 1, sizeOffset: -40, anchor: 0, pivot: 0, offset: 20 },
					y: { mode: 'fixed', size: 40, anchor: 0, pivot: 0, offset: 120 },
				},
			},
		])
		ed.setCamera({ x: -2800, y: -1200, z: 1 }, { immediate: true })
		ed.selectNone()
		return null
	})
	await page.waitForTimeout(500)
	/**
	 * What is actually PAINTED round a shape, by hovering it and reading the
	 * overlay canvas. Hover rather than select, so the selection box and the
	 * anchor handles stay out of the measurement; the canvas rather than the
	 * shape util, because the outline is drawn from live state and asking the
	 * util would not catch it going stale.
	 */
	const outlineOf = (name) =>
		page.evaluate((nm) => {
			const ed = window.__editor
			const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === nm)
			ed.selectNone()
			ed.setHoveredShape(s.id)
			return new Promise((resolve) =>
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						const c = document.querySelector('canvas.tl-canvas-overlays')
						const g = c.getContext('2d')
						const W = c.width
						const H = c.height
						const d = g.getImageData(0, 0, W, H).data
						const hit = (x, y) => {
							const i = (y * W + x) * 4
							return d[i + 3] > 120 && d[i + 2] > 150 && d[i + 2] - d[i] > 40
						}
						let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
						for (let y = 0; y < H; y++)
							for (let x = 0; x < W; x++)
								if (hit(x, y)) {
									if (x < minX) minX = x
									if (x > maxX) maxX = x
									if (y < minY) minY = y
									if (y > maxY) maxY = y
								}
						const geo = ed.getShapeGeometry(s.id).bounds
						resolve(
							maxX < 0
								? null
								: {
										outline: [Math.round(maxX - minX), Math.round(maxY - minY)],
										left: minX,
										shape: [Math.round(geo.w), Math.round(geo.h)],
										// a sharp corner paints into the very corner of its own
										// bounding box; a rounded one curves away and leaves it
										// empty. Counted over a small square rather than one
										// pixel, which antialiasing alone can leave unpainted.
										cornerPixels: (() => {
											let n = 0
											for (let y = minY; y < minY + 6; y++)
												for (let x = minX; x < minX + 6; x++) if (hit(x, y)) n++
											return n
										})(),
									}
						)
					})
				)
			)
		}, name)
	const textOutline = await outlineOf('Btx')
	check(
		'bounds: an anchored text outlines the box its rule gives it, not its glyphs',
		textOutline && textOutline.outline[0] > textOutline.shape[0] + 200 &&
			Math.abs(textOutline.outline[0] - 361) <= 3,
		JSON.stringify(textOutline)
	)
	await page.evaluate(() => {
		const ed = window.__editor
		const f = ed.getCurrentPageShapes().find((s) => s.meta?.clawName === 'Bounds')
		ed.updateShape({ id: f.id, type: 'frame', props: { w: 700 } })
		return null
	})
	await page.waitForTimeout(500)
	const widened = await outlineOf('Btx')
	check(
		'bounds: that outline grows with the screen, like every other shape',
		widened && Math.abs(widened.outline[0] - 661) <= 3,
		JSON.stringify(widened)
	)
	// A hand move rewrites the rule in `meta` and never touches `props`. tldraw
	// caches a shape util's indicator path against `props` alone, so drawing the
	// box that way left it behind at the position the shape was dragged from.
	const beforeMove = await outlineOf('Btx')
	await page.evaluate(() => {
		const ed = window.__editor
		const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Btx')
		ed.setHoveredShape(null)
		ed.select(s.id)
		return null
	})
	await page.waitForTimeout(300)
	const grab = await page.evaluate(() => {
		const ed = window.__editor
		const s = ed.getCurrentPageShapes().find((x) => x.meta?.clawName === 'Btx')
		const b = ed.getShapePageBounds(s.id)
		const p = ed.pageToScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
		return { x: p.x, y: p.y }
	})
	await page.mouse.move(grab.x, grab.y)
	await page.mouse.down()
	await page.mouse.move(grab.x + 40, grab.y, { steps: 8 })
	await page.mouse.move(grab.x + 90, grab.y, { steps: 8 })
	await page.mouse.up()
	await page.waitForTimeout(600)
	const afterMove = await outlineOf('Btx')
	check(
		'bounds: the outline follows the shape when it is moved by hand',
		beforeMove && afterMove &&
			Math.abs(afterMove.outline[0] - beforeMove.outline[0]) <= 3 &&
			Math.abs(afterMove.left - beforeMove.left - 90) <= 4,
		JSON.stringify({ beforeMove, afterMove })
	)
	// the two shapes that must be left exactly as they were
	const roundOutline = await outlineOf('Brnd')
	const freeOutline = await outlineOf('Bfree')
	check(
		'bounds: a rounded box keeps its rounded outline, corners and all',
		roundOutline && freeOutline &&
			roundOutline.cornerPixels === 0 && freeOutline.cornerPixels > 0 &&
			Math.abs(roundOutline.outline[0] - roundOutline.shape[0]) <= 3,
		JSON.stringify({ rounded: roundOutline, sharpForComparison: freeOutline.cornerPixels })
	)
	check(
		'bounds: text with no rule keeps its own tight outline',
		freeOutline && Math.abs(freeOutline.outline[0] - freeOutline.shape[0]) <= 3,
		JSON.stringify(freeOutline)
	)
	await page.evaluate(() => {
		window.__editor.setHoveredShape(null)
		return null
	})

	check('live editing raised no page errors', pageErrors.length === 0, pageErrors[0] ?? '')
	await page.close()
}

// ---------------------------------------------------------------------------
// 3. live room: record validation. The only place a claw-only enum value
// registered in the page but not in the room's schema shows up (v0.44.0
// shipped exactly that and disconnected every client with INVALID_RECORD).
// ---------------------------------------------------------------------------
try {
	const FILE = join(TMP, 'claw-features-live.tldr')
	writeFileSync(
		join(TMP, 'claw-features-ops.json'),
		JSON.stringify([{ add_screen: { name: 'Live', size: { w: 900, h: 500 } } }])
	)
	claw('new', FILE, join(TMP, 'claw-features-ops.json'), '--force')
	const url = claw('open', FILE).trim().split('\n').pop()

	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
	const syncErrors = []
	page.on('console', (m) => {
		if (m.type() === 'error' && /INVALID_RECORD|sync error|RemoteSync/i.test(m.text())) {
			syncErrors.push(m.text().slice(0, 120))
		}
	})
	page.on('pageerror', (e) => {
		if (/INVALID_RECORD|sync/i.test(String(e.message))) syncErrors.push(String(e.message).slice(0, 120))
	})
	await page.goto(`${url}?embed=1`)
	await page.waitForFunction(() => !!window.__editor, null, { timeout: 30000 })
	await page.waitForTimeout(1500)

	const live = await page.evaluate(
		async ({ CONVEX, GRADIENT }) => {
			const ops = [{ theme: { colors: { 'custom-1': GRADIENT } } }]
			CONVEX.forEach((geo, i) => {
				ops.push({
					add: { screen: 'Live', kind: 'box', name: `L${i}`, at: { x: 20 + (i % 5) * 120, y: 20 + Math.floor(i / 5) * 120 }, size: { w: 100, h: 100 } },
				})
				ops.push({ style: { id: `L${i}`, geo, radius: 12, color: 'custom-1', fill: 'fill' } })
			})
			await window.host.applyOps(ops)
			await new Promise((r) => setTimeout(r, 2500))
			const ed = window.__editor
			return {
				rounded: ed.getCurrentPageShapes().filter((s) => String(s.props.geo).startsWith('rounded-')).length,
				custom: ed.getCurrentPageShapes().filter((s) => s.props?.color === 'custom-1').length,
				connected: true,
			}
		},
		{ CONVEX, GRADIENT }
	)
	check('live room: accepts every rounded shape value', live.rounded === CONVEX.length, `${live.rounded}`)
	check('live room: accepts custom colour slots', live.custom === CONVEX.length, `${live.custom}`)
	check('live room: no record was rejected', syncErrors.length === 0, syncErrors[0] ?? '')

	// the room persists claw-only concepts back to disk in portable form
	await page.waitForTimeout(2500)
	const saved = JSON.parse(readFileSync(FILE, 'utf8'))
	const savedGeos = saved.records.filter((r) => r.type === 'geo')
	check(
		'live room: saves a portable file',
		savedGeos.length > 0 &&
			savedGeos.every((g) => !String(g.props.geo).startsWith('rounded-')) &&
			savedGeos.every((g) => !String(g.props.color).startsWith('custom-')),
		`${savedGeos.length} shapes`
	)
	check(
		'live room: keeps the radius in metadata',
		savedGeos.filter((g) => g.meta?.clawRadius > 0).length === CONVEX.length
	)
	await page.close()
	try {
		unlinkSync(FILE)
		unlinkSync(join(TMP, 'claw-features-ops.json'))
	} catch {}
} catch (err) {
	// report it as a failed check instead of losing every result above
	check('live room section ran', false, String(err.message ?? err).slice(0, 120))
}

await browser.close()
for (const line of results) console.log(line)
console.log(`\n${results.length - failures}/${results.length} checks passed`)
