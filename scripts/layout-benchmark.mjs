#!/usr/bin/env node
/**
 * Score a .tldr flow canvas against the layout principles
 * (reference/layout-principles.md). Pure file analysis, no editor needed.
 *
 *   node scripts/layout-benchmark.mjs <file.tldr> [<file2.tldr> ...]
 *
 * Compare algorithm output against test/fixtures/reference-layout.tldr:
 * lower shared-screen distance, shorter edges, fewer chains are better.
 * The reference sets the bar; matching its numbers is the goal, beating
 * them is fine, doubling them is a regression.
 */
import { readFileSync } from 'node:fs'

function analyze(path) {
	const file = JSON.parse(readFileSync(path, 'utf8'))
	const shapes = file.records.filter((r) => r.typeName === 'shape')
	const byId = new Map(shapes.map((s) => [s.id, s]))
	const frames = shapes.filter((s) => s.type === 'frame' && String(s.parentId).startsWith('page:'))
	const frameIds = new Set(frames.map((f) => f.id))

	const rootFrame = (id) => {
		let cur = byId.get(id)
		while (cur) {
			if (frameIds.has(cur.id)) return cur.id
			if (!String(cur.parentId).startsWith('shape:')) return null
			cur = byId.get(cur.parentId)
		}
		return null
	}

	// transitions: bound arrows (via binding records) + chain heads (via meta)
	const bindings = file.records.filter((r) => r.typeName === 'binding' && r.type === 'arrow')
	const byArrow = new Map()
	for (const b of bindings) {
		if (!byArrow.has(b.fromId)) byArrow.set(b.fromId, [])
		byArrow.get(b.fromId).push(b)
	}
	const transitions = []
	for (const [arrowId, list] of byArrow) {
		if (list.length < 2) continue
		const ends = list.map((b) => rootFrame(b.toId)).filter(Boolean)
		if (ends.length === 2 && ends[0] !== ends[1]) transitions.push([ends[0], ends[1]])
	}
	for (const s of shapes) {
		if (s.meta?.claw === 'chainhead' && s.meta.from && s.meta.to) {
			const a = rootFrame(s.meta.from)
			const b = rootFrame(s.meta.to)
			if (a && b && a !== b) transitions.push([a, b])
		}
	}

	const center = (id) => {
		const f = byId.get(id)
		return { x: f.x + (f.props?.w ?? 0) / 2, y: f.y + (f.props?.h ?? 0) / 2 }
	}
	const dist = (a, b) => {
		const ca = center(a)
		const cb = center(b)
		return Math.hypot(ca.x - cb.x, ca.y - cb.y)
	}

	// shared screens: referenced (incoming edge) by 2+ distinct frames
	const refsInto = new Map()
	for (const [from, to] of transitions) {
		if (!refsInto.has(to)) refsInto.set(to, new Set())
		refsInto.get(to).add(from)
	}
	const sharedDists = []
	for (const [target, refs] of refsInto) {
		if (refs.size < 2) continue
		const mean = [...refs].reduce((acc, r) => acc + dist(target, r), 0) / refs.size
		sharedDists.push({ name: byId.get(target)?.props?.name ?? target.slice(6, 12), mean })
	}

	const totalEdgeLen = transitions.reduce((acc, [a, b]) => acc + dist(a, b), 0)
	const minX = Math.min(...frames.map((f) => f.x))
	const maxX = Math.max(...frames.map((f) => f.x + f.props.w))
	const minY = Math.min(...frames.map((f) => f.y))
	const maxY = Math.max(...frames.map((f) => f.y + f.props.h))
	const chains = shapes.filter((s) => s.meta?.claw === 'chainhead').length

	return {
		frames: frames.length,
		transitions: transitions.length,
		sharedScreens: sharedDists.length,
		meanSharedDist: sharedDists.length
			? Math.round(sharedDists.reduce((a, s) => a + s.mean, 0) / sharedDists.length)
			: 0,
		sharedDetail: sharedDists.map((s) => `${s.name}=${Math.round(s.mean)}`).join(' '),
		totalEdgeLen: Math.round(totalEdgeLen),
		areaMpx: Math.round(((maxX - minX) * (maxY - minY)) / 1e6),
		chains,
	}
}

const files = process.argv.slice(2)
if (!files.length) {
	console.error('usage: node scripts/layout-benchmark.mjs <file.tldr> [...]')
	process.exit(1)
}
for (const f of files) {
	const m = analyze(f)
	console.log(`${f}`)
	console.log(
		`  frames=${m.frames} transitions=${m.transitions} chains=${m.chains} area=${m.areaMpx}Mpx totalEdgeLen=${m.totalEdgeLen}`
	)
	console.log(`  shared screens (${m.sharedScreens}) mean dist to referencers=${m.meanSharedDist}`)
	console.log(`    ${m.sharedDetail}`)
}
