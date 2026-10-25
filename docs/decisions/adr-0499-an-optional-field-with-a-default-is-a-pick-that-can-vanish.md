---
id: D499
title: An OPTIONAL field with a declared default is an operator pick that can vanish
status: proposed
date: 2026-09-15
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/types/src/capabilities/pipeline-runner.cap.ts
---

## Context

The operator picked `['onboard']` as the root detector for the Baby monitor and
said, twice, that it was on. The runner disagreed, in writing, three times:

```
[Baby monitor] camera registered: root detectors
  {detectionSources=["pipeline"] runsPipeline=true runsOnboard=false}
```

Both were right. The store held `['onboard']`, `resolveDeviceDetectionSettings`
read it correctly, and `CameraDetectionConfig.detectionSources` carried it all
the way to the session attach — where the literal in
`dispatchDetectionSession` simply did not mention the field. It is OPTIONAL on
`RunnerCameraConfig`, so TypeScript said nothing, and the transport's
`withCapInputDefaults` then merged the cap's declared default `['pipeline']`
into the payload before the runner saw it.

The tell was in a log line nobody had read closely: `attachCamera received
config` lists the payload's keys in order, and `detectionSources` appeared
AFTER `frameSource` and `nodeId` — appended by the default merge, not present
in the object.

It only ever affected ON-MOTION cameras. The always-on branch builds its config
through `buildRunnerConfig`, which carries the field, so the feature worked
whenever it was tested on an always-on camera and was inert on most of the
fleet. The runner-side fix that shipped the day before
(`detectionSources never reached registerCamera`) was real and was not this:
its test feeds the field straight into `registerCamera`, so the suite stayed
green while the orchestrator literal that produces the value had no coverage at
all.

## Decision

A field that carries an operator's CHOICE is set explicitly at every site that
builds the payload, and is covered by a test that asserts it arrives — not that
it merely equals the default afterwards. `dispatchDetectionSession` and
`ensureMotionWatch` now both set `detectionSources`.

The general rule this records: **`optional` plus a declared default is not a
safe combination for a pick.** Optionality means "a caller may omit it", the
default means "an omission becomes this value", and together they convert a
forgotten line into a deliberate-looking choice, silently, at the far end of a
transport. Absence must mean UNKNOWN, and where a default is unavoidable, the
test that matters asserts the key is PRESENT (`Object.hasOwn`), because an
absent key is exactly what the merge eats.

## Consequences

- Onboard detection becomes reachable on on-motion cameras for the first time.
  There is a second, independent blocker on the provider side — the Reolink
  forwarding flag (`nativeObjectDetection.getStatus.enabled`) reads `false` on
  all seven Reolink cameras, and the runner's bus gate only sees pushes the
  provider forwards — so this fix alone does not produce a single onboard
  detection. The two authorities (the orchestrator's `detectionSources` and the
  vendor flag) can drift, and nothing reconciles them today.
- The same trap exists for every other optional field on `RunnerCameraConfig`
  with a `.default()` in the cap. This record does not audit them; it names the
  shape so the next one is recognisable.
- The UI renders `detectionSources` TWICE — once from
  `RunnerCameraDeviceUIFields` and once from the orchestrator's contribution.
  Same writer and same value, so not a cause here, but a duplicate control.

## Enforcement

`session-dispatch-detection-sources.spec.ts` drives `handleSessionMotion` and
asserts the attach payload carries `['onboard']`, `['pipeline','onboard']` and
`['pipeline']`, plus that the key is present via `Object.hasOwn` — verified to
fail on all four when the line is removed. Nothing guards the other optional
fields; that is review only.
