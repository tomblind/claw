import { readFileSync } from 'node:fs'

export class TldrError extends Error {
	constructor(message, code = 2) {
		super(message)
		this.code = code
	}
}

/**
 * Read a .tldr file's raw text with a cheap sanity check. Real parsing,
 * validation, and schema migration happen inside the editor page
 * (tldraw's own parseTldrawJsonFile) — this only catches "not a tldr file
 * at all" early, with a friendlier error than a browser round-trip.
 */
export function readTldr(path) {
	let raw
	try {
		raw = readFileSync(path, 'utf8')
	} catch (err) {
		throw new TldrError(`cannot read ${path}: ${err.code ?? err.message}`)
	}
	raw = raw.replace(/^﻿/, '') // strip UTF-8 BOM (Windows editors, PowerShell)
	let parsed
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new TldrError(`${path} is not valid JSON: ${err.message}`)
	}
	if (!Array.isArray(parsed.records)) {
		throw new TldrError(`${path} has no "records" array — is this a .tldr file?`)
	}
	return raw
}
