/**
 * Text formatting over the editor projection. All geometry and binding facts
 * come from the page (real editor data); this file only decides how to say it.
 */

const clip = (s, n = 60) => {
	const one = String(s).replace(/\s+/g, ' ').trim()
	return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** Best human label for a projected shape; hint from largest text child if unnamed. */
export function labelFor(shape, page, { withId = true } = {}) {
	const own = shape.name ?? shape.text
	if (own) return JSON.stringify(clip(own, 40))
	const kids = page.shapes.filter((s) => s.parent === shape.id && s.text)
	let best = null
	let bestArea = -1
	for (const k of kids) {
		const a = (k.w ?? 0) * (k.h ?? 0)
		if (a > bestArea) {
			best = k
			bestArea = a
		}
	}
	if (best) return `~${JSON.stringify(clip(best.text, 40))}${withId ? `#${shape.id.slice(0, 8)}` : ''}`
	return `${shape.type}#${shape.id.slice(0, 8)}`
}

const byId = (page) => new Map(page.shapes.map((s) => [s.id, s]))

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

export function outlineText(projection, path, { all = false } = {}) {
	const lines = []
	const totalShapes = projection.pages.reduce(
		(n, p) => n + p.shapes.length + p.arrows.length,
		0
	)
	lines.push(
		`${path} — ${projection.pages.length} page${projection.pages.length === 1 ? '' : 's'}, ${totalShapes} shape${totalShapes === 1 ? '' : 's'}`
	)

	let inferredContainers = 0

	for (const page of projection.pages) {
		lines.push(`page#${String(page.id).replace(/^page:/, '')} ${JSON.stringify(page.name)}`)

		const childrenOf = new Map()
		const roots = []
		for (const s of page.shapes) {
			if (s.parent) {
				if (!childrenOf.has(s.parent)) childrenOf.set(s.parent, [])
				childrenOf.get(s.parent).push(s)
			} else {
				roots.push(s)
			}
		}

		const describe = (s) => {
			const bits = [`${s.type}#${s.id}`]
			const label = labelFor(s, page, { withId: false })
			if (!label.startsWith(s.type + '#')) bits.push(label)
			if (s.w != null) bits.push(`${s.w}x${s.h}`, `@${s.x},${s.y}`)
			return bits.join(' ')
		}
		const summarize = (shapes) => {
			const counts = new Map()
			for (const s of shapes) counts.set(s.type, (counts.get(s.type) ?? 0) + 1)
			return [...counts.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([t, n]) => `${n} ${t}`)
				.join(', ')
		}

		const walk = (shapes, depth) => {
			const pad = '  '.repeat(depth)
			const containers = shapes.filter((s) => s.container)
			const leaves = shapes.filter((s) => !s.container)
			for (const c of containers) {
				if (c.containerInferred) inferredContainers++
				lines.push(`${pad}${describe(c)}${c.containerInferred ? '  [container inferred]' : ''}`)
				walk(childrenOf.get(c.id) ?? [], depth + 1)
			}
			if (!leaves.length) return
			if (all) for (const l of leaves) lines.push(`${pad}${describe(l)}`)
			else lines.push(`${pad}· ${summarize(leaves)}`)
		}
		walk(roots, 1)

		if (page.arrows.length) {
			const arrowsLine = all
				? page.arrows.map((a) => `  arrow#${a.id}${a.label ? ` ${JSON.stringify(clip(a.label, 30))}` : ''}`)
				: [`  · ${page.arrows.length} arrow${page.arrows.length === 1 ? '' : 's'}`]
			lines.push(...arrowsLine)

			let bound = 0
			let partial = 0
			for (const a of page.arrows) {
				if (a.start?.how === 'bound' && a.end?.how === 'bound') bound++
				else partial++
			}
			lines.push(
				`flows: ${bound} fully bound, ${partial} inferred or unresolved` +
					(partial ? ' — run `flows` for detail' : '')
			)
		}
	}

	if (inferredContainers) {
		lines.push(
			`note: ${inferredContainers} container${inferredContainers === 1 ? '' : 's'} inferred from geometry — this document uses plain shapes, not frames.`,
			`      Nesting is a guess based on overlap. Naming these as frames would make it authoritative.`
		)
	}
	if (!all && totalShapes) lines.push(`(--all to list every shape, --json for machine form)`)
	return lines.join('\n')
}

// ---------------------------------------------------------------------------
// flows
// ---------------------------------------------------------------------------

export function flowsText(projection, { from = null, infer = true } = {}) {
	const recorded = []
	const inferred = []
	const intra = []
	const unresolved = []

	for (const page of projection.pages) {
		const shapes = byId(page)
		const name = (id) => {
			const s = shapes.get(id)
			return s ? labelFor(s, page) : `#${id.slice(0, 8)}`
		}
		const endpoint = (terminal, rootId) => {
			const label = name(terminal.id)
			if (terminal.id === rootId) return label
			const root = shapes.get(rootId)
			if (!root) return label
			const rootLabel = labelFor(root, page)
			if (rootLabel.includes(label.replace(/^~/, '').replace(/"/g, ''))) return rootLabel
			return `${label} in ${rootLabel}`
		}

		for (const a of page.arrows) {
			const suffix = a.label ? ` ${JSON.stringify(clip(a.label, 40))}` : ''
			const resolvedStart = a.start && (infer || a.start.how === 'bound') ? a.start : null
			const resolvedEnd = a.end && (infer || a.end.how === 'bound') ? a.end : null

			if (!resolvedStart || !resolvedEnd) {
				const which =
					!resolvedStart && !resolvedEnd ? 'both ends' : !resolvedStart ? 'start' : 'end'
				const other = resolvedStart ?? resolvedEnd
				unresolved.push(
					`arrow#${a.id.slice(0, 8)}${suffix} — nothing within reach at ${which}` +
						(other ? `, other end on ${name(other.id)}` : '')
				)
				continue
			}

			if (a.sameRoot) {
				intra.push(
					`within ${name(a.rootStart)}: ${name(resolvedStart.id)} -> ${name(resolvedEnd.id)}${suffix}`
				)
				continue
			}

			if (from && ![a.rootStart, resolvedStart.id].some((x) => x.startsWith(from))) continue

			const evidence = []
			for (const [which, t] of [
				['start', resolvedStart],
				['end', resolvedEnd],
			]) {
				if (t.how === 'inside') evidence.push(`${which} inside target`)
				else if (t.how === 'near') evidence.push(`${which} ${t.d}px from target`)
			}
			const line = `${endpoint(resolvedStart, a.rootStart)} -> ${endpoint(resolvedEnd, a.rootEnd)}${suffix}`
			if (evidence.length) inferred.push(`${line}   [${evidence.join(', ')}]`)
			else recorded.push(line)
		}
	}

	const out = []
	if (recorded.length) {
		out.push(`${recorded.length} recorded transition${recorded.length === 1 ? '' : 's'}:`)
		out.push(...recorded.map((l) => `  ${l}`))
	}
	if (inferred.length) {
		out.push(
			'',
			`${inferred.length} inferred transition${inferred.length === 1 ? '' : 's'} — endpoint not snapped in the file, deduced from geometry. Check against the render before relying on these:`
		)
		out.push(...inferred.map((l) => `  ${l}`))
	}
	if (intra.length) {
		out.push(
			'',
			`${intra.length} arrow${intra.length === 1 ? '' : 's'} inside a single screen — motion or annotation, not navigation:`
		)
		out.push(...intra.map((l) => `  ${l}`))
	}
	if (unresolved.length) {
		out.push(
			'',
			`${unresolved.length} arrow${unresolved.length === 1 ? '' : 's'} with no target within reach — ask the user about these:`
		)
		out.push(...unresolved.map((l) => `  ${l}`))
	}
	return out.length ? out.join('\n') : 'no arrows in this document'
}
