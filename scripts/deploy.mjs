#!/usr/bin/env node
/**
 * Deploy the working tree to the live skill location Claude Code reads.
 *
 * The repo is the source of truth; ~/.claude/skills/claw is the installed
 * copy that agents and the `claw` command actually run. Incremental: only
 * files whose size or mtime changed are copied, and files that vanished from
 * the repo are removed from the target — except the running core's state.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const DST = join(homedir(), '.claude', 'skills', 'claw')

// never traverse (repo/dev plumbing)
const EXCLUDE_DIRS = new Set(['.git', '.tmp'])
// never copy over, never delete from the target (live core's runtime state)
const isProtected = (name) =>
	name === '.claw-daemon.json' || name === '.tldr-browser.json' || name.endsWith('.log')

// refuse to deploy over a junction/symlink - that would write back into a repo
const existing = existsSync(DST) ? lstatSync(DST) : null
if (existing?.isSymbolicLink()) {
	console.error(`${DST} is a junction/symlink - remove it first (cmd /c rmdir "${DST}"), then re-run`)
	process.exit(1)
}

let copied = 0
let deleted = 0
let skipped = 0

function syncDir(src, dst) {
	mkdirSync(dst, { recursive: true })
	const srcEntries = readdirSync(src, { withFileTypes: true })
	const srcNames = new Set()
	for (const entry of srcEntries) {
		if (entry.isDirectory() && EXCLUDE_DIRS.has(entry.name)) continue
		if (isProtected(entry.name)) continue
		srcNames.add(entry.name)
		const s = join(src, entry.name)
		const d = join(dst, entry.name)
		if (entry.isDirectory()) {
			syncDir(s, d)
			continue
		}
		const sStat = statSync(s)
		let dStat = null
		try {
			dStat = statSync(d)
		} catch {}
		if (dStat?.isDirectory()) {
			rmSync(d, { recursive: true, force: true })
			dStat = null
		}
		// copy if new, size changed, or source is newer (2s slack for FAT-ish mtimes)
		if (!dStat || dStat.size !== sStat.size || sStat.mtimeMs > dStat.mtimeMs + 2000) {
			copyFileSync(s, d)
			copied++
		} else {
			skipped++
		}
	}
	// remove target entries that no longer exist in the repo
	for (const entry of readdirSync(dst, { withFileTypes: true })) {
		if (srcNames.has(entry.name)) continue
		if (isProtected(entry.name)) continue
		rmSync(join(dst, entry.name), { recursive: true, force: true })
		deleted++
	}
}

const started = Date.now()
syncDir(SRC, DST)
console.log(
	`deployed ${relative(homedir(), SRC)} -> ${relative(homedir(), DST)}: ` +
		`${copied} copied, ${deleted} removed, ${skipped} unchanged (${((Date.now() - started) / 1000).toFixed(1)}s)`
)
console.log('note: if the deployed core version changed, quit and relaunch the Claw app')
