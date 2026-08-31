/**
 * Primitives shared by every module in the editor page: error reporting the
 * CLI can read back, the canvas background colour, and hex mixing.
 */

/** Surface a failure where the CLI can see it (page.evaluate reads this). */
export function reportError(stage, err) {
	window.hostError = `${stage}: ${err?.message ?? err}`
}

/**
 * The canvas background for a colour mode - what an outline or a washed-out
 * fill is mixed toward. One definition; four copies drifted apart before.
 */
export const CANVAS_BG = { light: '#ffffff', dark: '#101011' }
export const canvasBg = (mode) => CANVAS_BG[mode === 'dark' ? 'dark' : 'light']
export const editorBg = (editor) => canvasBg(editor?.getColorMode?.() ?? 'light')

/** Blend two hex colours; t = 0 keeps `hex`, t = 1 becomes `other`. */
export const mixHex = (hex, other, t) => {
	const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
	const [a, b] = [p(hex), p(other)]
	return (
		'#' +
		a
			.map((v, i) =>
				Math.round(v + (b[i] - v) * t)
					.toString(16)
					.padStart(2, '0')
			)
			.join('')
	)
}
