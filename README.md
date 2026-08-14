# Claw

Claw (Claude + draw) is a human+AI co-op canvas tool built on [tldraw](https://tldraw.dev).
`.tldr` files live in project repos; agents read, edit, render, and lay them
out through a CLI while humans edit the same canvas live in a desktop app,
a browser, or a phone — all views synced in real time.

## Structure

- `SKILL.md` — the agent-facing skill (Claude Code discovers this via
  `~/.claude/skills/claw`)
- `cli/` — the `claw` CLI + the canvas core (Node: HTTP API, tldraw sync
  rooms, ELK-powered layout) + the editor page bundle (`cli/page/`)
- `app/` — the Neutralino desktop app: window = the system; hosts the hidden
  executor (a real tldraw editor) that runs all agent document operations
- `reference/` — format notes and canvas-authoring conventions

## Setup (per machine)

```
npm run setup      # cli deps + `claw` on PATH
npm run build      # editor page bundle + desktop app binaries
npm run deploy     # install to the live skill location
```

Node.js >= 18 required. The app launches automatically on the first `claw`
command; closing its window stops everything. `claw --help` for commands.

## Development workflow

This repo is the source of truth. The live skill that Claude Code discovers
(and that the `claw` command runs) is an installed COPY at
`~/.claude/skills/claw`. After making changes here:

```
npm run deploy         # incremental mirror to the live skill location
```

Rebuild first when applicable (`npm run build:page` for editor/executor
changes; `npm run build:app` for shell changes), then deploy. If the deployed
core version changed, quit and relaunch the Claw app window. `npm run e2e`
runs the end-to-end suite. Never edit the deployed copy directly — it gets
overwritten on every deploy.

## Architecture in one paragraph

The desktop app owns a Node "core" (child process) that serves an HTTP API
for the CLI, multiplayer sync rooms for live canvases (fixed port 4227, LAN
visible for phones), and the editor page. Agent commands execute inside a
hidden tldraw editor in the app's own webview — parsing, migration, geometry
and rendering are always tldraw's own code. Writes stream through live rooms
(watchable in real time); layout is ELK layered with satellite packing and
channel-following edge routing.
