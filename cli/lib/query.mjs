import { resolve } from 'node:path'
import { call } from './client.mjs'

/**
 * All document operations go over localhost HTTP to the core, which executes
 * them in the app's executor editor.
 *
 * Rooms: while a file has a live sync room, the room is the authority.
 * `flushFile` persists it before any file-based read, and `applyToFile`
 * sends the path so the daemon can route ops through the live room.
 */

/** Persist the file's live room to disk if one exists. Call before reading. */
export async function flushFile(path) {
	return await call('/api/flush', { path: resolve(path) })
}

export async function openCanvas(path, { reset = false } = {}) {
	return await call('/api/open', { path: resolve(path), reset })
}

export async function projectFile(tldrText) {
	return (await call('/api/project', { tldr: tldrText })).projection
}

export async function projectPair(oldText, newText) {
	return await call('/api/project-pair', { before: oldText, after: newText })
}

export async function renderFile(tldrText, { frame = null, scale = null } = {}) {
	return (await call('/api/render', { tldr: tldrText, frame, scale })).png
}

export async function applyToFile(tldrText, ops, path = null) {
	return await call('/api/apply', {
		tldr: tldrText,
		ops,
		path: path ? resolve(path) : null,
	})
}

export async function newFromOps(ops) {
	return await call('/api/new', { ops })
}
