#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { diff } from './lib/diff.mjs'
import { flowsText, outlineText } from './lib/format.mjs'
import { readTldr, TldrError } from './lib/load.mjs'
import { opsHelp, readOps } from './lib/ops.mjs'
import { applyToFile, inspectFileShape, lintFile, newFromOps, projectFile, projectPair, renderFile } from './lib/query.mjs'

import { VERSION } from './lib/version.mjs'

const HELP = `claw ${VERSION} - query, render, diff and edit .tldr files via the real tldraw editor

Every command runs through the actual tldraw editor inside the canvas app -
parsing, migration, geometry, rendering and writes are tldraw's own code,
never a reimplementation. The app launches automatically when needed.

USAGE
  claw outline <file.tldr> [--all] [--json]
      Structural skeleton: pages, containers (frames, or rectangles acting as
      screens), counts of everything else. Start here.

  claw flows <file.tldr> [--from <id>] [--no-infer]
      The arrow graph. Recorded transitions are facts from the file; endpoints
      the file doesn't record are deduced from geometry and reported separately
      with the evidence. --no-infer shows only recorded bindings.

  claw lint <file.tldr> [--json]
      Heuristic visual checks, as text: boxes poking out of their frame,
      overlapping siblings, labels wider than their box, connected arrows
      cutting through unrelated screens, unreadable label-on-fill contrast.
      Run after apply; far cheaper than rendering to look for problems.

  claw inspect <file.tldr> <shape ref> [--json]
      Everything about one shape: full props, page bounds, containing frame,
      and resolved styling (actual hex values, actual font family - custom
      slots included). The zoom-in companion to outline.

  claw render <file.tldr> [--frame <ref>] [--around <ref> --pad N] [-o out] [--scale N]
      Pixel-accurate PNG rendered by tldraw itself. Auto-fits within 2000px
      unless --scale is given. --frame renders one screen and its contents;
      --around is a tight crop of any single shape (cheap self-check).

  claw diff <new.tldr> <old.tldr>
      What changed between two canvases: screens, text, shapes and flow
      edges, with pure layout churn summarised separately.
        claw diff <file> --against <rev>  compare against a git revision
      Claw keeps no history itself. Projects that sync a canvas to code
      keep their own snapshot (e.g. copy ui.tldr to ui.accepted.tldr when
      the code matches) and diff against that.

  claw ops
      The full op reference: every op, kind, default size, and documented
      value. Read this before writing your first ops file.

  claw apply <file.tldr> <ops.json> [--dry-run]
      Modify the document through the real editor: add screens/elements, edit
      text, move, connect (with real bindings), place images/SVG, delete.
      Everything an op does not mention is untouched. Writes go through a
      live room (created on demand) - anyone watching sees them land in real
      time. --dry-run shows the report without touching anything.

  claw new <file.tldr> <ops.json> [--force]
      Build a fresh canvas from the same ops vocabulary on an empty document.

  claw layout <file.tldr> [--gap <px>] [--dry-run]
      Automatic arrangement (ELK layered): flow columns, satellite screens
      gridded under their hub, arrows routed through clear gutters and
      bands. Deterministic; contents and bound arrows travel automatically.
      --gap sets the spacing unit (default 240 - smaller is denser).
      --dry-run previews the moves without touching anything.

  claw open <file.tldr> [--launch]
      Open the file as a live canvas (full tldraw editor, multiplayer) and
      print its URL - open that in the desktop app, any browser, or a phone.
      While the canvas is open, agent edits appear on it in real time and the
      room persists to the file (debounced 2s). --launch additionally opens
      the default browser; by default the human picks the surface.

THE APP
  Commands run against the canvas app - a visible desktop window that holds
  the live state (sync rooms + the editor that executes agent commands).
  It launches automatically on first use; closing the window stops
  everything. Live docs are listed in the window's Open dialog (and at
  the URL shown by \`claw status\`, from any browser on the network).
  claw status    show whether it's running, its port, and executor state
  claw stop      stop the core (the app window will offer a retry)
  claw serve     run the bare core in the foreground with live logs
                 (debugging only - agent commands need the app's executor)

GLOBAL
  --json         machine-readable output where supported
  -h, --help     this text
  -v, --version  print version

EXIT CODES
  0 ok   1 usage error   2 unreadable/invalid file or environment problem

Warnings (unsnapped arrows, inferred containers) go to stderr and do not
affect the exit code.`

