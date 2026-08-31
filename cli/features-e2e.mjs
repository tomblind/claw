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
