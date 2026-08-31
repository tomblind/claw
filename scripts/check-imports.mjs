#!/usr/bin/env node
/**
 * Catch a reference to something another module owns but this one never
 * imported. A missing import is a RUNTIME error in the browser, so the build
 * happily succeeds and only a test (or a user) finds it - this check finds it
 * in a second.
 *
 * It deliberately flags names the owner does NOT export too: calling a
 * function that lives in another file and is not exported is always a bug,
 * and that is precisely the case that slipped through a refactor
 * (patchSlotLabels moved out from under applyClawTheme).
 */
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'

const FILES = [
	...globSync('cli/page/src/*.js'),
	...globSync('cli/page/src/*.jsx'),
	...globSync('cli/lib/*.mjs'),
	...globSync('cli/server/*.mjs'),
]

const GLOBALS = new Set(
	`Object Array String Number Boolean Math JSON Promise Set Map WeakMap Date Error RegExp
	 parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent btoa atob
	 structuredClone setTimeout setInterval clearTimeout clearInterval requestAnimationFrame
	 document window navigator location console Image Blob File FileReader DOMParser DOMPoint
	 XMLSerializer NodeFilter URL URLSearchParams AbortController AbortSignal fetch
	 localStorage getComputedStyle Buffer process require import globSync
	 if for while switch return typeof function catch try await new delete void this super`.split(/\s+/)
)

const mods = new Map()
for (const file of FILES) {
	const src = readFileSync(file, 'utf8')
	// every declaration anywhere in the file, used to suppress local names
	const declared = new Set(
		[...src.matchAll(/(?:^|[\s(])(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
	)
	// Anything sitting inside parentheses - a parameter or an argument - is
	// suppressed: a `call` parameter is not the exported `call`. This costs a
	// little detection power on arguments but keeps the signal that matters,
	// which is a CALLEE that lives in another module.
	for (const m of src.matchAll(/[(,]\s*([A-Za-z_$][\w$]*)\s*(?=[,)=])/g)) declared.add(m[1])

	// only TOP-LEVEL declarations (column 0) can be owned by a module
	const topLevel = new Set(
		[...src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
	)
	const exported = new Set(
		[...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
	)
	const imported = new Set()
	for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
		for (const part of m[1].split(',')) {
			const n = part.trim().split(/\s+as\s+/).pop()?.trim()
			if (n) imported.add(n)
		}
	}
	for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) imported.add(m[1])
	for (const m of src.matchAll(/import\s+\*\s+as\s+(\w+)/g)) imported.add(m[1])
	mods.set(file, { src, declared, topLevel, exported, imported })
}

// who owns each name (declared at top level in exactly one module)
const owners = new Map()
for (const [file, m] of mods) {
	for (const name of m.topLevel) {
		if (!owners.has(name)) owners.set(name, [])
		owners.get(name).push(file)
	}
}

let problems = 0
for (const [file, m] of mods) {
	const used = new Set([
		...[...m.src.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)].map((x) => x[1]),
		...[...m.src.matchAll(/(?<![.\w$])([A-Z][A-Z0-9_]{2,})(?![\w$])/g)].map((x) => x[1]),
	])
	for (const name of [...used].sort()) {
		if (m.declared.has(name) || m.imported.has(name) || GLOBALS.has(name)) continue
		const owner = (owners.get(name) ?? []).filter((f) => f !== file)
		if (!owner.length) continue
		const exportedSomewhere = owner.some((f) => mods.get(f).exported.has(name))
		console.log(
			`${file}: uses "${name}" (lives in ${owner.join(', ')})${exportedSomewhere ? '' : ' - and it is NOT exported'}`
		)
		problems++
	}
}
console.log(problems ? `\n${problems} missing import(s)` : 'no missing imports')
process.exit(problems ? 1 : 0)
