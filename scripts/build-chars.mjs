/**
 * Build the character data the insert-character picker searches.
 *
 * Maintainer-only, and run by hand: Unicode publishes once a year, so the
 * output is checked in and the build itself never touches the network. Run it
 * after a Unicode release, or to change which symbol blocks are carried.
 *
 *   node scripts/build-chars.mjs
 *
 * Three sources, all fetched here rather than at run time:
 *  - emoji-test.txt   the emoji, their standard names, and their groups
 *  - UnicodeData.txt  every other character's standard name
 *  - emojibase        the :shortcode: spellings people already type
 *
 * Skin-tone variants are left out. They would put six near-identical rows in
 * front of anyone searching "thumbs up", and choosing a tone wants a control
 * of its own rather than six search hits.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'cli', 'page', 'data', 'chars.json')

const EMOJI_TEST = 'https://unicode.org/Public/emoji/latest/emoji-test.txt'
const UNICODE_DATA = 'https://unicode.org/Public/UNIDATA/UnicodeData.txt'
const SHORTCODES = 'https://cdn.jsdelivr.net/npm/emojibase-data@16/en/shortcodes/github.json'

/**
 * The symbol blocks worth carrying, and what to call each group in the UI.
 *
 * This is the whole judgement call in the file. Unicode is 150,000 characters
 * and almost all of them are scripts and ideographs that no interface mockup
 * reaches for; carrying their names would cost megabytes to make "grinning"
 * compete with a Han radical. These are the blocks a person drawing a screen
 * actually wants, and anything outside them is still reachable by typing its
 * code point into the search box.
 */
const BLOCKS = [
	[0x00a1, 0x00ff, 'Latin'],
	[0x0100, 0x017f, 'Latin'],
	[0x0370, 0x03ff, 'Greek'],
	[0x2010, 0x205e, 'Punctuation'],
	[0x2070, 0x209f, 'Super & subscript'],
	[0x20a0, 0x20bf, 'Currency'],
	[0x2100, 0x214f, 'Letterlike'],
	[0x2150, 0x218b, 'Numbers'],
	[0x2190, 0x21ff, 'Arrows'],
	[0x2200, 0x22ff, 'Maths'],
	[0x2300, 0x23ff, 'Technical'],
	[0x2400, 0x2426, 'Technical'],
	[0x2460, 0x24ff, 'Numbers'],
	[0x2500, 0x257f, 'Box drawing'],
	[0x2580, 0x259f, 'Blocks'],
	[0x25a0, 0x25ff, 'Geometric'],
	[0x2600, 0x26ff, 'Symbols'],
	[0x2700, 0x27bf, 'Dingbats'],
	[0x27c0, 0x27ef, 'Maths'],
	[0x27f0, 0x27ff, 'Arrows'],
	[0x2900, 0x297f, 'Arrows'],
	[0x2980, 0x29ff, 'Maths'],
	[0x2a00, 0x2aff, 'Maths'],
	[0x2b00, 0x2bff, 'Symbols'],
]

/** Skin-tone modifiers, and the variation selector that only says "draw it in colour". */
const SKIN_TONES = new Set([0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff])

async function text(url) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`${url} -> ${res.status}`)
	return res.text()
}

function blockOf(code) {
	for (const [lo, hi, name] of BLOCKS) {
		if (code >= lo && code <= hi) return name
	}
	return null
}

/** emoji-test.txt: "1F600 ; fully-qualified # 😀 E1.0 grinning face", under "# group:" headings. */
function parseEmoji(src) {
	const out = []
	let group = ''
	for (const line of src.split('\n')) {
		const heading = /^#\s*group:\s*(.+?)\s*$/.exec(line)
		if (heading) {
			group = heading[1]
			continue
		}
		const row = /^([0-9A-F ]+);\s*fully-qualified\s*#\s*(\S+)\s+E[\d.]+\s+(.+?)\s*$/.exec(line)
		if (!row) continue
		// "Component" is skin tones and hair colours on their own, which are not
		// characters anyone inserts by themselves
		if (group === 'Component') continue
		const codes = row[1].trim().split(/\s+/).map((h) => parseInt(h, 16))
		if (codes.some((c) => SKIN_TONES.has(c))) continue
		out.push({ char: row[2], name: row[3], group, key: keyOf(codes) })
	}
	return out
}

/** The key emojibase uses: UPPERCASE hex code points joined by hyphens, with FE0F dropped. */
function keyOf(codes) {
	return codes
		.filter((c) => c !== 0xfe0f)
		.map((c) => c.toString(16).toUpperCase())
		.join('-')
}

/** UnicodeData.txt: "2190;LEFTWARDS ARROW;Sm;0;ON;;;;;N;LEFT ARROW;;;;" */
function parseSymbols(src) {
	const out = []
	for (const line of src.split('\n')) {
		if (!line) continue
		const f = line.split(';')
		const code = parseInt(f[0], 16)
		if (!Number.isFinite(code)) continue
		const group = blockOf(code)
		if (!group) continue
		let name = f[1]
		// a handful of old characters carry "<control>" and keep their real name
		// in the Unicode 1.0 field instead
		if (name.startsWith('<')) name = f[10] || ''
		if (!name) continue
		out.push({ char: String.fromCodePoint(code), name: name.toLowerCase(), group })
	}
	return out
}

const [emojiSrc, unicodeSrc, shortcodeSrc] = await Promise.all([
	text(EMOJI_TEST),
	text(UNICODE_DATA),
	text(SHORTCODES),
])

const version = /^# Version:\s*(.+)$/m.exec(emojiSrc)?.[1]?.trim() ?? 'unknown'
const shortcodes = JSON.parse(shortcodeSrc)
const emoji = parseEmoji(emojiSrc)
const symbols = parseSymbols(unicodeSrc)

// the emoji entry wins any code point both files describe: "sunny" beats
// "black sun with rays", and the emoji carries a shortcode
const claimed = new Set(emoji.map((e) => e.char))

const emojiRows = emoji.map((e) => {
	const sc = shortcodes[e.key]
	const codes = sc ? (Array.isArray(sc) ? sc : [sc]) : []
	return codes.length ? [e.char, e.name, e.group, codes.join(' ')] : [e.char, e.name, e.group]
})
const symbolRows = symbols.filter((s) => !claimed.has(s.char)).map((s) => [s.char, s.name, s.group])

const data = {
	unicodeVersion: version,
	// Unicode's licence asks that this travels with data taken from their files
	notice:
		'Character names and emoji groupings are from the Unicode Character Database, ' +
		'Copyright (c) 1991-2025 Unicode, Inc. Distributed under the Unicode License v3 ' +
		'(https://www.unicode.org/license.txt). Shortcodes from emojibase (MIT).',
	// Two lists rather than one, because the search ranks them differently: a
	// generic word like "arrow" in a diagramming tool usually means the
	// typographic glyph, so a symbol wins an otherwise equal match against an
	// emoji. Both are [character, name, group, shortcodes?] - arrays rather
	// than objects, which costs nothing to read and saves a third of the file
	// in repeated keys.
	emoji: emojiRows,
	symbols: symbolRows,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(data), 'utf8')

const withCodes = emojiRows.filter((r) => r[3]).length
console.log(
	`wrote ${OUT}` +
		`
  unicode ${version}: ${emojiRows.length} emoji (${withCodes} with shortcodes), ` +
		`${symbolRows.length} symbols, ${emojiRows.length + symbolRows.length} total` +
		`
  ${(JSON.stringify(data).length / 1024).toFixed(0)} KB`
)
