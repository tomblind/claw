/**
 * Finding a character, and getting it into the drawing.
 *
 * The names people search by are 226KB of Unicode's own data, which the local
 * core serves rather than the page carrying: nothing needs it until someone
 * opens the picker, and the editor page is one self-contained file that
 * everything else in claw loads. See scripts/build-chars.mjs for where the
 * data comes from and which parts of Unicode it covers.
 *
 * Nothing in here touches React, so the searching and the inserting can be
 * tested without a dialog on screen.
 */
import * as TL from 'tldraw'
import { overlayLabelOf, plainText } from './editor-utils.js'

/** Served by the core alongside the editor page (daemon.mjs, GET /chars.json). */
const CHARS_URL = '/chars.json'
const RECENT_KEY = 'claw-recent-chars'
const RECENT_MAX = 24

let loaded = null
let loading = null

/**
 * The character table, fetched once per page.
 *
 * A failure resolves to an empty table rather than throwing, and is retried on
 * the next open: the picker is worth degrading to "type a code point" if the
 * core is not reachable, and is never worth breaking the canvas over.
 */
export function loadChars() {
	if (loaded) return Promise.resolve(loaded)
	if (loading) return loading
	loading = fetch(CHARS_URL)
		.then((r) => (r.ok ? r.json() : null))
		.then((data) => {
			loaded = normalize(data)
			return loaded
		})
		.catch(() => normalize(null))
		.finally(() => {
			loading = null
		})
	return loading
}

/** Let a caller (a test, or an embedding host) supply the table directly. */
export function setChars(data) {
	loaded = normalize(data)
	return loaded
}

function normalize(data) {
	// [character, name, group, shortcodes] as stored; widened here once so the
	// search does no per-keystroke shape juggling. The two lists stay apart in
	// the file only so `isEmoji` can be set here without a per-row flag.
	const widen = (rows, isEmoji) =>
		(Array.isArray(rows) ? rows : [])
			.filter((r) => Array.isArray(r) && typeof r[0] === 'string' && r[0])
			.map((r) => ({
				char: r[0],
				name: String(r[1] ?? ''),
				group: String(r[2] ?? ''),
				codes: r[3] ? String(r[3]).split(' ') : [],
				isEmoji,
			}))
	return {
		unicodeVersion: data?.unicodeVersion ?? '',
		notice: data?.notice ?? '',
		chars: [...widen(data?.symbols, false), ...widen(data?.emoji, true)],
	}
}

/**
 * A query that names one character outright, or null.
 *
 * Two forms, both for reaching past the blocks the table carries: a code point
 * written the way Unicode writes it (`U+2316`, `u2316`, or four to six bare
 * hex digits), and a character pasted in as itself.
 */
