# Layout principles (from the hand-made reference)

Source of truth: `test/fixtures/reference-layout.tldr` is a hand arrangement
of the awkwordly ui-flow canvas (20 screens, 35 transitions) made by Tom on
2026-08-17 specifically to teach the layout algorithm. When a layout change
is proposed, run it against the same graph and compare with this file. The
algorithm's output does not need to match the reference shape-for-shape; it
needs to score comparably on the measures below and respect the rules.

## Placement rules

1. **Shared screens sit between their referencers.** A screen referenced by
   two hubs (Settings, PuzzleSelect, WordDefs, ShareSheet in the reference)
   goes in the space between those hubs, not in a strict flow column after
   both. A left-to-right layering algorithm cannot express this; it needs a
   dedicated placement pass.
2. **Hubs are central, their satellites orbit close.** Outcome modals and
   tools stack in short columns near the hub that owns them, on the side
   where their return arrows leave.
3. **Generous whitespace.** Space between screens exists to give arrows room
   for low-bend routes. When in doubt, spread out.

## Routing rules

4. **Chains are retired.** Every route is a plain elbow; the reference
   (and the reworked arrows in test/fixtures/reference-arrows.tldr) proves
   this always suffices. A route that cannot be cleared stays put and lint
   reports it - visible failure beats hidden complexity.
5. **Fuse, don't fan.** Arrows from the same source, or into the same
   destination, share the same anchor point (a side's center) and overlap
   along their common run, so several transitions read as one trunk that
   branches. This is the opposite of spreading anchors along a side; visual
   noise goes down when lines coincide.
6. **Anchor sides and positions are a joint decision.** Starts exit at the
   center of a control side that is close to the frame edge AND points
   toward the destination. Ends enter on the side that avoids crossings,
   at a POSITION along that side aligned with where the line arrives, so
   routes collapse to one or two segments. Fewest bends wins, then
   shortest.

## Label rules

7. **No labels that just restate the source button.** The arrow starting at
   a button named "Settings" does not need a "settings" label. Label only
   what the geometry cannot say (conditions like "3rd turn, no perfect",
   parameters like "?share=ID").
8. **Labels sit just after a trunk split**, where a branch becomes
   distinguishable, or near the arrow's start when the arrow shares no
   trunk.

## Measures for comparison (scripts/layout-benchmark.mjs)

- mean distance from each multi-referenced screen to its referencers
- total straight-line transition length
- occupied canvas area
- waypoint chain count (reference: 0)
- lint arrow-through count (reference: 0)

## Status

- Captured in engine (v0.24.5): anchor fusing at side centers; fused-trunk
  labels just after the branch point.
- Captured in engine (v0.25.0): shared satellites (low-degree screens with
  2+ hub-like referencers) leave the flow graph and sit at the barycenter
  between their referencers; single-hub packs stack as one column beside
  the hub with a fused side trunk; unrelated near-parallel lanes keep a
  48px minimum separation.
- Captured in engine (v0.26.0): jog removal turns ELK staircase routes
  into clean elbows; crossing elbows try nudged lanes (both in the planner
  and against real geometry in fix_crossings) before any chain is created;
  labels relocate along their arrow until they sit clear of every screen.
- Captured in engine (v0.27.0): pack columns sit on the side AWAY from
  the hub's flow traffic; outgoing arrows anchor at 0.38 of a side and
  incoming at 0.62 so a start point is never also an end point; same-side
  anchor routes (up-across-down and mirrors) are tried before any chain,
  both in the planner and against real geometry in fix_crossings.
- Not yet captured: branch-point labels for chained routes, and the final
  chain (one dense corridor with no single-elbow route).
