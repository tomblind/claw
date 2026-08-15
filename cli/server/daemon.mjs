#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../lib/version.mjs'
import { RoomManager, pathToRoomId } from './rooms.mjs'

/**
 * The canvas core. Runs as an owned child of the desktop app — the app IS
 * the system: window open = running, window closed = stopped. There is no
 * headless mode: agent ops execute in a hidden executor frame inside the
 * app's own webview, which registers here over a control WebSocket.
 *
 * Serves: agent HTTP API (CLI), sync rooms (app window / browsers / phone),
 * the editor page, and a status dashboard at /.
 */

const here = dirname(fileURLToPath(import.meta.url))
// PER-USER, not per-install: a core started from any copy of claw (repo
// checkout vs deployed skill) must see a core started from any other, or two
// stacks run blind to each other with separate rooms fighting over the files
const LOCKFILE = join(homedir(), '.claw-daemon.json')
const LOGFILE = join(here, '..', 'daemon.log')
const PAGE_HTML = join(here, '..', 'page', 'dist', 'index.html')
const FOREGROUND = process.argv.includes('--foreground')
const BODY_LIMIT = 128 * 1024 * 1024

// when spawned by the app, exit if the app dies without a clean shutdown
const parentArg = process.argv.indexOf('--parent-pid')
const PARENT_PID = parentArg !== -1 ? Number(process.argv[parentArg + 1]) : null

// Fixed preferred port ("CLAW" on a keypad) so phone bookmarks and PWA
// installs survive restarts; CLAW_PORT overrides, and if it's taken the core
// falls back to an OS-assigned port rather than failing.
const PREFERRED_PORT = Number(process.env.CLAW_PORT ?? 4227)

const startedAt = Date.now()
let lastActivity = Date.now()
let requestsServed = 0

/** LAN-facing IPv4s, best first: real LAN before CGNAT/VPN ranges (Tailscale). */
function lanAddresses() {
	const out = []
	for (const addrs of Object.values(networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family === 'IPv4' && !a.internal) out.push(a.address)
		}
	}
	return out.sort((a, b) => (a.startsWith('100.') ? 1 : 0) - (b.startsWith('100.') ? 1 : 0))
}

function log(msg) {
	const line = `${new Date().toISOString()} ${msg}`
	if (FOREGROUND) console.log(line)
	try {
		appendFileSync(LOGFILE, `${line}\n`)
	} catch {}
}

const rooms = new RoomManager(log)
const touch = () => {
	lastActivity = Date.now()
	requestsServed++
}

// ---------------------------------------------------------------------------
// executor: the hidden editor frame in the app's webview. One at a time;
// calls are serialized (one editor, one document loaded at a time).
// ---------------------------------------------------------------------------

let executorWs = null
let emptyTldr = null // serialized virgin document, captured at executor hello
const pending = new Map() // id -> {resolve, reject, timer}
let nextCallId = 1
let executorLock = Promise.resolve()

function executorConnected() {
	return executorWs?.readyState === 1
}

async function rawCall(method, args, timeoutMs = 120_000) {
	// tolerate the app-just-launched / page-reload window
	const attachDeadline = Date.now() + 15_000
	while (!executorConnected() && Date.now() < attachDeadline) {
		await new Promise((r) => setTimeout(r, 200))
	}
	return new Promise((resolve, reject) => {
		if (!executorConnected()) {
			reject(new Error('no executor connected - is the Claw app running?'))
			return
		}
		const id = nextCallId++
		const timer = setTimeout(() => {
			pending.delete(id)
			reject(new Error(`executor call ${method} timed out after ${timeoutMs / 1000}s`))
		}, timeoutMs)
		pending.set(id, { resolve, reject, timer })
		executorWs.send(JSON.stringify({ id, method, args }))
	})
}

/** Serialized multi-step executor task (mirrors the old peer's page mutex). */
function withExecutor(fn) {
	const run = () => fn(rawCall)
	const result = executorLock.then(run, run)
	executorLock = result.then(
		() => {},
		() => {}
	)
	return result
}

function attachExecutor(ws) {
	if (executorWs && executorWs !== ws) {
		try {
			executorWs.close()
		} catch {}
	}
	executorWs = ws
	ws.on('message', (data) => {
		let msg
		try {
			msg = JSON.parse(data.toString())
		} catch {
			return
		}
		const entry = pending.get(msg.id)
		if (!entry) return
		pending.delete(msg.id)
		clearTimeout(entry.timer)
		if (msg.error != null) entry.reject(new Error(msg.error))
		else entry.resolve(msg.result)
	})
	ws.on('close', () => {
		if (executorWs === ws) executorWs = null
		for (const [id, entry] of pending) {
			clearTimeout(entry.timer)
			entry.reject(new Error('executor disconnected mid-call'))
			pending.delete(id)
		}
		log('executor disconnected')
	})
	log('executor connected')
	// capture what an empty document serializes to (used by `new` and /api/create)
	if (!emptyTldr) {
		withExecutor(async (call) => {
			emptyTldr = await call('serialize', [])
			log('empty-document template captured')
		}).catch((err) => log(`empty-template capture failed: ${err.message}`))
	}
}

