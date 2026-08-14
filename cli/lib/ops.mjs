import { readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { TldrError } from './load.mjs'

/**
 * Validate an ops file before it reaches the editor: every op is checked for
 * shape here so failures are instant and name the op index, rather than a
 * browser round-trip ending in a generic error.
 */

const OPS = {
	add_screen: { required: ['name'], optional: ['near', 'at', 'size'] },
	add: {
		required: [],
		optional: ['screen', 'kind', 'text', 'at', 'size', 'color', 'name', 'font', 'textSize', 'svg', 'src', 'dataUrl'],
	},
	set_text: { required: ['id', 'text'], optional: [] },
	style: {
		required: ['id'],
		optional: ['font', 'size', 'color', 'fill', 'dash', 'align', 'verticalAlign', 'geo', 'opacity', 'labelColor', 'kind', 'bend'],
	},
	move: { required: ['id'], optional: ['to', 'by'] },
	center: { required: ['id', 'on'], optional: ['axis'] },
	align: { required: ['ids', 'edge'], optional: ['to'] },
	distribute: { required: ['ids'], optional: ['axis', 'gap'] },
	resize: { required: ['id'], optional: ['w', 'h'] },
	connect: { required: ['from', 'to'], optional: ['label', 'color', 'kind'] },
	route: { required: ['id'], optional: ['fromAnchor', 'toAnchor', 'mid', 'kind', 'labelAt'] },
	chain: { required: ['id'], optional: ['points', 'fromAnchor', 'toAnchor'] },
	delete: { required: ['id'], optional: [] },
	rename: { required: ['id', 'name'], optional: [] },
}

export function readOps(path) {
	let raw
	try {
		raw = readFileSync(path, 'utf8')
	} catch (err) {
		throw new TldrError(`cannot read ops file ${path}: ${err.code ?? err.message}`, 1)
	}
	let ops
	try {
		// Windows editors and PowerShell redirects often prepend a UTF-8 BOM,
		// which JSON.parse rejects.
		ops = JSON.parse(raw.replace(/^﻿/, ''))
	} catch (err) {
		throw new TldrError(`${path} is not valid JSON: ${err.message}`, 1)
	}
	return inlineImageFiles(validateOps(ops), dirname(resolve(path)))
}

const IMAGE_MIME = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
}

/**
 * `add image` accepts `src` (a file path) for convenience, but only the CLI
 * has filesystem access — inline it as a data URL before the ops travel to
 * the editor. Paths resolve relative to the ops file.
 */
function inlineImageFiles(ops, baseDir) {
	ops.forEach((op, i) => {
		const args = op.add
		if (!args || args.kind !== 'image' || args.src == null) return
		const path = isAbsolute(args.src) ? args.src : resolve(baseDir, args.src)
		const mime = IMAGE_MIME[extname(path).toLowerCase()]
		if (!mime) {
			throw new TldrError(
				`op ${i + 1} (add image): unsupported file type "${extname(path)}" (supported: ${Object.keys(IMAGE_MIME).join(' ')})`,
				1
			)
		}
		let buf
		try {
			buf = readFileSync(path)
		} catch (err) {
			throw new TldrError(`op ${i + 1} (add image): cannot read ${path}: ${err.code ?? err.message}`, 1)
		}
		args.dataUrl = `data:${mime};base64,${buf.toString('base64')}`
		delete args.src
	})
	return ops
}

export function validateOps(ops) {
	if (!Array.isArray(ops)) {
		throw new TldrError('ops must be a JSON array of operations, e.g. [{"set_text": {...}}]', 1)
	}
	if (!ops.length) throw new TldrError('ops array is empty — nothing to do', 1)

	ops.forEach((op, i) => {
		const at = `op ${i + 1}`
		if (op == null || typeof op !== 'object' || Array.isArray(op)) {
			throw new TldrError(`${at}: each op is an object with exactly one key, e.g. {"add": {...}}`, 1)
		}
		const keys = Object.keys(op)
		if (keys.length !== 1) {
			throw new TldrError(`${at}: expected exactly one op name, got [${keys.join(', ')}]`, 1)
		}
		const name = keys[0]
		const spec = OPS[name]
		if (!spec) {
			throw new TldrError(`${at}: unknown op "${name}" (known: ${Object.keys(OPS).join(', ')})`, 1)
		}
		const args = op[name]
		if (args == null || typeof args !== 'object') {
			throw new TldrError(`${at} (${name}): arguments must be an object`, 1)
		}
		for (const req of spec.required) {
			if (!(req in args)) throw new TldrError(`${at} (${name}): missing required field "${req}"`, 1)
		}
		for (const key of Object.keys(args)) {
			if (!spec.required.includes(key) && !spec.optional.includes(key)) {
				throw new TldrError(
					`${at} (${name}): unknown field "${key}" (allowed: ${[...spec.required, ...spec.optional].join(', ')})`,
					1
				)
			}
		}
	})
	return ops
}

