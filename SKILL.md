---
name: claw
description: Read, query, and render tldraw (.tldr) canvas files — wireframes, UI mockups, screen-flow diagrams, architecture sketches. Use when a project contains a .tldr file, when the user mentions tldraw, a canvas, a whiteboard, or a drawn mockup, or when asked to build UI/prototypes from a drawing or to trace the flows in one. Also use before editing any .tldr file.
---

# Claw

Claw (Claude + draw) is a human+AI co-op canvas tool built on [tldraw](https://tldraw.dev).

A `.tldr` file is a tldraw document: JSON holding a canvas of frames, shapes, text, and arrows. The user edits it visually (VS Code extension `tldraw-org.tldraw-vscode` opens `.tldr` natively as a canvas); you read it through this CLI.

**Never read or edit a `.tldr` file directly.** They are hundreds of verbose records with internal ids, fractional z-indices, and two different historical formats for arrow bindings. Reading one wastes context; editing one by hand silently destroys the user's work. Use the CLI.

## The CLI

```
node ~/.claude/skills/claw/cli/claw.mjs <command> <file.tldr>
```

| command | use it for |
|---|---|
| `outline <file>` | **Start here.** Pages, nested frames, and counts of everything else. Cheapest way to see what exists. `--all` lists every shape, `--json` for machine form. |
| `flows <file>` | The arrow graph alone — what connects to what. Essential for screen-flow docs. `--from <id>` to filter. |
| `render <file>` | **Pixel-accurate PNG from the real tldraw editor.** `--frame <id\|name>` renders one screen; `--around <ref> --pad N` is a tight crop of one shape (the cheap self-check while building). **Read the PNG** — layout is spatial and the text output can't convey it. |
| `diff <new> <old>` | What changed between two canvases (or `--against <git-rev>`). Pure comparison — see *Syncing a canvas to code* for how projects use it. |
| `ops` | **The op reference.** Read it once before writing your first ops file — every op, kind, default size, and allowed value. |
| `apply <file> <ops.json>` | Modify the canvas through the real editor — see *Writing to a canvas* below. |
| `new <file> <ops.json>` | Create a fresh canvas from the same ops vocabulary. **Once per file** — after that, always `apply`. |
| `layout <file>` | Full automatic arrangement (ELK layered): flow columns with proper crossing minimization, dead-end satellites gridded under their hub screen, arrows routed (anchors spread along sides, one lane per edge per corridor, long hops over the top band). Run after authoring a graph — never hand-compute positions or hand-tune arrow paths first. |
| `open <file>` | Open the file as a **live canvas** in the user's browser — see *Live canvas* below. |

`--help` has full flag detail. Exit codes: `0` ok, `1` usage, `2` bad file or environment problem.

Every command runs through the **actual tldraw editor** inside the canvas desktop app — parsing, schema migration, geometry, and rendering are tldraw's own code; any file version a current tldraw can open, these commands can too. The app launches automatically on first use (a visible window — that is by design, it's how the user sees the system is running) and closing its window stops everything. If a command fails with "no executor connected", the app isn't running or is still starting — retry once before reporting a problem.

## How to read a canvas

1. **`outline`** to orient. You now know the frames, their names, sizes, and nesting.
2. **`render`** and **Read the PNG.** Structure tells you what exists; the image tells you how it's arranged, which is what you need to build a layout.
3. **`flows`** if arrows matter (screen flows, state machines, architecture).
4. **`render --frame <name>`** to zoom into one screen when implementing it.

Only steps 1 and 2 are usually needed before starting work. Don't dump `--all` unless you actually need every shape.

**Delegate iterative canvas work to the `canvas-worker` sub-agent when it's available** (check your agents list). Building a diagram from a spec, or an edit pass that will need render-verify loops, belongs in the sub-agent: it absorbs the renders and op reports and returns a compact summary. Work directly only for one-shot reads (`outline`, `flows`, `diff`) or a single small `apply`.

**Context economy — every output of these commands lives in context for the rest of the session:**

