/**
 * Flow-aware layout, powered by ELK's layered algorithm (the full Sugiyama
 * pipeline: proper cycle breaking, layering with node promotion, layer-sweep
 * crossing minimization, Brandes-Köpf placement, aspect-ratio-aware wrapping).
 *
 * Edges are first-class in the layout, not an afterthought: ELK routes them
 * WITH the placement — long edges get dummy vertices that reserve physical
 * channels through intermediate columns, and inter-layer spacing grows with
 * lane count. We consume those routes and translate them into what a tldraw
 * elbow can express (two anchors + one adjustable middle segment). Every
 * route IS a plain elbow — no waypoint chains. A route that crosses a screen
 * gets a joint re-solve (exit sides near the frame edge x entry positions
 * aligned with the arriving line); if no clear elbow exists and the blocking
 * screen is a small leaf, the SCREEN moves to open a channel. Whatever still
 * crosses after the final fix_crossings pass (same search against real
 * editor geometry) is left in place for lint to report. Satellite screens
 * (dead-end modals of a single hub) skip the flow entirely and stack in a
 * column on the hub's quiet side with fused trunk routing.
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
				label: a.label ?? null,
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
	// single-leaf packs are fine: a lone dead-end (a toast off a share sheet)
	// still belongs in a column on its hub's quiet side, not in the flow

	// ---- shared satellites (reference rule 1) --------------------------------
	// A low-degree screen referenced by two or more hub-like screens (Settings
	// reachable from both game modes, a shared share-sheet) leaves the flow
	// graph entirely. A column layout necessarily pushes it past ALL of its
	// referencers; instead it will sit at the barycenter BETWEEN them.
	const degree = (id) => neighborSets.get(id)?.size ?? 0
	const hubLike = (id) => degree(id) >= 4
	const satellites = new Set()
	for (const s of screens) {
		if (packOf.has(s.id) || packs.has(s.id)) continue
		const d = degree(s.id)
		if (d < 2 || d > 3) continue
		const hubNeighbors = [...neighborSets.get(s.id)].filter(hubLike)
		if (hubNeighbors.length >= 2) satellites.add(s.id)
	}

	// pack columns: leaves stack in ONE column beside the hub (the reference
	// stacks a hub's outcome screens next to it with a fused return trunk),
	// with real breathing room between them. The hub-to-column channel grows
	// with the number of arrows that will live in it (user finding: busy
	// corridors like Discovery's need far more air than a single-arrow one).
	const PACK_GAP = Math.round(gapY / 3)
	const packEdgeCount = new Map()
	for (const e of edges) {
		for (const end of [e.from, e.to]) {
			const hub = packOf.get(end)
			if (hub != null) packEdgeCount.set(hub, (packEdgeCount.get(hub) ?? 0) + 1)
		}
	}
	// every distinct terminal point gets its own lane at 56px steps, so the
	// channel reserves room for the worst case (one lane per edge) plus air
	const chanOf = (hub) =>
		Math.max(
			gapX * 0.75,
			Math.round(gapX * 0.3 + 56 * Math.max(0, (packEdgeCount.get(hub) ?? 1) - 1) + 104)
		)
	const footprint = new Map() // hubId -> {w, h, colW, colH}
	for (const [hub, leaves] of packs) {
		leaves.sort((a, b) => (byId.get(a).name ?? a).localeCompare(byId.get(b).name ?? b))
		const colW = Math.max(...leaves.map((l) => byId.get(l).w))
		const colH =
			leaves.reduce((acc, l) => acc + byId.get(l).h, 0) + PACK_GAP * (leaves.length - 1)
		const h = byId.get(hub)
		footprint.set(hub, { w: h.w + chanOf(hub) + colW, h: Math.max(h.h, colH), colW, colH })
	}

	const flowScreens = screens.filter((s) => !packOf.has(s.id) && !satellites.has(s.id))
	const flowEdges = edges.filter(
		(e) =>
			!packOf.has(e.from) &&
			!packOf.has(e.to) &&
			!satellites.has(e.from) &&
			!satellites.has(e.to)
	)

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
			// give edge channels real width so lanes don't kiss the screens or
			// visually merge with each other over long parallel runs
			'elk.spacing.edgeNode': '64',
			'elk.spacing.edgeEdge': '36',
			'elk.layered.spacing.edgeNodeBetweenLayers': '64',
			'elk.layered.spacing.edgeEdgeBetweenLayers': '36',
			// NETWORK_SIMPLEX packs uneven-height screens tighter than the
			// default placement, shortening edges across the board
			'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
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
	if (process.env.CLAW_LAYOUT_DEBUG) {
		console.error(
			'DEBUG screens:',
			screens.length,
			'flowScreens:',
			flowScreens.length,
			'targets:',
			targets.size,
			'sample:',
			JSON.stringify([...targets.entries()].slice(0, 3)),
			'screen sample:',
			JSON.stringify(screens.slice(0, 3).map((s) => ({ id: s.id, x: s.x, y: s.y })))
		)
	}
	// attach ELK's computed route to each flow edge
	const laidEdgeById = new Map((laid.edges ?? []).map((le) => [le.id, le]))
	flowEdges.forEach((e, i) => {
		const s = laidEdgeById.get(`e${i}`)?.sections?.[0]
		if (s) e.elkRoute = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]
	})

	// place each pack's column beside its hub, inside the reserved footprint.
	// Side selection weighs two costs: the column should sit AWAY from the
	// hub's flow traffic (or every outbound arrow threads between the
	// satellites), and it should sit NEAR the controls that link to the
	// leaves — a trunk exiting a control on the far side crosses the hub's
	// own frame the whole way (user finding: Copy sits at ShareSheet's left
	// edge, so Toast belongs on the left).
	const packSide = new Map() // hubId -> 1 (column right) | -1 (column left)
	for (const [hub, leaves] of packs) {
		const t = targets.get(hub)
		if (!t) continue
		const hubShape = byId.get(hub)
		const f = footprint.get(hub)
		let leftTraffic = 0
		let rightTraffic = 0
		for (const e of flowEdges) {
			const other = e.from === hub ? e.to : e.to === hub ? e.from : null
			if (!other) continue
			const ot = targets.get(other)
			if (!ot) continue
			if (ot.x + byId.get(other).w / 2 > t.x + f.w / 2) rightTraffic++
			else leftTraffic++
		}
		// mean own-frame crossing each side would cost, from the linking
		// controls' positions inside the hub (0 = control on that edge)
		let exL = 0
		let exR = 0
		let nCtl = 0
		for (const e of edges) {
			let ctl = null
			if (e.from === hub && packOf.get(e.to) === hub) ctl = e.fromShape
			else if (e.to === hub && packOf.get(e.from) === hub) ctl = e.toShape
			if (!ctl || ctl === hub) continue
			const c = byId.get(ctl)
			if (!c) continue
			exL += Math.max(0, c.x - hubShape.x)
			exR += Math.max(0, hubShape.x + hubShape.w - (c.x + c.w))
			nCtl++
		}
		const total = Math.max(1, leftTraffic + rightTraffic)
		const costLeft = (nCtl ? exL / nCtl / hubShape.w : 0.5) * 3 + leftTraffic / total
		const costRight = (nCtl ? exR / nCtl / hubShape.w : 0.5) * 3 + rightTraffic / total
		const side = costRight <= costLeft ? 1 : -1
		packSide.set(hub, side)
		// the hub sits inside the reserved box: at its left edge when the
		// column is right, at its right edge when the column is left
		const chan = chanOf(hub)
		const hubX = side === 1 ? t.x : t.x + f.colW + chan
		const colX = side === 1 ? t.x + hubShape.w + chan : t.x
		targets.set(hub, { x: Math.round(hubX), y: t.y })
		let y = t.y
		for (const leaf of leaves) {
			targets.set(leaf, { x: Math.round(colX), y: Math.round(y) })
			y += byId.get(leaf).h + PACK_GAP
		}
	}

	// place satellites at the barycenter of their placed neighbors, nudged to
	// the nearest clear spot (waves, so satellites can depend on each other)
	let satellitesPlaced = 0
	{
		const margin = Math.round(gapY / 3)
		const rectAt = (id) => {
			const t = targets.get(id)
			const s = byId.get(id)
			return t && s ? { x: t.x, y: t.y, w: s.w, h: s.h } : null
		}
		const collides = (r) => {
			for (const id of targets.keys()) {
				const o = rectAt(id)
				if (!o) continue
				if (
					r.x < o.x + o.w + margin &&
					r.x + r.w + margin > o.x &&
					r.y < o.y + o.h + margin &&
					r.y + r.h + margin > o.y
				) {
					return true
				}
			}
			return false
		}
		let pending = [...satellites]
		for (let wave = 0; wave < 4 && pending.length; wave++) {
			const still = []
			for (const id of pending) {
				const neighbors = [...neighborSets.get(id)].filter((n) => targets.has(n))
				const want = Math.min(2, neighborSets.get(id).size)
				if (neighbors.length < want && wave < 3) {
					still.push(id)
					continue
				}
				if (!neighbors.length) {
					still.push(id)
					continue
				}
				const s = byId.get(id)
				const cx =
					neighbors.reduce((acc, n) => acc + targets.get(n).x + byId.get(n).w / 2, 0) /
					neighbors.length
				const cy =
					neighbors.reduce((acc, n) => acc + targets.get(n).y + byId.get(n).h / 2, 0) /
					neighbors.length
				const base = { x: cx - s.w / 2, y: cy - s.h / 2 }
				let spot = null
				search: for (let radius = 0; radius <= 6; radius++) {
					const step = radius * (gapY / 2)
					const cands =
						radius === 0
							? [base]
							: [
									{ x: base.x, y: base.y - step },
									{ x: base.x, y: base.y + step },
									{ x: base.x - step, y: base.y },
									{ x: base.x + step, y: base.y },
									{ x: base.x - step, y: base.y - step },
									{ x: base.x + step, y: base.y - step },
									{ x: base.x - step, y: base.y + step },
									{ x: base.x + step, y: base.y + step },
								]
					for (const c of cands) {
						if (!collides({ x: c.x, y: c.y, w: s.w, h: s.h })) {
							spot = c
							break search
						}
					}
				}
				if (spot) {
					targets.set(id, { x: Math.round(spot.x), y: Math.round(spot.y) })
					satellitesPlaced++
				} else {
					still.push(id)
				}
			}
			if (still.length === pending.length) break
			pending = still
		}
		// anything unplaceable keeps its current position; bound arrows adapt
	}

	// ---- emit move ops -------------------------------------------------------
	// first op: restore every chain to a plain bound arrow and sweep debris
	// from older/broken chains. Without this, re-running layout leaves stale
	// frozen routes crossing the new arrangement (chains don't self-heal).
	const ops = [{ unchain_all: {} }]
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
	/**
	 * Remove short perpendicular jogs from an orthogonal polyline: ELK's
	 * staircase routes often differ from a clean elbow only by sub-gap
	 * doglegs, and every removed jog is a bend the final elbow never needs.
	 * Endpoint-adjacent points stay put (they are anchored on screens).
	 */
	const dejog = (ptsIn, tol) => {
		let out = ptsIn.map((p) => ({ ...p }))
		for (let pass = 0; pass < 8; pass++) {
			let idx = -1
			for (let i = 1; i < out.length - 2; i++) {
				if (i - 1 < 1 || i + 2 > out.length - 2) continue
				const len = Math.abs(out[i].x - out[i + 1].x) + Math.abs(out[i].y - out[i + 1].y)
				if (len < tol) {
					idx = i
					break
				}
			}
			if (idx === -1) break
			const a = out[idx]
			const b = out[idx + 1]
			if (Math.abs(a.x - b.x) < 1) {
				const y = Math.round((a.y + b.y) / 2)
				out[idx - 1].y = y
				a.y = y
				b.y = y
				out[idx + 2].y = y
			} else {
				const x = Math.round((a.x + b.x) / 2)
				out[idx - 1].x = x
				a.x = x
				b.x = x
				out[idx + 2].x = x
			}
			out = simplify(out)
		}
		return out
	}

	/** does a horizontal/vertical segment pass through rect r */
	const segHits = (a, b, r) => {
		if (Math.abs(a.y - b.y) < 1) {
			const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)]
			return a.y > r.y && a.y < r.y + r.h && x1 > r.x && x0 < r.x + r.w
		}
		const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)]
		return a.x > r.x && a.x < r.x + r.w && y1 > r.y && y0 < r.y + r.h
	}
	/** the polyline a tldraw elbow with this mid would draw */
	const elbowPath = (p0, p3, mid, midVertical) => {
		if (mid == null) return [p0, { x: p3.x, y: p0.y }, p3]
		if (midVertical) {
			const laneX = p0.x + mid * (p3.x - p0.x)
			return [p0, { x: laneX, y: p0.y }, { x: laneX, y: p3.y }, p3]
		}
		const laneY = p0.y + mid * (p3.y - p0.y)
		return [p0, { x: p0.x, y: laneY }, { x: p3.x, y: laneY }, p3]
	}
	/** total length of a path's orthogonal segments inside rect r */
	const insideLen = (path, r) => {
		let total = 0
		for (let i = 0; i < path.length - 1; i++) {
			const a = path[i]
			const b = path[i + 1]
			if (Math.abs(a.x - b.x) < 1) {
				if (a.x > r.x && a.x < r.x + r.w) {
					total += Math.max(
						0,
						Math.min(Math.max(a.y, b.y), r.y + r.h) - Math.max(Math.min(a.y, b.y), r.y)
					)
				}
			} else if (a.y > r.y && a.y < r.y + r.h) {
				total += Math.max(
					0,
					Math.min(Math.max(a.x, b.x), r.x + r.w) - Math.max(Math.min(a.x, b.x), r.x)
				)
			}
		}
		return total
	}
	// a route is bad if it cuts an unrelated screen, OR if it travels more
	// than the exit allowance inside its OWN screens (a control-bound arrow
	// may cross the strip between the control and the frame edge, no more)
	const pathCrosses = (path, skipA, skipB) => {
		for (const s of screens) {
			if (s.id === skipA || s.id === skipB) continue
			const r = rectOf(s.id)
			const infl = { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 }
			for (let i = 0; i < path.length - 1; i++) {
				if (segHits(path[i], path[i + 1], infl)) return true
			}
		}
		for (const own of [skipA, skipB]) {
			if (!own || !targets.has(own)) continue
			if (insideLen(path, rectOf(own)) > 200) return true
		}
		return false
	}
	// routes need AIR, not just non-intersection: a line 5px above a frame
	// reads as touching it. CLEARANCE is the soft margin; passing inside it
	// is penalized in scoring and triggers a re-solve, but never hard-fails
	// a route (dense areas keep their best option).
	const CLEARANCE = 56
	const nearPassers = (path, skipA, skipB, margin = CLEARANCE) => {
		const out = []
		for (const s of screens) {
			if (s.id === skipA || s.id === skipB) continue
			const r = rectOf(s.id)
			const infl = { x: r.x - margin, y: r.y - margin, w: r.w + margin * 2, h: r.h + margin * 2 }
			for (let i = 0; i < path.length - 1; i++) {
				if (segHits(path[i], path[i + 1], infl)) {
					out.push(s.id)
					break
				}
			}
		}
		return out
	}
	/** comparable badness of a full path: bends, length, own-frame pixels,
	 * near-passes, and a heavy term for real crossings */
	const pathScore = (path, from, to) => {
		let len = 0
		for (let i = 0; i < path.length - 1; i++) {
			len += Math.abs(path[i + 1].x - path[i].x) + Math.abs(path[i + 1].y - path[i].y)
		}
		return (
			(path.length - 2) * 320 +
			len +
			(insideLen(path, rectOf(from)) + insideLen(path, rectOf(to))) * 3 +
			nearPassers(path, from, to).length * 400 +
			(pathCrosses(path, from, to) ? 10000 : 0)
		)
	}
	// tldraw elbows LEAVE perpendicular-outward from the start side and ARRIVE
	// perpendicular-inward at the end side. A candidate whose first or last leg
	// contradicts that is not a route tldraw can draw - it would wrap with
	// extra segments the planner never scored (this exact gap once sent a
	// planner-approved route through Settings in real geometry).
	const exitLegOk = (side, from, to) =>
		side === 'right'
			? to.x > from.x
			: side === 'left'
				? to.x < from.x
				: side === 'top'
					? to.y < from.y
					: to.y > from.y
	const entryLegOk = (side, prev, end) =>
		side === 'right'
			? prev.x > end.x
			: side === 'left'
				? prev.x < end.x
				: side === 'top'
					? prev.y < end.y
					: prev.y > end.y
	/**
	 * Joint elbow search (chains are retired - the reference proves every
	 * route can be an elbow). Candidate exit sides: the sides of the bound
	 * control near its frame's edge. Candidate entries: each target side,
	 * with the entry POSITION aligned to where the line arrives (the
	 * reference reworks enter at aligned fractions, collapsing routes to 1-2
	 * segments). Score: crossings and own-frame budget reject, then fewest
	 * bends, then shortest.
	 */
	const bestElbow = (e) => {
		const fr = endRect(e.fromShape, e.from)
		const tr = endRect(e.toShape, e.to)
		const sideDefs = (rect, frame) => {
			const defs = []
			const near = (d) => d <= 220
			if (near(rect.x - frame.x)) defs.push({ side: 'left', a: { x: 0, y: 0.5 } })
			if (near(frame.x + frame.w - (rect.x + rect.w))) defs.push({ side: 'right', a: { x: 1, y: 0.5 } })
			if (near(rect.y - frame.y)) defs.push({ side: 'top', a: { x: 0.5, y: 0 } })
			if (near(frame.y + frame.h - (rect.y + rect.h))) defs.push({ side: 'bottom', a: { x: 0.5, y: 1 } })
			return defs.length
				? defs
				: [
						{ side: 'left', a: { x: 0, y: 0.5 } },
						{ side: 'right', a: { x: 1, y: 0.5 } },
						{ side: 'top', a: { x: 0.5, y: 0 } },
						{ side: 'bottom', a: { x: 0.5, y: 1 } },
					]
		}
		const fromDefs = sideDefs(fr, rectOf(e.from))
		const toDefs = sideDefs(tr, rectOf(e.to))
		// positions along a side: the center, plus 0.28/0.72 variants - the
		// variants are what thread a route through a narrow corridor the side
		// center cannot reach (they used to live only in the executor's
		// repair search; the planner is the single author of anchors now)
		const posVariant = (def, pos) =>
			def.side === 'top' || def.side === 'bottom' ? { x: pos, y: def.a.y } : { x: def.a.x, y: pos }
		let best = null
		for (const fd of fromDefs) {
			for (const fpos of [0.5, 0.28, 0.72]) {
				const fa = posVariant(fd, fpos)
				const p0 = anchorPoint(fr, fa)
				for (const td of toDefs) {
					// entries: aligned with the arriving line where geometry allows,
					// plus the position variants
					const tas = []
					if (td.side === 'top' || td.side === 'bottom') {
						const fracX = (p0.x - tr.x) / tr.w
						if (fracX > 0.06 && fracX < 0.94) {
							tas.push({ x: Math.round(fracX * 1000) / 1000, y: td.a.y })
						}
					} else {
						const fracY = (p0.y - tr.y) / tr.h
						if (fracY > 0.06 && fracY < 0.94) {
							tas.push({ x: td.a.x, y: Math.round(fracY * 1000) / 1000 })
						}
					}
					for (const tpos of [0.5, 0.28, 0.72]) tas.push(posVariant(td, tpos))
					const fromVert = fd.side === 'top' || fd.side === 'bottom'
					const toVert = td.side === 'top' || td.side === 'bottom'
					const sameSide = fd.side === td.side
					for (const ta of tas) {
						const p3 = anchorPoint(tr, ta)
						const cands = []
						if (fromVert && toVert) {
							if (Math.abs(p0.x - p3.x) < 2) cands.push({ path: [p0, p3], mid: null, mv: false })
							const bandY = sameSide
								? fd.side === 'top'
									? Math.min(p0.y, p3.y) - 80
									: Math.max(p0.y, p3.y) + 80
								: (p0.y + p3.y) / 2
							cands.push({
								path: [p0, { x: p0.x, y: bandY }, { x: p3.x, y: bandY }, p3],
								mid: sameSide ? null : 0.5,
								mv: false,
							})
						} else if (fromVert) {
							cands.push({ path: [p0, { x: p0.x, y: p3.y }, p3], mid: null, mv: false })
						} else if (toVert) {
							cands.push({ path: [p0, { x: p3.x, y: p0.y }, p3], mid: null, mv: true })
						} else {
							if (Math.abs(p0.y - p3.y) < 2) cands.push({ path: [p0, p3], mid: null, mv: true })
							const bandX = sameSide
								? fd.side === 'left'
									? Math.min(p0.x, p3.x) - 80
									: Math.max(p0.x, p3.x) + 80
								: (p0.x + p3.x) / 2
							cands.push({
								path: [p0, { x: bandX, y: p0.y }, { x: bandX, y: p3.y }, p3],
								mid: sameSide ? null : 0.5,
								mv: true,
							})
						}
						for (const c of cands) {
							if (!exitLegOk(fd.side, c.path[0], c.path[1])) continue
							if (!entryLegOk(td.side, c.path[c.path.length - 2], c.path[c.path.length - 1])) continue
							if (pathCrosses(c.path, e.from, e.to)) continue
							// same-side loops are the one shape tldraw draws least
							// predictably; prefer any drawable alternative
							const score = pathScore(c.path, e.from, e.to) + (sameSide ? 400 : 0)
							if (!best || score < best.score) {
								best = { score, fa, ta, mid: c.mid, midVertical: c.mv }
							}
						}
					}
				}
			}
		}
		return best
	}

	/** scan lane positions for an elbow that is both screen-free AND keeps
	 * clearance from every screen; lockVertical restricts to the one lane
	 * orientation the anchor sides can express */
	const findClearMid = (p0, p3, skipA, skipB, preferVertical, lockVertical = null) => {
		const orients =
			lockVertical != null ? [lockVertical] : preferVertical ? [true, false] : [false, true]
		for (const vertical of orients) {
			for (const m of [0.5, 0.35, 0.65, 0.2, 0.8, 0.12, 0.88]) {
				const path = elbowPath(p0, p3, m, vertical)
				if (!pathCrosses(path, skipA, skipB) && !nearPassers(path, skipA, skipB).length) {
					return { mid: m, vertical }
				}
			}
		}
		return null
	}

	// ---- anchor-side-aware path model ------------------------------------------
	// tldraw's elbow leaves PERPENDICULAR to the start side and arrives
	// perpendicular to the end side; this model is what every pass scores and
	// verifies against, so it must match what tldraw actually draws.
	const sideOfAnchor = (a) =>
		a.x === 0 ? 'L' : a.x === 1 ? 'R' : a.y === 0 ? 'T' : a.y === 1 ? 'B' : null
	// a mid fraction only means something to tldraw between FACING sides
	// (left-right or top-bottom); for same-side and mixed pairs tldraw shapes
	// the route itself
	const midMeaningful = (fa, ta) => {
		const fs = sideOfAnchor(fa)
		const ts = sideOfAnchor(ta)
		if (!fs || !ts) return true
		const fH = fs === 'L' || fs === 'R'
		const tH = ts === 'L' || ts === 'R'
		return fH === tH && fs !== ts
	}
	const routePath = (e, ov = {}) => {
		const fa = ov.fa ?? anchors.get(`${e.id}:from`)
		const ta = ov.ta ?? anchors.get(`${e.id}:to`)
		if (!fa || !ta) return null
		const p0 = anchorPoint(endRect(e.fromShape, e.from), fa)
		const p3 = anchorPoint(endRect(e.toShape, e.to), ta)
		const mid = 'mid' in ov ? ov.mid : (e.mid ?? null)
		const fs = sideOfAnchor(fa)
		const ts = sideOfAnchor(ta)
		if (!fs || !ts) return elbowPath(p0, p3, mid, !!e.midVertical)
		const fH = fs === 'L' || fs === 'R'
		const tH = ts === 'L' || ts === 'R'
		if (fs === ts) {
			// same side: the route loops OUTSIDE that side, never between the ends
			const off = 80
			if (fs === 'L') {
				const bx = Math.min(p0.x, p3.x) - off
				return [p0, { x: bx, y: p0.y }, { x: bx, y: p3.y }, p3]
			}
			if (fs === 'R') {
				const bx = Math.max(p0.x, p3.x) + off
				return [p0, { x: bx, y: p0.y }, { x: bx, y: p3.y }, p3]
			}
			if (fs === 'T') {
				const by = Math.min(p0.y, p3.y) - off
				return [p0, { x: p0.x, y: by }, { x: p3.x, y: by }, p3]
			}
			const by = Math.max(p0.y, p3.y) + off
			return [p0, { x: p0.x, y: by }, { x: p3.x, y: by }, p3]
		}
		const simple =
			fH && tH
				? elbowPath(p0, p3, mid ?? 0.5, true)
				: !fH && !tH
					? elbowPath(p0, p3, mid ?? 0.5, false)
					: // mixed orientations: L along the exit axis, then the entry axis
						fH
						? [p0, { x: p3.x, y: p0.y }, p3]
						: [p0, { x: p0.x, y: p3.y }, p3]
		const longSide = { L: 'left', R: 'right', T: 'top', B: 'bottom' }
		if (
			exitLegOk(longSide[fs], simple[0], simple[1]) &&
			entryLegOk(longSide[ts], simple[simple.length - 2], simple[simple.length - 1])
		) {
			return simple
		}
		// the simple shape contradicts an anchor side: tldraw wraps instead -
		// out from the exit side, around, and in against the entry side
		const dir = (s) =>
			s === 'L' ? { x: -1, y: 0 } : s === 'R' ? { x: 1, y: 0 } : s === 'T' ? { x: 0, y: -1 } : { x: 0, y: 1 }
		const o0 = { x: p0.x + dir(fs).x * 40, y: p0.y + dir(fs).y * 40 }
		const o3 = { x: p3.x + dir(ts).x * 40, y: p3.y + dir(ts).y * 40 }
		const corner = fH ? { x: o0.x, y: o3.y } : { x: o3.x, y: o0.y }
		return [p0, o0, corner, o3, p3]
	}
	const currentPath = (e) => routePath(e)

	/**
	 * Anchor side for an endpoint bound to a control INSIDE a frame: exit
	 * through the frame edge that is close to the control AND points roughly
	 * toward the other end. A button at the frame's bottom must not exit
	 * through the top and drag its arrow across the whole frame (user
	 * finding, the DiscoveryIntro "Let's Play" case).
	 */
	const chooseControlAnchor = (ctl, frame, toward, frac) => {
		const cands = [
			{ exitDist: Math.max(0, ctl.x - frame.x), dir: { x: -1, y: 0 }, a: { x: 0, y: frac } },
			{
				exitDist: Math.max(0, frame.x + frame.w - (ctl.x + ctl.w)),
				dir: { x: 1, y: 0 },
				a: { x: 1, y: frac },
			},
			{ exitDist: Math.max(0, ctl.y - frame.y), dir: { x: 0, y: -1 }, a: { x: frac, y: 0 } },
			{
				exitDist: Math.max(0, frame.y + frame.h - (ctl.y + ctl.h)),
				dir: { x: 0, y: 1 },
				a: { x: frac, y: 1 },
			},
		]
		const cx = ctl.x + ctl.w / 2
		const cy = ctl.y + ctl.h / 2
		const tx = toward.x - cx
		const ty = toward.y - cy
		const len = Math.hypot(tx, ty) || 1
		let best = null
		for (const c of cands) {
			const dot = (c.dir.x * tx + c.dir.y * ty) / len
			// not crossing the frame outranks pointing at the destination
			// (user finding: a bottom button should exit the bottom even when
			// the destination is up-left)
			const score = c.exitDist * 3 + (dot < 0 ? 400 : 0) - dot * 60
			if (!best || score < best.score) best = { score, a: c.a }
		}
		return best.a
	}

	/** normalized anchor on rect r for a route endpoint p leaving toward q */
	const anchorFor = (r, p, q) => {
		const horizontal = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y)
		if (horizontal) {
			return {
				x: q.x > p.x ? 1 : 0,
				y: Math.round(Math.max(0.1, Math.min(0.9, (p.y - r.y) / r.h)) * 1000) / 1000,
			}
		}
		return {
			x: Math.round(Math.max(0.1, Math.min(0.9, (p.x - r.x) / r.w)) * 1000) / 1000,
			y: q.y > p.y ? 1 : 0,
		}
	}


	const flowRouted = []
	for (const e of flowEdges) {
		if (!e.routable || !e.elkRoute || e.elkRoute.length < 2) continue
		e.pts = dejog(simplify(e.elkRoute), 48)
		const fr = endRect(e.fromShape, e.from)
		const tr = endRect(e.toShape, e.to)
		// control-bound endpoints pick their own exit side (nearest frame edge
		// toward the other end); frame-bound endpoints follow ELK's route
		anchors.set(
			`${e.id}:from`,
			e.fromShape !== e.from
				? chooseControlAnchor(fr, rectOf(e.from), e.pts[e.pts.length - 1], 0.38)
				: anchorFor(fr, e.pts[0], e.pts[1])
		)
		anchors.set(
			`${e.id}:to`,
			e.toShape !== e.to
				? chooseControlAnchor(tr, rectOf(e.to), e.pts[0], 0.62)
				: anchorFor(tr, e.pts[e.pts.length - 1], e.pts[e.pts.length - 2])
		)
		flowRouted.push(e)
	}

	// ---- fuse anchors (reference rule, corrected) ------------------------------
	// Routes may overlap ONLY when the overlap is forced by a truly shared
	// terminal point. Frame-bound endpoints snap to a standard spot on their
	// side (0.38 outgoing / 0.62 incoming, so a start never sits on an end),
	// which makes same-frame-side edges genuinely share that point - those
	// fuse into a trunk that branches late. Edges starting at DIFFERENT
	// controls have different start points and never share a lane.
	{
		const sourceGroups = new Map() // `${startPoint}:${orientation}` -> edges
		for (const e of flowRouted) {
			for (const end of ['from', 'to']) {
				const a = anchors.get(`${e.id}:${end}`)
				const side = a.x === 0 ? 'left' : a.x === 1 ? 'right' : a.y === 0 ? 'top' : 'bottom'
				const frac = end === 'from' ? 0.38 : 0.62
				if (side === 'left' || side === 'right') a.y = frac
				else a.x = frac
				if (end === 'from' && e.pts.length === 4) {
					const midVertical = Math.abs(e.pts[1].x - e.pts[2].x) < 1
					// key by the actual page-space start point: only edges leaving
					// the exact same spot may share a lane
					const p = anchorPoint(endRect(e.fromShape, e.from), a)
					const key = `${Math.round(p.x)},${Math.round(p.y)}:${midVertical ? 'v' : 'h'}`
					if (!sourceGroups.has(key)) sourceGroups.set(key, [])
					sourceGroups.get(key).push(e)
				}
			}
		}
		for (const group of sourceGroups.values()) {
			if (group.length < 2) continue
			// shared lane = median of the lanes ELK assigned to the group
			const lanes = group
				.map((e) => (Math.abs(e.pts[1].x - e.pts[2].x) < 1 ? e.pts[1].x : e.pts[1].y))
				.sort((a, b) => a - b)
			const lane = lanes[Math.floor(lanes.length / 2)]
			for (const e of group) {
				e.sharedLane = lane
				e.fused = true
			}
		}
	}

	// ---- derive chains / labels / mids from the (possibly shifted) anchors --
	for (const e of flowRouted) {
		const pts = e.pts
		const fr = endRect(e.fromShape, e.from)
		const tr = endRect(e.toShape, e.to)
		const fa = anchors.get(`${e.id}:from`)
		const ta = anchors.get(`${e.id}:to`)
		// chains are retired: routes ELK drew with more bends than one elbow
		// holds get re-solved by bestElbow in the verify pass instead
		if (pts.length === 4) {
			// H-V-H or V-H-V: position the middle segment where ELK put it,
			// or on the group's shared lane when this edge is part of a fused
			// trunk (all trunk members overlap until the lane, then branch)
			const exit = anchorPoint(fr, fa)
			const entry = anchorPoint(tr, ta)
			const midVertical = Math.abs(pts[1].x - pts[2].x) < 1
			const span = midVertical ? entry.x - exit.x : entry.y - exit.y
			const at =
				(e.sharedLane ?? (midVertical ? pts[1].x : pts[1].y)) - (midVertical ? exit.x : exit.y)
			if (Math.abs(span) > 1) {
				e.mid = Math.round(Math.max(0.05, Math.min(0.95, at / span)) * 1000) / 1000
			}
			e.midVertical = midVertical
			// labels: on a fused trunk, sit just after the branch point (where
			// this edge becomes distinguishable); otherwise near the start
			const manhattan = Math.abs(entry.x - exit.x) + Math.abs(entry.y - exit.y)
			if (e.fused && manhattan > 1) {
				e.labelAt = Math.round(Math.max(0.1, Math.min(0.7, (Math.abs(at) + 60) / manhattan)) * 1000) / 1000
			} else if (manhattan > 600) {
				e.labelAt = 0.2
			}
		} else {
			// straight or single-bend route: label near the start when long
			const exit = anchorPoint(fr, fa)
			const entry = anchorPoint(tr, ta)
			const manhattan = Math.abs(entry.x - exit.x) + Math.abs(entry.y - exit.y)
			if (manhattan > 600) e.labelAt = 0.2
		}
	}

	const hubTrunk = new Map() // hubId -> {side, groups: [{point, lane, outgoing}]}

	// ---- pack edges: one lane per shared terminal point ------------------------
	// Fusion rule (user correction): two routes may overlap ONLY when the
	// overlap is forced by a shared terminal point - same start point (a
	// trunk that branches) or same end point (runs converging into one
	// anchor). Pack edges from DIFFERENT controls to DIFFERENT leaves share
	// nothing, so each group keyed by its hub-side terminal point gets its
	// own lane, stacked outward at 56px steps. The 0.38/0.62 direction split
	// keeps a start point from ever also being an end point.
	for (const [hub] of packs) {
		const hubT = targets.get(hub)
		if (!hubT) continue
		const hubShape = byId.get(hub)
		const side = packSide.get(hub) ?? 1
		const packEdges = edges.filter(
			(e) =>
				e.routable &&
				((e.from === hub && packOf.get(e.to) === hub) || (e.to === hub && packOf.get(e.from) === hub))
		)
		const hubEdgeX = side === 1 ? hubT.x + hubShape.w : hubT.x
		const entries = []
		for (const e of packEdges) {
			const outgoing = e.from === hub
			const hubEnd = outgoing ? 'from' : 'to'
			const frac = outgoing ? 0.38 : 0.62
			anchors.set(`${e.id}:${hubEnd}`, { x: side === 1 ? 1 : 0, y: frac })
			anchors.set(`${e.id}:${hubEnd === 'from' ? 'to' : 'from'}`, {
				x: side === 1 ? 0 : 1,
				y: frac,
			})
			// terminal points solved against the BOUND shapes (controls), the
			// same geometry tldraw will draw between
			const p0 = anchorPoint(endRect(e.fromShape, e.from), anchors.get(`${e.id}:from`))
			const p3 = anchorPoint(endRect(e.toShape, e.to), anchors.get(`${e.id}:to`))
			entries.push({ e, outgoing, p0, p3, hubP: outgoing ? p0 : p3, leafP: outgoing ? p3 : p0 })
		}
		const groups = []
		for (const en of entries) {
			const g = groups.find(
				(g) =>
					g.outgoing === en.outgoing &&
					Math.hypot(g.hubP.x - en.hubP.x, g.hubP.y - en.hubP.y) < 4
			)
			if (g) g.members.push(en)
			else groups.push({ outgoing: en.outgoing, hubP: en.hubP, members: [en] })
		}
		// shortest vertical runs take the inner lanes; long hauls go outside
		for (const g of groups) {
			g.span = Math.max(...g.members.map((m) => Math.abs(m.leafP.y - g.hubP.y)))
		}
		groups.sort((a, b) => a.span - b.span)
		const trunkGroups = []
		groups.forEach((g, i) => {
			const lane = hubEdgeX + side * (gapX * 0.3 + 56 * i)
			trunkGroups.push({ point: g.hubP, lane, outgoing: g.outgoing })
			for (const m of g.members) {
				const e = m.e
				const span = m.p3.x - m.p0.x
				if (Math.abs(span) > 1) {
					e.mid = Math.round(Math.max(0.05, Math.min(0.95, (lane - m.p0.x) / span)) * 1000) / 1000
				}
				e.midVertical = true
				e.fused = true
				e.laneAbs = lane
				const manhattan = Math.abs(span) + Math.abs(m.leafP.y - g.hubP.y)
				if (manhattan > 1) {
					e.labelAt =
						Math.round(Math.max(0.1, Math.min(0.7, (gapX / 4 + 60) / manhattan)) * 1000) / 1000
				}
				e.packRouted = true
			}
		})
		hubTrunk.set(hub, { side, groups: trunkGroups })
	}

	// ---- stray edges: everything the flow/pack routers don't own -------------
	// (satellite hops, pack leaf -> elsewhere). Route them as real elbows on
	// facing side-centers, scanning lane positions for a screen-free path;
	// an edge with no clear elbow is left for fix_crossings' corridor detours.
	for (const e of edges) {
		if (!e.routable || e.packRouted || anchors.has(`${e.id}:from`)) continue
		const fr = endRect(e.fromShape, e.from)
		const tr = endRect(e.toShape, e.to)
		const fc = { x: fr.x + fr.w / 2, y: fr.y + fr.h / 2 }
		const tc = { x: tr.x + tr.w / 2, y: tr.y + tr.h / 2 }
		const horizontal = Math.abs(tc.x - fc.x) >= Math.abs(tc.y - fc.y)
		// 0.38/0.62: outgoing and incoming never share a point (see fuse pass);
		// control-bound endpoints exit through their nearest sensible frame edge
		const fa =
			e.fromShape !== e.from
				? chooseControlAnchor(fr, rectOf(e.from), tc, 0.38)
				: horizontal
					? { x: tc.x > fc.x ? 1 : 0, y: 0.38 }
					: { x: 0.38, y: tc.y > fc.y ? 1 : 0 }
		const ta =
			e.toShape !== e.to
				? chooseControlAnchor(tr, rectOf(e.to), fc, 0.62)
				: horizontal
					? { x: tc.x > fc.x ? 0 : 1, y: 0.62 }
					: { x: 0.62, y: tc.y > fc.y ? 0 : 1 }
		anchors.set(`${e.id}:from`, fa)
		anchors.set(`${e.id}:to`, ta)
		const p0 = anchorPoint(fr, fa)
		const p3 = anchorPoint(tr, ta)
		const solved = bestElbow(e)
		if (solved) {
			anchors.set(`${e.id}:from`, solved.fa)
			anchors.set(`${e.id}:to`, solved.ta)
			if (solved.mid != null) {
				e.mid = solved.mid
				e.midVertical = solved.midVertical
			}
		} else {
			const clear = findClearMid(p0, p3, e.from, e.to, horizontal)
			if (clear) {
				e.mid = clear.mid
				e.midVertical = clear.vertical
			}
		}
		if (Math.abs(p3.x - p0.x) + Math.abs(p3.y - p0.y) > 600) e.labelAt = 0.2
	}

	// ---- trunk adoption: a stray may join a pack lane ONLY when it truly
	// shares that lane's terminal point (the fusion rule) - a stray from a
	// different control runs its own course and the minimum-separation pass
	// keeps it clear of the lanes
	for (const e of edges) {
		if (!e.routable || e.packRouted || e.mid == null || !e.midVertical) continue
		for (const end of ['from', 'to']) {
			const hubId = end === 'from' ? e.from : e.to
			const trunk = hubTrunk.get(hubId)
			if (!trunk) continue
			const a = anchors.get(`${e.id}:${end}`)
			if (!a) continue
			if ((trunk.side === 1 && a.x !== 1) || (trunk.side === -1 && a.x !== 0)) continue
			const shape = end === 'from' ? e.fromShape : e.toShape
			const p = anchorPoint(endRect(shape, hubId), a)
			const g = trunk.groups.find(
				(g) => g.outgoing === (end === 'from') && Math.hypot(g.point.x - p.x, g.point.y - p.y) < 4
			)
			if (!g) continue
			const p0 = anchorPoint(endRect(e.fromShape, e.from), anchors.get(`${e.id}:from`))
			const p3 = anchorPoint(endRect(e.toShape, e.to), anchors.get(`${e.id}:to`))
			const span = p3.x - p0.x
			if (Math.abs(span) < 1) continue
			const nm = (g.lane - p0.x) / span
			if (nm < 0.05 || nm > 0.95) continue
			if (pathCrosses(routePath(e, { mid: Math.round(nm * 1000) / 1000 }), e.from, e.to)) continue
			e.mid = Math.round(nm * 1000) / 1000
			e.laneAbs = g.lane // joins the lane's separation group
			e.fused = true
			break
		}
	}

	// (route separation is enforced by separateRoutes after verify and
	// placement repair, when the geometry is final)

	// ---- verify every elbow against every screen ------------------------------
	// A crossing edge first tries a nudged lane, then a full joint re-solve.
	// Runs again after placement repair moves a screen, because a moved screen
	// changes what every nearby route crosses.
	const verifyRoutes = () => {
		for (const e of edges) {
			if (!e.routable) continue
			const path = currentPath(e)
			if (!path) continue
			const crossing = pathCrosses(path, e.from, e.to)
			// engineered trunk lanes keep their exact lane unless they actually
			// cross something; everything else also re-solves when it passes
			// inside the clearance margin of an unrelated screen
			const airless = e.laneAbs == null && nearPassers(path, e.from, e.to).length > 0
			const fa = anchors.get(`${e.id}:from`)
			const ta = anchors.get(`${e.id}:to`)
			// an entry side pointing AWAY from the source also re-solves (user
			// finding: a route wrapped to a screen's far side when the facing
			// side was open). Checked every verify round, because screen nudges
			// keep changing which routes are possible.
			let awayFacing = false
			if (!crossing && !airless && e.laneAbs == null && e.sharedLane == null && ta) {
				const ts = sideOfAnchor(ta)
				if (ts) {
					const n =
						ts === 'L'
							? { x: -1, y: 0 }
							: ts === 'R'
								? { x: 1, y: 0 }
								: ts === 'T'
									? { x: 0, y: -1 }
									: { x: 0, y: 1 }
					const p0 = path[0]
					const p3 = path[path.length - 1]
					awayFacing = n.x * (p0.x - p3.x) + n.y * (p0.y - p3.y) <= 0
				}
			}
			if (!crossing && !airless && !awayFacing) continue
			// mid-lane tuning only helps between facing sides (and cannot fix a
			// wrong-side entry); the lane must run in the one orientation those
			// sides can express
			const tunable = (crossing || airless) && fa && ta && midMeaningful(fa, ta)
			const lockV = tunable ? sideOfAnchor(fa) === 'L' || sideOfAnchor(fa) === 'R' : null
			const clear = tunable
				? findClearMid(path[0], path[path.length - 1], e.from, e.to, !!e.midVertical, lockV)
				: null
			if (clear) {
				e.mid = clear.mid
				e.midVertical = clear.vertical
				continue
			}
			// full joint re-solve (sides + aligned entries), adopted only when it
			// scores better than what the edge already has; edges nothing can
			// clear go to fix_crossings, which searches the same space against
			// REAL geometry. No chains, ever - lint reports whatever survives.
			const solved = bestElbow(e)
			if (solved && solved.score < pathScore(path, e.from, e.to)) {
				anchors.set(`${e.id}:from`, solved.fa)
				anchors.set(`${e.id}:to`, solved.ta)
				e.mid = solved.mid ?? undefined
				if (solved.mid != null) e.midVertical = solved.midVertical
			}
		}
	}
	verifyRoutes()

	// (entries that point away from their source re-solve inside verifyRoutes,
	// so the rule keeps holding as placement repair moves screens around)

	// ---- placement repair: open a channel by moving a blocked screen -----------
	// When a route still crosses exactly ONE screen and that screen is a small
	// leaf (a modal, a toast), the screen moves out of the way instead of the
	// route accepting the crossing. This is how a person fixes it: slide
	// InviteView down a bit and the AuthGate -> DailyChallenge line has a
	// channel. Hubs, pack columns, and busy screens never move.
	{
		const degree = new Map()
		for (const e of edges) {
			if (!e.routable) continue
			degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
			degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
		}
		// hubs never move; pack leaves may slide along their column (dy only);
		// small free screens move any direction
		const movable = (id) => !packs.has(id) && (degree.get(id) ?? 0) <= 3
		const rectsClash = (r1, r2, m) =>
			r1.x < r2.x + r2.w + m && r1.x + r1.w + m > r2.x && r1.y < r2.y + r2.h + m && r1.y + r1.h + m > r2.y
		// blockers include near-passes, not just intersections - a route 5px
		// above a frame is worth opening a channel for
		const crossedScreens = (path, skipA, skipB) => nearPassers(path, skipA, skipB)
		let nudged = 0
		// a screen may move at most twice: two edges wanting it in opposite
		// places would otherwise make the rounds oscillate
		const movedCount = new Map()
		for (let round = 0; round < 3; round++) {
			let moved = false
			for (const e of edges) {
				if (!e.routable) continue
				const path = currentPath(e)
				if (!path) continue
				const hit = crossedScreens(path, e.from, e.to)
				if (hit.length !== 1 || !movable(hit[0])) continue
				const sid = hit[0]
				if ((movedCount.get(sid) ?? 0) >= 2) continue
				const r = rectOf(sid)
				// candidate shifts: slide the screen fully past each offending
				// segment (plus 80px of air), smallest move first. Pack leaves may
				// only slide along their (vertical) column.
				const inColumn = packOf.has(sid)
				const cands = []
				for (let i = 0; i < path.length - 1; i++) {
					const a = path[i]
					const b = path[i + 1]
					const m = CLEARANCE
					if (!segHits(a, b, { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 })) continue
					if (Math.abs(a.y - b.y) < 1) {
						cands.push({ dx: 0, dy: a.y + 80 - r.y })
						cands.push({ dx: 0, dy: a.y - 80 - (r.y + r.h) })
					} else if (!inColumn) {
						cands.push({ dx: a.x + 80 - r.x, dy: 0 })
						cands.push({ dx: a.x - 80 - (r.x + r.w), dy: 0 })
					}
				}
				cands.sort((c1, c2) => Math.hypot(c1.dx, c1.dy) - Math.hypot(c2.dx, c2.dy))
				for (const c of cands) {
					if (Math.hypot(c.dx, c.dy) > gapY * 1.5) continue
					const nr = { x: r.x + c.dx, y: r.y + c.dy, w: r.w, h: r.h }
					if (screens.some((o) => o.id !== sid && rectsClash(nr, rectOf(o.id), 48))) continue
					movedCount.set(sid, (movedCount.get(sid) ?? 0) + 1)
					const t = targets.get(sid)
					targets.set(sid, { x: Math.round(t.x + c.dx), y: Math.round(t.y + c.dy) })
					const d = deltas.get(sid) ?? { dx: 0, dy: 0 }
					deltas.set(sid, { dx: d.dx + c.dx, dy: d.dy + c.dy })
					// a follow-up move op wins over the one already emitted; the
					// screen's inferred children and loose arrows ride along too
					const nt = targets.get(sid)
					ops.push({ move: { id: sid, to: { x: nt.x, y: nt.y } } })
					for (const child of page.shapes) {
						if (!child.parentInferred || rootOf(child.id) !== sid) continue
						ops.push({ move: { id: child.id, by: { dx: c.dx, dy: c.dy } } })
					}
					for (const a of page.arrows) {
						const bound = a.start?.how === 'bound' && a.end?.how === 'bound'
						if (bound || !a.start || !a.end) continue
						if (a.rootStart === sid && a.rootEnd === sid) {
							ops.push({ move: { id: a.id, by: { dx: c.dx, dy: c.dy } } })
						}
					}
					nudged++
					moved = true
					break
				}
			}
			if (!moved) break
			verifyRoutes()
		}
		if (nudged) report.push(`moved ${nudged} screen${nudged === 1 ? '' : 's'} to open route channels`)
	}

	// ---- separation: overlap is legal only at truly shared terminal points -----
	// ONE pass enforces the whole fusion rule against final geometry:
	//   a) a start point never sits on an end point (they split 0.38/0.62
	//      along the side, the same direction split the packs use);
	//   b) two runs may coincide only while forced by a genuinely shared
	//      start or end point; everything else keeps its distance.
	// Fix menu, in order: shift a tunable lane, slide the start anchor along
	// its side. Engineered lanes never move (they are built 56px apart);
	// a pair nothing fixes stays put for lint.
	{
		const proximityLen = (pa, pb, near) => {
			let total = 0
			for (let i = 0; i < pa.length - 1; i++) {
				const a0 = pa[i]
				const a1 = pa[i + 1]
				const aVert = Math.abs(a0.x - a1.x) < 1
				for (let j = 0; j < pb.length - 1; j++) {
					const b0 = pb[j]
					const b1 = pb[j + 1]
					const bVert = Math.abs(b0.x - b1.x) < 1
					if (aVert !== bVert) continue
					if (aVert) {
						if (Math.abs(a0.x - b0.x) > near) continue
						const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y))
						const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y))
						if (hi > lo) total += hi - lo
					} else {
						if (Math.abs(a0.y - b0.y) > near) continue
						const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x))
						const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x))
						if (hi > lo) total += hi - lo
					}
				}
			}
			return total
		}
		const routables = edges.filter((e) => e.routable)
		const termPts = (e) => {
			const fa = anchors.get(`${e.id}:from`)
			const ta = anchors.get(`${e.id}:to`)
			if (!fa || !ta) return null
			return {
				p0: anchorPoint(endRect(e.fromShape, e.from), fa),
				p3: anchorPoint(endRect(e.toShape, e.to), ta),
			}
		}
		// a) start/end coincidence split
		let split = 0
		for (const a of routables) {
			if (a.laneAbs != null) continue
			const pa = termPts(a)
			if (!pa) continue
			for (const b of routables) {
				if (a === b || b.laneAbs != null || a.fromShape !== b.toShape) continue
				const pb = termPts(b)
				if (!pb) continue
				if (Math.hypot(pa.p0.x - pb.p3.x, pa.p0.y - pb.p3.y) > 12) continue
				const slide = (e, which, frac) => {
					const an = anchors.get(`${e.id}:${which}`)
					anchors.set(
						`${e.id}:${which}`,
						an.y === 0 || an.y === 1 ? { x: frac, y: an.y } : { x: an.x, y: frac }
					)
				}
				slide(a, 'from', 0.38)
				slide(b, 'to', 0.62)
				split++
			}
		}
		// b) parallel-run separation
		const sharedTerminal = (pa, pb) =>
			Math.hypot(pa.p0.x - pb.p0.x, pa.p0.y - pb.p0.y) < 2 ||
			Math.hypot(pa.p3.x - pb.p3.x, pa.p3.y - pb.p3.y) < 2
		const illegalOverlap = (a, b) => {
			const pa = currentPath(a)
			const pb = currentPath(b)
			if (!pa || !pb) return 0
			const near = proximityLen(pa, pb, 48)
			if (near < 1) return 0
			const ta = termPts(a)
			const tb = termPts(b)
			const allowed = ta && tb && sharedTerminal(ta, tb) ? proximityLen(pa, pb, 2) : 0
			return near - allowed
		}
		const lenOf = (p) => {
			let l = 0
			for (let k = 0; k < p.length - 1; k++) {
				l += Math.abs(p[k + 1].x - p[k].x) + Math.abs(p[k + 1].y - p[k].y)
			}
			return l
		}
		let separated = 0
		for (let round = 0; round < 3; round++) {
			let fixedAny = false
			for (let i = 0; i < routables.length; i++) {
				for (let j = i + 1; j < routables.length; j++) {
					const a = routables[i]
					const b = routables[j]
					if (illegalOverlap(a, b) < 64) continue
					// engineered lanes never move; otherwise the shorter route does
					let mover = a.laneAbs != null ? b : b.laneAbs != null ? a : null
					if (mover?.laneAbs != null) continue
					if (mover == null) mover = lenOf(currentPath(a)) <= lenOf(currentPath(b)) ? a : b
					const other = mover === a ? b : a
					const fa = anchors.get(`${mover.id}:from`)
					const taM = anchors.get(`${mover.id}:to`)
					if (!fa || !taM) continue
					const baseAir = nearPassers(currentPath(mover), mover.from, mover.to).length
					const tryFix = (ov) => {
						const np = routePath(mover, ov)
						if (!np || pathCrosses(np, mover.from, mover.to)) return false
						if (nearPassers(np, mover.from, mover.to).length > baseAir) return false
						const save = { fa: anchors.get(`${mover.id}:from`), mid: mover.mid }
						if (ov.fa) anchors.set(`${mover.id}:from`, ov.fa)
						if ('mid' in ov) mover.mid = ov.mid ?? undefined
						let ok = illegalOverlap(mover, other) < 64
						if (ok) {
							for (const c of routables) {
								if (c === mover || c === other) continue
								if (illegalOverlap(mover, c) >= 64) {
									ok = false
									break
								}
							}
						}
						if (!ok) {
							anchors.set(`${mover.id}:from`, save.fa)
							mover.mid = save.mid
						}
						return ok
					}
					let fixed = false
					if (midMeaningful(fa, taM)) {
						for (const m of [0.5, 0.35, 0.65, 0.2, 0.8, 0.12, 0.88]) {
							if (m === mover.mid) continue
							if (tryFix({ mid: m })) {
								fixed = true
								break
							}
						}
					}
					if (!fixed) {
						const onVertSide = fa.x === 0 || fa.x === 1
						for (const f of [0.28, 0.72, 0.2, 0.8]) {
							const cand = onVertSide ? { x: fa.x, y: f } : { x: f, y: fa.y }
							const mids = midMeaningful(cand, taM)
								? [mover.mid ?? null, null, 0.5, 0.35, 0.65]
								: [null]
							for (const m of mids) {
								if (tryFix({ fa: cand, mid: m })) {
									fixed = true
									break
								}
							}
							if (fixed) break
						}
					}
					if (fixed) {
						separated++
						fixedAny = true
					}
				}
			}
			if (!fixedAny) break
		}
		if (split) report.push(`split ${split} start/end pair(s) sharing one anchor point`)
		if (separated) report.push(`separated ${separated} overlapping route pair(s)`)
		if (split || separated) verifyRoutes()
	}

	// ---- keep labels off screens ----------------------------------------------
	{
		const pointAt = (path, frac) => {
			let total = 0
			for (let i = 0; i < path.length - 1; i++) {
				total += Math.abs(path[i + 1].x - path[i].x) + Math.abs(path[i + 1].y - path[i].y)
			}
			let want = frac * total
			for (let i = 0; i < path.length - 1; i++) {
				const seg = Math.abs(path[i + 1].x - path[i].x) + Math.abs(path[i + 1].y - path[i].y)
				if (want <= seg || i === path.length - 2) {
					const t = seg ? want / seg : 0
					return {
						x: path[i].x + (path[i + 1].x - path[i].x) * t,
						y: path[i].y + (path[i + 1].y - path[i].y) * t,
					}
				}
				want -= seg
			}
			return path[path.length - 1]
		}
		const labelClear = (p, w, h) =>
			!screens.some((s) => {
				const r = rectOf(s.id)
				return p.x + w / 2 > r.x && p.x - w / 2 < r.x + r.w && p.y + h / 2 > r.y && p.y - h / 2 < r.y + r.h
			})
		for (const e of edges) {
			if (!e.routable || !e.label || e.labelAt == null) continue
			const path = currentPath(e)
			if (!path) continue
			const w = Math.min(320, String(e.label).length * 8 + 20)
			if (labelClear(pointAt(path, e.labelAt), w, 26)) continue
			const cands = []
			for (let f = 0.1; f <= 0.9; f += 0.05) cands.push(Math.round(f * 1000) / 1000)
			cands.sort((a, b) => Math.abs(a - e.labelAt) - Math.abs(b - e.labelAt))
			const found = cands.find((f) => labelClear(pointAt(path, f), w, 26))
			if (found != null) e.labelAt = found
		}
	}

	// ---- emit route ops ---------------------------------------------------------
	let routed = 0
	for (const e of edges) {
		if (!e.routable) continue
		const fromAnchor = anchors.get(`${e.id}:from`)
		const toAnchor = anchors.get(`${e.id}:to`)
		// EVERY routable edge gets an unchain first - a file from an older
		// engine may still carry a frozen waypoint chain, and unchaining
		// restores real bindings so the following route op works. No-op for
		// plain arrows.
		ops.push({ chain: { id: e.id, points: [] } })
		if (!fromAnchor && !toAnchor && e.mid == null) continue
		// tldraw's elbowMidPoint only positions a lane between FACING sides; on
		// same-side or mixed pairs it would misplace the route, so those emit
		// the neutral 0.5 - which also clears any stale handle the arrow
		// carried in from the source file
		const emitMid =
			e.mid != null && (!fromAnchor || !toAnchor || midMeaningful(fromAnchor, toAnchor))
		// every emitted lane carries its absolute position so the executor can
		// calibrate the midpoint against REAL geometry - tldraw measures the
		// fraction over its own span, so a model-solved mid lands a few px off,
		// differently per arrow, and runs meant to coincide (or stay apart)
		// drift
		let laneX
		let laneY
		if (emitMid && fromAnchor && toAnchor) {
			if (e.laneAbs != null) {
				laneX = e.laneAbs
			} else {
				const p0 = anchorPoint(endRect(e.fromShape, e.from), fromAnchor)
				const p3 = anchorPoint(endRect(e.toShape, e.to), toAnchor)
				const fs = sideOfAnchor(fromAnchor)
				if (fs === 'L' || fs === 'R') laneX = Math.round(p0.x + e.mid * (p3.x - p0.x))
				else laneY = Math.round(p0.y + e.mid * (p3.y - p0.y))
			}
		}
		ops.push({
			route: {
				id: e.id,
				kind: 'elbow', // normalize: a prior layout may have left this an arc
				...(fromAnchor ? { fromAnchor } : {}),
				...(toAnchor ? { toAnchor } : {}),
				mid: emitMid ? e.mid : 0.5,
				...(laneX != null ? { laneX } : {}),
				...(laneY != null ? { laneY } : {}),
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
			`${packs.size ? ` + ${packs.size} pack column(s) (${[...packs.values()].reduce((a, l) => a + l.length, 0)} screens stacked beside their hubs)` : ''}` +
			`${satellitesPlaced ? ` + ${satellitesPlaced} shared screen(s) placed between their referencers` : ''} (${edges.length} transitions considered)`
	)
	if (routed) {
		report.push(`${routed} transition arrows routed along ELK's reserved channels`)
	}
	if (unmovableArrows) {
		report.push(
			`WARN: ${unmovableArrows} unsnapped arrow(s) span screens that moved differently - they may need re-drawing (bound arrows follow automatically)`
		)
	}
	// last op: editor-verified collision repair - whatever the translated
	// routes still cut through gets rerouted through a clear corridor using
	// REAL arrow geometry - rectilinear detours, never arcs
	ops.push({ fix_crossings: {} })
	return { ops, report }
}