// document operations, composed like the old peer but over RPC
const host = {
	project: (tldr) =>
		withExecutor(async (call) => {
			await call('load', [tldr])
			return await call('project', [])
		}),
	projectPair: (before, after) =>
		withExecutor(async (call) => {
			await call('load', [before])
			const a = await call('project', [])
			await call('load', [after])
			const b = await call('project', [])
			return { before: a, after: b }
		}),
	render: (tldr, opts) =>
		withExecutor(async (call) => {
			await call('load', [tldr])
			return await call('render', [opts])
		}),
	apply: (tldr, ops) =>
		withExecutor(async (call) => {
			await call('load', [tldr])
			try {
				const { report } = await call('applyOps', [ops])
				const serialized = await call('serialize', [])
				return { report, serialized }
			} catch (err) {
				// an errored batch leaves partially-applied state in the editor;
				// scrub it so no later task can ever observe phantom shapes
				await call('load', [tldr]).catch(() => {})
				throw err
			}
		}),
	newDoc: (ops) =>
		withExecutor(async (call) => {
			if (!emptyTldr) throw new Error('executor not fully initialized yet - retry in a moment')
			await call('load', [emptyTldr])
			try {
				const { report } = await call('applyOps', [ops])
				const serialized = await call('serialize', [])
				return { report, serialized }
			} catch (err) {
				await call('load', [emptyTldr]).catch(() => {})
				throw err
			}
		}),
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

function required(body, key) {
	if (body?.[key] == null) {
		const err = new Error(`missing required field "${key}"`)
		err.statusCode = 400
		throw err
	}
	return body[key]
}

const api = {
	'GET /health': async () => ({
		ok: true,
		version: VERSION,
		pid: process.pid,
		startedAt,
		uptimeMs: Date.now() - startedAt,
		executor: executorConnected() ? 'connected' : 'none',
		rooms: rooms.list().length,
		requestsServed,
		lastActivity,
		lan: lanAddresses().map((ip) => `http://${ip}:${server.address()?.port}`),
	}),

	'POST /shutdown': async () => {
		log('shutdown requested')
		setTimeout(shutdown, 100)
		return { ok: true, stopping: true }
	},

	'POST /api/project': async (body) => {
		touch()
		return { projection: await host.project(required(body, 'tldr')) }
	},

	'POST /api/project-pair': async (body) => {
		touch()
		return await host.projectPair(required(body, 'before'), required(body, 'after'))
	},

	'POST /api/render': async (body) => {
		touch()
		return {
			png: await host.render(required(body, 'tldr'), {
				frame: body.frame ?? null,
				around: body.around ?? null,
				...(body.pad != null ? { pad: body.pad } : {}),
				scale: body.scale ?? null,
			}),
		}
	},

	'POST /api/apply': async (body) => {
		touch()
		const ops = required(body, 'ops')
		const path = body.path ?? null
		// Writes always go through a live room (created on demand): the room is
		// the document authority, connected viewers see the ops land in real
		// time, persistence is the room's debounced save, and there is exactly
		// one write path — no stateless-write/room race. Ops execute against
		// the room's current snapshot and load back server-side.
		if (path) {
			const entry = rooms.getOrCreate(pathToRoomId(path))
			const current = rooms.snapshotText(entry)
			const { report, serialized } = await host.apply(current, ops)
			rooms.loadText(entry, serialized)
			const port = server.address().port
			return { report, mode: 'room', url: `http://127.0.0.1:${port}/f/${entry.id}` }
		}
		// no path = preview only (--dry-run): stateless, touches nothing
		const { report, serialized } = await host.apply(required(body, 'tldr'), ops)
		return { report, serialized, mode: 'stateless' }
	},

	'POST /api/new': async (body) => {
		touch()
		return await host.newDoc(required(body, 'ops'))
	},

	'POST /api/flush': async (body) => {
		const flushed = rooms.flushPath(required(body, 'path'))
		return { ok: true, hadRoom: flushed }
	},

	'POST /api/open': async (body) => {
		touch()
		const path = required(body, 'path')
		const id = pathToRoomId(path)
		const existed = rooms.has(path)
		const entry = rooms.getOrCreate(id)
		// reset: the file on disk was legitimately replaced (`new --force`) —
		// rehydrate the live room from it instead of letting the stale room
		// stomp the fresh file on its next save
		if (existed && body.reset) {
			rooms.loadText(entry, readFileSync(entry.path, 'utf8'))
			log(`room reset from disk: ${path}`)
		}
		const port = server.address().port
		return { ok: true, id, url: `http://127.0.0.1:${port}/f/${id}` }
	},

	'GET /api/rooms': async () => ({ rooms: rooms.list() }),

	'POST /api/create': async (body) => {
		touch()
		const path = required(body, 'path')
		if (existsSync(path)) {
			const err = new Error(`${path} already exists`)
			err.statusCode = 409
			throw err
		}
		if (!emptyTldr) throw new Error('executor not fully initialized yet - retry in a moment')
		writeFileSync(path, emptyTldr, 'utf8')
		const id = pathToRoomId(path)
		rooms.getOrCreate(id)
		const port = server.address().port
		log(`created new canvas: ${path}`)
		return { ok: true, id, url: `http://127.0.0.1:${port}/f/${id}` }
	},
}

// The Claw mark: three claw-swipe strokes on a coral tile. Uniform strokes
// (not the tapered app-icon version) — they stay legible at favicon sizes.
const CLAW_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
	'<rect width="512" height="512" rx="116" fill="#D06A4E"/>' +
	'<g transform="rotate(-18 256 256)" fill="none" stroke="#fff" stroke-width="62" stroke-linecap="round">' +
	'<path d="M162 118Q112 236 162 394"/><path d="M260 82Q210 246 260 430"/><path d="M358 118Q308 236 358 394"/>' +
	'</g></svg>'
const CLAW_FAVICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(CLAW_ICON_SVG)}">`

