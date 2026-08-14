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

Two inferences the editor cannot make, implemented in `page/src/app.jsx` `project()`:

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

## Maintenance

- **Bumping tldraw:** `npm update tldraw` in `cli/`, then `node page/build.mjs`, then run the
  regression (`outline`/`flows`/`render`/`diff` on a known file — compare against committed
  expected output). API drift shows up as `hostError` from the page, not silent corruption.
- The page pins whatever tldraw version was installed at build time; files newer than it
  are rejected by tldraw's own parser with a clear error rather than misread.
- `render` fidelity is tldraw's own export — do not add drawing code to this repo. If a
  render looks wrong, it's a load problem or a tldraw bug, not a rendering gap to patch.
