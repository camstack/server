---
id: D607
title: A surface has ONE answer to "what is open", and a dismiss is a layer, not a flag
status: accepted
date: 2026-09-22
applies-to:
  - camstack/src/grid/panel-dismiss.ts
---

## Context

Two operator reports on the grid toolbar, with one root each.

**The audio highlight was the odd control of three.** `HighlightTriggerRows`
drew motion as a switch, detection as a switch with its detail revealed
underneath, and audio as a FOUR-WAY picker between them. Three triggers, two
control shapes, the odd one in the middle.

**A tap on the grid did not dismiss an open panel.** The cell panel and the
share dialog each brought their own outside-tap; the control bar's popover had
NONE — and on iOS and web the wall is a WebView, so the tap went THROUGH it
and opened a camera. The popover's state lived inside the shared chrome, where
the page could not see it.

## Decision

**A surface has one answer to "what is open."** `grid/panel-dismiss.ts` holds
it, and every backdrop plus the body layer calls one `dismissPanels()`. A
fourth panel adds a field and is covered everywhere at once, instead of
arriving with its own rule that disagrees with the other three.

**The dismiss is a LAYER, mounted only while something is open** — above the
picture and below the chrome. So the dismissing tap cannot also act: while the
layer exists the press never reaches a tile, and with nothing open it is not
rendered, so tile press, long-press and pinch are byte-for-byte what they were.
That is structural rather than a flag, which is the point.

**Every trigger in a settings group is the same KIND of control.** Audio is a
switch with its level behind it — detection's shape, in the same row position.

## Consequences

- `FloatingControlBar` becomes fully controlled. Its private popover state was
  the reason the page could not see what was open.
- No storage migration: the store keeps `audio` + `audioDb` + `audioHoldSec`
  untouched. A stored `'level'` still reads as on at its rung, and can never
  become `'sensor'` because nothing writes that word — it is dead as a written
  value and survives only as a legacy READ.
- The timeline rail is deliberately not covered by the layer: it is a control
  surface, not the grid body.

## Enforcement

`panel-dismiss.spec.ts`, `grid-tap-dismiss.spec.ts` and
`grid-tap-dismisses-panels.spec.ts` pin the rule, the mount gate and the page
wiring; `highlight-audio-toggle.spec.ts` pins the control shape.

Two honesty notes kept deliberately. The screen spec's "with nothing open there
is NO layer" is a CONTROL, not a gate — it stays green under the disarm, and
says so. And **the drag rule is not asserted in any mount test**: react-native-web
resolves `onPressIn` at the position of the last pointer event, so in jsdom
every drag looks like a tap. That assertion was written, watched to pass for
the wrong reason, and deleted; the rule is gated where the endpoints are the
input, and the docblock says why it is not gated above.
