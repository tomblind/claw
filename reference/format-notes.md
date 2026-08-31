# Architecture notes

As of v0.3 this tool **does not parse or interpret the .tldr format itself**. Every command
loads the file into the real tldraw editor, running headlessly in an installed browser
(`page/dist/index.html` bundles tldraw; `lib/session.mjs` drives it via playwright-core).
Parsing, schema migration, bounds, binding resolution, and rendering are tldraw's own code.

This replaced ~30KB of format reimplementation (v0.1–0.2) that accumulated eleven bugs —
each one a divergence between our reading of the format and tldraw's. The lesson that
survives: **never reinterpret a GUI application's serialization; drive the application.**
The old sharp-edge catalog (dual arrow-binding formats, richText extraction, growY,
scale-corrected text widths, stale terminal points) is obsolete as implementation guidance —
tldraw handles all of it — but is preserved in git history as a record of why this
architecture was chosen.

## What is still ours (and why)

Two inferences the editor cannot make, implemented in `page/src/projection.js`:

1. **Rectangles as screens.** tldraw only parents shapes into real frames. People draw
   screens as plain rectangles, leaving the parent tree flat. We infer containment
   geometrically: a shape ≥90% covered by a strictly larger *closed* shape (frame, geo,
   image, note — never text, never arrows) is treated as contained; smallest such
   container wins. Always reported as `[container inferred]`, never as fact.

2. **Unsnapped arrows.** tldraw records a binding only when the user snapped the endpoint.
   Loose endpoints are resolved geometrically: shape containing the point (≤2px), else
   nearest shape within 120px, else unresolved. `flows` reports these in a separate
   "inferred" section with per-endpoint evidence (`[end 6px from target]`). The invariant:
   **never present a guess as recorded** — and never refuse to guess, either; most
   hand-drawn arrows are unsnapped and a tool that only reports recorded bindings is
   useless on real input.

3. **Intra-screen arrows are not navigation.** An arrow with both effective endpoints in
   the same root container (shuffle-motion arrows, annotations) is bucketed separately.
   Reporting them as transitions produces phantom routes in generated code.

## The projection contract

`host.project()` returns `{v, pages: [{id, name, shapes, arrows}], warnings}` — shapes carry
short ids, page-space integer bounds, effective `parent`, `container`/`containerInferred`;
arrows carry `start`/`end` terminals as `{id, how: bound|inside|near, d}` plus root-container
ids. Node-side code (`format.mjs`, `diff.mjs`) formats this and must not re-derive geometry.
Bump `v` on breaking changes; `diff` compares two projections, so both sides must come from
the same page build.

## The editor page, module by module

`cli/page/src` is bundled into one HTML file that serves three roles: the hidden
executor the CLI drives, the live canvas a person edits, and a standalone viewer.

| File | What lives there |
| --- | --- |
| `app.jsx` | boot, the `window.host` API the CLI calls, the style panel, the menus |
| `ops.js` | every agent operation (`applyOps`) and the chain and text helpers it needs |
| `projection.js` | the read-only outline an agent gets back: shapes, boxes, arrow ends |
| `dialogs.jsx` | the two "Customize..." dialogs that edit the document's colour and font slots |
| `gradients.js` | the slot model, the paint applied to canvas and export, the drag handles |
| `theme.js` | reading and writing `meta.clawTheme`, registering slots with tldraw |
| `rounded.js` | the corner fillet used by the rounded shape variants |
| `lint.js` | the layout checks (`lintDocument`) the CLI reports |
| `figma-svg.js` | rewriting exported HTML text into real SVG text Figma can read |
| `editor-utils.js` | id shortening, rounding, plain text from rich text |
| `common.js` | error reporting, the canvas background, hex mixing |

Two rules keep this workable. Nothing here reimplements tldraw, so parsing, rendering,
and serialization stay the editor's own code paths. And a call to a function in another
module is a runtime error if the import is missing, which the bundler will not catch, so
`npm run check:imports` (part of `npm test`) looks for exactly that.

## Maintenance

- **Bumping tldraw:** `npm update tldraw` in `cli/`, then `node page/build.mjs`, then run the
  regression (`outline`/`flows`/`render`/`diff` on a known file — compare against committed
  expected output). API drift shows up as `hostError` from the page, not silent corruption.
- The page pins whatever tldraw version was installed at build time; files newer than it
  are rejected by tldraw's own parser with a clear error rather than misread.
- `render` fidelity is tldraw's own export — do not add drawing code to this repo. If a
  render looks wrong, it's a load problem or a tldraw bug, not a rendering gap to patch.

## Claw-only concepts in a portable file

Claw adds four things tldraw has no vocabulary for. All of them survive a
round trip through a vanilla tldraw editor, because the FILE never contains a
value tldraw would reject: props carry a legal standard value, the claw truth
lives in record `meta`, and `lib/custom-slots.mjs` swaps between the two at
every file boundary (`restoreCustomStyles` on read, `extractCustomStyles` on
write, called from both the editor page and the sync room).

| concept | in memory | in the file | metadata |
|---|---|---|---|
| custom colour / font slots | `props.color = 'custom-3'` | nearest standard colour | `meta.clawStyle = {color, colorFallback}` |
| rounded corners | `props.geo = 'rounded-hexagon'` | `'hexagon'` | `meta.clawRadius` (the radius IS the marker) |
| gradient slots | slot value is `{gradient, from, to}` | shape uses the midpoint colour | slot in `meta.clawTheme`, geometry in `meta.clawGradient` |
| per-shape text outline | — | — | `meta.clawText.outline` |

Three rules learned the hard way:

1. **`meta.clawStyle`, never `meta.claw`.** A string-valued `meta.claw` is a
   waypoint-chain marker from the old arrow router. v0.22–0.24.1 wrote style
   data there and silently destroyed chain markers on every load.
2. **A claw-only enum value must be registered in THREE places** or a live
   canvas rejects it: the editor page (shape util config), the sync room's
   schema (`server/rooms.mjs`), and the file transform that hides it. Missing
   the room registration produced `INVALID_RECORD` disconnects in v0.44.0,
   and only a live room reproduces it - standalone tests cannot.
3. **`updateShape` MERGES `meta`.** Omitting a key does not delete it; write
   `null` explicitly and let the file transform drop it.

### Gradients

A gradient lives on a colour SLOT (two colours plus linear/radial), so editing
the slot restyles every shape using it. Each shape owns only the geometry, as
FRACTIONS of its own box, so a resize preserves the look.

Painting is split by how the pixels are produced, and the split is the reason
it works everywhere:

- **Vector shapes** get their resolved fill/stroke replaced with a reference to
  their own gradient definition, via tldraw's `getCustomDisplayValues` hook.
  Canvas, PNG and SVG export all read that hook, so one mechanism covers them.
- **Fill styles are not "on/off".** tldraw maps each fill style to a different
  palette key of the same colour, so a gradient derives per-style stops
  (`fill` full strength, `solid` a pale wash, `lined-fill` between). `semi` and
  `pattern` deliberately keep tldraw's own treatment.
- **Text** is HTML and cannot reference an SVG paint, so it clips a css
  gradient to the glyphs. That forces the text's own fill transparent, which
  in turn breaks both of tldraw's outline techniques (a text-shadow or a
  text-stroke paints ABOVE the clipped fill: one whites the letters out, the
  other eats into them). Gradient text therefore draws its outline with an SVG
  filter that dilates the glyph once - a chain of css drop-shadows compounds
  and comes out far too heavy.
- **The Figma export** rewrites text into real SVG `<text>`; a transparent run
  resolves to the shape's gradient rather than to transparent, or the text
  imports invisible.