- **Renders are the expensive channel** (~1–1.7k tokens each, permanently resident once Read). Verify structure with `outline`/`flows`/`diff` — nearly free — and Read a render for *visual* judgments and final confirmation, not as a routine check after every step. One render after a batch of ops, not one per op. Prefer `render --frame <screen>` over full-canvas renders when you're working on one screen — cheaper and more legible.
- **Avoid discovery-by-render.** The op reference (`claw apply` with no ops file) documents every `add` kind's default size — pass explicit `size` values and check placement arithmetic with `--dry-run` instead of rendering to see how big something came out.
- **Batch your ops — but cap the blast radius.** One `apply` with ten ops costs one command and a ten-line report; ten separate applies cost ten round-trips. Plan edits, then apply in batches. **Apply is all-or-nothing: one failed op rolls back the entire batch.** Keep batches under ~50 ops on big builds (adds in one batch, styling in the next, deletes in another) so a single bad reference doesn't discard hundreds of ops of work. **After an errored apply, NOTHING landed** — verify state with `outline`, fix the bad op, and re-apply the whole batch.
- **When canvas work is done, unrelated follow-up work belongs in a fresh session** — otherwise every later turn re-carries the accumulated canvas context for nothing.

## Rules

**Warnings on stderr are not noise.** In particular:

- **`N of M arrows have endpoint(s) not snapped`** is normal, not a problem. tldraw only records a binding when the user drags an endpoint onto a shape until it highlights, and most hand-drawn arrows never get that treatment. `flows` deduces them.

**Distinguish recorded from inferred, and act accordingly.** `flows` splits them because they carry different weight, not to make you ask about every arrow:

- **Recorded** — the file states it. Treat as fact.
- **Inferred** — deduced from geometry, with the evidence shown (`[end 6px from target]`). Small distances and `inside target` are strong; tens of pixels on a crowded canvas are weaker. **Use these** — a flow doc is mostly inferred edges and that's expected. Check them against the rendered PNG rather than asking the user to re-draw.
- **Unresolved** — nothing within 120px. These are the only ones worth asking about.

When you build from inferred edges, say so briefly in your summary so the user can correct a misread. Don't refuse to proceed, and don't ask them to snap arrows — that isn't a practical request.

**Frames are the unit of meaning — but most documents don't use them.** A named frame is a screen, component, or module. People commonly draw screens as plain rectangles instead, in which case tldraw's parent tree is flat and says nothing.

`outline` and `render --frame` handle this by inferring containment from geometry (a shape ≥90% inside a larger one is treated as contained). Inferred containers are marked `[container inferred]`, and unnamed ones get a `~"label"` guessed from the largest text inside them.

**Treat inferred containment as a guess.** It is usually right, but overlapping or adjacent shapes can nest wrongly. If structure matters for the task, confirm it against the rendered PNG. Suggest the user convert screens to named frames if they want it to be authoritative.

**`flows` output has four sections** — read the headings, not just the arrows:

- **recorded transitions** — navigation the file states outright.
- **inferred transitions** — navigation deduced from geometry, with evidence.
- **arrows inside a single screen** — motion, sequence, or annotation. **Not navigation**; don't wire these as routes. A shuffle animation drawn as five curved arrows inside one screen lands here.
- **arrows with no target within reach** — genuinely ambiguous; ask.

Endpoints name the shape actually hit, qualified `in <screen>` when they differ, so `"LET'S GO!" in ~"Title" -> ~"Reveal"` means that button triggers that transition. A `~"label"#id` prefix means the label was borrowed from the largest text inside an unnamed container — the id disambiguates, since two unnamed screens can easily hint to the same string.

`--no-infer` restricts output to what the file states. Use it only when you specifically need ground truth.

**Coordinates are page-space and already resolve parent transforms**, so a child frame's `@x,y` is directly comparable to its parent's. Sizes are rounded to whole pixels.

## Live canvas (rooms)

Every write (`apply`, `new`) automatically opens a **live room** on the file and goes through it — the room is watchable from the app's dashboard, and `apply`/`new` print a `watch live:` URL. If the user asks to see what you're doing, give them that URL or tell them the file is on the dashboard — it always is.

`claw open <file>` opens the same live room explicitly without writing anything — a full tldraw editor in the user's browser. While a room is live:

