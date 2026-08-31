/**
 * The document outline an agent reads: every shape with its box, its label,
 * what frame contains it, and every arrow with the shapes its ends attach to.
 * Read-only - it never touches the document, it only describes it.
 */
import { plainText, round, short } from './editor-utils.js'
import { isWaypointShape, walkChain } from './ops.js'

const CONTAINER_TYPES = new Set(['frame', 'group', 'geo', 'image', 'video', 'embed', 'note'])
const CONTAIN_THRESHOLD = 0.9
const NEAR_THRESHOLD = 120
const INSIDE_TOLERANCE = 2

export function projectDocument(editor) {
	const pages = editor.getPages()
	const currentPageId = editor.getCurrentPageId()
	const out = { v: 1, pages: [], warnings: [] }

	for (const page of pages) {
		if (page.id !== editor.getCurrentPageId()) editor.setCurrentPage(page.id)
		out.pages.push(projectPage(editor, page, out.warnings))
	}
	if (editor.getCurrentPageId() !== currentPageId) editor.setCurrentPage(currentPageId)
	return out
}

function projectPage(editor, page, warnings) {
	const allRaw =
		typeof editor.getCurrentPageShapesSorted === 'function'
			? editor.getCurrentPageShapesSorted()
			: [...editor.getCurrentPageShapes()].sort((a, b) =>
					String(a.index).localeCompare(String(b.index))
				)
	// waypoint dots, chain segments, and chain groups are rendering plumbing,
	// not content: chains are stitched back into their head arrow below
	const all = allRaw.filter(
		(s) =>
			s.meta?.claw !== 'waypoint' &&
			s.meta?.claw !== 'chainseg' &&
			!(s.type === 'group' && s.meta?.claw === 'chain')
	)

	const bounds = new Map()
	for (const s of all) bounds.set(s.id, editor.getShapePageBounds(s.id))

	// ---- effective containment: real parents, else geometry -----------------
	const parentOf = new Map()
	const inferredContainers = new Set()
	const inferredMembership = new Set() // children whose containment is geometric, not real
	const pageLevel = []
	for (const s of all) {
		if (String(s.parentId).startsWith('shape:')) parentOf.set(s.id, s.parentId)
		else pageLevel.push(s)
	}
	const area = (b) => (b ? b.w * b.h : 0)
	for (const inner of pageLevel) {
		if (inner.type === 'arrow') continue
		const ib = bounds.get(inner.id)
		if (!ib || area(ib) <= 0) continue
		let best = null
		let bestArea = Infinity
		for (const outer of pageLevel) {
			if (outer.id === inner.id || !CONTAINER_TYPES.has(outer.type)) continue
			const ob = bounds.get(outer.id)
			if (!ob || area(ob) <= area(ib)) continue
			const ix = Math.max(0, Math.min(ib.x + ib.w, ob.x + ob.w) - Math.max(ib.x, ob.x))
			const iy = Math.max(0, Math.min(ib.y + ib.h, ob.y + ob.h) - Math.max(ib.y, ob.y))
			if ((ix * iy) / area(ib) < CONTAIN_THRESHOLD) continue
			if (area(ob) < bestArea) {
				best = outer
				bestArea = area(ob)
			}
		}
		if (best) {
			parentOf.set(inner.id, best.id)
			inferredContainers.add(best.id)
			inferredMembership.add(inner.id)
		}
	}
	const rootOf = (id) => {
		let cur = id
		const seen = new Set()
		while (!seen.has(cur)) {
			seen.add(cur)
			const p = parentOf.get(cur)
			if (!p) break
			cur = p
		}
		return cur
	}

	// ---- arrow terminals: recorded bindings, else geometric inference -------
	const nonArrows = all.filter((s) => s.type !== 'arrow')
	const resolveLoose = (point) => {
		let inside = null
		let insideArea = Infinity
		let nearest = null
		let nearestD = Infinity
		for (const s of nonArrows) {
			const b = bounds.get(s.id)
			if (!b || b.w <= 0) continue
			const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.w))
			const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.h))
			const d = Math.hypot(dx, dy)
			if (d <= INSIDE_TOLERANCE) {
				if (area(b) < insideArea) {
					inside = s
					insideArea = area(b)
				}
			} else if (d < nearestD) {
				nearest = s
				nearestD = d
			}
		}
		if (inside) return { id: short(inside.id), how: 'inside', d: 0 }
		if (nearest && nearestD <= NEAR_THRESHOLD) {
			return { id: short(nearest.id), how: 'near', d: Math.round(nearestD) }
		}
		return null
	}

	const arrows = []
	let looseArrows = 0
	for (const s of all) {
		if (s.type !== 'arrow') continue
		const entry = { id: short(s.id), label: plainText(editor, s) ?? null, start: null, end: null }
		const recorded = { start: null, end: null }
		// a chain head carries its true endpoints in meta (the chain itself is
		// unbound); that record is as authoritative as a binding — we wrote it
		if (s.meta?.claw === 'chainhead') {
			if (editor.getShape(s.meta.from)) recorded.start = s.meta.from
			if (editor.getShape(s.meta.to)) recorded.end = s.meta.to
		}
		for (const binding of editor.getBindingsFromShape(s, 'arrow')) {
			recorded[binding.props?.terminal === 'start' ? 'start' : 'end'] = binding.toId
		}
		// legacy waypoint chains: the true end is at the tail of the chain
		if (recorded.end && isWaypointShape(editor, recorded.end)) {
			const { finalBinding } = walkChain(editor, s)
			recorded.end =
				finalBinding?.toId && !isWaypointShape(editor, finalBinding.toId) ? finalBinding.toId : null
		}
		const transform = editor.getShapePageTransform(s.id)
		for (const which of ['start', 'end']) {
			if (recorded[which]) {
				entry[which] = { id: short(recorded[which]), how: 'bound', d: 0 }
			} else {
				const local = s.props?.[which] ?? { x: 0, y: 0 }
				const pt = transform ? transform.applyToPoint(local) : local
				entry[which] = resolveLoose(pt)
			}
		}
		if (entry.start?.how !== 'bound' || entry.end?.how !== 'bound') looseArrows++
		if (entry.start && entry.end) {
			entry.rootStart = short(rootOf(`shape:${entry.start.id}`))
			entry.rootEnd = short(rootOf(`shape:${entry.end.id}`))
			entry.sameRoot = entry.rootStart === entry.rootEnd
		}
		arrows.push(entry)
	}
	if (looseArrows) {
		warnings.push(
			`${looseArrows} of ${arrows.length} arrows have endpoint(s) not snapped to a shape — ` +
				`inferred from geometry and labelled as inferred`
		)
	}

	// ---- shapes --------------------------------------------------------------
	const shapes = all
		.filter((s) => s.type !== 'arrow')
		.map((s) => {
			const b = bounds.get(s.id)
			const text = plainText(editor, s)
			return {
				id: short(s.id),
				type: s.type,
				geo: s.props?.geo ?? undefined,
				name: s.props?.name ?? undefined,
				text: text ?? undefined,
				note: s.meta?.note ?? undefined,
				x: b ? round(b.x) : null,
				y: b ? round(b.y) : null,
				w: b ? round(b.w) : null,
				h: b ? round(b.h) : null,
				parent: parentOf.has(s.id) ? short(parentOf.get(s.id)) : null,
				parentInferred: inferredMembership.has(s.id) || undefined,
				container: s.type === 'frame' || s.type === 'group' || inferredContainers.has(s.id),
				containerInferred: inferredContainers.has(s.id) && s.type !== 'frame' && s.type !== 'group',
			}
		})

	return { id: page.id, name: page.name ?? 'Page', shapes, arrows }
}
