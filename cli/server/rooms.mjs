import * as tlschema from '@tldraw/tlschema'

const { createTLSchema } = tlschema
import { TLSocketRoom } from '@tldraw/sync-core'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Live sync rooms — one per .tldr file. While a room is open, the ROOM is the
 * authority for that document; the file on disk is its persistence, written
 * debounced and on every lifecycle edge (last disconnect, eviction, shutdown).
 *
 * Room ids are base64url-encoded absolute file paths, so the mapping is
 * stateless and survives daemon restarts.
 */

const SAVE_DEBOUNCE_MS = 2_000
const ROOM_IDLE_MS = Number(process.env.TLDR_ROOM_IDLE_MS ?? 10 * 60 * 1000)

/**
 * One file must map to exactly one room, no matter how its path is spelled.
 * Windows paths have many spellings (forward/back slashes, letter case, 8.3
 * names) and different clients produce different ones — the desktop app's
 * dialogs return forward slashes, node's resolve() returns backslashes. Two
 * spellings once produced two live rooms silently fighting over one file.
 *
 * realpathSync.native canonicalizes separators, symlinks, AND on-disk casing.
 * For not-yet-existing files (create), canonicalize the parent instead.
 */
export function canonicalPath(path) {
	const abs = resolve(String(path))
	try {
		return realpathSync.native(abs)
	} catch {
		try {
			return join(realpathSync.native(dirname(abs)), basename(abs))
		} catch {
			return abs
		}
	}
}

export const pathToRoomId = (path) => Buffer.from(canonicalPath(path), 'utf8').toString('base64url')
export const roomIdToPath = (id) => Buffer.from(id, 'base64url').toString('utf8')

// register claw's reserved custom color slots BEFORE any document validates:
// the sync server parses .tldr files on room hydrate, and a shape using
// custom-N must pass the enum check here just like in the editor pages
const CUSTOM_COLOR_SLOTS = Array.from({ length: 24 }, (_, i) => `custom-${i + 1}`)
const CUSTOM_FONT_SLOTS = Array.from({ length: 8 }, (_, i) => `custom-${i + 1}`)
// DefaultLabelColorStyle isn't a root export; the same enum instance is
// reachable through any shape-props object that uses it
for (const styleProp of [
	tlschema.DefaultColorStyle,
	tlschema.DefaultLabelColorStyle,
	tlschema.geoShapeProps?.labelColor,
	tlschema.arrowShapeProps?.labelColor,
]) {
	try {
		styleProp?.addValues?.(...CUSTOM_COLOR_SLOTS)
	} catch {}
}
try {
	tlschema.DefaultFontStyle?.addValues?.(...CUSTOM_FONT_SLOTS)
} catch {}

const schema = createTLSchema()

/** .tldr file text -> array of migrated document records. */
function recordsFromTldr(raw) {
	const file = JSON.parse(raw.replace(/^﻿/, ''))
	if (!Array.isArray(file.records)) throw new Error('no "records" array - not a .tldr file')
	const store = Object.fromEntries(file.records.map((r) => [r.id, r]))
	const migrated = schema.migrateStoreSnapshot({ schema: file.schema, store })
	if (migrated.type !== 'success') {
		throw new Error(`tldraw schema migration failed: ${migrated.reason ?? migrated.type}`)
	}
	return Object.values(migrated.value)
}

/** Room snapshot -> .tldr file text (matches what tldraw's serializer produces). */
function tldrFromSnapshot(snapshot) {
	const records = snapshot.documents
		.map((d) => d.state)
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	return JSON.stringify({
		tldrawFileFormatVersion: 1,
		schema: schema.serialize(),
		records,
	})
}

export class RoomManager {
	#rooms = new Map() // roomId -> entry
	#log

	constructor(log = () => {}) {
		this.#log = log
	}

