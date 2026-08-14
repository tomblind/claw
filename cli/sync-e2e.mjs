// E2E for the folded architecture: a bare core + a headless browser standing
// in for the app (one tab plays the hidden executor frame, another plays the
// user). playwright-core is a devDependency - tests only, never runtime.
//
// usage: node sync-e2e.mjs   (starts everything itself; needs no running app)
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBrowser } from './lib/browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FILE = join(process.env.TEMP ?? '/tmp', 'sync-e2e-test.tldr')
const OPS = join(here, 'e2e-ops.json')
const LOCKFILE = join(here, '.claw-daemon.json')

const results = []
const check = (name, ok, detail = '') => {
	results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
	if (!ok) process.exitCode = 1
}
const claw = (...args) =>
	execFileSync(process.execPath, [join(here, 'claw.mjs'), ...args], { encoding: 'utf8' })

async function health(port) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
		return r.ok ? await r.json() : null
	} catch {
		return null
	}
}
function lockPort() {
	try {
		return JSON.parse(readFileSync(LOCKFILE, 'utf8')).port
	} catch {
		return null
	}
}

// --- core: reuse a running one (e.g. the real app), else start a bare one ---
let startedCore = false
let port = lockPort()
if (!port || !(await health(port))) {
	// --parent-pid ties the core's life to this test process as a backstop
	spawn(process.execPath, [join(here, 'server', 'daemon.mjs'), '--parent-pid', String(process.pid)], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
	}).unref()
	startedCore = true
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 250))
		port = lockPort()
		if (port && (await health(port))) break
	}
}
const h0 = await health(port)
check('core is up', !!h0?.ok, `port ${port}, v${h0?.version}`)
const base = `http://127.0.0.1:${port}`

const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ executablePath: findBrowser(), headless: true })
try {
	// --- executor: the role the app's hidden frame plays in production --------
	if (h0?.executor !== 'connected') {
		const executorTab = await browser.newPage({ viewport: { width: 1280, height: 800 } })
		executorTab.on('pageerror', (e) => console.error(`executor pageerror: ${e.message}`))
		await executorTab.goto(`${base}/executor-page?executor=1`)
		await executorTab.waitForFunction('window.hostReady === true || window.hostError', {
			timeout: 30_000,
		})
	}
	let hx = null
	for (let i = 0; i < 20 && hx?.executor !== 'connected'; i++) {
		await new Promise((r) => setTimeout(r, 250))
		hx = await health(port)
	}
	check('executor registered with core', hx?.executor === 'connected')

	// --- `new`: goes through /api/new -> executor + empty-doc template --------
	if (existsSync(FILE)) unlinkSync(FILE)
	writeFileSync(
		OPS,
		JSON.stringify([
			{ add_screen: { name: 'Home', at: { x: 0, y: 0 }, size: { w: 320, h: 568 } } },
			{ add: { screen: 'Home', kind: 'button', text: 'START', at: 'center' } },
		])
	)
	const newOut = claw('new', FILE, OPS)
	check('new canvas via executor', newOut.includes(`wrote ${FILE}`), newOut.trim().split('\n').pop())

	// --- open a room + a user tab ---------------------------------------------
	const url = claw('open', FILE).trim().split('\n').pop()
	const page = await browser.newPage()
	const errors = []
	page.on('pageerror', (e) => errors.push(e.message))
	await page.goto(url)
	await page.waitForFunction('window.hostReady === true || window.hostError', { timeout: 30_000 })
	const hostError = await page.evaluate('window.hostError ?? null')
	check('user tab connects to room', !hostError, hostError ?? 'ok')

	const count0 = await page.evaluate(() => window.__editor.getCurrentPageShapes().length)
	check('room hydrated from file', count0 >= 2, `${count0} shapes`)

	// --- agent apply routes through the room and broadcasts -------------------
	writeFileSync(
		OPS,
		JSON.stringify([{ add: { screen: 'Home', kind: 'note', text: 'sync-e2e-marker', at: 'bottom' } }])
	)
	const out = claw('apply', FILE, OPS)
	check(
		'apply routed through live room',
		out.includes('applied to live canvas'),
		out.trim().split('\n').pop()
	)

	await page
		.waitForFunction(`window.__editor.getCurrentPageShapes().length === ${count0 + 1}`, {
			timeout: 10_000,
		})
		.catch(() => {})
	const count1 = await page.evaluate(() => window.__editor.getCurrentPageShapes().length)
	check('agent edit visible in user tab (live)', count1 === count0 + 1, `${count1} shapes`)

	// --- room persists to disk (debounce 2s) -----------------------------------
	await new Promise((r) => setTimeout(r, 3500))
	check('room persisted agent edit to .tldr', readFileSync(FILE, 'utf8').includes('sync-e2e-marker'))

	// --- user edit -> flush-before-read shows it to the CLI --------------------
	await page.evaluate(() => {
		window.__editor.createShape({
			type: 'geo',
			x: 400,
			y: 40,
			props: { w: 90, h: 60, geo: 'rectangle' },
		})
	})
	// the local edit travels client -> server on tldraw's push throttle; poll
	let seen = 0
	for (let i = 0; i < 12; i++) {
		await new Promise((r) => setTimeout(r, 500))
		const outline = claw('outline', FILE)
		seen = Number(outline.match(/(\d+) shapes/)?.[1] ?? 0)
		if (seen >= count0 + 2) break
	}
	check('flush-before-read: outline sees user edit', seen >= count0 + 2, `${seen} shapes`)

	if (errors.length) check('no page errors in user tab', false, errors.join(' | '))
} finally {
	await browser.close()
	try {
		unlinkSync(OPS)
	} catch {}
	if (startedCore) {
		await fetch(`${base}/shutdown`, { method: 'POST' }).catch(() => {})
	}
}
console.log(results.join('\n'))