function dashboard() {
	const mins = (ms) => Math.round(ms / 60000)
	const roomRows = rooms
		.list()
		.map(
			(r) =>
				`<tr><td><a href="/f/${r.id}">${r.file}</a></td><td>${r.clients} client${r.clients === 1 ? '' : 's'}</td><td>${r.dirty ? 'unsaved (2s)' : 'saved'}</td></tr>`
		)
		.join('')
	const roomsHtml = roomRows
		? `<h2 style="font-size:1.05rem">Live canvases</h2><table><tr><td><b>file</b></td><td><b>clients</b></td><td><b>state</b></td></tr>${roomRows}</table>`
		: `<p style="color:#777">No live canvases. Open one from the app toolbar or: <code>claw open &lt;file.tldr&gt;</code></p>`
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="manifest" href="/manifest.webmanifest">${CLAW_FAVICON}<title>Claw</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#1d1d1d}
h1{font-size:1.3rem}table{border-collapse:collapse}td{padding:.2rem .8rem .2rem 0}
button{padding:.4rem 1rem;margin-right:.5rem;cursor:pointer}</style></head><body>
<h1>Claw</h1>
<table>
<tr><td>version</td><td>${VERSION}</td></tr>
<tr><td>pid</td><td>${process.pid}</td></tr>
<tr><td>uptime</td><td>${mins(Date.now() - startedAt)} min</td></tr>
<tr><td>executor</td><td>${executorConnected() ? 'connected (app)' : 'none - agent commands unavailable'}</td></tr>
<tr><td>requests served</td><td>${requestsServed}</td></tr>
</table>
${roomsHtml}
${lanAddresses()
	.map(
		(ip) =>
			`<p style="color:#555">On your phone (same network): <code>http://${ip}:${server.address()?.port}</code></p>`
	)
	.join('')}
<p><form style="display:inline" method="post" action="/shutdown"><button>Stop</button></form></p>
<p style="color:#777">This core runs as part of the Claw app. Rooms save to their .tldr
files debounced (2s) and on every lifecycle edge.</p>
</body></html>`
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (c) => {
			size += c.length
			if (size > BODY_LIMIT) {
				reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => {
			if (!chunks.length) return resolve({})
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
			} catch {
				resolve({})
			}
		})
		req.on('error', reject)
	})
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, 'http://localhost')
	const key = `${req.method} ${url.pathname}`

	res.setHeader('access-control-allow-origin', '*')
	res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
	res.setHeader('access-control-allow-headers', 'content-type')
	if (req.method === 'OPTIONS') {
		res.writeHead(204)
		res.end()
		return
	}

	try {
		if (key === 'GET /') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
			res.end(dashboard())
			return
		}
		// editor page: /f/<roomId> for humans, /executor-page for the app's frame
		if (req.method === 'GET' && (url.pathname.startsWith('/f/') || url.pathname === '/executor-page')) {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
			res.end(readFileSync(PAGE_HTML, 'utf8'))
			return
		}
		if (key === 'GET /manifest.webmanifest') {
			res.writeHead(200, { 'content-type': 'application/manifest+json' })
			res.end(
				JSON.stringify({
					name: 'Claw',
					short_name: 'Claw',
					start_url: '/',
					display: 'standalone',
					background_color: '#fbfbfb',
					theme_color: '#C96442',
					icons: [
						{
							src: 'data:image/svg+xml,' + encodeURIComponent(CLAW_ICON_SVG),
							sizes: 'any',
							type: 'image/svg+xml',
						},
					],
				})
			)
			return
		}
		const handler = api[key]
		if (!handler) {
			res.writeHead(404, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ error: `no route: ${key}` }))
			return
		}
		const body = req.method === 'POST' ? await readBody(req) : {}
		const result = await handler(body)
		const wantsHtml = (req.headers.accept ?? '').includes('text/html')
		if (wantsHtml) {
			res.writeHead(303, { location: '/' })
			res.end()
		} else {
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify(result))
		}
	} catch (err) {
		log(`error ${key}: ${err.message}`)
		res.writeHead(err.statusCode ?? 500, { 'content-type': 'application/json' })
		res.end(JSON.stringify({ error: err.message }))
	}
})

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function anotherDaemonAlive() {
	try {
		const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'))
		const r = await fetch(`http://127.0.0.1:${lock.port}/health`, {
			signal: AbortSignal.timeout(1500),
		})
		if (r.ok) return true
	} catch {}
	return false
}