export function literalChar(query) {
	const q = String(query ?? '').trim()
	if (!q) return null
	const hex = /^(?:u\+?|0x|\\u)?([0-9a-f]{4,6})$/i.exec(q)
	if (hex) {
		const code = parseInt(hex[1], 16)
		// surrogate halves are not characters, and nothing is defined past this
		if (!(code >= 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return null
		try {
			return String.fromCodePoint(code)
		} catch {
			return null
		}
	}
	// a single character, counted in code points so an emoji is one thing
	return [...q].length === 1 ? q : null
}

/**
 * Does `q` appear in `text` as a whole word, with `sep` between words?
 *
 * This is the distinction that decides whether the picker is any use. Someone
 * typing "arrow" means the word, so "leftwards arrow" has to beat "arrow
 * pointing rightwards then curving upwards", which merely starts with those
 * letters. Ranking by where the match falls, rather than by whether the name
 * begins with it, is what puts the plain arrows first.
 */
function hasWord(text, q, sep) {
	if (text === q) return true
	if (text.startsWith(q + sep)) return true
	if (text.endsWith(sep + q)) return true
	return text.includes(sep + q + sep)
}

/** How well one row answers a query; higher is better, 0 means it does not. */
function score(row, q) {
	const name = row.name
	if (name === q) return 100
	let best = 0
	for (const code of row.codes) {
		if (code === q) return 95
		// shortcodes join their words with underscores, not spaces
		if (hasWord(code, q, '_')) best = Math.max(best, 75)
		else if (code.startsWith(q)) best = Math.max(best, 55)
		else if (code.includes(q)) best = Math.max(best, 25)
	}
	if (hasWord(name, q, ' ')) best = Math.max(best, 80)
	else if (name.startsWith(q) || name.includes(` ${q}`)) best = Math.max(best, 60)
	else if (name.includes(q)) best = Math.max(best, 30)
	return best
}

/**
 * Characters matching a query, best first.
 *
 * Two tie-breaks under the score, in order. A symbol beats an emoji, because a
 * generic word in a diagramming tool usually means the typographic glyph:
 * someone typing "arrow" wants an arrow before they want 🔚 "end arrow", whose
 * only advantage is a shorter name. Then the shorter name wins, which is
 * reliably the more ordinary character within a family: "leftwards arrow"
 * ahead of "leftwards arrow with double vertical stroke".
 */
export function searchChars(table, query, { limit = 300 } = {}) {
	const q = String(query ?? '').trim().toLowerCase()
	const rows = table?.chars ?? []
	if (!q) return []
	const hits = []
	for (const row of rows) {
		const s = score(row, q)
		if (s > 0) hits.push({ row, s })
	}
	hits.sort(
		(a, b) =>
			b.s - a.s ||
			(a.row.isEmoji ? 1 : 0) - (b.row.isEmoji ? 1 : 0) ||
			a.row.name.length - b.row.name.length
	)
	const out = hits.slice(0, limit).map((h) => h.row)
	// a code point or a pasted character answers itself, even when the table
	// has never heard of it
	const literal = literalChar(query)
	if (literal && !out.some((r) => r.char === literal)) {
		const known = rows.find((r) => r.char === literal)
		out.unshift(
			known ?? { char: literal, name: codePointLabel(literal), group: '', codes: [], isEmoji: false }
		)
	}
	return out
}

/** "U+2316" for a single character, for when nothing knows its name. */
export function codePointLabel(char) {
	return [...String(char)]
		.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
		.join(' ')
}

// ---------------------------------------------------------------------------
// recently used
// ---------------------------------------------------------------------------

/** The characters this browser inserted last, most recent first. */
export function recentChars() {
	try {
		const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
		return Array.isArray(raw) ? raw.filter((c) => typeof c === 'string' && c).slice(0, RECENT_MAX) : []
	} catch {
		return []
	}
}

export function rememberChar(char) {
	try {
		const next = [char, ...recentChars().filter((c) => c !== char)].slice(0, RECENT_MAX)
		localStorage.setItem(RECENT_KEY, JSON.stringify(next))
		return next
	} catch {
		// a browser with storage switched off still gets a working picker
		return recentChars()
	}
}

/** Fill out the table rows for a list of bare characters, in the order given. */
export function rowsFor(table, chars) {
	const byChar = new Map((table?.chars ?? []).map((r) => [r.char, r]))
	return chars.map(
		(c) =>
			byChar.get(c) ?? { char: c, name: codePointLabel(c), group: '', codes: [], isEmoji: false }
	)
}

// ---------------------------------------------------------------------------
// putting one into the drawing
// ---------------------------------------------------------------------------

/**
 * The shape whose text a character would be appended to, or null.
 *
 * A chip's text lives on a separate label shape rather than on the box, the
 * same redirect `set_text` makes, so clicking a character with a button
 * selected writes to the button's label and not to nothing.
 */
export function appendTargetOf(editor) {
	const selected = editor.getSelectedShapes()
	if (selected.length !== 1) return null
	const shape = selected[0]
	if (shape.type === 'geo' && !plainText(editor, shape)) {
		const overlay = overlayLabelOf(editor, shape)
		if (overlay) return overlay
	}
	if (shape.type === 'text' || shape.type === 'geo' || shape.type === 'note') return shape
	return null
}

/**
 * Put a character where the person can see it land.
 *
 * Three places, in the order of how specific the person has been about where
 * they want it. Returns what happened, so the picker can say so.
 *
 *  - typing in a shape: at the caret, which is the only place that respects a
 *    person who put the caret somewhere on purpose
 *  - one shape selected: appended to its text
 *  - otherwise: the clipboard, so a click is never a no-op
 */
export function insertChar(editor, char) {
	const rt = editor.getRichTextEditor?.()
	if (rt) {
		try {
			rt.chain().focus().insertContent(char).run()
			return { where: 'caret' }
		} catch {
			// fall through: a stale editor is no reason to lose the character
		}
	}
	const target = appendTargetOf(editor)
	if (target) {
		const existing = plainText(editor, target) ?? ''
		editor.updateShape({
			id: target.id,
			type: target.type,
			props: { richText: TL.toRichText(existing + char) },
		})
		return { where: 'shape', id: target.id }
	}
	try {
		navigator.clipboard?.writeText(char)
		return { where: 'clipboard' }
	} catch {
		return { where: 'none' }
	}
}

// ---------------------------------------------------------------------------
// :shortcode: while typing
// ---------------------------------------------------------------------------

/**
 * What a shortcode has to look like: `:` then the characters shortcodes are
 * made of, then `:`, ending right at the caret.
 *
 * Both colons are required, and a space breaks it, so ordinary text is left
 * alone. "10:30:" does not match because `30` is nobody's shortcode, and the
 * lookup below is what finally decides: an unknown code is typed through as
 * the text it is.
 */
const SHORTCODE_AT_CARET = /:([a-z0-9_+-]+):$/

let codeMap = null
let codeMapFor = null

/** Shortcode to character, built once per table. */
export function shortcodeMap(table) {
	if (codeMap && codeMapFor === table) return codeMap
	const map = new Map()
	for (const row of table?.chars ?? []) {
		for (const code of row.codes) if (!map.has(code)) map.set(code, row.char)
	}
	codeMap = map
	codeMapFor = table
	return map
}

let expanding = false

/**
 * Turn a just-completed `:shortcode:` into its character.
 *
 * Runs against the live text editor rather than the stored shape, so the
 * replacement goes through the same path as typing and the caret ends up after
 * the character instead of jumping to the end of the line.
 *
 * Returns the code it expanded, or null. Re-entry is blocked because replacing
 * the text is itself an edit, and the edit would otherwise be inspected again.
 */
export function expandShortcodeAtCaret(rt, table) {
	if (expanding || !rt?.state) return null
	const map = shortcodeMap(table)
	if (!map.size) return null
	const sel = rt.state.selection
	if (!sel.empty) return null
	const from = sel.from
	let before
	try {
		before = rt.state.doc.textBetween(sel.$from.start(), from, '\n', '\n')
	} catch {
		return null
	}
	const m = SHORTCODE_AT_CARET.exec(before)
	if (!m) return null
	const char = map.get(m[1])
	if (!char) return null
	expanding = true
	try {
		rt.chain()
			.insertContentAt({ from: from - m[0].length, to: from }, char)
			.run()
	} catch {
		return null
	} finally {
		expanding = false
	}
	return m[1]
}
