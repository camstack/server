---
id: D170
title: An on-motion audio window closes on quiet, never on a falling edge
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/audio-subscription-controller.ts
  - packages/addon-pipeline-orchestrator/src/orchestrator-subscriptions.ts
  - packages/addon-provider-reolink/src/email-push-shared.ts
---

## Context

`audioMode: 'on-motion'` exists for one camera: the battery one. A battery
Reolink cam (device 106, Argus 3E, sitting at 14%) cannot hold an audio
subscription open — the substream keeps the radio up and flattens the battery
in hours. So the operator picks `on-motion`, expecting audio to be analysed
only around a motion event.

The gate was wired and looked complete: `handleLazyAudioMotion` subscribed on
`MotionOnMotionChanged { detected: true }` and scheduled a teardown on
`detected: false`, after `motionCooldownMs`. It had a lock, an idempotent
rearm, and a doc comment explaining the rearm contract.

**The falling edge never arrives.** Camera-native motion is a RISING EDGE
ONLY. The Reolink driver emits `detected: true` at both of its emit sites —
the native Baichuan push AND the email-push SMTP path a sleeping battery cam
uses — and has no falling counterpart; the fall is owned by the runner's phase
machine. The only component that emits `detected: false` is the frame-diff
ANALYZER, and an onboard-only camera has no standing analyzer to emit it. So
on exactly the cameras `on-motion` was built for, the teardown branch was
unreachable: the first motion opened an audio subscription that stayed open
forever. `on-motion` silently behaved as `always-on` — which on a battery
camera is not a performance regression, it is a flat battery, i.e. the precise
outcome the mode exists to prevent.

Nothing caught this. The mode had tests, and they passed, because they drove
the falling edge the tests themselves supplied — a fake feeding the event
production never sends. The one honest signal was a stale doc comment two
methods away still describing the mode as a stub.

A second instance of the same shape sits on the email path: the lib's
classifier can return `doorbell`, and `handleSimpleEvent`'s `doorbell` branch
emits `DoorbellOnPressed` and returns — no motion. An email is the ONLY signal
a sleeping camera can send, so a doorbell-classified email was a wake that
reached no motion consumer at all.

## Decision

A motion-driven audio window is closed by a QUIET TIMER measured from the last
motion event (`audioMotionWindowMs`, default 90 s), rearmed by every motion
event without touching the live subscription. A falling edge is an
optimisation, never the mechanism: when one does arrive it may close the
window earlier via `motionCooldownMs`, and whichever fires first wins. The
open window is explicit per-device state, and it — not the mode alone — is
what authorises `subscribeAudioStream` to attach, so a reattach or rebalance
landing mid-window rebuilds the subscription instead of muting the camera
until the next motion.

Generally: **a gate driven by edge events from a device closes on a timer the
hub owns, never on an edge the device may never send.** Where a mapping fans a
device signal into internal events, every branch must reach the consumer the
mapping exists to feed — `mapInferredTypeToSimpleEvents` returns a LIST, and
`doorbell` returns `['doorbell', 'motion']`.

## Consequences

Audio on an `on-motion` camera now runs for a bounded, operator-visible period
after motion (default 90 s) rather than either forever or not at all. The cost
is that a camera whose motion stops mid-window keeps analysing audio for the
remainder of it — deliberate, because the alternative is a per-event
subscribe/teardown churn on the broker's decode session, and because the
window is the knob the operator tunes.

`audioMotionWindowMs` joins `maxSessionHoldMs` as an orchestrator-only field
carried on the runner cap for the shared per-camera settings surface; the
runner itself does not read it.

This does NOT make a battery camera's audio free. It makes it bounded. Whether
`on-motion` should become the battery profile's default `audioMode` (today:
`disabled`) is an operator choice, deliberately not taken here.

## Enforcement

`lazy-audio-motion-window.spec.ts`. Its load-bearing case advances fake timers
with NO falling edge ever supplied and asserts the subscription is gone —
neutralising the window arming turns 4 of its cases red. A companion case
drives the REAL `subscribeAudioStream` (not a stub) to prove the window
authorises the attach, so the mode cannot pass its own tests while being mute
in production. `email-push.spec.ts` asserts every classifier output yields at
least one event that is not `doorbell`.
