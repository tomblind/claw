/**
 * Small shared readings of editor state: naming a shape, resolving a
 * reference the way every op accepts one, and plain text out of rich text.
 */
import * as TL from 'tldraw'

export const short = (id) => String(id).replace(/^shape:/, '')
export const round = (n) => Math.round(n)

export function plainText(editor, shape) {
	const p = shape.props ?? {}
	if (typeof p.text === 'string' && p.text.length) return p.text
	if (p.richText) {
		if (typeof TL.renderPlaintextFromRichText === 'function') {
			try {
				const t = TL.renderPlaintextFromRichText(editor, p.richText)
				if (t?.trim().length) return t
			} catch {}
		}
		// fallback: walk the tiptap tree
		const walk = (n) => {
			if (!n) return ''
			if (typeof n.text === 'string') return n.text
			if (Array.isArray(n.content)) return n.content.map(walk).join('')
			return ''
		}
		const blocks = Array.isArray(p.richText.content) ? p.richText.content : [p.richText]
		const t = blocks.map(walk).join('\n').trim()
		if (t.length) return t
	}
	return undefined
}


/** Find a shape by full id, short id (prefix), or frame-name / label text. */
export function resolveShape(editor, query) {
	const q = String(query)
	const shapes = editor.getCurrentPageShapes()
	const byId = shapes.find((s) => s.id === q || s.id === `shape:${q}`)
	if (byId) return byId
	const lower = q.toLowerCase()
	const byName = shapes.filter((s) => (s.props?.name ?? '').toLowerCase() === lower)
	if (byName.length === 1) return byName[0]
	// names given to ops persist on the shape (meta.clawName) and resolve
	// across batches and sessions
	const byClawName = shapes.filter((s) => s.meta?.clawName === q)
	if (byClawName.length === 1) return byClawName[0]
	const byPrefix = shapes.filter((s) => s.id.slice(6).startsWith(q))
	if (byPrefix.length === 1) return byPrefix[0]
	throw new Error(`no unique shape matching "${q}"`)
}

