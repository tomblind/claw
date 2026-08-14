/**
 * Flow-aware layout, powered by ELK's layered algorithm (the full Sugiyama
 * pipeline: proper cycle breaking, layering with node promotion, layer-sweep
 * crossing minimization, Brandes-Köpf placement, aspect-ratio-aware wrapping).
 *
 * Edges are first-class in the layout, not an afterthought: ELK routes them
 * WITH the placement — long edges get dummy vertices that reserve physical
 * channels through intermediate columns, and inter-layer spacing grows with
 * lane count. We consume those routes and translate them into what a tldraw
 * elbow can express (two anchors + one adjustable middle segment). Routes
 * too bendy to translate become arcs bowed toward clear space. Every
 * translated route is geometrically verified against the screens before it
 * ships; failures also fall back to arcs. Satellite screens (dead-end modals
 * of a single hub) skip the flow entirely and grid under their hub with
 * hand-built band routing.
 *
 * Results are emitted as ordinary `move` + `route`/`style` ops for the apply
 * pipeline, so layout streams onto the live canvas like any other edit.
 */

const GAP_X = 240
const GAP_Y = 240

export async function computeLayout(projection, { gapX = GAP_X, gapY = GAP_Y } = {}) {
	const page = projection.pages[0]
	if (!page) return { ops: [], report: ['nothing to lay out - document has no pages'] }

	const byId = new Map(page.shapes.map((s) => [s.id, s]))

	// screens: top-level containers. Their (possibly inferred) children travel
	// with them; real frame children travel for free.
	const screens = page.shapes.filter((s) => s.parent == null && s.container)
	if (screens.length < 2) {
		return { ops: [], report: [`nothing to lay out - ${screens.length} screen(s)`] }
	}
	const screenIds = new Set(screens.map((s) => s.id))

	// screen-to-screen edges from the arrow graph (recorded + inferred),
	// ignoring arrows inside a single screen
	const edges = []
	for (const a of page.arrows) {
		if (!a.start || !a.end || a.sameRoot) continue
		const from = a.rootStart
		const to = a.rootEnd
		if (screenIds.has(from) && screenIds.has(to) && from !== to) {
			edges.push({
				from,
				to,
				id: a.id,
				// any bound arrow routes — including ones bound to a button INSIDE
				// a screen (the common case): anchors go on the endpoint shape,
				// route geometry comes from ELK
				routable: a.start.how === 'bound' && a.end.how === 'bound',
				fromShape: a.start.id,
				toShape: a.end.id,
			})
		}
	}

	// ---- leaf packs: satellites whose ONLY connections are to one hub don't
	// deserve a flow column — they become a grid parked under the hub. This is
	// what keeps hub-heavy canvases (one game screen, twelve modals) compact
	// instead of one endless column: layering has no answer for a tall layer,
	// so we take those nodes out of the layering entirely.
	const neighborSets = new Map(screens.map((s) => [s.id, new Set()]))
	for (const e of edges) {
		neighborSets.get(e.from)?.add(e.to)
		neighborSets.get(e.to)?.add(e.from)
	}
	const hasIncoming = new Set(edges.map((e) => e.to))
	const packOf = new Map() // leafId -> hubId
	const packs = new Map() // hubId -> [leafIds]
	for (const s of screens) {
		const n = neighborSets.get(s.id)
		if (n.size !== 1) continue
		// pure sources are entry points — they belong at the head of the flow
		if (!hasIncoming.has(s.id)) continue
		const hub = [...n][0]
		if (neighborSets.get(hub).size <= 1) continue
		packOf.set(s.id, hub)
		if (!packs.has(hub)) packs.set(hub, [])
		packs.get(hub).push(s.id)
	}
	for (const [hub, leaves] of [...packs]) {
		if (leaves.length < 2) {
			for (const l of leaves) packOf.delete(l)
			packs.delete(hub)
		}
	}

	// pack grids: wide beats deep (max 2 rows up to 6 columns); odd rows are
	// offset half a cell (brick lattice) so a drop into row 2 falls through
	// the GAP between the row-1 screens above it
	const PACK_GAP = Math.round(gapY * 0.4)
	const MAX_COLS = 6
	const footprint = new Map() // hubId -> {w, h, cols, rows, cellW, cellH}
	for (const [hub, leaves] of packs) {
		leaves.sort((a, b) => (byId.get(a).name ?? a).localeCompare(byId.get(b).name ?? b))
		const cellW = Math.max(...leaves.map((l) => byId.get(l).w)) + PACK_GAP
		const cellH = Math.max(...leaves.map((l) => byId.get(l).h)) + PACK_GAP
		const cols = Math.min(MAX_COLS, Math.max(2, Math.ceil(leaves.length / 2)))
		const rows = Math.ceil(leaves.length / cols)
		const packW = cols * cellW - PACK_GAP + (rows > 1 ? cellW / 2 : 0)
		const packH = rows * cellH - PACK_GAP
		const h = byId.get(hub)
		footprint.set(hub, {
			w: Math.max(h.w, packW),
			h: h.h + gapY / 2 + packH,
			cols,
			rows,
			cellW,
			cellH,
		})
	}

	const flowScreens = screens.filter((s) => !packOf.has(s.id))
	const flowEdges = edges.filter((e) => !packOf.has(e.from) && !packOf.has(e.to))

	// ---- placement AND routing: ELK layered -------------------------------
	const { default: ELK } = await import('elkjs')
	const elk = new ELK()
	const laid = await elk.layout({
		id: 'root',
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.direction': 'RIGHT',
			'elk.aspectRatio': '1.6',
			'elk.edgeRouting': 'ORTHOGONAL',
			'elk.spacing.nodeNode': String(gapY),
			'elk.layered.spacing.nodeNodeBetweenLayers': String(gapX),
			// give edge channels real width so lanes don't kiss the screens
			'elk.spacing.edgeNode': '48',
			'elk.spacing.edgeEdge': '24',
			'elk.layered.spacing.edgeNodeBetweenLayers': '48',
			'elk.layered.spacing.edgeEdgeBetweenLayers': '24',
			'elk.layered.wrapping.strategy': 'MULTI_EDGE',
			'elk.layered.wrapping.additionalEdgeSpacing': String(gapY / 2),
			'elk.separateConnectedComponents': 'true',
			'elk.layered.thoroughness': '10',
		},
		children: flowScreens.map((s) => {
			const f = footprint.get(s.id)
			return { id: s.id, width: f?.w ?? s.w, height: f?.h ?? s.h }
		}),
		edges: flowEdges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
	})

	const targets = new Map(laid.children.map((c) => [c.id, { x: Math.round(c.x), y: Math.round(c.y) }]))
	// attach ELK's computed route to each flow edge
	const laidEdgeById = new Map((laid.edges ?? []).map((le) => [le.id, le]))
	flowEdges.forEach((e, i) => {
		const s = laidEdgeById.get(`e${i}`)?.sections?.[0]
		if (s) e.elkRoute = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]
	})

	// place each pack's grid under its hub, inside the reserved footprint
	for (const [hub, leaves] of packs) {
		const f = footprint.get(hub)
		const t = targets.get(hub)
		if (!t) continue
		leaves.forEach((leaf, i) => {
			const col = i % f.cols
			const row = Math.floor(i / f.cols)
			const brick = row % 2 === 1 ? f.cellW / 2 : 0
			targets.set(leaf, {
				x: Math.round(t.x + col * f.cellW + brick),
				y: Math.round(t.y + byId.get(hub).h + gapY / 2 + row * f.cellH),
			})
		})
	}

	// ---- emit move ops -------------------------------------------------------
	const ops = []
	const report = []
	let unmovableArrows = 0
	const deltas = new Map()
	for (const s of screens) {
		const t = targets.get(s.id)
		if (!t) continue
		const dx = t.x - s.x
		const dy = t.y - s.y
		if (dx === 0 && dy === 0) continue
		deltas.set(s.id, { dx, dy })
		ops.push({ move: { id: s.id, to: { x: t.x, y: t.y } } })
	}
	const rootOf = (id) => {
		let cur = id
		const seen = new Set()
		while (!seen.has(cur)) {
			seen.add(cur)
			const p = byId.get(cur)?.parent
			if (p == null) break
			cur = p
		}
		return cur
	}
	for (const child of page.shapes) {
		if (!child.parentInferred) continue
		const d = deltas.get(rootOf(child.id))
		if (d) ops.push({ move: { id: child.id, by: { dx: d.dx, dy: d.dy } } })
	}
	for (const a of page.arrows) {
		const bound = a.start?.how === 'bound' && a.end?.how === 'bound'
		if (bound || !a.start || !a.end) continue
		const d1 = deltas.get(a.rootStart)
		const d2 = deltas.get(a.rootEnd)
		if (d1 && d2 && d1.dx === d2.dx && d1.dy === d2.dy) {
			ops.push({ move: { id: a.id, by: { dx: d1.dx, dy: d1.dy } } })
		} else if (d1 || d2) {
			unmovableArrows++
		}
	}

	// ---- route translation: ELK bend points -> tldraw elbows ----------------
	const rectOf = (id) => {
		const s = byId.get(id)
		const t = targets.get(id)
		return { x: t.x, y: t.y, w: s.w, h: s.h }
	}
	const endRect = (shapeId, rootId) => {
		if (shapeId === rootId) return rectOf(rootId)
		const s = byId.get(shapeId)
		const d = deltas.get(rootId) ?? { dx: 0, dy: 0 }
		return { x: s.x + d.dx, y: s.y + d.dy, w: s.w, h: s.h }
	}
	const anchors = new Map() // `${edgeId}:${from|to}` -> {x,y}
	const anchorPoint = (r, a) => ({ x: r.x + a.x * r.w, y: r.y + a.y * r.h })

	/** drop interior points collinear with their neighbours */
	const simplify = (pts) => {
		const out = [pts[0]]
		for (let i = 1; i < pts.length - 1; i++) {
			const a = out[out.length - 1]
			const b = pts[i]
			const c = pts[i + 1]
			const collinear =
				(Math.abs(a.x - b.x) < 1 && Math.abs(b.x - c.x) < 1) ||
				(Math.abs(a.y - b.y) < 1 && Math.abs(b.y - c.y) < 1)
			if (!collinear) out.push(b)
		}
		out.push(pts[pts.length - 1])
		return out
	}
	/** normalized anchor on rect r for a route endpoint p leaving toward q */
	const anchorFor = (r, p, q) => {
		const horizontal = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y)
		if (horizontal) {
			return {
				x: q.x > p.x ? 1 : 0,
				y: Math.round(Math.max(0.1, Math.min(0.9, (p.y - r.y) / r.h)) * 100) / 100,
			}
		}
		return {
			x: Math.round(Math.max(0.1, Math.min(0.9, (p.x - r.x) / r.w)) * 100) / 100,
			y: q.y > p.y ? 1 : 0,
		}
	}

	const flowRouted = []
	for (const e of flowEdges) {
		if (!e.routable || !e.elkRoute || e.elkRoute.length < 2) continue
		const pts = simplify(e.elkRoute)
		const fr = endRect(e.fromShape, e.from)
		const tr = endRect(e.toShape, e.to)
		const fa = anchorFor(fr, pts[0], pts[1])
		const ta = anchorFor(tr, pts[pts.length - 1], pts[pts.length - 2])
		anchors.set(`${e.id}:from`, fa)
		anchors.set(`${e.id}:to`, ta)
		if (pts.length > 4) {
			// too bendy for one elbow: render ELK's exact route as a waypoint chain
			e.chainPts = pts.slice(1, -1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
			flowRouted.push(e)
			continue
		}
		if (pts.length === 4) {
			// H-V-H or V-H-V: position the middle segment where ELK put it
			const exit = anchorPoint(fr, fa)
			const entry = anchorPoint(tr, ta)
			const midVertical = Math.abs(pts[1].x - pts[2].x) < 1
			const span = midVertical ? entry.x - exit.x : entry.y - exit.y
			const at = midVertical ? pts[1].x - exit.x : pts[1].y - exit.y
			if (Math.abs(span) > 1) {
				e.mid = Math.round(Math.max(0.05, Math.min(0.95, at / span)) * 100) / 100
			}
			e.midVertical = midVertical
		}
		flowRouted.push(e)
	}

	// ---- verify translated elbows against every other screen ----------------
	const segHits = (a, b, r) => {
		if (Math.abs(a.y - b.y) < 1) {
			const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)]
			return a.y > r.y && a.y < r.y + r.h && x1 > r.x && x0 < r.x + r.w
		}
		const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)]
		return a.x > r.x && a.x < r.x + r.w && y1 > r.y && y0 < r.y + r.h
	}
	let chained = 0
	for (const e of flowRouted) {
		if (e.chainPts) {
			chained++
			continue
		}
		const p0 = anchorPoint(endRect(e.fromShape, e.from), anchors.get(`${e.id}:from`))
		const p3 = anchorPoint(endRect(e.toShape, e.to), anchors.get(`${e.id}:to`))
		let path
		if (e.mid == null) {
			// L-shape or straight: elbow picks the single bend at the far corner
			path = [p0, { x: p3.x, y: p0.y }, p3]
		} else if (e.midVertical) {
			const laneX = p0.x + e.mid * (p3.x - p0.x)
			path = [p0, { x: laneX, y: p0.y }, { x: laneX, y: p3.y }, p3]
		} else {
			const laneY = p0.y + e.mid * (p3.y - p0.y)
			path = [p0, { x: p0.x, y: laneY }, { x: p3.x, y: laneY }, p3]
		}
		const crossed = screens.some((s) => {
			if (s.id === e.from || s.id === e.to) return false
			const r = rectOf(s.id)
			const infl = { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 }
			for (let i = 0; i < path.length - 1; i++) {
				if (segHits(path[i], path[i + 1], infl)) return true
			}
			return false
		})
		if (crossed) {
			// the lossy elbow translation crosses something ELK's exact route
			// avoided — render the exact route as a chain instead
			e.chainPts = simplify(e.elkRoute)
				.slice(1, -1)
				.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
			chained++
		}
	}

	// ---- pack edges: hand-routed bands (hub bottom fan -> brick-gap drops) --
	for (const [hub] of packs) {
		const packEdges = edges.filter(
			(e) =>
				e.routable &&
				((e.from === hub && packOf.get(e.to) === hub) || (e.to === hub && packOf.get(e.from) === hub))
		)
		const leafOf = (e) => (packOf.has(e.from) ? e.from : e.to)
		packEdges.sort((a, b) => {
			const la = targets.get(leafOf(a))
			const lb = targets.get(leafOf(b))
			return la.x - lb.x || la.y - lb.y || (a.id < b.id ? -1 : 1)
		})
		const hubBottom = targets.get(hub).y + byId.get(hub).h
		packEdges.forEach((e, i) => {
			const frac = packEdges.length === 1 ? 0.5 : 0.15 + (0.7 * i) / (packEdges.length - 1)
			const f = Math.round(frac * 100) / 100
			const hubEnd = e.from === hub ? 'from' : 'to'
			anchors.set(`${e.id}:${hubEnd}`, { x: f, y: 1 })
			anchors.set(`${e.id}:${hubEnd === 'from' ? 'to' : 'from'}`, { x: 0.5, y: 0 })
			const leafTop = targets.get(leafOf(e)).y
			if (leafTop > hubBottom) {
				e.mid = Math.round(Math.max(0.05, Math.min(0.95, gapY / 4 / (leafTop - hubBottom))) * 100) / 100
				const row = Math.round((leafTop - hubBottom - gapY / 2) / footprint.get(hub).cellH)
				e.labelAt = row >= 1 ? 0.3 : null
			}
			e.packRouted = true
		})
	}

	// ---- emit chain/route ops -------------------------------------------------
	let routed = 0
	for (const e of edges) {
		if (!e.routable) continue
		const fromAnchor = anchors.get(`${e.id}:from`)
		const toAnchor = anchors.get(`${e.id}:to`)
		if (!fromAnchor && !toAnchor && e.mid == null && !e.chainPts) continue
		if (e.chainPts?.length) {
			ops.push({
				chain: {
					id: e.id,
					points: e.chainPts,
					...(fromAnchor ? { fromAnchor } : {}),
					...(toAnchor ? { toAnchor } : {}),
				},
			})
			routed++
			continue
		}
		// clear any waypoint chain a previous layout may have left on this arrow,
		// then apply the plain-elbow route
		if (!e.packRouted) ops.push({ chain: { id: e.id, points: [] } })
		ops.push({
			route: {
				id: e.id,
				kind: 'elbow', // normalize: a prior layout may have left this an arc
				...(fromAnchor ? { fromAnchor } : {}),
				...(toAnchor ? { toAnchor } : {}),
				...(e.mid != null ? { mid: e.mid } : {}),
				...(e.labelAt != null ? { labelAt: e.labelAt } : {}),
			},
		})
		routed++
	}

	// column count for the report: cluster distinct layer x-positions
	const xs = [...new Set(laid.children.map((c) => Math.round(c.x)))].sort((a, b) => a - b)
	let columns = 0
	let lastX = -Infinity
	for (const x of xs) {
		if (x - lastX >= 40) columns++
		lastX = x
	}

	report.push(
		`${deltas.size} of ${screens.length} screens arranged by ELK layered into ${columns} flow column(s)` +
			`${packs.size ? ` + ${packs.size} satellite pack(s) (${[...packs.values()].reduce((a, l) => a + l.length, 0)} screens gridded under their hubs)` : ''} (${edges.length} transitions considered)`
	)
	if (routed) {
		report.push(`${routed} transition arrows routed along ELK's reserved channels`)
	}
	if (chained) {
		report.push(
			`${chained} route(s) needed more bends than one arrow can hold - rendered as waypoint chains (queries still see single transitions)`
		)
	}
	if (unmovableArrows) {
		report.push(
			`WARN: ${unmovableArrows} unsnapped arrow(s) span screens that moved differently - they may need re-drawing (bound arrows follow automatically)`
		)
	}
	return { ops, report }
}
