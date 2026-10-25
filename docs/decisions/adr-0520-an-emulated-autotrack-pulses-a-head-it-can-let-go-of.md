---
id: D520
title: An emulated autotrack pulses a head it can LET GO of, and is one implementation behind the autotrack switch — never a second switch
status: accepted
date: 2026-09-17
supersedes:
applies-to:
  - packages/system/src/builtins/autotrack/**
---

## Context

Several cameras on this fleet have a mechanical head and no firmware autotrack.
The operator wants them to follow a subject the way Reolink's native one does.
The pieces to try it already exist: `pipeline-analytics.frame-tracked` carries
tracked boxes with the frame they were measured in, and `ptz` can move a head.

What did NOT exist is any evidence that a loop built on those pieces is safe or
even possible, and two of its premises had never been measured.

**The input is telemetry, and telemetry may be dropped.** `frame-tracked` is an
event ([D8](adr-0008.md), [D11](adr-0011.md)); a hub-only subscriber is also
across a node boundary from the analytics runner. The obvious first design —
`continuousMove` when off-centre, `stop` when centred — puts the head's SAFETY
on the delivery of a second event. One dropped `stop` and the camera pans until
a person notices. That design was rejected before a line was written.

**Nobody has measured the hop.** The one latency figure in these docs (p90
381 ms, max 22 s) belongs to a DIFFERENT hop and reusing it would have been
inventing a number. The error a visual loop acts on is exactly this stale, so
the number decides whether the loop is viable at all.

**The safety premise is inferred, not measured.** The loop assumes every bbox on
`frame-tracked` is an OBSERVED detection and never a coasted `SortTracker`
prediction — otherwise it would chase a fabricated position with full
confidence. The assumption reads well from the code: `buildOverlayDetections`
(`addon-post-analysis/.../overlay-frame-builder.ts`) iterates the REAL frame
detections and attaches a track only to the associated ones, so a coasted track
contributes no box. But `matchedThisFrame` is not on the wire, so nothing can
confirm it from the payload, and a comment that describes the right design is
not verification.

**A per-camera function must not grow two switches.** [D62](adr-0062.md) was
paid for twice in this repo already: a knob that wrote a store nobody read.
`ptz-autotrack` (the native one) is the switch for "does this camera follow a
subject". An emulated implementation that shipped its own toggle would let an
operator set the two to disagree, with the camera's firmware and this loop both
driving one head.

Two things also turned out to be readable that had not been: `moveImpulseMs` on
`ptz.getOptions` (how long one `move` pulse runs — 200 reolink, 350 amcrest, 500
hikvision, 1000 onvif), and `goHome`, which now refuses honestly when nothing is
configured ([D522](adr-0522.md)).

## Decision

An emulated autotrack moves a head ONLY with a self-terminating `ptz.move`
pulse, never `continuousMove`; it refuses to move at all when it cannot read
`moveImpulseMs`, because that number is what proves the head stops without a
second message. It corrects only outside a central dead zone and STOPS
correcting at a tighter inner box, short of the centre. It is DECLAREDLY VISUAL:
`getPosition` is null on every PTZ driver on this fleet, so the loop never knows
where the head points and must never log, store or reason as if it did — the
only feedback it has is where the subject appears in the next frame. It holds
ONE target by `trackId` and never switches while that target lives. Its command
rate is a ceiling in commands per second owned by the loop, never derived from
the analysis rate. And when it becomes a feature, it is a second IMPLEMENTATION
behind the existing autotrack switch — `ptz-autotrack` — never a second switch
([D62](adr-0062.md), [D113](adr-0113.md)).

Until the two measurements exist — the real bus latency of `frame-tracked` at
the hub, and the run-length distribution of frames where the held track has no
box — the loop ships DISARMED, on a camera named by a constant, registering no
capability.

## Consequences

**What this costs.** A pulse is a worse actuator than continuous motion: the
head moves in discrete steps with a dead time after each, so tracking is coarser
than a firmware autotrack. That is accepted. The alternative buys smoothness
with a failure mode whose worst case is a camera spinning unattended.

**What it forbids.** `continuousMove` and `stop` in this loop, in any form. A
made-up pulse duration for a driver that does not report one. A second
autotrack switch. Deriving the command rate from `detectionFps` — at 10 Hz that
is ~10 commands/s, and a Reolink E1 Outdoor PoE was MEASURED rejecting commands
1.2 s apart with `response_code 400` and accepting them at 3 s
(`reolink-camera.ts`). Any claim about where the head is pointing.

**What must be true elsewhere.** `ptz` has no events, and `status.kind:
'command-driven'` is a documentation hint wired to nothing (verified in
`capability-definition.ts`: the only readers are `generate-cap-status-types.ts`
and `gen-api-reference.ts`, both of which print it). So this loop cannot hear an
operator driving the head by hand.

Adding `ptz.onCommanded` was considered for this slice and DEFERRED. Declaring
it costs codegen plus a framework publish, and — decisively — an event with no
emitter is worse than no event: a subscriber that never fires reads as "nobody
is driving this head", which is precisely the false assurance it would be added
to prevent. Every provider (reolink, hikvision, amcrest, onvif) plus the cap's
own mutation path would have to emit it first. It would also still be
insufficient: an operator driving the camera from the vendor app or an NVR
produces no CamStack event at all.

The consequence is therefore stated in code rather than papered over by a
half-built event: the camera is a CONSTANT, arming is an explicit edit, and the
addon logs a WARN at boot whenever it is armed, saying that this camera must not
be driven by anyone else. `ptz.onCommanded` becomes worth adding when the loop
becomes a feature with a UI — and then it lands together with its emitters, or
not at all.

**The premise is still a premise.** Nothing here proves boxes are never coasted.
The addon measures it: a gap run-length distribution that DECAYS is honest
misses; one that is flat-then-spikes at a single length is the tracker filling
gaps and giving up at its max age, and then this design is wrong and must be
redesigned around an explicitly-matched signal.

### MEASURED, 2026-09-18 — both numbers, on camera 1438 with a person walking

The operator walked in front of the camera while the loop was bound, switched on
and watching. One pass, 188 frames:

**1. Bus latency of `frame-tracked` at a hub-only subscriber.** Mean **17.9 ms**,
min 10, max 160. Buckets `[50,100,200,400,800,1600,3200]` counted
`[177,9,2,0,0,0,0,0]` — 177 frames under 50 ms, nothing above 200,
`negativeAgeFrames=0` (no clock skew between the analytics node and the hub).
This ADR reasoned around a FEAR that the hop might cost hundreds of ms; the only
number in the docs was p90 381 ms for a different hop. The real one is ~18 ms,
and a visual loop on that error is comfortably viable.

**2. The safety premise: are the boxes ever coasted predictions?**
`framesWithTarget=183, absentFrames=8 (4.4 %), maxGapFrames=3`, and the
distribution is `gapRunHistogram=[2,0,1,0,0,0,0,0,0]` — two gaps of one frame,
one of three, nothing else. DECAYING and ragged, which is the shape this ADR
named as honest misses. No spike at a single length, so the tracker is not
filling gaps and giving up at its max age. **The premise holds.**

**And the loop behaved as specified.** It acquired one target and never switched
(`selection=acquired` then `held`, one `trackId`), corrected only outside the
dead zone and kept correcting to the tighter settle box (`errorX=-0.421` → pulse
left; `-0.239` → still pulsing; `+0.313` → pulse right, the overshoot a pulse
actuator is expected to make), issued **8 pulses and 1 home**, zero command
failures, and released on silence (`selection=silence-released, action=home,
reason=target-gone`). `nativeAutotrack=absent` throughout — the camera has no
firmware autotrack, which is the case this exists for.

The consequence for the zoom/autotune work this ADR deferred: the input it would
have been built on blind is now measured, and both numbers are favourable.

## Enforcement

Unit tests on the pure decision function (`decideAutotrack`) pin every gate:
dead zone, inner-box stop, pulse dead time, commands-per-second ceiling,
`moveImpulseMs === null` refusal, native-autotrack refusal, disappear delay,
home-once. Each was verified by SABOTAGE — the gate removed, the run confirmed
red, the gate restored (17 sabotages, 17 red; one of them found a test that
asserted nothing and it was rewritten).

Nothing guards the wider rules. There is no check that a future emulated
autotrack stays behind `ptz-autotrack` rather than growing its own switch, and
no check that `continuousMove` stays out of this package. Both are review-only
today, and a guard is worth adding at the moment this stops being a measurement
slice — which is the moment it also gets a cap, a UI, and the ability to move
more than one camera.
