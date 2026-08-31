/**
 * Figma-ready SVG: rewrite tldraw's embedded html text into real SVG <text>.
 *
 * Figma's importer ignores <foreignObject>, so a stock export arrives with
 * every shape and none of the words. The conversion is measurement, not
 * guesswork: the export is laid out offscreen in this browser, so every line
 * of wrapped text has a real box to read.
 */

/**
 * Rewrite an exported SVG so text lives in real <text> elements.
 *
 * The conversion is measurement, not guesswork: the SVG is laid out offscreen
 * in this very browser, so every line of wrapped text has a real box. For each
 * text node we walk characters, group them into line boxes by their client
 * rects, and emit one <text> per line run with that run's own font, weight,
 * style, color and alignment (so bold or italic spans inside a label survive).
 * Client coordinates convert to SVG user units through the root's screen
 * matrix, which handles viewBox and scale without any arithmetic of our own.
 *
 * Text baselines come from real font metrics (canvas fontBoundingBox*), so a
 * line sits where the browser drew it rather than at an estimated offset.
 */
export function foreignObjectTextToSvgText(svgText) {
	const SVG_NS = 'http://www.w3.org/2000/svg'
	const host = document.createElement('div')
	host.setAttribute('aria-hidden', 'true')
	host.style.cssText =
		'position:fixed;left:-20000px;top:0;opacity:0;pointer-events:none;contain:strict'
	host.innerHTML = svgText
	document.body.appendChild(host)
	try {
		const svg = host.querySelector('svg')
		if (!svg?.getScreenCTM?.()) return { svg: svgText, converted: 0 }
		const ctx = document.createElement('canvas').getContext('2d')
		const metrics = new Map()
		const ascentOf = (font, size) => {
			if (!metrics.has(font)) {
				let m = null
				try {
					ctx.font = font
					const t = ctx.measureText('Hxg')
					if (Number.isFinite(t.fontBoundingBoxAscent)) {
						m = { asc: t.fontBoundingBoxAscent, desc: t.fontBoundingBoxDescent }
					}
				} catch {}
				// fall back to typical proportions when the browser withholds metrics
				metrics.set(font, m ?? { asc: size * 0.8, desc: size * 0.2 })
			}
			return metrics.get(font)
		}
		let converted = 0
		for (const fo of [...svg.querySelectorAll('foreignObject')]) {
			// gradient text is painted by clipping a background to the glyphs, so
			// its own colour is transparent - emitting that verbatim gives Figma
			// invisible text. The shape's gradient is already in this file (its
			// toSvg put it there), and the wrapper class names the shape, so the
			// <text> can point straight at it.
			const scoped = fo.closest('[class*="claw-gt-"]')
			const scopeClass = scoped
				? [...scoped.classList].find((c) => c.startsWith('claw-gt-'))
				: null
			const textGradientId = scopeClass ? `claw-grad-${scopeClass.slice('claw-gt-'.length)}-color` : null
			// each foreignObject usually sits in a translated group, and the
			// replacement text goes back into that same group (keeping the
			// original stacking order), so measurements must land in the GROUP's
			// coordinate system - not the root's, or the group's transform is
			// applied twice and the text flies off the canvas
			const frame = typeof fo.parentNode?.getScreenCTM === 'function' ? fo.parentNode : svg
			const frameCtm = frame.getScreenCTM() ?? svg.getScreenCTM()
			const inv = frameCtm.inverse()
			const toUser = (x, y) => new DOMPoint(x, y).matrixTransform(inv)
			const runs = []
			const walker = document.createTreeWalker(fo, NodeFilter.SHOW_TEXT)
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const raw = node.nodeValue ?? ''
				if (!raw.trim()) continue
				const cs = getComputedStyle(node.parentElement)
				const range = document.createRange()
				let line = null
				const lines = []
				for (let i = 0; i < raw.length; i++) {
					range.setStart(node, i)
					range.setEnd(node, i + 1)
					const r = range.getBoundingClientRect()
					if (!r || (r.width === 0 && r.height === 0)) {
						// zero-width (a space at a wrap point): keep it in the current
						// line's string, never start a line with it
						if (line) line.text += raw[i]
						continue
					}
					if (line && Math.abs(r.top - line.top) < 1) {
						line.text += raw[i]
						line.right = Math.max(line.right, r.right)
					} else {
						line = { text: raw[i], top: r.top, left: r.left, right: r.right, height: r.height }
						lines.push(line)
					}
				}
				for (const ln of lines) {
					if (!ln.text.trim()) continue
					runs.push({ ln, cs })
				}
			}
			if (!runs.length) {
				// an empty label: drop the node rather than leave stray embedded
				// HTML in a file meant for another editor
				fo.remove()
				continue
			}
			const group = document.createElementNS(SVG_NS, 'g')
			for (const { ln, cs } of runs) {
				const size = parseFloat(cs.fontSize) || 16
				const font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`
				const { asc, desc } = ascentOf(font, size)
				// centre the font's own box inside the line box, then drop to the
				// baseline: this is where the browser actually painted the glyphs
				const baseline = ln.top + (ln.height - (asc + desc)) / 2 + asc
				const align = cs.textAlign
				const anchor = align === 'center' ? 'middle' : align === 'right' || align === 'end' ? 'end' : 'start'
				const clientX = anchor === 'middle' ? (ln.left + ln.right) / 2 : anchor === 'end' ? ln.right : ln.left
				const p = toUser(clientX, baseline)
				const el = document.createElementNS(SVG_NS, 'text')
				el.setAttribute('x', String(Math.round(p.x * 100) / 100))
				el.setAttribute('y', String(Math.round(p.y * 100) / 100))
				// user units, not client px: the export may be scaled
				const scaleY = Math.abs(toUser(0, 1).y - toUser(0, 0).y) || 1
				el.setAttribute('font-size', String(Math.round(size * scaleY * 100) / 100))
				el.setAttribute('font-family', cs.fontFamily)
				if (cs.fontWeight && cs.fontWeight !== '400') el.setAttribute('font-weight', cs.fontWeight)
				if (cs.fontStyle && cs.fontStyle !== 'normal') el.setAttribute('font-style', cs.fontStyle)
				const transparent = /rgba?\([^)]*,\s*0(\.0+)?\s*\)/.test(cs.color)
				el.setAttribute(
					'fill',
					transparent && textGradientId && svg.querySelector(`#${textGradientId}`)
						? `url(#${textGradientId})`
						: cs.color
				)
				if (anchor !== 'start') el.setAttribute('text-anchor', anchor)
				el.textContent = ln.text.replace(/\s+$/, '')
				group.appendChild(el)
			}
			fo.replaceWith(group)
			converted++
		}
		return { svg: svg.outerHTML, converted }
	} finally {
		host.remove()
	}
}

