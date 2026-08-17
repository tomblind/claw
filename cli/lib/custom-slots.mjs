/**
 * Custom color/font slots, and the file-boundary transform that keeps .tldr
 * files valid for OTHER tldraw editors.
 *
 * The invariant: serialized .tldr text is always vanilla-safe. A shape that
 * uses a custom slot stores a legal STANDARD value in its props (the nearest
 * standard color / closest standard font to the custom definition) and the
 * claw truth in meta.claw: {color: 'custom-3', colorFallback: 'light-red'}.
 * In memory (executor stores, sync rooms) shapes carry the real custom-N
 * values and meta.claw does not exist.
 *
 *   file -> memory: restoreCustomStyles(records)  (after schema migration)
 *   memory -> file: extractCustomStyles(records)  (records must be clones)
 *
 * Conflict rule: if a vanilla editor changed the prop (it no longer equals
 * the recorded fallback), that edit wins and the claw payload is dropped.
 */

export const CUSTOM_COLOR_SLOTS = Array.from({ length: 24 }, (_, i) => `custom-${i + 1}`)
export const CUSTOM_FONT_SLOTS = Array.from({ length: 8 }, (_, i) => `custom-${i + 1}`)

const STYLE_KEYS = ['color', 'labelColor', 'font']
const isCustom = (v) => typeof v === 'string' && v.startsWith('custom-')

// tldraw's default light-theme solid hexes (stable constants; white excluded
// as a fallback target - it's also excluded from tldraw's own picker)
const STANDARD_SOLIDS = {
	black: '#1d1d1d',
	grey: '#9fa8b2',
	'light-violet': '#e085f4',
	violet: '#ae3ec9',
	blue: '#4465e9',
	'light-blue': '#4ba1f1',
	yellow: '#f1ac4b',
	orange: '#e16919',
	green: '#099268',
	'light-green': '#4cb05e',
	'light-red': '#f87777',
	red: '#e03131',
}

const hexOf = (val) => {
	if (typeof val === 'string') return val
	const solid = val?.light?.solid ?? val?.solid
	return typeof solid === 'string' ? solid : null
}

/** Nearest standard color name for a hex (weighted RGB distance). */
export function nearestStandardColor(hex) {
	const parse = (h) => {
		const m = /^#?([0-9a-f]{6})/i.exec(String(h))
		if (!m) return null
		const n = parseInt(m[1], 16)
		return [n >> 16, (n >> 8) & 255, n & 255]
	}
	const target = parse(hex)
	if (!target) return 'black'
	let best = 'black'
	let bestD = Infinity
	for (const [name, solid] of Object.entries(STANDARD_SOLIDS)) {
		const c = parse(solid)
		const d =
			3 * (c[0] - target[0]) ** 2 + 4 * (c[1] - target[1]) ** 2 + 2 * (c[2] - target[2]) ** 2
		if (d < bestD) {
			bestD = d
			best = name
		}
	}
	return best
}

/** Closest standard font slot for a custom font definition (by family name). */
export function nearestStandardFont(val) {
	const s = (typeof val === 'string' ? val : (val?.family ?? '')).toLowerCase()
	if (/mono|courier|consolas|menlo|code/.test(s)) return 'mono'
	if (/sans|arial|helvetica|segoe|verdana|tahoma|inter|roboto|calibri/.test(s)) return 'sans'
	if (/serif|georgia|times|garamond|palatino|cambria|book|lora/.test(s)) return 'serif'
	if (/comic|hand|cursive|script|marker|shantell/.test(s)) return 'draw'
	return 'sans'
}

const docThemeOf = (records) =>
	records.find((r) => r.typeName === 'document')?.meta?.clawTheme ?? null

/**
 * file -> memory: put custom values back into props, drop the style payload.
 *
 * NAMESPACE WARNING: the payload lives in meta.clawStyle. It must NEVER be
 * meta.claw - that key belongs to the chain system ('chainhead'/'chainseg'/
 * 'chain' string markers), and v0.22-0.24.1 used it for styles, stripping
 * chain markers on every load (chains silently became untracked fragment
 * trains). Legacy object-valued meta.claw is still read and cleaned up;
 * string-valued meta.claw is a chain marker and is never touched.
 */
export function restoreCustomStyles(records) {
	for (const r of records) {
		if (r.typeName !== 'shape') continue
		const legacy = typeof r.meta?.claw === 'object' && r.meta.claw !== null ? r.meta.claw : null
		const payload = r.meta?.clawStyle ?? legacy
		if (!payload) continue
		for (const key of STYLE_KEYS) {
			if (!isCustom(payload[key])) continue
			// a vanilla editor changed this prop since claw saved it - its edit
			// wins and the stale claw value is discarded
			if (r.props?.[key] === payload[`${key}Fallback`]) r.props[key] = payload[key]
		}
		const { clawStyle: _dropped, ...rest } = r.meta
		if (legacy) delete rest.claw
		r.meta = rest
	}
	return records
}

/** memory -> file: swap custom values for standard fallbacks + meta.claw. */
export function extractCustomStyles(records) {
	const theme = docThemeOf(records)
	for (const r of records) {
		if (r.typeName !== 'shape') continue
		let claw = null
		for (const key of STYLE_KEYS) {
			const v = r.props?.[key]
			if (!isCustom(v)) continue
			const fallback =
				key === 'font'
					? nearestStandardFont(theme?.fonts?.[v])
					: nearestStandardColor(hexOf(theme?.colors?.[v]) ?? '#1d1d1d')
			claw = claw ?? {}
			claw[key] = v
			claw[`${key}Fallback`] = fallback
			r.props[key] = fallback
		}
		if (claw) r.meta = { ...(r.meta ?? {}), clawStyle: claw }
	}
	return records
}
