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

4. **Never exceed what one tldraw elbow can express.** The reference uses
   zero waypoint chains. Chains are a last resort, not a routing tool.
5. **Fuse, don't fan.** Arrows from the same source, or into the same
   destination, share the same anchor point (a side's center) and overlap
   along their common run, so several transitions read as one trunk that
   branches. This is the opposite of spreading anchors along a side; visual
   noise goes down when lines coincide.
6. **Pick each arrow's side to minimize bends and overlap with screens.**
   The side facing the other endpoint's region, not a fixed convention.

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

- Captured in engine (v0.24.5): anchor fusing at side centers, chains
  avoided in favor of corridor detours only when a route genuinely fails.
- Not yet captured: between-referencers placement, hub-orbit stacking,
  branch-point label positioning. The ELK layered arrangement remains the
  placement engine until a dedicated pass replaces or post-processes it.