let stopping = false
async function shutdown(code = 0) {
	if (stopping) return
	stopping = true
	log('shutting down')
	try {
		rooms.closeAll()
	} catch (err) {
		log(`room close on shutdown failed: ${err.message}`)
	}
	try {
		const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'))
		if (lock.pid === process.pid) unlinkSync(LOCKFILE)
	} catch {}
	server.close(() => process.exit(code))
	setTimeout(() => process.exit(code), 3000).unref()
}

async function main() {
	if (await anotherDaemonAlive()) {
		log('another core is already running - exiting')
		process.exit(0)
	}
	try {
		writeFileSync(LOGFILE, '')
	} catch {}

	const { WebSocketServer } = await import('ws')
	const wss = new WebSocketServer({ noServer: true })
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url, 'http://localhost')
		// the app's hidden executor frame
		if (url.pathname === '/executor') {
			wss.handleUpgrade(req, socket, head, (ws) => attachExecutor(ws))
			return
		}
		// sync clients: ws://host/connect/<roomId>?sessionId=...
		if (!url.pathname.startsWith('/connect/')) {
			socket.destroy()
			return
		}
		const roomId = url.pathname.slice('/connect/'.length)
		const sessionId = url.searchParams.get('sessionId')
		if (!sessionId) {
			socket.destroy()
			return
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			try {
				const entry = rooms.getOrCreate(roomId)
				entry.lastActivity = Date.now()
				entry.room.handleSocketConnect({ sessionId, socket: ws })
				log(`room ${entry.path.split(/[\\/]/).pop()}: session joined (${entry.room.getNumActiveSessions()} total)`)
			} catch (err) {
				log(`ws connect failed: ${err.message}`)
				ws.close(1011, err.message)
			}
		})
	})

	// All interfaces, so phones/tablets on the LAN reach the dashboard and
	// live canvases directly (trusted-network tool by design).
	const started = () => {
		const port = server.address().port
		writeFileSync(LOCKFILE, JSON.stringify({ pid: process.pid, port, version: VERSION, startedAt }))
		log(`core ${VERSION} listening on http://127.0.0.1:${port} (pid ${process.pid}${PARENT_PID ? `, parent ${PARENT_PID}` : ''})`)
		for (const ip of lanAddresses()) log(`LAN: http://${ip}:${port}`)
	}
	server.once('error', (err) => {
		if (err.code === 'EADDRINUSE') {
			log(`preferred port ${PREFERRED_PORT} taken - falling back to an OS-assigned port`)
			server.listen(0, '0.0.0.0', started)
		} else {
			log(`listen failed: ${err.message}`)
			shutdown(1)
		}
	})
	server.listen(PREFERRED_PORT, '0.0.0.0', started)

	// evict clientless idle rooms; flush dirty rooms as a belt-and-braces
	setInterval(() => rooms.evictIdle(), 60_000).unref()
	setInterval(() => rooms.flushAll(), 30_000).unref()

	// if the app that owns us dies without a clean shutdown, follow it
	if (PARENT_PID) {
		setInterval(() => {
			try {
				process.kill(PARENT_PID, 0)
			} catch {
				log(`parent app (pid ${PARENT_PID}) is gone - shutting down`)
				shutdown(0)
			}
		}, 10_000).unref()
	}

	for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
		process.on(sig, () => shutdown(0))
	}
	process.on('uncaughtException', (err) => {
		log(`uncaught: ${err.stack ?? err}`)
		shutdown(1)
	})
	process.on('unhandledRejection', (err) => {
		log(`unhandled rejection: ${err?.stack ?? err}`)
	})
}

main()
