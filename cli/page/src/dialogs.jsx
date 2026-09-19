/**
 * The two "Customize..." dialogs and the buttons that open them. A dialog
 * edits the document's own colour and font slots (meta.clawTheme), so the
 * choices travel with the file; nothing here writes to a shape.
 */
import React from 'react'
import * as TL from 'tldraw'
import { CUSTOM_COLOR_SLOTS, CUSTOM_FONT_SLOTS } from '../../lib/custom-slots.mjs'
import { mixHex, reportError } from './common.js'
import { clawThemePatch, colorHexOf, fontFamilyOf, fontLabelOf, useClawTheme } from './theme.js'
import { gradientCss, gradientMidpoint, isGradientSlot } from './gradients.js'
import {
	codePointLabel,
	insertChar,
	loadChars,
	recentChars,
	rememberChar,
	rowsFor,
	searchChars,
} from './chars.js'

const FONT_CANDIDATES = [
	'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara',
	'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
	'Franklin Gothic Medium', 'Gabriola', 'Garamond', 'Georgia', 'Impact',
	'Lucida Console', 'Palatino Linotype', 'Segoe Print', 'Segoe Script',
	'Segoe UI', 'Sitka Text', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
	'Verdana', 'serif', 'sans-serif', 'monospace', 'cursive',
]
const GENERIC_FAMILIES = new Set([
	'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
	'ui-serif', 'ui-sans-serif', 'ui-monospace',
])
let fontMeasureCtx = null
const familyAvailable = (name) => {
	const n = String(name).trim().replace(/^['"]|['"]$/g, '')
	if (!n) return false
	if (GENERIC_FAMILIES.has(n.toLowerCase())) return true
	// document.fonts.check() lies (true for any unknown family), so measure:
	// a real family changes text metrics vs at least one generic baseline
	try {
		fontMeasureCtx ??= document.createElement('canvas').getContext('2d')
		const sample = 'mmmmmmmmmmlliWQ@0123'
		const width = (font) => {
			fontMeasureCtx.font = `16px ${font}`
			return fontMeasureCtx.measureText(sample).width
		}
		return (
			width(`"${n}", monospace`) !== width('monospace') ||
			width(`"${n}", serif`) !== width('serif')
		)
	} catch {
		return false
	}
}
const stackAvailable = (stack) => String(stack).split(',').some(familyAvailable)

const FONT_FORMATS = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' }
const formatFromUrl = (u) => FONT_FORMATS[/\.(woff2|woff|ttf|otf)(\?|$)/i.exec(u)?.[1]?.toLowerCase()]

/**
 * Turn whatever URL the user pasted into a loadable font-file URL. Google
 * Fonts (and Bunny etc.) hand out CSS links ("css2?family=..."), so if the
 * URL looks like a stylesheet, fetch it, parse its @font-face rules, and
 * pick the best face: the requested family (or the first one), latin
 * subset, upright, regular weight. Direct font-file URLs pass through.
 */
async function resolveWebfontUrl(url, requestedFamily) {
	const looksCss = /\.css(\?|#|$)|\/css2?\?/i.test(url)
	if (!looksCss) {
		if (!requestedFamily) throw new Error('give the font a family name')
		return { family: requestedFamily, url, format: formatFromUrl(url) }
	}
	const res = await fetch(url).catch(() => null)
	if (!res?.ok) throw new Error(`could not fetch the stylesheet (${res?.status ?? 'network error'})`)
	const css = await res.text()
	const faces = []
	const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*{([^}]*)}/g
	let m
	while ((m = re.exec(css))) {
		const body = m[2]
		const fam = /font-family:\s*['"]?([^'";]+)/.exec(body)?.[1]?.trim()
		const src = /url\((['"]?)([^)'"]+)\1\)/.exec(body)?.[2]
		if (!fam || !src) continue
		faces.push({
			subset: m[1] ?? '',
			family: fam,
			url: src,
			weight: /font-weight:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? '',
			style: /font-style:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? 'normal',
		})
	}
	if (!faces.length) throw new Error('no @font-face rules in that stylesheet')
	const families = [...new Set(faces.map((f) => f.family))]
	let family = requestedFamily
	if (family) {
		const match = families.find((f) => f.toLowerCase() === family.toLowerCase())
		if (!match) {
			throw new Error(`that stylesheet has: ${families.join(', ')} — put one of those in the name field`)
		}
		family = match
	} else {
		family = families[0]
	}
	const cands = faces.filter((f) => f.family === family)
	const upright = cands.filter((f) => f.style === 'normal')
	const regular = upright.filter((f) => !f.weight || /(^|\s)400(\s|$)|100 900|normal/.test(f.weight))
	const pool = regular.length ? regular : upright.length ? upright : cands
	const pick = pool.find((f) => f.subset === 'latin') ?? pool[0]
	return { family, url: pick.url, format: formatFromUrl(pick.url) ?? 'woff2' }
}

/**
 * Style-picker tooltips: tldraw labels picker buttons via translation keys
 * ("font-style.custom-1"), which have no entry for custom slots and show
 * raw. The translation map is a plain object read at render time, so we
 * write friendly entries into it (hex for colors, family for fonts)
 * whenever the theme changes; the pickers re-render on the same change.
 */
const dialogRowStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }
const dialogHintStyle = { color: 'var(--tl-color-text-3)', fontSize: 11, padding: '4px 0' }

function ColorCustomizeDialog() {
	const editor = TL.useEditor()
	const clawTheme = useClawTheme(editor)
	const colors = clawTheme?.colors ?? {}
	const defined = CUSTOM_COLOR_SLOTS.filter((s) => s in colors)
	// an explicit edit session per slot: live-preview while the native picker
	// is open, then OK keeps the value and Cancel restores `before` (null
	// before = the slot was just added, so Cancel removes it again)
	const [editing, setEditing] = React.useState(null) // {slot, before, isNew, hex}
	const editRef = React.useRef(null) // {slot, timer} for the live input stream

	const endEdit = (keep, ed = editing) => {
		if (!ed) return
		clearTimeout(editRef.current?.timer)
		try {
			if (keep) {
				clawThemePatch(editor, 'colors', ed.slot, ed.hex)
				if (ed.isNew && TL.DefaultColorStyle) {
					editor.setStyleForSelectedShapes?.(TL.DefaultColorStyle, ed.slot)
					editor.setStyleForNextShapes?.(TL.DefaultColorStyle, ed.slot)
				}
			} else {
				clawThemePatch(editor, 'colors', ed.slot, ed.before)
			}
		} catch (err) {
			reportError('edit-color', err)
		}
		editRef.current = null
		setEditing(null)
	}
	const startEdit = (slot, isNew) => {
		if (editing) endEdit(true)
		const hex = isNew ? '#4f6df5' : colorHexOf(colors[slot])
		editRef.current = { slot, timer: null }
		setEditing({ slot, before: isNew ? null : colors[slot], isNew, hex })
		if (isNew) {
			try {
				clawThemePatch(editor, 'colors', slot, hex)
			} catch (err) {
				reportError('add-color', err)
			}
		}
	}
	const onLive = (hex) => {
		// fires per interaction while the native picker is open - always the
		// slot fixed at session start (a new slot per event once filled all
		// slots in one drag), debounced so dragging rethemes the canvas live
		const edit = editRef.current
		if (!edit) return
		setEditing((e) => (e ? { ...e, hex } : e))
		clearTimeout(edit.timer)
		edit.timer = setTimeout(() => {
			try {
				clawThemePatch(editor, 'colors', edit.slot, hex)
			} catch (err) {
				reportError('edit-color', err)
			}
		}, 80)
	}
	return (
		<>
			<TL.TldrawUiDialogHeader>
				<TL.TldrawUiDialogTitle>Custom colors</TL.TldrawUiDialogTitle>
				<TL.TldrawUiDialogCloseButton />
			</TL.TldrawUiDialogHeader>
			<TL.TldrawUiDialogBody style={{ minWidth: 300 }}>
				{defined.length === 0 && (
					<div style={dialogHintStyle}>
						No custom colors yet — add up to {CUSTOM_COLOR_SLOTS.length}. They join the color
						picker for everyone in this canvas.
					</div>
				)}
				{defined.map((slot) => {
					const isEditing = editing?.slot === slot
					const def = colors[slot]
					if (isGradientSlot(def) && !isEditing) {
						// a gradient slot edits in place: two stops and a type, with no
						// native picker session (there is no single colour to preview)
						const patch = (next) => {
							try {
								clawThemePatch(editor, 'colors', slot, { ...def, ...next })
							} catch (err) {
								reportError('edit-gradient', err)
							}
						}
						return (
							<div key={slot} style={dialogRowStyle}>
								<span
									title={`${def.gradient} gradient`}
									style={{
										width: 22,
										height: 22,
										borderRadius: 4,
										background: gradientCss(def),
										border: '1px solid var(--tl-color-muted-1)',
										flexShrink: 0,
									}}
								/>
								<input
									type="color"
									aria-label="gradient start"
									data-testid={`claw-grad-from-${slot}`}
									value={def.from}
									onChange={(e) => patch({ from: e.target.value })}
									style={{ width: 26, height: 22, padding: 0, border: 'none', background: 'none' }}
								/>
								<input
									type="color"
									aria-label="gradient end"
									data-testid={`claw-grad-to-${slot}`}
									value={def.to}
									onChange={(e) => patch({ to: e.target.value })}
									style={{ width: 26, height: 22, padding: 0, border: 'none', background: 'none' }}
								/>
								<TL.TldrawUiButton
									type="normal"
									title="Switch between linear and radial"
									data-testid={`claw-grad-type-${slot}`}
									onClick={() => patch({ gradient: def.gradient === 'radial' ? 'linear' : 'radial' })}
								>
									<TL.TldrawUiButtonLabel>{def.gradient}</TL.TldrawUiButtonLabel>
								</TL.TldrawUiButton>
								<TL.TldrawUiButton
									type="normal"
									title="Back to a single colour"
									data-testid={`claw-grad-solid-${slot}`}
									onClick={() => {
										try {
											clawThemePatch(editor, 'colors', slot, gradientMidpoint(def))
										} catch (err) {
											reportError('edit-gradient', err)
										}
									}}
								>
									<TL.TldrawUiButtonLabel>Solid</TL.TldrawUiButtonLabel>
								</TL.TldrawUiButton>
								<TL.TldrawUiButton
									type="normal"
									title="Shapes using it go grey until it's re-added"
									data-testid={`claw-color-remove-${slot}`}
									onClick={() => {
										try {
											clawThemePatch(editor, 'colors', slot, null)
										} catch (err) {
											reportError('remove-color', err)
										}
									}}
								>
									<TL.TldrawUiButtonLabel>Remove</TL.TldrawUiButtonLabel>
								</TL.TldrawUiButton>
							</div>
						)
					}
					return (
						<div key={slot} style={dialogRowStyle}>
							{isEditing ? (
								<>
									{/* same swatch look as the idle row; the native input is an
									    invisible overlay so the OS picker anchors right here
									    instead of the window corner (and the box keeps its shape) */}
									<span style={{ position: 'relative', width: 22, height: 22, flexShrink: 0 }}>
										<span
											style={{
												position: 'absolute',
												inset: 0,
												borderRadius: 4,
												background: editing.hex,
												border: '1px solid var(--tl-color-muted-1)',
											}}
										/>
										<input
											type="color"
											data-testid="claw-color-input"
											defaultValue={editing.hex}
											// open the OS picker after layout (double rAF) so it
											// anchors to this element's real position - clicking
											// at commit time anchors to 0,0 (top-left)
											ref={(el) => {
												if (el && !el.__clawOpened) {
													el.__clawOpened = true
													requestAnimationFrame(() =>
														requestAnimationFrame(() => {
															try {
																el.click()
															} catch {}
														})
													)
												}
											}}
											onChange={(e) => onLive(e.target.value)}
											style={{
												position: 'absolute',
												inset: 0,
												width: '100%',
												height: '100%',
												opacity: 0,
												padding: 0,
												border: 'none',
												cursor: 'pointer',
											}}
										/>
									</span>
									<span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}>{editing.hex}</span>
									<TL.TldrawUiButton type="primary" data-testid="claw-color-ok" onClick={() => endEdit(true)}>
										<TL.TldrawUiButtonLabel>OK</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
									<TL.TldrawUiButton type="normal" data-testid="claw-color-cancel" onClick={() => endEdit(false)}>
										<TL.TldrawUiButtonLabel>Cancel</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
								</>
							) : (
								<>
									<button
										title={`Edit ${slot}`}
										data-testid={`claw-color-swatch-${slot}`}
										onClick={() => startEdit(slot, false)}
										style={{
											width: 22,
											height: 22,
											borderRadius: 4,
											background: colorHexOf(colors[slot]),
											border: '1px solid var(--tl-color-muted-1)',
											flexShrink: 0,
											cursor: 'pointer',
											padding: 0,
										}}
									/>
									<span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}>
										{colorHexOf(colors[slot])}
									</span>
									<TL.TldrawUiButton
										type="normal"
										data-testid={`claw-color-edit-${slot}`}
										onClick={() => startEdit(slot, false)}
									>
										<TL.TldrawUiButtonLabel>Edit</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
									<TL.TldrawUiButton
										type="normal"
										title="Turn this colour into a gradient"
										data-testid={`claw-color-gradient-${slot}`}
										onClick={() => {
											const from = colorHexOf(colors[slot])
											try {
												clawThemePatch(editor, 'colors', slot, {
													gradient: 'linear',
													from,
													to: mixHex(from, '#ffffff', 0.55),
												})
											} catch (err) {
												reportError('edit-gradient', err)
											}
										}}
									>
										<TL.TldrawUiButtonLabel>Gradient</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
									<TL.TldrawUiButton
										type="normal"
										title="Shapes using it go grey until it's re-added"
										data-testid={`claw-color-remove-${slot}`}
										onClick={() => {
											try {
												clawThemePatch(editor, 'colors', slot, null)
											} catch (err) {
												reportError('remove-color', err)
											}
										}}
									>
										<TL.TldrawUiButtonLabel>Remove</TL.TldrawUiButtonLabel>
									</TL.TldrawUiButton>
								</>
							)}
						</div>
					)
				})}
			</TL.TldrawUiDialogBody>
			<TL.TldrawUiDialogFooter className="tlui-dialog__footer__actions">
				<span style={{ ...dialogHintStyle, marginRight: 'auto' }}>
					{defined.length}/{CUSTOM_COLOR_SLOTS.length} slots used
				</span>
				<TL.TldrawUiButton
					type="primary"
					data-testid="claw-color-add"
					disabled={!!editing || defined.length >= CUSTOM_COLOR_SLOTS.length}
					onClick={() => {
						const free = CUSTOM_COLOR_SLOTS.find((s) => !(s in colors))
						if (free) startEdit(free, true)
					}}
				>
					<TL.TldrawUiButtonLabel>＋ Add color</TL.TldrawUiButtonLabel>
				</TL.TldrawUiButton>
			</TL.TldrawUiDialogFooter>
		</>
	)
}

export function ClawColorControls() {
	const dialogs = typeof TL.useDialogs === 'function' ? TL.useDialogs() : null
	if (!dialogs) return null
	return (
		<TL.TldrawUiButton
			type="menu"
			data-testid="claw-customize-colors"
			onClick={() => dialogs.addDialog({ component: ColorCustomizeDialog })}
		>
			<TL.TldrawUiButtonLabel>Customize colors…</TL.TldrawUiButtonLabel>
		</TL.TldrawUiButton>
	)
}

function FontCustomizeDialog() {
	const editor = TL.useEditor()
	const clawTheme = useClawTheme(editor)
	const fonts = clawTheme?.fonts ?? {}
	const defined = CUSTOM_FONT_SLOTS.filter((s) => s in fonts)
	// form: {slot: 'custom-N' (editing) | null (adding), family, url, error, busy}
	const [form, setForm] = React.useState(null)
	const [listOpen, setListOpen] = React.useState(false)
	// full installed-font list where the Local Font Access API exists (needs
	// the user gesture we're inside); curated availability-checked list
	// otherwise - browsers expose nothing more without it
	const [fontOptions, setFontOptions] = React.useState(null)
	const loadOptions = () => {
		if (fontOptions) return
		;(async () => {
			let fams = null
			try {
				if (typeof window.queryLocalFonts === 'function') {
					// race it: without a permission UI (headless, some webviews)
					// the promise can hang forever instead of rejecting
					const local = await Promise.race([
						window.queryLocalFonts(),
						new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
					])
					fams = [...new Set(local.map((f) => f.family))].sort((a, b) => a.localeCompare(b))
				}
			} catch {}
			if (!fams?.length) fams = FONT_CANDIDATES.filter(familyAvailable)
			setFontOptions(fams)
		})()
	}
	const openForm = (init) => {
		setForm(init)
		setListOpen(false)
		loadOptions()
	}
	const familyOk = form?.family.trim() ? stackAvailable(form.family) : null

	const submit = async () => {
		if (!form || form.busy) return
		let family = form.family.trim().replace(/^['"]|['"]$/g, '')
		let url = form.url.trim()
		let format
		if (!family && !url) return
		const slot = form.slot ?? CUSTOM_FONT_SLOTS.find((s) => !(s in fonts))
		if (!slot) {
			window.alert(`All ${CUSTOM_FONT_SLOTS.length} custom font slots are in use`)
			return
		}
		try {
			if (url) {
				setForm({ ...form, busy: true, error: null })
				// people paste Google Fonts CSS links ("css2?family=..."), not
				// font files - resolve those to the actual font-file URL first
				const resolved = await resolveWebfontUrl(url, family)
				family = resolved.family
				url = resolved.url
				format = resolved.format
				// prove the webfont actually loads before committing it
				const face = new FontFace(family, `url("${url}")`)
				await Promise.race([
					face.load(),
					new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 8000)),
				])
				document.fonts.add(face)
			} else if (!stackAvailable(family)) {
				setForm({ ...form, error: 'Not found on this device - pick from the list or add a webfont URL' })
				return
			}
			clawThemePatch(editor, 'fonts', slot, url ? { family, url, ...(format ? { format } : {}) } : family)
			if (form.slot == null && TL.DefaultFontStyle) {
				editor.setStyleForSelectedShapes?.(TL.DefaultFontStyle, slot)
				editor.setStyleForNextShapes?.(TL.DefaultFontStyle, slot)
			}
			setForm(null)
		} catch (err) {
			setForm({ ...form, busy: false, error: `Could not load webfont: ${err?.message ?? err}` })
		}
	}
	const inputKeys = (e) => {
		e.stopPropagation()
		if (e.key === 'Enter') submit()
		if (e.key === 'Escape') setForm(null)
	}
	return (
		<>
			<TL.TldrawUiDialogHeader>
				<TL.TldrawUiDialogTitle>Custom fonts</TL.TldrawUiDialogTitle>
				<TL.TldrawUiDialogCloseButton />
			</TL.TldrawUiDialogHeader>
			<TL.TldrawUiDialogBody style={{ minWidth: 300 }}>
				{defined.length === 0 && !form && (
					<div style={dialogHintStyle}>
						No custom fonts yet — add up to {CUSTOM_FONT_SLOTS.length}. They join the font row
						for everyone in this canvas.
					</div>
				)}
				{defined.map((slot) => (
					<div key={slot} style={dialogRowStyle}>
						<span
							style={{
								fontFamily: fontFamilyOf(fonts[slot]),
								fontSize: 16,
								width: 26,
								textAlign: 'center',
								flexShrink: 0,
							}}
						>
							Aa
						</span>
						<span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
							{fontLabelOf(fonts[slot])}
							{typeof fonts[slot] === 'object' && fonts[slot]?.url ? (
								<span style={{ color: 'var(--tl-color-text-3)' }}> · webfont</span>
							) : null}
						</span>
						<TL.TldrawUiButton
							type="normal"
							data-testid={`claw-font-edit-${slot}`}
							onClick={() =>
								openForm({
									slot,
									family: fontLabelOf(fonts[slot]),
									url: typeof fonts[slot] === 'object' ? (fonts[slot].url ?? '') : '',
									error: null,
									busy: false,
								})
							}
						>
							<TL.TldrawUiButtonLabel>Edit</TL.TldrawUiButtonLabel>
						</TL.TldrawUiButton>
						<TL.TldrawUiButton
							type="normal"
							title="Shapes using it fall back to the default font until it's re-added"
							data-testid={`claw-font-remove-${slot}`}
							onClick={() => {
								try {
									clawThemePatch(editor, 'fonts', slot, null)
								} catch (err) {
									reportError('remove-font', err)
								}
							}}
						>
							<TL.TldrawUiButtonLabel>Remove</TL.TldrawUiButtonLabel>
						</TL.TldrawUiButton>
					</div>
				))}
				{form && (
					<div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0 0' }}>
						<div style={{ fontSize: 12, fontWeight: 600 }}>
							{form.slot ? `Edit ${form.slot}` : 'New font'}
						</div>
						<div style={{ position: 'relative' }}>
							<div style={{ display: 'flex', gap: 4 }}>
								<input
									className="tlui-input"
									placeholder="Font name or CSS stack"
									autoFocus
									value={form.family}
									// open the list on typing, not on focus - focus-open made the
									// dropdown blanket the edit form the instant it appeared
									onChange={(e) => {
										setForm({ ...form, family: e.target.value, error: null })
										setListOpen(true)
									}}
									onKeyDown={(e) => {
										if (e.key === 'Escape' && listOpen) {
											e.stopPropagation()
											setListOpen(false)
											return
										}
										inputKeys(e)
									}}
									style={{ flex: 1, border: '1px solid var(--tl-color-muted-1)', borderRadius: 6, padding: '4px 8px' }}
								/>
								<TL.TldrawUiButton
									type="normal"
									title="Browse fonts"
									data-testid="claw-font-list-toggle"
									onClick={() => setListOpen((o) => !o)}
								>
									<TL.TldrawUiButtonLabel>▾</TL.TldrawUiButtonLabel>
								</TL.TldrawUiButton>
							</div>
							{listOpen && (
								<div
									data-testid="claw-font-options"
									style={{
										position: 'absolute',
										top: '100%',
										left: 0,
										right: 0,
										zIndex: 10,
										marginTop: 2,
										maxHeight: 220,
										overflowY: 'auto',
										background: 'var(--tl-color-panel)',
										border: '1px solid var(--tl-color-muted-1)',
										borderRadius: 6,
										boxShadow: '0 4px 16px rgba(0,0,0,.25)',
									}}
								>
									{(fontOptions ?? []).map((name) => (
										<button
											key={name}
											data-testid="claw-font-option"
											onMouseDown={(e) => {
												e.preventDefault()
												setForm({ ...form, family: name, error: null })
												setListOpen(false)
											}}
											style={{
												display: 'block',
												width: '100%',
												textAlign: 'left',
												padding: '4px 8px',
												border: 'none',
												background: form.family === name ? 'var(--tl-color-muted-2)' : 'transparent',
												color: 'var(--tl-color-text-1)',
												fontFamily: `"${name}"`,
												fontSize: 14,
												cursor: 'pointer',
											}}
										>
											{name}
										</button>
									))}
									{!fontOptions && <div style={{ ...dialogHintStyle, padding: '4px 8px' }}>Loading fonts…</div>}
								</div>
							)}
						</div>
						<input
							className="tlui-input"
							placeholder="Webfont or Google Fonts URL (optional)"
							value={form.url}
							onChange={(e) => setForm({ ...form, url: e.target.value, error: null })}
							onKeyDown={inputKeys}
							style={{ border: '1px solid var(--tl-color-muted-1)', borderRadius: 6, padding: '4px 8px' }}
						/>
						<div style={{ fontSize: 11, color: form.error ? 'var(--tl-color-warning)' : 'var(--tl-color-text-3)', minHeight: 14 }}>
							{form.error ??
								(form.busy
									? 'Loading webfont…'
									: form.url.trim()
										? 'Webfont: renders on every device'
										: familyOk == null
											? 'Pick a font, or type any installed one'
											: familyOk
												? '✓ available on this device (webfont URL renders everywhere)'
												: '⚠ not found on this device')}
						</div>
						<div style={{ display: 'flex', gap: 4 }}>
							<TL.TldrawUiButton
								type="primary"
								data-testid="claw-font-form-confirm"
								disabled={form.busy}
								onClick={submit}
							>
								<TL.TldrawUiButtonLabel>{form.slot ? 'Save' : 'Add'}</TL.TldrawUiButtonLabel>
							</TL.TldrawUiButton>
							<TL.TldrawUiButton type="normal" onClick={() => setForm(null)}>
								<TL.TldrawUiButtonLabel>Cancel</TL.TldrawUiButtonLabel>
							</TL.TldrawUiButton>
						</div>
					</div>
				)}
			</TL.TldrawUiDialogBody>
			<TL.TldrawUiDialogFooter className="tlui-dialog__footer__actions">
				<span style={{ ...dialogHintStyle, marginRight: 'auto' }}>
					{defined.length}/{CUSTOM_FONT_SLOTS.length} slots used
				</span>
				<TL.TldrawUiButton
					type="primary"
					data-testid="claw-font-add"
					disabled={!!form || defined.length >= CUSTOM_FONT_SLOTS.length}
					onClick={() => openForm({ slot: null, family: '', url: '', error: null, busy: false })}
				>
					<TL.TldrawUiButtonLabel>＋ Add font</TL.TldrawUiButtonLabel>
				</TL.TldrawUiButton>
			</TL.TldrawUiDialogFooter>
		</>
	)
}

export function ClawFontControls() {
	const dialogs = typeof TL.useDialogs === 'function' ? TL.useDialogs() : null
	if (!dialogs) return null
	return (
		<TL.TldrawUiButton
			type="menu"
			data-testid="claw-customize-fonts"
			onClick={() => dialogs.addDialog({ component: FontCustomizeDialog })}
		>
			<TL.TldrawUiButtonLabel>Customize fonts…</TL.TldrawUiButtonLabel>
		</TL.TldrawUiButton>
	)
}

/**
 * Insert character: a search box and the characters that match it.
 *
 * Search, not browsing. Two things make that enough. The names are Unicode's
 * own, so "leftwards arrow" and "party popper" are findable by what they are
 * called; and the emoji also carry the `:shortcode:` spellings people already
 * know, so "tada" finds the party popper. Anything the table does not carry is
 * still reachable by typing its code point, such as `U+2316`.
 *
 * Clicking a character inserts it and leaves the dialog open, since wanting
 * two arrows in a row is more common than wanting exactly one. tldraw keeps a
 * shape in edit mode while a dialog is open, so the caret survives the trip.
 */
const CHAR_STARTERS = ['←', '→', '↑', '↓', '✓', '✕', '•', '–', '—', '…', '⌘', '⏎', '★', '▲', '●', '🎉']

function InsertCharDialog({ onClose }) {
	const editor = TL.useEditor()
	const [table, setTable] = React.useState(null)
	const [query, setQuery] = React.useState('')
	const [recent, setRecent] = React.useState(() => recentChars())
	const [said, setSaid] = React.useState('')
	const inputRef = React.useRef(null)
	const gridRef = React.useRef(null)
	React.useEffect(() => {
		let live = true
		loadChars().then((t) => live && setTable(t))
		return () => {
			live = false
		}
	}, [])

	/**
	 * Hand the caret back on the way out.
	 *
	 * Opening the picker leaves the shape in edit mode, so closing it should
	 * leave the person exactly where they were, mid-word, able to keep typing.
	 * This runs on every way out - Escape, the close button, a click outside -
	 * because they all end in this component unmounting.
	 */
	React.useEffect(() => {
		return () => {
			try {
				editor.getRichTextEditor?.()?.commands.focus()
			} catch {
				// no text being edited: nothing to hand back to
			}
		}
	}, [editor])

	const results = React.useMemo(() => {
		if (!table) return []
		if (query.trim()) return searchChars(table, query)
		return rowsFor(table, recent.length ? recent : CHAR_STARTERS)
	}, [table, query, recent])

	const pick = (row) => {
		const result = insertChar(editor, row.char)
		setRecent(rememberChar(row.char))
		setSaid(
			result.where === 'caret'
				? `${row.char} inserted`
				: result.where === 'shape'
					? `${row.char} added to the selected shape`
					: result.where === 'clipboard'
						? `${row.char} copied — nothing was selected to put it in`
						: `could not place ${row.char}`
		)
	}

	/** How many characters the grid is currently fitting across. */
	const columns = () => {
		const grid = gridRef.current
		if (!grid) return 1
		const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
		return Math.max(1, cols)
	}

	/**
	 * Move focus through the grid by `delta` places.
	 *
	 * Stepping back off the first character lands in the search box, which is
	 * what makes the whole dialog reachable from the keyboard: type, arrow down
	 * into the characters, arrow around, Enter, and arrow back up to retype.
	 */
	const moveFocus = (delta) => {
		const grid = gridRef.current
		if (!grid) return
		const items = Array.from(grid.querySelectorAll('.claw-char'))
		if (!items.length) return
		const at = items.indexOf(document.activeElement)
		if (at === -1) {
			items[0].focus()
			return
		}
		const next = at + delta
		if (next < 0) {
			inputRef.current?.focus()
			return
		}
		const target = items[Math.min(next, items.length - 1)]
		target.focus()
		target.scrollIntoView({ block: 'nearest' })
	}

	/**
	 * Escape closes the picker and nothing else.
	 *
	 * Left alone the key also reaches tldraw, which reads it as "stop editing
	 * this shape" and throws away the caret the picker was opened to serve.
	 * Stopping it from inside the dialog's own React tree is not enough: the
	 * dialog is portalled out of the container React listens on, so by the time
	 * a handler there runs the key has already reached the document. Catching
	 * it on the window in the capture phase is the one place that is reliably
	 * before everything else.
	 */
	const closeRef = React.useRef(onClose)
	closeRef.current = onClose
	React.useEffect(() => {
		const onEscape = (e) => {
			if (e.key !== 'Escape' || e.defaultPrevented) return
			e.preventDefault()
			e.stopPropagation()
			e.stopImmediatePropagation?.()
			closeRef.current()
		}
		window.addEventListener('keydown', onEscape, true)
		return () => window.removeEventListener('keydown', onEscape, true)
	}, [])

	/**
	 * Arrow keys walk the grid, which Tab alone only walks one at a time.
	 */
	const onKeyDown = (e) => {
		const inGrid = gridRef.current?.contains(document.activeElement)
		const step =
			e.key === 'ArrowRight' ? 1
			: e.key === 'ArrowLeft' ? -1
			: e.key === 'ArrowDown' ? columns()
			: e.key === 'ArrowUp' ? -columns()
			: 0
		// from the search box only Down reaches in; Left and Right still move
		// the text caret, which is what they are for while typing
		if (!step || (!inGrid && e.key !== 'ArrowDown')) return
		e.preventDefault()
		e.stopPropagation()
		moveFocus(inGrid ? step : 0)
	}

	const heading = query.trim() ? `${results.length} found` : recent.length ? 'Recent' : 'Common'
	return (
		<div onKeyDown={onKeyDown}>
			<TL.TldrawUiDialogHeader>
				<TL.TldrawUiDialogTitle>Insert character</TL.TldrawUiDialogTitle>
				<TL.TldrawUiDialogCloseButton />
			</TL.TldrawUiDialogHeader>
			<TL.TldrawUiDialogBody style={{ minWidth: 380, maxWidth: 380 }}>
				<input
					ref={inputRef}
					className="claw-char-search"
					type="text"
					autoFocus
					value={query}
					placeholder="arrow, tada, box drawings, U+2316…"
					data-testid="claw-char-search"
					onChange={(e) => setQuery(e.target.value)}
				/>
				<div className="claw-char-heading">{table ? heading : 'Loading characters…'}</div>
				{/* fixed height, not max-height: the dialog must not jump about as
				    results come and go while someone is still typing the query */}
				<div className="claw-char-grid" ref={gridRef} data-testid="claw-char-grid">
					{results.map((row) => (
						<button
							key={row.char}
							className="claw-char"
							type="button"
							title={`${row.name}${row.codes.length ? `  :${row.codes.join(': :')}:` : ''}\n${codePointLabel(row.char)}`}
							data-char={row.char}
							onClick={() => pick(row)}
						>
							{row.char}
						</button>
					))}
					{table && query.trim() && !results.length && (
						<div className="claw-char-empty">
							Nothing matched. Try a shorter word, or a code point like U+2316.
						</div>
					)}
				</div>
			</TL.TldrawUiDialogBody>
			<TL.TldrawUiDialogFooter className="tlui-dialog__footer__actions">
				<div className="claw-char-said" data-testid="claw-char-said">
					{said}
				</div>
			</TL.TldrawUiDialogFooter>
		</div>
	)
}

/**
 * The dialog itself, for anything that opens it without the style-panel button.
 * Exported rather than the button, because a keyboard shortcut reaches the
 * dialog through tldraw's own action list and never renders a button at all.
 */
export const CLAW_INSERT_CHAR_DIALOG = InsertCharDialog

export function ClawInsertCharControl() {
	const dialogs = typeof TL.useDialogs === 'function' ? TL.useDialogs() : null
	if (!dialogs) return null
	return (
		<TL.TldrawUiButton
			type="menu"
			data-testid="claw-insert-char"
			onClick={() => dialogs.addDialog({ component: InsertCharDialog })}
		>
			<TL.TldrawUiButtonLabel>Insert character…</TL.TldrawUiButtonLabel>
		</TL.TldrawUiButton>
	)
}
