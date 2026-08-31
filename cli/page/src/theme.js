/**
 * Custom colour and font slots: registering them with tldraw's style enums,
 * turning a document's `meta.clawTheme` into a real tldraw theme, and writing
 * slot edits back into that metadata.
 *
 * Slots are strictly ADDITIVE - tldraw's own palette is never remapped - and
 * a file never carries a custom-N value (see lib/custom-slots.mjs).
 */
import * as TL from 'tldraw'
import { CUSTOM_COLOR_SLOTS, CUSTOM_FONT_SLOTS } from '../../lib/custom-slots.mjs'
import { canvasBg, mixHex, reportError } from './common.js'
import { gradientMidpoint, isGradientSlot } from './gradients.js'

export function guardSlots(styleProp, slots) {
	try {
		styleProp?.addValues?.(...slots)
		// make the slots UNREMOVABLE: internal store creations (e.g. inside
		// parseTldrawJsonFile) re-run registerColorsFromThemes with default
		// themes, which strips unknown values BEFORE validating incoming
		// records - a after-the-fact re-add can't save that parse
		if (styleProp.removeValues && !styleProp.__clawGuarded) {
			const orig = styleProp.removeValues.bind(styleProp)
			styleProp.removeValues = (...vals) => orig(...vals.filter((v) => !slots.includes(v)))
			styleProp.__clawGuarded = true
		}
	} catch {}
}
export function ensureCustomSlots() {
	for (const styleProp of [
		TL.DefaultColorStyle,
		TL.DefaultLabelColorStyle,
		TL.geoShapeProps?.labelColor,
		TL.arrowShapeProps?.labelColor,
	]) {
		guardSlots(styleProp, CUSTOM_COLOR_SLOTS)
	}
	guardSlots(TL.DefaultFontStyle, CUSTOM_FONT_SLOTS)
}
ensureCustomSlots()

export const CLAW_THEMES = (() => {
	try {
		// a COMPLETE definition (clone of the default) so nothing downstream
		// trips on missing fields; only the extra color slots differ
		const def = JSON.parse(JSON.stringify(TL.DEFAULT_THEME))
		def.id = 'claw'
		const placeholder = () => ({ solid: '#888888', semi: '#dddddd', pattern: '#bbbbbb', fill: '#888888' })
		for (const mode of ['light', 'dark']) {
			for (const s of CUSTOM_COLOR_SLOTS) def.colors[mode][s] = placeholder()
		}
		return { claw: def }
	} catch (err) {
		console.warn('claw theme registration unavailable', err)
		return undefined
	}
})()


let PRISTINE_THEME = null
let lastAppliedTheme = '__unset__'