export function opsHelp() {
	return `Ops file: a JSON array, applied in order through the real editor.
References (id/from/to/screen/near) accept: a shape id, short id, frame name,
label text, or the "name" given to an earlier op in the same batch.

  {"add_screen": {"name": "BonusRound"}}
      Placement is optional: omit "near"/"at" and screens auto-flow onto a
      grid (rows of 5) - the right default when authoring a whole canvas.
      "near": <ref> places beside that shape; "at": {"x","y"} is explicit.
  {"add": {"screen": "BonusRound", "kind": "button", "text": "PLAY AGAIN", "at": "bottom"}}
      kind: card | button | label | note | box | image
      at: top | center | bottom | {"x":N,"y":N}
      Default sizes (pass "size" to override): card = (screen width - 40) x 120,
      button = 200x56, box = 160x100, note = fixed 200x200 yellow sticky (not
      resizable - use a box for small annotations), label = auto-sized text.
      Consecutive at:"top" adds stack downward automatically.
  {"add": {"screen": "Title", "kind": "image", "svg": "<svg ...>...</svg>", "at": "center"}}
      Real visuals: an image shape. Give EITHER "svg" (inline SVG markup -
      ideal for generated mockups/diagram art) or "src" (path to a
      png/jpg/gif/webp/svg file, resolved relative to the ops file). Size
      comes from "size", else the SVG's viewBox/width, else the image's own
      pixels. Assets embed in the document as data URLs.
  {"set_text": {"id": "TMKkAD33", "text": "YOU WIN!"}}
  {"style": {"id": "TMKkAD33", "font": "serif", "size": "l", "color": "violet"}}
      font: draw | sans | serif | mono      size: s | m | l | xl
      color/labelColor: black grey light-violet violet blue light-blue yellow
        orange green light-green light-red red white
      fill: none | semi | solid | pattern   dash: draw | solid | dashed | dotted
      align: start | middle | end           verticalAlign: start | middle | end
      geo: rectangle | ellipse | triangle | diamond | star | ... (change shape kind)
      opacity: 0..1. Inapplicable keys for the shape type are skipped and noted
      in the report. "add" also accepts font and textSize at creation.
      Arrows also take "kind" (arc | elbow) and "bend" (px, arc only): when an
      elbow transition cuts THROUGH intervening screens, restyle it
      {"style": {"id": "...", "kind": "arc", "bend": 220}} so it bows around
      them. Connected arrows always render above screens (kept automatically).
  {"move": {"id": "...", "by": {"dx": 0, "dy": 40}}}          or "to": {"x":N,"y":N}
  {"center": {"id": "<label>", "on": "<box>", "axis": "both|x|y"}}
  {"align": {"ids": [...], "edge": "left|right|top|bottom|centerX|centerY", "to": "<ref>"}}
  {"distribute": {"ids": [...], "axis": "x|y", "gap": 8}}
      Alignment uses REAL rendered bounds (the editor's own glyph metrics) -
      never hand-estimate text sizes or center by arithmetic. Fixed-size
      labeled chip recipe: boxes with their own text enforce a minimum text
      height (tldraw behavior, by design), so create the box WITHOUT text,
      add a label, then center it on the box - pixel-perfect, stays put.
      distribute stacks in current order from the first shape, real heights.
  {"resize": {"id": "...", "w": 240, "h": 64}}
  {"connect": {"from": "BonusRound", "to": "Title", "label": "done"}}   (bound both ends)
      Bind "from" to the TRIGGERING ELEMENT when you know it (the button/row
      that causes the transition), not the whole screen - the arrow starts at
      that control, and flows reports which control drives which route.
      \`claw layout\` handles where/how the arrow exits; never place anchors
      by hand. Screen-to-screen is fine when the trigger is diffuse (timers,
      auto-advance, whole-card taps).
      Arrows are created SOLID (not sketchy draw-style) for crisp diagrams;
      use the style op if a hand-drawn look is wanted.
      Frame-to-frame connects default to ELBOW arrows (orthogonal routing -
      stays legible in dense graphs); everything else defaults to arc.
      "kind": "arc" | "elbow" overrides. Connect screens DIRECTLY rather than
      building a separate node map; merge parallel transitions between the
      same two screens into one arrow with a combined label. For A<->B pairs
      (open/back, pause/resume) label only the forward arrow - the pair's
      elbows share a lane and two labels there always collide. For a dense
      graph, author the screens and connects, then run \`claw layout\`.
  {"chain": {"id": "<arrow>", "points": [{"x":N,"y":N}, ...]}}
      Multi-bend path for one arrow (routes a single elbow can't express):
      invisible waypoint dots + bound segments render the exact polyline;
      queries still see ONE transition. "points" are page-space interior
      bends; empty points unchains back to a plain arrow. \`claw layout\`
      emits these automatically - hand-write only for fine-tuning.
  {"route": {"id": "<arrow>", "fromAnchor": {"x":1,"y":0.3}, "toAnchor": {"x":0,"y":0.5}, "mid": 0.35}}
      Precise control of a bound arrow's path. Anchors are normalized points
      on each bound shape (x:1,y:0.3 = right edge, 30% down) - the arrow is
      pinned there instead of auto-sliding. "mid" (0..1) positions an elbow's
      middle segment between the endpoints - give arrows sharing a corridor
      different mids so their bends don't stack. \`claw layout\` computes all
      of this automatically; hand-write route ops only for fine-tuning.
  {"delete": {"id": "..."}}
      Idempotent: an id that no longer resolves is skipped with a note, not
      an error (deleting a group's children dissolves the group, so its id
      may vanish mid-batch). Deleting a group or frame deletes its children -
      delete containers FIRST rather than children-then-container.
  {"rename": {"id": "...", "name": "NewFrameName"}}   (frames only)`
}
