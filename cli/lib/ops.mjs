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
		optional: ['screen', 'kind', 'text', 'at', 'size', 'color', 'name', 'font', 'textSize', 'labelColor', 'svg', 'src', 'dataUrl'],
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
	row: { required: ['ids'], optional: ['gap'] },
	clear: { required: ['id'], optional: [] },
	theme: { required: [], optional: ['colors', 'fonts', 'reset'] },
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
      FIXED CHIP: text + an explicit size.h makes an exact-size box with a
      SEPARATE overlay label centered by real glyph bounds (labelColor sets
      its color; default black - dark labels read best on the pastel fills).
      ALWAYS prefer this for buttons/tiles/rows: without size.h the text
      lives ON the geo, which grows to fit it and breaks your sizing.
      Boxes default to dash:solid and labels to font:sans (crisp, not the
      hand-sketched draw style) - pass dash/font only to deviate.
      "name"s persist on the shape - reuse them in ANY later batch/session.
  {"add": {"screen": "Title", "kind": "image", "svg": "<svg ...>...</svg>", "at": "center"}}
      Real visuals: an image shape. Give EITHER "svg" (inline SVG markup)
      or "src" (path to a png/jpg/gif/webp/svg file, resolved relative to
      the ops file). Size comes from "size", else the SVG's viewBox/width,
      else the image's own pixels. Assets embed as data URLs. STATIC ART
      ONLY (logos, illustrations): an embedded image is uneditable in the
      canvas - anything that is layout, text, or component structure must
      be native shapes so humans and later agents can change it.
  {"set_text": {"id": "TMKkAD33", "text": "YOU WIN!"}}
      On a fixed chip, targeting the BOX redirects to its overlay label and
      re-centers it (retexting the box itself would add a second label).
  {"style": {"id": "TMKkAD33", "font": "serif", "size": "l", "color": "violet"}}
      font: draw | sans | serif | mono (+ theme-defined custom-1..custom-8)
      size: s | m | l | xl
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
  {"distribute": {"ids": [...], "axis": "x|y", "gap": 8}}   (stacks; real heights)
  {"row": {"ids": [...], "gap": 12}}
      Horizontal row: shapes line up after the FIRST one, vertically centered
      on it - the standard UI-row layout in one op.
      Alignment ops use REAL rendered bounds (the editor's own glyph metrics)
      - never hand-estimate text sizes or center by arithmetic.
  {"clear": {"id": "<frame>"}}
      Delete a frame's children (frame itself + bound arrows kept). THE op
      for regenerating one screen's interior without losing layout/routing.
  {"resize": {"id": "...", "w": 240, "h": 64}}
      On a TEXT shape, "w" sets a fixed width and turns on WRAPPING (long
      copy flows to multiple lines; no more hand-inserted newlines); resize
      with no "w" restores auto-size. w/h are clamped to >= 1 everywhere.
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
  {"theme": {"colors": {"custom-1": "#e91e63", "custom-2": {"solid": "#1a73e8", "semi": "#1a73e8"}},
             "fonts": {"custom-1": "Inter, system-ui, sans-serif",
                       "custom-2": {"family": "Lora", "url": "https://.../lora.woff2"}}}}
      Adds palette colors and fonts, per document. STRICTLY ADDITIVE: colors
      accepts only the 24 reserved slots "custom-1".."custom-24" and fonts
      only the 8 slots "custom-1".."custom-8" - the 13 standard color names
      and 4 standard fonts (draw sans serif mono) are deliberately not replaceable
      (they mean the same thing in every tldraw app). Colors: a bare "#hex"
      derives the pale semi/pattern fill variants automatically; an object
      sets exact variants (set "semi" to the same hex for a truly saturated
      fill), with optional {"light": {...}, "dark": {...}} splits. Fonts: a
      CSS stack (installed fonts) or {family, url} to load a webfont -
      embedded in renders too. Once defined, custom-N works anywhere a
      color/font is accepted; the human can also manage both via the
      "Customize colors/fonts" dialogs in the editor's style panel. Stored IN
      the document;
      every claw surface (app, browser, phone, renders) shows it.
      {"theme": {"reset": true}} clears it (shapes still using custom-N keep
      validating but render placeholder grey/default font). PORTABILITY:
      saved files stay valid for other tldraw editors - on disk a
      custom-slot shape stores the nearest standard color/font, with the
      claw value in shape meta; other editors (e.g. the VS Code extension)
      open the file fine and show that approximation, and an edit they make
      to such a prop wins over the stored custom value on the next claw
      load.
  {"delete": {"id": "..."}}
      Idempotent: an id that no longer resolves is skipped with a note, not
      an error (deleting a group's children dissolves the group, so its id
      may vanish mid-batch). Deleting a group or frame deletes its children -
      delete containers FIRST rather than children-then-container.
  {"rename": {"id": "...", "name": "NewFrameName"}}   (frames only)`
}
