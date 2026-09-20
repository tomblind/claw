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
 * Query matching, in tiers.
 *
 * Two things have to be true at once. A generic word has to bring back the
 * plain glyph, so "arrow" finds "leftwards arrow" ahead of "arrowhead". And a
 * half-remembered name has to work, so "left arrow" finds "leftwards arrow"
 * even though those two words never appear in it in that form.
 *
 * Both fall out of asking, in order: are the query's words there exactly, in
 * this order, side by side; then the same but allowing each to be the start of
 * a longer word; then are they all there in any order; then anywhere at all.
 * "left arrow" reaches "leftwards arrow" on the second question and "left
 * right arrow" only on the third, which is the right way round.
 *
 * Unicode names hyphenate ("left-pointing magnifying glass") and shortcodes
 * use underscores, so what counts as a gap between words is passed in.
 */
const RX_ESCAPE = /[.*+?^${}()|[\]\\]/g
const esc = (s) => s.replace(RX_ESCAPE, '\\$&')

/** Compiled once per query, then run against every row. */
function queryMatcher(q, words, sep) {
	const gap = `[${sep}]`
	const notGap = `[^${sep}]`
	const phrase = words.map(esc).join(`${gap}+`)
	const loose = words.map((w) => `${esc(w)}${notGap}*`).join(`${gap}+`)
	return {
		exact: new RegExp(`(^|${gap})${phrase}($|${gap})`),
		prefix: new RegExp(`(^|${gap})${loose}`),
		// every word somewhere, in any order: "arrow left" as well as "left arrow"
		anyOrder: words.map((w) => new RegExp(`(^|${gap})${esc(w)}`)),
		// every word's stem somewhere, which is how "smile face" reaches
		// "smiling face": the two share "smil" and diverge after it, so no
		// amount of prefix matching connects them. Two characters is all that
		// is given up, and never below three, so short words stay exact.
		stems: words.map((w) => new RegExp(`(^|${gap})${esc(w.slice(0, Math.max(3, w.length - 2)))}`)),
		words,
		q,
	}
}

function tierScore(text, m) {
	if (!text) return 0
	if (text === m.q) return 100
	if (m.exact.test(text)) return 80
	if (m.prefix.test(text)) return 70
	if (m.anyOrder.every((rx) => rx.test(text))) return 60
	if (m.stems.every((rx) => rx.test(text))) return 50
	if (m.words.every((w) => text.includes(w))) return 40
	return text.includes(m.q) ? 30 : 0
}

/** How well one row answers a query; higher is better, 0 means it does not. */
function score(row, nameMatch, codeMatch) {
	const byName = tierScore(row.name, nameMatch)
	let byCode = 0
	for (const code of row.codes) {
		if (code === codeMatch.q) return 95
		// a shortcode is a weaker signal than the real name, since it is a
		// nickname: "heavy_check_mark" should not outrank the character named
		// "check mark"
		byCode = Math.max(byCode, Math.round(tierScore(code, codeMatch) * 0.9))
	}
	return Math.max(byName, byCode)
}

/**
 * Characters matching a query, best first.
 *
 * Four questions, in order, because no single number gets all of these right.
 *
 * Is it named exactly that? "left arrow" is the name of ⬅️, so nothing should
 * come before it.
 *
 * Is it a symbol? A generic word in a diagramming tool usually means the
 * typographic glyph, so "arrow" answers ← before 🏹 "bow and arrow", whose
 * only advantage is a shorter name.
 *
 * Then match quality against name length together, as one number. Separately
 * they each get a case wrong: on quality alone "left arrow with small circle"
 * beats "leftwards arrow", because it contains the words exactly rather than
 * as a prefix, and on length alone a loose match on a short name beats a good
 * one. Subtracting the length from the tier settles both, and is why ← comes
 * back for "left arrow" at all.
 *
 * Then the shorter name, for two characters that are otherwise equal.
 */
export function searchChars(table, query, { limit = 300 } = {}) {
	const q = String(query ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
	const rows = table?.chars ?? []
	if (!q) return []
	const words = q.split(' ').filter(Boolean)
	if (!words.length) return []
	// names break on spaces and hyphens ("left-pointing magnifying glass"),
	// shortcodes on underscores ("arrow_upper_left")
	const nameMatch = queryMatcher(q, words, '\\s\\-')
	const codeMatch = queryMatcher(q.replace(/ /g, '_'), words, '_\\-')
	const hits = []
	for (const row of rows) {
		const s = score(row, nameMatch, codeMatch)
		if (s > 0) hits.push({ row, s })
	}
	const named = (h) => (h.s >= 95 ? 1 : 0)
	const worth = (h) => h.s - h.row.name.length
	hits.sort(
		(a, b) =>
			named(b) - named(a) ||
			(a.row.isEmoji ? 1 : 0) - (b.row.isEmoji ? 1 : 0) ||
			worth(b) - worth(a) ||
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
/** The shape types that carry text of their own. */
const TEXT_TYPES = new Set(['text', 'geo', 'note', 'arrow'])

export function appendTargetOf(editor) {
	const selected = editor.getSelectedShapes()
	// two shapes give a character nowhere unambiguous to go
	if (selected.length !== 1) return null
	const shape = selected[0]
	if (shape.type === 'geo' && !plainText(editor, shape)) {
		const overlay = overlayLabelOf(editor, shape)
		if (overlay) return overlay
	}
	return TEXT_TYPES.has(shape.type) ? shape : null
}

/**
 * Is there anywhere for a character to go right now?
 *
 * Either text is being edited, in which case it goes at the caret, or exactly
 * one shape that holds text is selected, in which case it goes on the end of
 * that. With neither, offering the picker is offering to do nothing to the
 * drawing, so the style panel leaves the option out.
 */
export function canInsertChar(editor) {
	if (editor.getEditingShapeId()) return true
	return appendTargetOf(editor) !== null
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