- **The room is the document authority**, persisting to the `.tldr` debounced (~2s). Every CLI command flushes the room to disk automatically before reading, so `outline`/`flows`/`render`/`diff` always reflect what the user currently sees — including their unsaved strokes.
- **`apply` routes through the live room**: the user watches your edits land on their canvas in real time (you appear as "Claude"). The output says `applied to live canvas` instead of `wrote <file>`; do not expect or attempt a file write — the room persists it.
- Room applies are **atomic**: ops execute against the room's current state and the result is loaded back server-side in one step, broadcast to every connected client. A batch either fully lands or errors cleanly with nothing changed — retry on failure.
- When the user asks to "open the canvas" / "show me the board", run `claw open` and **give them the URL — never launch a browser for them** (they may prefer the desktop app, a specific browser, or their phone; `--launch` exists only for when they explicitly ask you to open it locally).
- **Before choosing the write path, check `claw status` + the URL output**: `apply` automatically routes through the live room when one exists — if the output says `wrote <file>` but the user says their canvas is open, stop and reconcile (the app may have restarted, invalidating old room URLs) rather than continuing to write the file.
- Never edit the `.tldr` file by any other means while a room is live (no direct writes, no VS Code extension edits) — the room will overwrite them.

## Syncing a canvas to code (the accepted-copy pattern)

Claw keeps **no history and no hidden state** — every command reads the file as it is. When a project derives an artifact from a canvas (an HTML prototype, Unity screens, generated code), the *project* owns the sync point, as a plain visible file:

1. Build (or update) the artifact from the canvas.
2. Snapshot the moment they matched: `cp design/ui.tldr design/ui.accepted.tldr`
3. Next time the user says "I updated the canvas": `claw diff design/ui.tldr design/ui.accepted.tldr`
4. Act on **only** what the diff reports, then refresh the snapshot (step 2).

`diff` reports screens added/removed, text changes, shapes added/removed, and flow edges added/removed — then summarises pure position and size changes separately as `layout: N moved`. That separation is the point: a user who nudges six screens two pixels left has changed nothing you should act on. If it prints `no semantic changes`, **stop** — the artifact does not need updating; say so rather than finding something to change.

Why the snapshot matters: querying tells you the current *state* and can never tell you the *delta*. Without a delta you either regenerate the whole artifact (thousands of output tokens, discarding work already in it) or hand-compare canvas to code. `diff` scopes the write, not the read.

**Record the convention in the project's `CLAUDE.md`** — where the canvas lives, what it maps to, and where the accepted copy sits, e.g. `design/ui.tldr → src/components/; accepted copy: design/ui.accepted.tldr`. If the project doesn't note a convention and the task is a sync pass, set one up (and mention it). The accepted copy can be committed or gitignored — the project's choice; render outputs (`*.png`) are regenerable and belong in `.gitignore`.

Projects that don't derive anything from the canvas need none of this — don't create snapshot files for pure diagramming or brainstorming work.

