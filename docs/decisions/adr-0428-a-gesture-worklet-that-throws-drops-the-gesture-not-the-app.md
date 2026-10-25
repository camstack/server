---
id: D428
title: A gesture worklet that throws drops the gesture, not the app
status: accepted
date: 2026-09-10
applies-to:
  - camstack/src/lib/worklet-guard.ts
last-verified: 2026-09-10
---

## Context

Three TestFlight reports arrived from the operator on build 1.0.454 (16),
iPhone16,2 / iOS 26.5.2, labelled by the operator with what he was doing:

- **"Joystick"** (2026-09-10 09:16:01) — `EXC_CRASH (SIGABRT)`. The stack is
  unambiguous: `RNGestureHandler sendEvent` → `RNGestureHandlerManager
  sendEventForReanimated` → `REANodesManager dispatchEvent` →
  `reanimated::UIEventHandler::process` → `worklets::runSyncOnRuntime` →
  `hermesvm … throwPendingError` → `__cxa_throw` → `abort`.
- **"Boooh"** (09:13:52) — `SIGSEGV`, `KERN_INVALID_ADDRESS` with a
  pointer-authentication failure, in `Scheduler::uiManagerDidDispatchCommand`.
- **"Zoom"** (2026-09-08 20:31) — `SIGSEGV` at `0x11` inside
  `worklets::JSIWorkletsModuleProxy::toOptimizedObject`.

The first is the shape that matters: **a JS exception inside a worklet running
synchronously on the UI runtime is not an error, it is a terminated process.**
There is no JS frame above it, so nothing can catch it and Hermes aborts.

Ruled out by inspection before writing anything, so this is not a guess at a
cause: the versions agree (reanimated 4.5.0 / worklets 0.10.0 /
gesture-handler 2.32.0 — reanimated 4.5 wants worklets 0.10); the joystick's
maths helpers ARE workletized (`joystickVector`, `joystickThumbPosition` both
carry `'worklet'`); and both call sites pass `onVector` and `onRelease`, so
`runOnJS(undefined)` is not it.

What could not be established is **which line throws**. The native crash log
does not carry the JS message — Hermes does not put it there — and the app dies
before its own logger can ship anything, so the hub has no `app:error` for
either crash. Twelve hours of hub logs plus three full crash reports cannot
name it. The nearest neighbours in the hub log are ordinary: a snapshot 404 on
4374 six seconds earlier, and an indicator/stream divergence.

Guessing the throwing line and "fixing" it would have been the third guess of
one morning — the D426 zone-refusal regression and the dreame audio-grace
hypothesis were both plausible stories that measurement destroyed.

## Decision

**Every gesture worklet body is wrapped in `guardWorklet(scope, body)`.** The
wrapper catches inside the worklet, stringifies the throw there (an `Error`
instance does not survive the hop to the JS thread, and a non-`Error` throw
must not throw in turn), and reports it through the normal log path as
`app:error:worklet:<scope>` — the same channel that already reaches the hub.

The gesture is then dropped. A dropped gesture is a missed swipe; an uncaught
one is a terminated app, and the operator loses the session — including, on
2026-09-10, the live stream whose relay teardown was being measured for an
unrelated investigation.

Reports are throttled per guard (first few always, then one per window). A
gesture worklet runs on every frame of a passage, so an error that repeats is
an unbounded emitter — the identical shape that made 1473 events out of one
stationary parcel in [D426](adr-0426-a-refused-detection-is-observed-never-alerted-on.md).

## Consequences

- The crash class stops being fatal at the joystick and the zoom, which is
  where the operator actually met it.
- The next occurrence arrives **with its message attached**, on the hub,
  attributed to a named surface (`joystick.update`, `zoom.pinch.update`). That
  is what closes the investigation; this record does not claim to.
- It is a containment, not a cure. The underlying throw is still there, and the
  two `SIGSEGV` reports are a different animal — a native fault in the worklets
  runtime and in the renderer's command dispatch — which a JS-level guard
  cannot catch. If they recur without a matching `app:error`, they are native
  and need a different instrument.
