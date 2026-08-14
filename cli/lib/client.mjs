import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TldrError } from './load.mjs'
import { VERSION } from './version.mjs'

/**
 * CLI-side client for the canvas core. The core runs inside the desktop app:
 * the app window IS the system (visible, closeable, owns the Node core and
 * the executor editor). Any CLI command launches the app if it isn't running.
 *
 * The CLI never spawns a bare (appless) core — with no app there's no
 * executor, so document commands would fail anyway; erroring up front is
 * clearer. A bare core someone started by hand (`claw serve`, the e2e
 * harness) is still used if found.
 */

const here = dirname(fileURLToPath(import.meta.url))
const LOCKFILE = join(here, '..', '.claw-daemon.json')
const DAEMON = join(here, '..', 'server', 'daemon.mjs')
const APP_DIST = join(here, '..', '..', 'app', 'dist', 'claw')

function findAppExe() {
	const arm = process.arch === 'arm64'
	const names =
		{
			win32: ['claw-win_x64.exe'],
			darwin: arm
				? ['claw-mac_arm64', 'claw-mac_universal', 'claw-mac_x64']
				: ['claw-mac_x64', 'claw-mac_universal'],
			linux: arm ? ['claw-linux_arm64', 'claw-linux_x64'] : ['claw-linux_x64'],
		}[process.platform] ?? []
	for (const name of names) {
		const path = join(APP_DIST, name)
		if (existsSync(path)) return path
	}
	return null
}

function readLock() {
	try {
		return JSON.parse(readFileSync(LOCKFILE, 'utf8'))
	} catch {
		return null
	}
}

async function health(port, timeoutMs = 1500) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!r.ok) return null
		return await r.json()
	} catch {
		return null
	}
}

function launchApp(exe) {
	// GUI executable: detaching is safe here (the console-host trap only bites
	// console-subsystem children). cwd must be the exe's dir for resources.neu.
	const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: dirname(exe) })
	child.unref()
}

async function waitForCore({ deadlineMs = 30_000, wantExecutor = false } = {}) {
	const start = Date.now()
	let last = null
	while (Date.now() - start < deadlineMs) {
		const lock = readLock()
		if (lock?.port) {
			const h = await health(lock.port)
			if (h?.ok) {
				last = { ...lock, health: h }
				if (!wantExecutor || h.executor === 'connected') return last
			}
		}
		await new Promise((r) => setTimeout(r, 250))
	}
	if (last) return last // core is up, executor never arrived; calls will explain
	throw new TldrError(
		`the Claw app did not start within ${deadlineMs / 1000}s - check ${join(here, '..', 'daemon.log')} and the app's neutralinojs.log`,
		2
	)
}

/** Running core info, launching the app as needed. */
export async function ensureDaemon() {
	const lock = readLock()
	const appExe = findAppExe()
	if (lock?.port) {
		const h = await health(lock.port)
		if (h?.ok) {
			if (h.version !== VERSION) {
				if (h.executor === 'connected') {
					// the app owns this core; killing it under the window breaks the
					// app's port binding — the user has to cycle the app itself
					throw new TldrError(
						`the Claw app is running version ${h.version} but this CLI is ${VERSION} - quit and relaunch the app to update`,
						2
					)
				}
				// bare dev core: retire it and start fresh
				process.stderr.write(`note: restarting core (running ${h.version}, CLI is ${VERSION})\n`)
				try {
					await fetch(`http://127.0.0.1:${lock.port}/shutdown`, {
						method: 'POST',
						signal: AbortSignal.timeout(3000),
					})
				} catch {}
				const gone = Date.now() + 5000
				while (Date.now() < gone && (await health(lock.port))) {
					await new Promise((r) => setTimeout(r, 150))
				}
			} else if (h.executor === 'connected' || !appExe) {
				return { ...lock, health: h }
			} else {
				// core alive but no executor (bare dev core): the app adopts a
				// running core rather than starting its own, so launching it heals this
				launchApp(appExe)
				return await waitForCore({ wantExecutor: true })
			}
		}
	}
	if (!appExe) {
		throw new TldrError(
			`the Claw app is not built (no executable in ${APP_DIST}).\n` +
				`  Build it: \`npx @neutralinojs/neu build --release\` in the app/ directory.\n` +
				`  (Core development only: \`claw serve\` runs a bare core in the foreground.)`,
			2
		)
	}
	launchApp(appExe)
	return await waitForCore({ wantExecutor: true })
}

/** Info about a running core without starting anything. */
export async function daemonStatus() {
	const lock = readLock()
	if (!lock?.port) return null
	const h = await health(lock.port)
	return h?.ok ? { ...lock, health: h } : null
}

/** POST to the core (launching the app if needed) and return the parsed response. */
export async function call(path, body, { timeoutMs = 180_000 } = {}) {
	const daemon = await ensureDaemon()
	let response
	try {
		response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body ?? {}),
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (err) {
		throw new TldrError(`core call ${path} failed: ${err.message}`, 2)
	}
	const payload = await response.json().catch(() => ({}))
	if (!response.ok) {
		throw new TldrError(payload.error ?? `core returned ${response.status} for ${path}`, 2)
	}
	return payload
}

export async function stopDaemon() {
	const status = await daemonStatus()
	if (!status) return false
	try {
		await fetch(`http://127.0.0.1:${status.port}/shutdown`, {
			method: 'POST',
			signal: AbortSignal.timeout(3000),
		})
	} catch {}
	const gone = Date.now() + 5000
	while (Date.now() < gone) {
		if (!(await health(status.port))) return true
		await new Promise((r) => setTimeout(r, 150))
	}
	return false
}

export { DAEMON as DAEMON_PATH }