(You may see a stale `.tldr-state/` folder beside older canvases — it's from a removed mechanism; safe to delete, never read it.)

## Writing to a canvas

Write through `apply` (modify) and `new` (create) — **never edit .tldr JSON directly.** Ops run through the real editor, so everything an op doesn't mention is untouched by construction, and arrows created with `connect` get real bindings (they show as *recorded* transitions, not inferred).

**Before your first ops file, run `claw ops`** — it documents every op, kind, default size, and allowed value. Do not discover the vocabulary by trial and error, by grepping this skill's source, or by creating throwaway canvases to poke at.

**Iterate with `apply`, never by regenerating.** Build the canvas with ONE `new`, then fix and extend it with `apply` patches (`move`, `resize`, `style`, `delete`). Regenerating with `new --force` to fix a layout mistake throws away the editor's ids (breaking any accepted-copy diff) and forces a full re-render to see the result — three ops in an `apply` would have cost a 3-line report. Plan placement arithmetic up front (screens are typically 320×568; leave 120px gutters), preview with `--dry-run`, and verify with `render --frame <screen>` — full-canvas renders of a big document are the most expensive single artifact you can put in context.

**No throwaway prototype canvases.** Ops behave identically on every canvas; testing an op on a scratch file then repeating it on the real one pays for everything twice. `--dry-run` on the real file is the preview mechanism.

**Flow diagrams: connect the screens themselves — don't build a separate node map.** Frame-to-frame `connect` produces elbow arrows that route orthogonally and stay legible even in dense graphs. The recipe for a graph of any size: `add_screen` everything (omit positions — they auto-grid), `connect` the transitions, then run `claw layout` to arrange screens into flow columns. Merge parallel transitions between the same two screens into one arrow with a combined label ("save / cancel") instead of stacking arrows.

Arrow hygiene in dense graphs: connected arrows always render above screens (kept automatically), but the elbow router only avoids its own two endpoints — a long transition can still cut *through* screens between them. When a render shows that, restyle that arrow to bow around: `{"style": {"id": "...", "kind": "arc", "bend": 220}}` (negative bend bows the other way). Don't hand-shuffle screens to dodge one arrow.

### Building UI mockups (native shapes)

For UI-flow diagrams, **faithful native-shape wireframes are the default**:
complete, real component layouts (a *full* board, not three representative
tiles), never descriptive-text cards, never SVG mockups when the user will
edit them (SVG is uneditable in the canvas — use it only for art/logos).
`font: sans` on everything. Rules that prevent whole rounds of rework:

- **Never hand-compute text positions — use `center`/`align`/`row` on BOTH
  axes.** A text shape's y is the top of its line-box, not the visible glyph;
  any label that must line up with a sibling must be `center`ed on it.
- **Fixed-size chips/tiles/buttons**: `add` with text + explicit `size.h`
  builds the exact-size box + centered overlay label automatically.
- **Long copy**: `resize` the label with a `w` — it wraps at that width. Don't
  hand-insert newlines.
- **Named fills render pastel** — use dark label text (`labelColor: black`,
  the default), `fill: solid` for shaded tiles.
- **Brand colors/typography**: the `theme` op adds palette colors (reserved
  slots `custom-1`..`custom-24`) and fonts (slots `custom-1`..`custom-8`) —
  strictly additive; the 13 standard colors and 4 standard fonts are never
  replaced. Stored in the file; every claw surface and render honors it.
  Shapes that USE a custom slot make the file claw-only: other tldraw apps
  report it as corrupted. For truly saturated custom fills set the color's
  `semi` variant to the same hex.
- **Regenerating one screen**: `clear` the frame (children gone, frame +
  arrows + layout survive), then re-add its interior. Never delete children
  one by one.
- **`outline --json` includes the arrows** (ids, labels, endpoints, roots) —
  no text-scraping needed to script arrow ops.

Write an ops file (JSON array, applied in order) and run it:

```json
[
  { "add_screen": { "name": "BonusRound", "near": "wHQy97tn" } },
  { "add": { "screen": "BonusRound", "kind": "card", "text": "BONUS ROUND" } },
  { "add": { "screen": "BonusRound", "kind": "button", "text": "GO!", "at": "center", "name": "GoBtn" } },
  { "set_text": { "id": "TMKkAD33", "text": "YOU WIN!" } },
  { "connect": { "from": "GoBtn", "to": "Title", "label": "done" } },
  { "delete": { "id": "SJ3rUgrH" } }
]
```

```
claw apply design/ui.tldr ops.json      # or --dry-run to preview the report
claw new design/flow.tldr spec.json     # same vocabulary on an empty canvas
```

`claw ops` prints the full reference (`add_screen`, `add` with kinds `card|button|label|note|box|image`, `set_text`, `style`, `move`, `resize`, `connect`, `rename`, `delete`). References accept ids, short ids, frame names, label text, or `name`s given earlier in the same batch.

**Real visuals — images and SVG.** `{"add": {"kind": "image", ...}}` places an image shape: pass `svg` with inline SVG markup (generate mockup art directly — no file needed), or `src` with a path to a png/jpg/gif/webp/svg file (resolved relative to the ops file). Size comes from `size`, else the SVG viewBox, else the image's own pixels. Use this when a flow diagram or mockup needs visual fidelity beyond boxes and labels — e.g. one SVG mock per screen inside its frame.

Rules:

- **Render after writing** and look at the result — placement is spatial and the report can't confirm it looks right.
- `add_screen` creates real named frames — canvases you author are *more* structured than hand-drawn ones (no inference needed on them).
- **`connect` from the triggering control, not the screen**, whenever you know which button/row causes a transition — that's semantic information only you have at authoring time, and `flows` carries it through to whoever syncs the code. Layout decides all arrow geometry; endpoints are your only routing decision.
- **Look before you write** if the user may have edited recently — `outline` (or a diff against the accepted copy, if the project keeps one) shows what changed; warn rather than write over fresh edits.
- In sync-workflow projects, refresh the accepted copy after acting (see *Syncing a canvas to code*).

## Setup

One-time per machine: `npm install` in the `cli/` directory (small — sync server + ws only; no browser or binary downloads). The editor page bundle ships prebuilt in `cli/page/dist/`, and the desktop app ships prebuilt in `app/dist/claw/`. Node.js must be installed — the app runs the core with it.

## Reference

- `reference/format-notes.md` — the `.tldr` format's sharp edges, and what this tool deliberately doesn't do
- `reference/conventions.md` — labelling conventions that make a drawing machine-readable
