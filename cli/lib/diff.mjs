import { labelFor } from './format.mjs'

/**
 * Semantic diff between two projections of the same document. Compares by
 * shape id (stable across tldraw edits): screens, text, shapes, and flow
 * edges are reported; pure layout churn is summarised separately so nudging
 * things around doesn't read as work.
 */

const MOVE_EPSILON = 1

function index(projection) {
	const shapes = new Map()
	const pageOf = new Map()
	for (const page of projection.pages) {
		for (const s of page.shapes) {
			shapes.set(s.id, s)
			pageOf.set(s.id, page)
		}
	}
	const edges = new Map()
	for (const page of projection.pages) {
		for (const a of page.arrows) {
			if (!a.start || !a.end || a.sameRoot) continue
			const inferred = a.start.how !== 'bound' || a.end.how !== 'bound'
			edges.set(`${a.start.id}->${a.end.id}|${a.label ?? ''}`, {
				start: a.start.id,
				end: a.end.id,
				label: a.label,
				inferred,
				page,
			})
		}
	}
	return { shapes, pageOf, edges }
}

export function diff(before, after, { labels = ['old', 'new'] } = {}) {
	const a = index(before)
	const b = index(after)

	const name = (ix, id) => {
		const s = ix.shapes.get(id)
		return s ? labelFor(s, ix.pageOf.get(id)) : `#${String(id).slice(0, 8)}`
	}

	const screensAdded = []
	const screensRemoved = []
	const shapesAdded = []
	const shapesRemoved = []
	const textChanged = []
	let moved = 0
	let resized = 0
	let reparented = 0

	for (const [id, s] of b.shapes) {
		const old = a.shapes.get(id)
		if (!old) {
			if (s.container) screensAdded.push(`${name(b, id)}  ${s.w}x${s.h} @${s.x},${s.y}`)
			else {
				const within = s.parent ? ` in ${name(b, s.parent)}` : ''
				shapesAdded.push(`${s.type} ${name(b, id)}${within}`)
			}
			continue
		}
		if ((old.text ?? old.name) !== (s.text ?? s.name)) {
			const container = s.parent ? name(b, s.parent) : ''
			const newText = s.text ?? s.name ?? ''
			const within = container && !container.includes(newText) ? ` in ${container}` : ''
			textChanged.push(
				`${JSON.stringify(old.text ?? old.name ?? '')} -> ${JSON.stringify(newText)}${within}`
			)
		}
		if (old.parent !== s.parent) reparented++
		if (
			old.x != null &&
			s.x != null &&
			(Math.abs(old.x - s.x) > MOVE_EPSILON || Math.abs(old.y - s.y) > MOVE_EPSILON)
		)
			moved++
		if (
			old.w != null &&
			s.w != null &&
			(Math.abs(old.w - s.w) > MOVE_EPSILON || Math.abs(old.h - s.h) > MOVE_EPSILON)
		)
			resized++
	}
	for (const [id, s] of a.shapes) {
		if (b.shapes.has(id)) continue
		if (s.container) screensRemoved.push(name(a, id))
		else shapesRemoved.push(`${s.type} ${name(a, id)}`)
	}

	const edgeText = (ix, e) =>
		`${name(ix, e.start)} -> ${name(ix, e.end)}` +
		(e.label ? ` ${JSON.stringify(e.label)}` : '') +
		(e.inferred ? '  (inferred)' : '')
	const edgesAdded = [...b.edges].filter(([k]) => !a.edges.has(k)).map(([, e]) => edgeText(b, e))
	const edgesRemoved = [...a.edges].filter(([k]) => !b.edges.has(k)).map(([, e]) => edgeText(a, e))

	// ---- render --------------------------------------------------------------
	const out = [`${labels[0]} -> ${labels[1]}`]
	const section = (title, items, prefix = '') => {
		if (!items.length) return
		out.push('', `${title}:`)
		for (const i of items) out.push(`  ${prefix}${i}`)
	}
	section('screens added', screensAdded, '+ ')
	section('screens removed', screensRemoved, '- ')
	section('text changed', textChanged)
	section('shapes added', shapesAdded, '+ ')
	section('shapes removed', shapesRemoved, '- ')
	section('flow added', edgesAdded, '+ ')
	section('flow removed', edgesRemoved, '- ')

	const churn = []
	if (moved) churn.push(`${moved} moved`)
	if (resized) churn.push(`${resized} resized`)
	if (reparented) churn.push(`${reparented} changed container`)
	if (churn.length) out.push('', `layout: ${churn.join(', ')}`)

	const semantic =
		screensAdded.length +
		screensRemoved.length +
		textChanged.length +
		shapesAdded.length +
		shapesRemoved.length +
		edgesAdded.length +
		edgesRemoved.length
	if (!semantic) {
		out.push('', 'no semantic changes — layout only, the prototype should not need updating')
	}
	return out.join('\n')
}