	list() {
		return [...this.#rooms.values()].map((e) => ({
			id: e.id,
			path: e.path,
			file: basename(e.path),
			clients: e.room.getNumActiveSessions(),
			dirty: e.dirty,
			openedAt: e.openedAt,
			agentWriteAt: e.agentWriteAt ?? 0,
		}))
	}

	has(path) {
		return this.#rooms.has(pathToRoomId(path))
	}

	getByPath(path) {
		return this.#rooms.get(pathToRoomId(path)) ?? null
	}

	/** Open (or return) the live room for a file. */
	getOrCreate(rawRoomId) {
		// re-canonicalize: ids minted by clients may encode any path spelling,
		// and every spelling must land on the same room
		const roomId = pathToRoomId(roomIdToPath(rawRoomId))
		const existing = this.#rooms.get(roomId)
		if (existing) return existing

		const path = roomIdToPath(roomId)
		if (!existsSync(path)) throw new Error(`file not found: ${path}`)
		const records = recordsFromTldr(readFileSync(path, 'utf8'))

		const entry = {
			id: roomId,
			path,
			dirty: false,
			openedAt: Date.now(),
			lastActivity: Date.now(),
			keepaliveAt: 0, // shell tabs pinging "still displayed" (not real activity)
			agentWriteAt: 0, // last server-side agent write (apply/new via loadText)
			saveTimer: null,
			room: null,
		}

		entry.room = new TLSocketRoom({
			schema,
			initialSnapshot: {
				clock: 0,
				documents: records.map((state) => ({ state, lastChangedClock: 0 })),
				schema: schema.serialize(),
			},
			onDataChange: () => {
				entry.dirty = true
				entry.lastActivity = Date.now()
				clearTimeout(entry.saveTimer)
				entry.saveTimer = setTimeout(() => this.flushEntry(entry), SAVE_DEBOUNCE_MS)
			},
			onSessionRemoved: (room, args) => {
				entry.lastActivity = Date.now()
				this.#log(`room ${basename(path)}: session left (${args.numSessionsRemaining} remain)`)
				if (args.numSessionsRemaining === 0) this.flushEntry(entry)
			},
			log: {
				warn: (...a) => this.#log(`room warn: ${a.join(' ')}`),
				error: (...a) => this.#log(`room error: ${a.join(' ')}`),
			},
		})

		this.#rooms.set(roomId, entry)
		this.#log(`room opened: ${basename(path)} (${records.length} records)`)
		return entry
	}

	flushEntry(entry) {
		clearTimeout(entry.saveTimer)
		entry.saveTimer = null
		if (!entry.dirty) return false
		try {
			const text = tldrFromSnapshot(entry.room.getCurrentSnapshot())
			// write-then-rename so a crash mid-write can't corrupt the file
			const tmp = `${entry.path}.tldr-tmp`
			writeFileSync(tmp, text, 'utf8')
			renameSync(tmp, entry.path)
			entry.dirty = false
			this.#log(`room saved: ${basename(entry.path)}`)
			return true
		} catch (err) {
			this.#log(`room save FAILED for ${entry.path}: ${err.message}`)
			return false
		}
	}

	/** Flush one file's room if it exists. Safe no-op otherwise. */
	flushPath(path) {
		const entry = this.getByPath(path)
		if (entry) this.flushEntry(entry)
		return !!entry
	}

	/** Current room state as .tldr text (no disk round-trip). */
	snapshotText(entry) {
		return tldrFromSnapshot(entry.room.getCurrentSnapshot())
	}

	/**
	 * Replace a live room's document with new .tldr text (the write path for
	 * agent ops: executor applies ops to the snapshot, result loads back here
	 * and the server broadcasts it to every connected client). Server-side,
	 * so there is no client push to await or verify.
	 */
	loadText(entry, tldrText) {
		const records = recordsFromTldr(tldrText)
		entry.room.loadSnapshot({
			clock: entry.room.getCurrentDocumentClock() + 1,
			documents: records.map((state) => ({ state, lastChangedClock: 0 })),
			schema: schema.serialize(),
		})
		entry.dirty = true
		entry.lastActivity = Date.now()
		entry.agentWriteAt = Date.now()
		clearTimeout(entry.saveTimer)
		entry.saveTimer = setTimeout(() => this.flushEntry(entry), SAVE_DEBOUNCE_MS)
	}

	flushAll() {
		for (const entry of this.#rooms.values()) this.flushEntry(entry)
	}

	/** Close rooms idle past the limit (no clients, no changes, no shell tab). */
	evictIdle() {
		for (const [id, entry] of this.#rooms) {
			const lastSeen = Math.max(entry.lastActivity, entry.keepaliveAt ?? 0)
			const idle = Date.now() - lastSeen > ROOM_IDLE_MS
			if (idle && entry.room.getNumActiveSessions() === 0) {
				this.flushEntry(entry)
				entry.room.close()
				this.#rooms.delete(id)
				this.#log(`room evicted (idle): ${basename(entry.path)}`)
			}
		}
	}

	/** Explicitly close one room (tab ✕): flush to disk, drop from the map. */
	closePath(path) {
		const entry = this.getByPath(path)
		if (!entry) return false
		this.flushEntry(entry)
		entry.room.close()
		this.#rooms.delete(entry.id)
		this.#log(`room closed (tab): ${basename(entry.path)}`)
		return true
	}

	closeAll() {
		this.flushAll()
		for (const [id, entry] of this.#rooms) {
			entry.room.close()
			this.#rooms.delete(id)
		}
	}
}
