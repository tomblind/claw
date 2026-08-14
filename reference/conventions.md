# Drawing conventions

Conventions that let a hand-drawn canvas be read as a UI spec without guesswork. These are
suggestions to offer the user, not requirements — the CLI works on any `.tldr`. Adopting them
mostly removes ambiguity about *intent*, which is the part no amount of parsing can recover.

## Frames are screens and components

Name every frame that means something. The name is the only durable handle — ids are random and
positions change.

```
LoginScreen          → a screen/route
LoginScreen/Header   → or just nest a frame named "Header" inside it
```

Nesting is containment. An unnamed frame reads as incidental grouping.

## Say what a shape *is*, not just what it looks like

A rectangle with the text "Sign in" could be a button, a heading, or a text field. Prefix the label
to remove the ambiguity:

```
[Button] Sign in
[Input] Email address
[Label] Welcome back
[Image] hero
[List] Recent files
```

The alternative, if the user doesn't want prefixes rendered in their mockup: tldraw stores arbitrary
metadata per shape in `shape.meta`, and tldraw's own agent starter kit uses `meta.note` for exactly
this purpose. That keeps the canvas clean but needs a way to author it, which the VS Code extension
doesn't provide — so visible prefixes are the pragmatic choice today.

## Arrows must be snapped

**The most important convention.** An arrow between two frames means a transition or dependency —
but only if its endpoints are *attached* to those frames. Drag each endpoint until the target
highlights.

An unsnapped arrow looks identical in the picture and carries no data. `flows` reports these
separately, and the correct response is to ask the user, not to infer from position.

Label arrows with the trigger:

```
LoginScreen --"submit"--> HomeScreen
LoginScreen --"forgot password"--> ResetScreen
```

## Keep one flow per page

tldraw pages are cheap. One page per feature or flow keeps `outline` output small and makes `render`
legible. A single page with forty frames renders to something no one can read.

## What survives and what doesn't

| Reliably readable | Not readable |
|---|---|
| Frame names and nesting | Freehand drawings (`draw` shapes) as meaning |
| Text labels on shapes | Colour as semantics, unless stated |
| Snapped arrows and their labels | Visual grouping by proximity alone |
| Position and size | Which of two overlapping shapes is "on top" as intent |
| Geo shape kind (rect, ellipse, …) | Anything conveyed only by style |

If something matters, write it as text. A note shape explaining intent is worth more than any
amount of visual convention.
