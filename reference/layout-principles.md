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
5. **Fuse only at truly shared points.** Two routes may overlap only while
   the overlap is forced by a shared terminal point: arrows leaving the
   SAME point (one control, or a frame side's standard spot) form a trunk
   that branches late, and arrows converging into the same entry point
   share their final run. Arrows with different start and end points never
   coincide - each gets its own lane, 56px from the next. (Corrected from
   an earlier reading that fused everything sharing a source SCREEN.)
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
- Captured in engine (v0.30.0): chains retired — every route is a plain
  elbow solved by a joint search over exit sides near the frame edge and
  entry positions aligned with the arriving line.
- Captured in engine (v0.35.0): fusion requires a truly shared terminal
  point. Pack edges group by their hub-side terminal point and each group
  gets its own lane at 56px steps (shortest runs innermost); flow-edge
  lane sharing keys on the actual page-space start point, not the source
  screen; trunk adoption requires a matching terminal point; channels
  reserve one lane per edge.
- Captured in engine (v0.34.0): trunk arrows land on their shared lane
  EXACTLY in real geometry - the route op carries the absolute lane x and
  the executor calibrates each arrow's midpoint by measuring the rendered
  segment (tldraw normalizes the midpoint over its own span, so a
  model-solved value drifts a few px differently per arrow, unfusing the
  trunk into near-parallel lines).
- Captured in engine (v0.33.0): the planner's path model is faithful to
  tldraw's elbow semantics - routes leave perpendicular-outward from the
  start side and arrive perpendicular-inward at the end side; candidates
  that contradict a side are rejected (tldraw would wrap them with
  unscored segments), current routes that contradict are modeled as the
  wrap; mids are emitted only between facing sides (0.5 otherwise, which
  also clears stale handles); a pack leaf on the opposite vertical side of
  its trunk's main run gets a lane one step further out instead of riding
  the trunk against its direction.
- Captured in engine (v0.32.0): routes keep a 56px clearance margin from
  unrelated screens (near-passes are penalized in scoring, re-solved, and
  can trigger a screen nudge — a line 5px above a frame reads as touching
  it); entry sides must FACE the source (an away-facing entry gets a joint
  re-solve); a start point never sits on an end point (coincident pairs
  split 0.38/0.62 along the side); pack columns sit on the side nearest
  their linking controls (weighed against flow traffic), and the
  hub-to-column channel grows with the number of arrows living in it;
  pack leaves may slide along their column to open a channel.
- Captured in engine (v0.31.0): exit-side scoring prefers the side nearest
  the frame edge over the side pointing at the destination (own-frame
  pixels cost triple in the route score); same-source routes to DIFFERENT
  destinations are pulled apart when they run near-but-not-exactly together
  (exact overlap stays — that is deliberate fusion); a route blocked by a
  single small leaf screen moves THE SCREEN to open a channel instead of
  accepting the crossing; single-leaf packs (a lone toast) get a column on
  the hub's quiet side; hub-to-satellite channels widened to 0.75 of the
  spacing unit.