export function applyClawTheme(editor, { force = false } = {}) {
	try {
		if (typeof editor.getTheme !== 'function' || typeof editor.updateThemes !== 'function') return
		PRISTINE_THEME ??= JSON.parse(JSON.stringify(editor.getTheme('default')))
		const spec = editor.getDocumentSettings?.()?.meta?.clawTheme ?? null
		const key = JSON.stringify(spec)
		if (!force && key === lastAppliedTheme) return
		lastAppliedTheme = key
		const next = JSON.parse(JSON.stringify(PRISTINE_THEME))
		for (const [name, val] of Object.entries(spec?.colors ?? {})) {
			if (!CUSTOM_COLOR_SLOTS.includes(name)) continue // standard colors stay standard
			for (const mode of ['light', 'dark']) {
				let base = next.colors?.[mode]?.[name]
				// custom slots have no default entry - synthesize one from a template
				if (!base && CUSTOM_COLOR_SLOTS.includes(name) && next.colors?.[mode]) {
					base = JSON.parse(JSON.stringify(next.colors[mode].black ?? {}))
					next.colors[mode][name] = base
				}
				if (!base || typeof base !== 'object') continue
				const asColor = isGradientSlot(val) ? gradientMidpoint(val) : val
				if (typeof asColor === 'string') {
					const val = asColor // eslint-disable-line no-shadow
					const bg = canvasBg(mode)
					const ink = mode === 'light' ? '#000000' : '#ffffff'
					// a palette entry is more than a fill: frames, notes and lined
					// fills read their own keys, and a slot cloned from black would
					// otherwise tint geo shapes while leaving frames/notes black.
					// Ratios follow tldraw's own palette (e.g. blue solid #4465e9 ->
					// frameStroke #6681ec, frameFill #f9fafe).
					Object.assign(base, {
						solid: val,
						semi: mixHex(val, bg, 0.7),
						pattern: mixHex(val, bg, 0.45),
						frameStroke: mixHex(val, bg, 0.18),
						frameHeadingStroke: mixHex(val, bg, 0.18),
						frameFill: mixHex(val, bg, 0.96),
						frameHeadingFill: mixHex(val, bg, 0.96),
						frameText: ink,
						noteFill: mixHex(val, bg, 0.35),
						noteText: ink,
						linedFill: mixHex(val, bg, 0.15),
					})
					if ('fill' in base) base.fill = val
				} else {
					Object.assign(base, val[mode] ?? val)
				}
			}
		}
		// custom font slots render straight from theme.fonts[slot] (both the
		// canvas and export embedding read it) - the standard --tl-font-* CSS
		// vars are never touched, so draw/sans/serif/mono stay stock
		document.getElementById('claw-theme-fonts')?.remove()
		let fontFaceCss = ''
		for (const [slot, val] of Object.entries(spec?.fonts ?? {})) {
			if (!CUSTOM_FONT_SLOTS.includes(slot)) continue // standard fonts stay standard
			const base = { fontFamily: 'sans-serif', faces: [] }
			if (typeof val === 'string') {
				base.fontFamily = val
			} else if (val?.family) {
				base.fontFamily = `'${val.family}'`
				if (val.url) {
					base.faces = [
						{ family: val.family, src: { url: val.url, format: val.format ?? 'woff2' }, weight: 'normal' },
					]
					// belt and suspenders for the live canvas: the browser needs the
					// face loaded even if the FontManager misses a theme-only slot
					fontFaceCss += `@font-face{font-family:'${val.family}';src:url('${val.url}');font-display:swap}\n`
				}
			} else {
				continue
			}
			next.fonts[slot] = base
			// the builtin font row renders custom slots with the generic draw
			// glyph (mask icon) - swap in a real "Aa" in the slot's own face.
			// !important: the mask is an inline style (TldrawUiIcon), and left
			// active it clips the ::after text into garbage
			fontFaceCss +=
				`[data-testid="style.font.${slot}"] .tlui-icon{-webkit-mask:none !important;mask:none !important;background:none !important;display:flex;align-items:center;justify-content:center}` +
				`[data-testid="style.font.${slot}"] .tlui-icon::after{content:'Aa';font-family:${base.fontFamily};font-size:15px;line-height:1}\n`
		}
		if (fontFaceCss) {
			const el = document.createElement('style')
			el.id = 'claw-theme-fonts'
			el.textContent = fontFaceCss
			document.head.appendChild(el)
		}
		patchSlotLabels(clawMessages, spec)
		editor.updateThemes({ ...editor.getThemes(), default: next })
	} catch (err) {
		reportError('theme', err)
	}
}

/** PNG export via whichever API this tldraw version ships. */

export function clawThemePatch(editor, kind, slot, value) {
	const settings = editor.getDocumentSettings()
	const meta = { ...(settings.meta ?? {}) }
	const group = { ...(meta.clawTheme?.[kind] ?? {}) }
	if (value == null) delete group[slot]
	else group[slot] = value
	meta.clawTheme = { ...(meta.clawTheme ?? {}), [kind]: group }
	editor.updateDocumentSettings({ meta })
	applyClawTheme(editor, { force: true })
}

// datalist candidates for the font form, filtered by what this device renders

export const colorHexOf = (val) => {
	if (typeof val === 'string') return val
	if (isGradientSlot(val)) return gradientMidpoint(val)
	const solid = val?.light?.solid ?? val?.solid
	return typeof solid === 'string' ? solid : '#888888'
}

export const fontFamilyOf = (val) =>
	typeof val === 'string' ? val : val?.family ? `'${val.family}'` : 'sans-serif'
export const fontLabelOf = (val) => (typeof val === 'string' ? val : (val?.family ?? ''))

let clawMessages = null // the live translation map, captured from context

/**
 * Take the translation map from React context and refresh the slot labels in
 * it. The map is captured because applyClawTheme runs outside React and still
 * has to relabel slots when a theme changes.
 */
export function captureTranslations(messages, theme) {
	clawMessages = messages
	patchSlotLabels(messages, theme)
}
export function patchSlotLabels(messages, theme) {
	if (!messages) return
	try {
		for (const slot of CUSTOM_COLOR_SLOTS) {
			const val = theme?.colors?.[slot]
			messages[`color-style.${slot}`] = val != null ? colorHexOf(val) : slot
		}
		for (const slot of CUSTOM_FONT_SLOTS) {
			const val = theme?.fonts?.[slot]
			messages[`font-style.${slot}`] = val != null ? fontLabelOf(val) || slot : slot
		}
		messages['claw.smooth-text'] = 'Smooth text outline'
		messages['claw.export-figma'] = 'SVG for Figma'
	} catch {}
}

/** Reactive view of meta.clawTheme for any component (panel or dialog). */
