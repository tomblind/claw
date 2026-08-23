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
 * too bendy to translate become waypoint chains. Every translated route is
 * geometrically verified against the screens; anything still crossing a
 * frame is rerouted through a clear corridor by the final fix_crossings
 * pass (rectilinear detours, never arcs). Satellite screens (dead-end modals
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
	for (const [hub, leaves] of [...packs]) {
		if (leaves.length < 2) {
			for (const l of leaves) packOf.delete(l)
			packs.delete(hub)
		}
	}

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
	// with real breathing room between them
	const PACK_GAP = Math.round(gapY / 3)
	const footprint = new Map() // hubId -> {w, h, colW, colH}
	for (const [hub, leaves] of packs) {
		leaves.sort((a, b) => (byId.get(a).name ?? a).localeCompare(byId.get(b).name ?? b))
		const colW = Math.max(...leaves.map((l) => byId.get(l).w))
		const colH =
			leaves.reduce((acc, l) => acc + byId.get(l).h, 0) + PACK_GAP * (leaves.length - 1)
		const h = byId.get(hub)
		footprint.set(hub, { w: h.w + gapX / 2 + colW, h: Math.max(h.h, colH), colW, colH })
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
	// Side selection (user finding): the column must sit AWAY from the hub's
	// flow traffic, or every outbound arrow threads between the satellites.
	const packSide = new Map() // hubId -> 1 (column right) | -1 (column left)
	for (const [hub, leaves] of packs) {
		const t = targets.get(hub)
		if (!t) continue
		const hubShape = byId.get(hub)
		const f = footprint.get(hub)
		let traffic = 0
		for (const e of flowEdges) {
			const other = e.from === hub ? e.to : e.to === hub ? e.from : null
			if (!other) continue
			const ot = targets.get(other)
			if (!ot) continue
			traffic += ot.x + byId.get(other).w / 2 > t.x + f.w / 2 ? 1 : -1
		}
		// traffic mostly to the right -> column on the left, and vice versa
		const side = traffic > 0 ? -1 : 1
		packSide.set(hub, side)
		// the hub sits inside the reserved box: at its left edge when the
		// column is right, at its right edge when the column is left
		const hubX = side === 1 ? t.x : t.x + f.colW + gapX / 2
		const colX = side === 1 ? t.x + hubShape.w + gapX / 2 : t.x
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
	 * doglegs, and every removed jog is a chain that never gets created.
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
	/** scan lane positions (both orientations) for a screen-free elbow */
	const findClearMid = (p0, p3, skipA, skipB, preferVertical) => {
		for (const vertical of preferVertical ? [true, false] : [false, true]) {
			for (const m of [0.5, 0.35, 0.65, 0.2, 0.8, 0.12, 0.88]) {
				if (!pathCrosses(elbowPath(p0, p3, m, vertical), skipA, skipB)) {
					return { mid: m, vertical }
				}
			}
		}
		return null
	}
	/**
	 * Same-side routes (user example: Discovery -> Settings as up, across,
	 * down into Settings' top): both anchors on one side, path running
	 * through the band just beyond the extreme edge. tldraw's elbow router
	 * draws these natively once the anchors are on matching sides.
	 */
	const findClearSameSide = (fr, tr, skipA, skipB) => {
		const sides = [
			{ side: 'top', fa: { x: 0.38, y: 0 }, ta: { x: 0.62, y: 0 } },
			{ side: 'bottom', fa: { x: 0.38, y: 1 }, ta: { x: 0.62, y: 1 } },
			{ side: 'left', fa: { x: 0, y: 0.38 }, ta: { x: 0, y: 0.62 } },
			{ side: 'right', fa: { x: 1, y: 0.38 }, ta: { x: 1, y: 0.62 } },
		]
		// a side is only usable when the bound endpoint sits NEAR that edge of
		// its own frame - otherwise the route's first leg drags through the
		// frame interior (a control at the bottom must not take a top route)
		const frameA = rectOf(skipA)
		const frameB = rectOf(skipB)
		const nearEdge = (ctl, frame, side) => {
			if (!frame) return true
			if (side === 'top') return ctl.y - frame.y <= 180
			if (side === 'bottom') return frame.y + frame.h - (ctl.y + ctl.h) <= 180
			if (side === 'left') return ctl.x - frame.x <= 180
			return frame.x + frame.w - (ctl.x + ctl.w) <= 180
		}
		for (const cand of sides) {
			if (!nearEdge(fr, frameA, cand.side) || !nearEdge(tr, frameB, cand.side)) continue
			const p0 = anchorPoint(fr, cand.fa)
			const p3 = anchorPoint(tr, cand.ta)
			for (const clearance of [80, 160, 260]) {
				let band
				if (cand.side === 'top') band = Math.min(p0.y, p3.y) - clearance
				else if (cand.side === 'bottom') band = Math.max(p0.y, p3.y) + clearance
				else if (cand.side === 'left') band = Math.min(p0.x, p3.x) - clearance
				else band = Math.max(p0.x, p3.x) + clearance
				const vertical = cand.side === 'left' || cand.side === 'right'
				const path = vertical
					? [p0, { x: band, y: p0.y }, { x: band, y: p3.y }, p3]
					: [p0, { x: p0.x, y: band }, { x: p3.x, y: band }, p3]
				if (!pathCrosses(path, skipA, skipB)) return cand
			}
		}
		return null
	}

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
			const score = c.exitDist + (dot < 0 ? 500 : 0) - dot * 100
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

	/**
	 * Chain waypoints with explicit exit stubs: the chain op bridges from the
	 * anchor straight to the first waypoint, which can drag the bridge across
	 * the frame interior when the anchor sits on a control deep inside. A
	 * stub 48px outside the frame on the anchor's side forces a clean exit.
	 */
	const chainPtsWithExits = (e, corePts) => {
		const pts = [...corePts]
		const fa = anchors.get(`${e.id}:from`)
		const ta = anchors.get(`${e.id}:to`)
		const stub = (a, p, frame) => {
			if (!a || !frame) return null
			if (a.x === 0) return { x: Math.round(frame.x - 48), y: Math.round(p.y) }
			if (a.x === 1) return { x: Math.round(frame.x + frame.w + 48), y: Math.round(p.y) }
			if (a.y === 0) return { x: Math.round(p.x), y: Math.round(frame.y - 48) }
			if (a.y === 1) return { x: Math.round(p.x), y: Math.round(frame.y + frame.h + 48) }
			return null
		}
		if (e.fromShape !== e.from && fa) {
			const s = stub(fa, anchorPoint(endRect(e.fromShape, e.from), fa), rectOf(e.from))
			if (s) pts.unshift(s)
		}
		if (e.toShape !== e.to && ta) {
			const s = stub(ta, anchorPoint(endRect(e.toShape, e.to), ta), rectOf(e.to))
			if (s) pts.push(s)
		}
		return pts
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

	// ---- fuse anchors (reference rule: fuse, don't fan) ----------------------
	// Every endpoint snaps to the CENTER of its side, so arrows sharing a
	// source or destination coincide at the screen edge and read as one line.
	// Same-source groups leaving one side also share a first lane, so their
	// common run overlaps into a trunk that branches late.
	{
		const sourceGroups = new Map() // `${root}:${side}:${orientation}` -> edges
		for (const e of flowRouted) {
			for (const end of ['from', 'to']) {
				const a = anchors.get(`${e.id}:${end}`)
				const side = a.x === 0 ? 'left' : a.x === 1 ? 'right' : a.y === 0 ? 'top' : 'bottom'
				// direction split: outgoing arrows fuse at 0.38 of the side,
				// incoming at 0.62 - an arrow must never START where another
				// ENDS (it reads as ambiguous direction)
				const frac = end === 'from' ? 0.38 : 0.62
				if (side === 'left' || side === 'right') a.y = frac
				else a.x = frac
				if (end === 'from' && e.pts.length === 4) {
					const midVertical = Math.abs(e.pts[1].x - e.pts[2].x) < 1
					const key = `${e.from}:${side}:${midVertical ? 'v' : 'h'}`
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
		if (pts.length > 4 && packSide.get(e.from) !== -1 && packSide.get(e.to) !== -1) {
			// too bendy for one elbow: render ELK's exact route as a waypoint
			// chain (except around left-column hubs, whose shifted geometry
			// invalidates ELK waypoints - those edges go to fix_crossings)
			e.chainPts = chainPtsWithExits(
				e,
				pts.slice(1, -1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
			)
			continue
		}
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

	const hubTrunk = new Map() // hubId -> {laneOut, laneIn, side}

	// ---- pack edges: fused trunks between hub and its column ------------------
	// Direction split (user finding): an arrow must never START where another
	// arrow ENDS, or directionality becomes unreadable. Outgoing and incoming
	// trunks get separate anchor heights and separate lanes.
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
		const laneOut = hubEdgeX + side * (gapX / 4)
		const laneIn = hubEdgeX + side * (gapX / 4 + 56)
		hubTrunk.set(hub, { laneOut, laneIn, side })
		for (const e of packEdges) {
			const outgoing = e.from === hub
			const hubEnd = outgoing ? 'from' : 'to'
			const leafId = outgoing ? e.to : e.from
			const frac = outgoing ? 0.38 : 0.62
			anchors.set(`${e.id}:${hubEnd}`, { x: side === 1 ? 1 : 0, y: frac })
			anchors.set(`${e.id}:${hubEnd === 'from' ? 'to' : 'from'}`, {
				x: side === 1 ? 0 : 1,
				y: frac,
			})
			const lane = outgoing ? laneOut : laneIn
			// solve the mid against the BOUND terminals (controls), not the
			// frame edges - tldraw positions the lane between the terminals, so
			// frame-edge math lands each edge on a slightly different lane and
			// the trunk stops overlapping
			const p0 = anchorPoint(
				endRect(e.fromShape, e.from),
				anchors.get(`${e.id}:from`)
			)
			const p3 = anchorPoint(endRect(e.toShape, e.to), anchors.get(`${e.id}:to`))
			const span = p3.x - p0.x
			if (Math.abs(span) > 1) {
				e.mid = Math.round(Math.max(0.05, Math.min(0.95, (lane - p0.x) / span)) * 1000) / 1000
			}
			e.midVertical = true
			e.fused = true
			e.laneAbs = lane
			const leafShape = byId.get(leafId)
			const dy = Math.abs(targets.get(leafId).y + leafShape.h / 2 - (hubT.y + hubShape.h / 2))
			const manhattan = Math.abs(span) + dy
			if (manhattan > 1) {
				e.labelAt =
					Math.round(Math.max(0.1, Math.min(0.7, (gapX / 4 + 60) / manhattan)) * 1000) / 1000
			}
			e.packRouted = true
		}
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
		const clear = findClearMid(p0, p3, e.from, e.to, horizontal)
		if (clear) {
			e.mid = clear.mid
			e.midVertical = clear.vertical
		} else {
			const pi = findClearSameSide(fr, tr, e.from, e.to)
			if (pi) {
				anchors.set(`${e.id}:from`, pi.fa)
				anchors.set(`${e.id}:to`, pi.ta)
				e.piSide = pi.side
			}
		}
		if (Math.abs(p3.x - p0.x) + Math.abs(p3.y - p0.y) > 600) e.labelAt = 0.2
	}

	// ---- trunk adoption: a stray leaving (or entering) a hub on its column
	// side joins the pack trunk lane instead of running parallel next to it -
	// same source, same direction, so the fuse rule applies across routers
	for (const e of edges) {
		if (!e.routable || e.packRouted || e.chainPts || e.mid == null || !e.midVertical) continue
		for (const end of ['from', 'to']) {
			const hubId = end === 'from' ? e.from : e.to
			const trunk = hubTrunk.get(hubId)
			if (!trunk) continue
			const a = anchors.get(`${e.id}:${end}`)
			if (!a) continue
			if ((trunk.side === 1 && a.x !== 1) || (trunk.side === -1 && a.x !== 0)) continue
			const lane = end === 'from' ? trunk.laneOut : trunk.laneIn
			const p0 = anchorPoint(endRect(e.fromShape, e.from), anchors.get(`${e.id}:from`))
			const p3 = anchorPoint(endRect(e.toShape, e.to), anchors.get(`${e.id}:to`))
			const span = p3.x - p0.x
			if (Math.abs(span) < 1) continue
			const nm = (lane - p0.x) / span
			if (nm < 0.05 || nm > 0.95) continue
			if (pathCrosses(elbowPath(p0, p3, nm, true), e.from, e.to)) continue
			e.mid = Math.round(nm * 1000) / 1000
			e.laneAbs = lane // joins the trunk's separation group
			e.fused = true
			break
		}
	}

	// ---- minimum lane separation (user rule: unrelated near-parallel runs
	// keep their distance; a fused trunk is one line and exempt within itself)
	{
		const MIN_SEP = 56
		const laneEntries = []
		for (const e of edges) {
			if (!e.routable || e.mid == null || e.chainPts) continue
			const fa = anchors.get(`${e.id}:from`)
			const ta = anchors.get(`${e.id}:to`)
			if (!fa || !ta) continue
			const exit = anchorPoint(endRect(e.fromShape, e.from), fa)
			const entry = anchorPoint(endRect(e.toShape, e.to), ta)
			const vertical = !!e.midVertical
			// pack trunks know their absolute lane; computed lanes for other
			// edges follow the bound terminals
			const lane =
				e.laneAbs ?? (vertical ? exit.x + e.mid * (entry.x - exit.x) : exit.y + e.mid * (entry.y - exit.y))
			laneEntries.push({
				e,
				exit,
				entry,
				lane,
				vertical,
				lo: vertical ? Math.min(exit.y, entry.y) : Math.min(exit.x, entry.x),
				hi: vertical ? Math.max(exit.y, entry.y) : Math.max(exit.x, entry.x),
				group:
					e.laneAbs != null
						? `pack:${e.laneAbs}`
						: e.sharedLane != null
							? `fuse:${e.from}:${e.sharedLane}`
							: e.id,
			})
		}
		for (const vertical of [true, false]) {
			const list = laneEntries.filter((en) => en.vertical === vertical).sort((a, b) => a.lane - b.lane)
			for (let i = 1; i < list.length; i++) {
				const prev = list[i - 1]
				const cur = list[i]
				if (cur.group === prev.group) continue
				const overlap = Math.min(prev.hi, cur.hi) - Math.max(prev.lo, cur.lo)
				if (overlap < 40) continue
				if (cur.lane - prev.lane >= MIN_SEP) continue
				// a pack trunk's lane is fixed by construction: when one side of
				// the conflict is a trunk, the OTHER edge moves
				let move = cur
				let anchor = prev
				if (cur.e.laneAbs != null && prev.e.laneAbs == null) {
					move = prev
					anchor = cur
				} else if (cur.e.laneAbs != null && prev.e.laneAbs != null) {
					continue // two trunks: their spacing is set where they are built
				}
				const shifted = move.lane >= anchor.lane ? anchor.lane + MIN_SEP : anchor.lane - MIN_SEP
				const span = move.vertical ? move.entry.x - move.exit.x : move.entry.y - move.exit.y
				if (Math.abs(span) < 1) continue
				const nm = (shifted - (move.vertical ? move.exit.x : move.exit.y)) / span
				if (nm < 0.05 || nm > 0.95) continue
				// never separate INTO a screen: keep the old lane if the shifted
				// path would cross one
				if (pathCrosses(elbowPath(move.exit, move.entry, nm, move.vertical), move.e.from, move.e.to)) continue
				move.e.mid = Math.round(nm * 1000) / 1000
				move.lane = shifted
			}
		}
	}

	// ---- verify every elbow against every screen ------------------------------
	// A crossing edge first tries nudged lanes in both orientations; a flow
	// edge that still crosses falls back to its exact ELK route as a chain;
	// pack/stray edges without a clear elbow are left for fix_crossings.
	for (const e of edges) {
		if (!e.routable || e.chainPts) continue
		const fa = anchors.get(`${e.id}:from`)
		const ta = anchors.get(`${e.id}:to`)
		if (!fa || !ta) continue
		const p0 = anchorPoint(endRect(e.fromShape, e.from), fa)
		const p3 = anchorPoint(endRect(e.toShape, e.to), ta)
		if (!pathCrosses(elbowPath(p0, p3, e.mid ?? null, !!e.midVertical), e.from, e.to)) continue
		const clear = findClearMid(p0, p3, e.from, e.to, !!e.midVertical)
		if (clear) {
			e.mid = clear.mid
			e.midVertical = clear.vertical
			continue
		}
		// same-side route (up-across-down / around the side) before any chain
		const pi = findClearSameSide(
			endRect(e.fromShape, e.from),
			endRect(e.toShape, e.to),
			e.from,
			e.to
		)
		if (pi) {
			anchors.set(`${e.id}:from`, pi.fa)
			anchors.set(`${e.id}:to`, pi.ta)
			e.mid = undefined
			e.piSide = pi.side
			continue
		}
		// no ELK-chain fallback for edges touching a LEFT-column hub: the hub
		// shifted inside its ELK footprint, so ELK's waypoints thread the
		// hub's real rectangle. fix_crossings reroutes these against real
		// geometry instead.
		const touchesShiftedHub =
			packSide.get(e.from) === -1 || packSide.get(e.to) === -1
		if (e.elkRoute && !touchesShiftedHub) {
			e.chainPts = chainPtsWithExits(
				e,
				simplify(e.elkRoute)
					.slice(1, -1)
					.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
			)
		}
	}
	const chained = edges.filter((e) => e.chainPts?.length).length

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
			if (!e.routable || e.chainPts || e.piSide || !e.label || e.labelAt == null) continue
			const fa = anchors.get(`${e.id}:from`)
			const ta = anchors.get(`${e.id}:to`)
			if (!fa || !ta) continue
			const p0 = anchorPoint(endRect(e.fromShape, e.from), fa)
			const p3 = anchorPoint(endRect(e.toShape, e.to), ta)
			const path = elbowPath(p0, p3, e.mid ?? null, !!e.midVertical)
			const w = Math.min(320, String(e.label).length * 8 + 20)
			if (labelClear(pointAt(path, e.labelAt), w, 26)) continue
			const cands = []
			for (let f = 0.1; f <= 0.9; f += 0.05) cands.push(Math.round(f * 1000) / 1000)
			cands.sort((a, b) => Math.abs(a - e.labelAt) - Math.abs(b - e.labelAt))
			const found = cands.find((f) => labelClear(pointAt(path, f), w, 26))
			if (found != null) e.labelAt = found
		}
	}

	// ---- emit chain/route ops -------------------------------------------------
	let routed = 0
	for (const e of edges) {
		if (!e.routable) continue
		const fromAnchor = anchors.get(`${e.id}:from`)
		const toAnchor = anchors.get(`${e.id}:to`)
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
		// EVERY non-chained routable edge gets an unchain first — an edge that
		// was chained by a previous layout may be classified differently this
		// run (packed, same-column, unrouted) and would otherwise keep a stale
		// chain frozen at its old geometry. No-op for plain arrows, and it
		// restores real bindings so a following route op works.
		ops.push({ chain: { id: e.id, points: [] } })
		if (!fromAnchor && !toAnchor && e.mid == null) continue
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
			`${packs.size ? ` + ${packs.size} pack column(s) (${[...packs.values()].reduce((a, l) => a + l.length, 0)} screens stacked beside their hubs)` : ''}` +
			`${satellitesPlaced ? ` + ${satellitesPlaced} shared screen(s) placed between their referencers` : ''} (${edges.length} transitions considered)`
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
	// last op: editor-verified collision repair - whatever the translated
	// routes still cut through gets rerouted through a clear corridor using
	// REAL arrow geometry - rectilinear detours, never arcs
	ops.push({ fix_crossings: {} })
	return { ops, report }
}