const BOOLEAN_FLAGS = new Set([
	'all',
	'json',
	'help',
	'h',
	'version',
	'v',
	'no-infer',
	'dry-run',
	'force',
	'launch',
])

function parseArgs(argv) {
	const positional = []
	const flags = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--') {
			positional.push(...argv.slice(i + 1))
			break
		}
		const isLong = arg.startsWith('--')
		const isShort = !isLong && arg.startsWith('-') && arg.length > 1
		if (!isLong && !isShort) {
			positional.push(arg)
			continue
		}
		const key = arg.slice(isLong ? 2 : 1)
		if (BOOLEAN_FLAGS.has(key)) {
			flags[key] = true
			continue
		}
		const next = argv[i + 1]
		if (next === undefined || next.startsWith('--')) flags[key] = true
		else {
			flags[key] = next
			i++
		}
	}
	return { positional, flags }
}

function emitWarnings(projection) {
	for (const w of projection?.warnings ?? []) process.stderr.write(`WARN: ${w}\n`)
}

/** Contents of `file` at a git revision. Opt-in; git is never required. */
function readFromGit(file, rev) {
	const dir = dirname(file) || '.'
	try {
		return execFileSync('git', ['-C', dir, 'show', `${rev}:./${basename(file)}`], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	} catch (err) {
		const detail = String(err.stderr ?? err.message).trim().split('\n')[0]
		throw new TldrError(
			`cannot read ${basename(file)} at ${rev}: ${detail}\n` +
				`  --against needs git. Without it, pass two paths:\n` +
				`    claw diff <new.tldr> <old.tldr>`,
			1
		)
	}
}

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2))

	if (flags.h || flags.help) {
		process.stdout.write(`${HELP}\n`)
		return 0
	}
	if (flags.v || flags.version) {
		process.stdout.write(`${VERSION}\n`)
		return 0
	}
	if (!positional.length) {
		process.stderr.write(`${HELP}\n`)
		return 1
	}

	const [command, file] = positional

	if (command === 'ops') {
		process.stdout.write(`${opsHelp()}\n`)
		return 0
	}

	// daemon lifecycle commands take no file argument
	if (command === 'status') {
		const { daemonStatus } = await import('./lib/client.mjs')
		const s = await daemonStatus()
		if (!s) {
			process.stdout.write('app: not running (launches automatically on the next command)\n')
			return 0
		}
		const h = s.health
		process.stdout.write(
			`core: running  v${h.version}  pid ${h.pid}  http://127.0.0.1:${s.port}\n` +
				`executor: ${h.executor}   rooms: ${h.rooms}   uptime: ${Math.round(h.uptimeMs / 60000)}min   requests: ${h.requestsServed}\n` +
				(h.lan?.length ? `phone (same network): ${h.lan.join('  ')}\n` : '')
		)
		return 0
	}
	if (command === 'stop') {
		const { stopDaemon } = await import('./lib/client.mjs')
		const wasRunning = await stopDaemon()
		process.stdout.write(wasRunning ? 'daemon stopped\n' : 'daemon was not running\n')
		return 0
	}
	if (command === 'serve') {
		const { spawnSync } = await import('node:child_process')
		const { DAEMON_PATH } = await import('./lib/client.mjs')
		const r = spawnSync(process.execPath, [DAEMON_PATH, '--foreground'], { stdio: 'inherit' })
		return r.status ?? 0
	}

	if (!file) throw new TldrError(`${command}: missing <file.tldr>`, 1)

	// `new` creates the file - everything else reads it first
	if (command === 'new') {
		const opsPath = positional[2]
		if (!opsPath) throw new TldrError(`new: missing <ops.json>\n\n${opsHelp()}`, 1)
		if (existsSync(file) && !flags.force) {
			throw new TldrError(
				`${file} already exists - use \`apply\` to modify it, or --force to overwrite`,
				1
			)
		}
		const ops = readOps(opsPath)
		const { report, serialized } = await newFromOps(ops)
		for (const line of report) process.stdout.write(`${line}\n`)
		writeFileSync(file, serialized, 'utf8')
		process.stdout.write(`wrote ${file}\n`)
		// open a live room on it immediately so the new canvas is watchable;
		// reset any room that survived a --force overwrite
		try {
			const { openCanvas } = await import('./lib/query.mjs')
			const { url } = await openCanvas(file, { reset: true })
			process.stdout.write(`watch live: ${url}\n`)
		} catch {}
		return 0
	}

	if (command === 'open') {
		const { openCanvas } = await import('./lib/query.mjs')
		readTldr(file) // validate before opening a room on it
		const { url } = await openCanvas(file)
		process.stdout.write(`${url}\n`)
		// Deliberately no auto-launch: the human picks their surface (desktop
		// app, browser, phone). --launch opens the default browser explicitly.
		if (flags.launch) {
			const { spawn } = await import('node:child_process')
			try {
				spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
			} catch {}
		}
		return 0
	}

	// while a live room exists for this file, it is the authority — persist it
	// before reading the file for any command. Only relevant when a daemon is
	// already up (no daemon = no rooms), so don't boot one just to flush.
	{
		const { daemonStatus } = await import('./lib/client.mjs')
		if (await daemonStatus()) {
			const { flushFile } = await import('./lib/query.mjs')
			await flushFile(file).catch(() => {})
		}
	}

	const raw = readTldr(file)

	switch (command) {
		case 'outline': {
			const projection = await projectFile(raw)
			if (flags.json) process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`)
			else process.stdout.write(`${outlineText(projection, file, { all: !!flags.all })}\n`)
			emitWarnings(projection)
			return 0
		}

		case 'flows': {
			const projection = await projectFile(raw)
			const from = flags.from && flags.from !== true ? String(flags.from) : null
			process.stdout.write(`${flowsText(projection, { from, infer: !flags['no-infer'] })}\n`)
			emitWarnings(projection)
			return 0
		}

		case 'lint': {
			const result = await lintFile(raw)
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
				return 0
			}
			if (!result.issues.length) {
				process.stdout.write(`ok: no issues found (${result.shapes} shapes checked)\n`)
				return 0
			}
			process.stdout.write(`${result.issues.length} issue(s) in ${result.shapes} shapes:\n`)
			for (const issue of result.issues) {
				process.stdout.write(`  ${issue.kind.padEnd(15)} ${issue.detail}\n`)
			}
			process.stdout.write(`(heuristics - render to confirm anything surprising)\n`)
			return 0
		}

		case 'inspect': {
			const shapeRef = positional[2]
			if (!shapeRef) throw new TldrError('inspect: missing <shape ref> (id, short id, name, or label text)', 1)
			const shape = await inspectFileShape(raw, String(shapeRef))
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(shape, null, 2)}\n`)
				return 0
			}
			const lines = []
			lines.push(`${shape.type} ${shape.id.slice(6)}${shape.name ? `  "${shape.name}"` : ''}`)
			if (shape.text) lines.push(`  text: ${JSON.stringify(shape.text)}`)
			if (shape.frame) lines.push(`  frame: ${shape.frame}`)
			if (shape.bounds) lines.push(`  bounds: ${shape.bounds.w}x${shape.bounds.h} @${shape.bounds.x},${shape.bounds.y}`)
			if (shape.rotation) lines.push(`  rotation: ${shape.rotation}`)
			if (shape.opacity !== 1) lines.push(`  opacity: ${shape.opacity}`)
			const r = shape.resolved ?? {}
			if (r.color) lines.push(`  color: ${r.color.name}${r.color.solid ? ` (${r.color.solid}, fill ${r.color.semi})` : ''}`)
			if (r.labelColor) lines.push(`  labelColor: ${r.labelColor.name}${r.labelColor.solid ? ` (${r.labelColor.solid})` : ''}`)
			if (r.font) lines.push(`  font: ${r.font.name}${r.font.family ? ` (${r.font.family})` : ''}`)
			const skip = new Set(['color', 'labelColor', 'font', 'name'])
			const rest = Object.entries(shape.props ?? {}).filter(([k]) => !skip.has(k))
			if (rest.length) lines.push(`  props: ${rest.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`)
			process.stdout.write(`${lines.join('\n')}\n`)
			return 0
		}

		case 'render': {
			const frame = flags.frame && flags.frame !== true ? String(flags.frame) : null
			const around = flags.around && flags.around !== true ? String(flags.around) : null
			const pad = flags.pad && flags.pad !== true ? Number(flags.pad) : null
			const scale = flags.scale && flags.scale !== true ? Number(flags.scale) : null
			if (scale !== null && (!Number.isFinite(scale) || scale <= 0)) {
				throw new TldrError(`--scale must be a positive number, got "${flags.scale}"`, 1)
			}
			const pngBase64 = await renderFile(raw, { frame, around, pad, scale })
			const outFlag = [flags.o, flags.out, flags.output].find((v) => v && v !== true)
			const base = outFlag
				? String(outFlag).replace(/\.(svg|png)$/i, '')
				: join(
						dirname(file),
						basename(file, extname(file)) +
							(frame ? `.${frame.slice(0, 12)}` : around ? `.${around.slice(0, 12)}.crop` : '')
					)
			const pngPath = `${base}.png`
			writeFileSync(pngPath, Buffer.from(pngBase64, 'base64'))
			process.stdout.write(`${pngPath}\n`)
			return 0
		}

		case 'diff': {
			const second = positional[2]
			let oldRaw
			let labels
			if (second) {
				oldRaw = readTldr(second)
				labels = [basename(second), basename(file)]
			} else if (flags.against && flags.against !== true) {
				const rev = String(flags.against)
				oldRaw = readFromGit(file, rev)
				labels = [`${basename(file)}@${rev}`, basename(file)]
			} else {
				throw new TldrError(
					`diff needs something to compare against:\n` +
						`    claw diff <new.tldr> <old.tldr>\n` +
						`    claw diff <file.tldr> --against <git-rev>\n` +
						`  Claw keeps no history. Sync workflows keep their own snapshot - copy\n` +
						`  the canvas (e.g. to ui.accepted.tldr) when the code matches it, and\n` +
						`  diff against that copy on the next pass.`,
					1
				)
			}
			const { before, after } = await projectPair(oldRaw, raw)
			process.stdout.write(`${diff(before, after, { labels })}\n`)
			emitWarnings(after)
			return 0
		}

		case 'apply': {
			const opsPath = positional[2]
			if (!opsPath) {
				throw new TldrError(`apply: missing <ops.json>\n\n${opsHelp()}`, 1)
			}
			const ops = readOps(opsPath)
			if (flags['dry-run']) {
				// dry-run must not touch a live room: preview statelessly
				const { report } = await applyToFile(raw, ops)
				for (const line of report) process.stdout.write(`${line}\n`)
				process.stdout.write(`(dry run - ${file} not written)\n`)
				return 0
			}
			const result = await applyToFile(raw, ops, file)
			for (const line of result.report) process.stdout.write(`${line}\n`)
			if (result.mode === 'room') {
				process.stdout.write(`applied to live canvas (persists to ${file})\n`)
				if (result.url) process.stdout.write(`watch live: ${result.url}\n`)
			} else {
				writeFileSync(file, result.serialized, 'utf8')
				process.stdout.write(`wrote ${file}\n`)
			}
			return 0
		}

		case 'layout': {
			const projection = await projectFile(raw)
			const { computeLayout } = await import('./lib/layout.mjs')
			const gap = flags.gap && flags.gap !== true ? Number(flags.gap) : null
			if (gap !== null && (!Number.isFinite(gap) || gap < 40)) {
				throw new TldrError(`--gap must be a number >= 40, got "${flags.gap}"`, 1)
			}
			const { ops, report } = await computeLayout(projection, gap ? { gapX: gap, gapY: gap } : {})
			for (const line of report) process.stdout.write(`${line}\n`)
			if (!ops.length) return 0
			if (flags['dry-run']) {
				for (const op of ops) process.stdout.write(`  ${JSON.stringify(op)}\n`)
				process.stdout.write(`(dry run - ${file} not touched)\n`)
				return 0
			}
			const result = await applyToFile(raw, ops, file)
			process.stdout.write(`applied to live canvas (persists to ${file})\n`)
			if (result.url) process.stdout.write(`watch live: ${result.url}\n`)
			emitWarnings(projection)
			return 0
		}

		default:
			throw new TldrError(`unknown command "${command}" - try --help`, 1)
	}
}

// Natural exit only (process.exitCode, never process.exit): hard-exiting while
// undici keep-alive sockets and AbortSignal timers are mid-teardown trips a
// libuv assertion on Windows (uv async.c "!(handle->flags & UV_HANDLE_CLOSING)")
// and the process dies with 0xC0000409 after doing all its work correctly.
main()
	.then((code) => {
		process.exitCode = code ?? 0
	})
	.catch((err) => {
		if (err instanceof TldrError) {
			process.stderr.write(`error: ${err.message}\n`)
			process.exitCode = err.code
			return
		}
		process.stderr.write(`internal error: ${err?.stack ?? err}\n`)
		process.exitCode = 2
	})
