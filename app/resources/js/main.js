/**
 * Claw: the canvas app. The window IS the system: it spawns and owns the
 * Node core (HTTP + sync rooms) as a child, hosts the hidden executor frame
 * that services agent commands, and takes the whole thing down when closed.
 * The shell itself stays deliberately dumb — document features live in the
 * core and the editor page; this window supplies native file dialogs, a
 * taskbar icon, and the executor's webview.
 */
Neutralino.init()

const $ = (id) => document.getElementById(id)
const overlay = (msg, retry = false) => {
	$('overlay-msg').textContent = msg
	$('retry').style.display = retry ? 'inline-block' : 'none'
	$('overlay').classList.add('show')
	try {
		Neutralino.debug.log(`shell: ${msg}`, 'ERROR')
	} catch {}
}
window.addEventListener('unhandledrejection', (e) => {
	try {
		Neutralino.debug.log(`shell unhandled: ${e.reason?.message ?? e.reason}`, 'ERROR')
	} catch {}
})
window.addEventListener('error', (e) => {
	try {
		Neutralino.debug.log(`shell error: ${e.error?.message ?? e.message}`, 'ERROR')
	} catch {}
})
const overlayHide = () => $('overlay').classList.remove('show')

let cliDir = null
let daemon = null // { port }

// ---------------------------------------------------------------------------
// locating the cli directory (shell lives in <skill>/app or <skill>/app/dist/…)
// ---------------------------------------------------------------------------
async function findCliDir() {
	const roots = [NL_PATH, NL_CWD]
	const ups = ['/../cli', '/../../cli', '/../../../cli', '/../../../../cli', '/cli']
	for (const root of roots) {
		for (const up of ups) {
			const candidate = (root + up).replaceAll('\\', '/')
			try {
				await Neutralino.filesystem.getStats(candidate + '/server/daemon.mjs')
				return candidate
			} catch {}
		}
	}
	throw new Error(
		'cannot locate the claw cli directory relative to ' + NL_PATH
	)
}

// ---------------------------------------------------------------------------
// daemon lifecycle (mirror of lib/client.mjs, in shell form)
// ---------------------------------------------------------------------------
async function readLock() {
	try {
		// per-user lockfile, matching the core (never per-install)
		const home =
			(await Neutralino.os.getEnv('USERPROFILE')) || (await Neutralino.os.getEnv('HOME'))
		const raw = await Neutralino.filesystem.readFile(home + '/.claw-daemon.json')
		return JSON.parse(raw)
	} catch {
		return null
	}
}

async function health(port) {
	try {
		const ctl = new AbortController()
		const t = setTimeout(() => ctl.abort(), 1500)
		const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal })
		clearTimeout(t)
		return r.ok ? await r.json() : null
	} catch {
		return null
	}
}

async function findNode() {
	// GUI-launched processes can have a leaner PATH than a terminal; probe,
	// then fall back to the standard install locations.
	try {
		const probe = await Neutralino.os.execCommand('node --version')
		if (probe.exitCode === 0) return 'node'
		Neutralino.debug.log(`shell: node probe failed: ${JSON.stringify(probe)}`, 'ERROR')
	} catch (err) {
		Neutralino.debug.log(`shell: node probe threw: ${err.message}`, 'ERROR')
	}
	for (const candidate of [
		'C:/Program Files/nodejs/node.exe',
		'C:/Program Files (x86)/nodejs/node.exe',
		'/usr/local/bin/node',
		'/opt/homebrew/bin/node',
	]) {
		try {
			await Neutralino.filesystem.getStats(candidate)
			return `"${candidate}"`
		} catch {}
	}
	throw new Error('node.js not found - install node or add it to PATH')
}

async function ensureDaemon() {
	const lock = await readLock()
	if (lock?.port && (await health(lock.port))) return { port: lock.port }
	overlay('Starting the canvas core…')
	const nodeCmd = await findNode()
	// --parent-pid: the core follows this window down if it dies uncleanly
	const spawned = await Neutralino.os.spawnProcess(
		`${nodeCmd} "${cliDir}/server/daemon.mjs" --parent-pid ${NL_PID}`
	)
	Neutralino.debug.log(`shell: spawned ${JSON.stringify(spawned)} via ${nodeCmd}`, 'INFO')
	const deadline = Date.now() + 20000
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 300))
		const fresh = await readLock()
		if (fresh?.port && (await health(fresh.port))) return { port: fresh.port }
	}
	throw new Error('the core did not start (is node on PATH? check cli/daemon.log)')
}

const base = () => `http://127.0.0.1:${daemon.port}`

// ---------------------------------------------------------------------------
// native dialog bridge: the served shell (inside #frame) posts a request,
// this window shows the OS dialog Neutralino owns, and posts the path back
// ---------------------------------------------------------------------------
const TLDR_FILTERS = [
	{ name: 'tldraw canvas', extensions: ['tldr'] },
	{ name: 'All files', extensions: ['*'] },
]
window.addEventListener('message', async (e) => {
	const msg = e.data
	if (!msg || !msg.reqId) return
	try {
		if (msg.type === 'claw-open-dialog') {
			const picked = await Neutralino.os.showOpenDialog('Open canvas', { filters: TLDR_FILTERS })
			e.source.postMessage(
				{ type: 'claw-dialog-result', reqId: msg.reqId, path: picked?.[0] ?? null },
				'*'
			)
		} else if (msg.type === 'claw-save-dialog') {
			let path = await Neutralino.os.showSaveDialog('New canvas', {
				filters: [{ name: 'tldraw canvas', extensions: ['tldr'] }],
			})
			if (path && !/\.tldr$/i.test(path)) path += '.tldr'
			e.source.postMessage(
				{ type: 'claw-dialog-result', reqId: msg.reqId, path: path || null },
				'*'
			)
		}
	} catch (err) {
		Neutralino.debug.log(`shell dialog bridge: ${err.message}`, 'ERROR')
		try {
			e.source.postMessage({ type: 'claw-dialog-result', reqId: msg.reqId, path: null }, '*')
		} catch {}
	}
})

$('retry').addEventListener('click', () => {
	overlayHide()
	boot()
})

// died-core recovery
setInterval(async () => {
	if (!daemon) return
	const ok = await health(daemon.port)
	if (!ok) {
		daemon = null
		$('executor').src = 'about:blank'
		$('frame').src = 'about:blank'
		overlay('The canvas core stopped.', true)
	}
}, 10000)

// closing the window shuts the whole system down (rooms flush to disk first)
Neutralino.events.on('windowClose', async () => {
	try {
		if (daemon) {
			const ctl = new AbortController()
			const t = setTimeout(() => ctl.abort(), 3000)
			await fetch(`${base()}/shutdown`, { method: 'POST', signal: ctl.signal })
			clearTimeout(t)
		}
	} catch {}
	Neutralino.app.exit()
})

// ---------------------------------------------------------------------------
async function boot() {
	try {
		cliDir = cliDir ?? (await findCliDir())
		daemon = await ensureDaemon()
		// the hidden editor that services agent commands; registers with the
		// core over ws as soon as it mounts
		$('executor').src = `${base()}/executor-page?executor=1`
		overlayHide()
		// the served shell: tab bar + modals + canvas, same UI as a browser
		$('frame').src = `${base()}/?app=1`
		const info = await health(daemon.port)
		Neutralino.window.setTitle(`Claw – v${info?.version ?? '?'}`)
	} catch (err) {
		overlay(String(err.message ?? err), true)
	}
}
boot()
