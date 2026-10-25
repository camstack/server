---
id: D923
title: A camera-recorded clip carries our detections, joined by its provider with the one overlap rule
status: accepted
date: 2026-10-23
applies-to:
  - packages/types/src/clips/clip-event-labels.ts
  - packages/addon-pipeline/src/recorder/addon/videoclip-visits.ts
  - packages/addon-provider-hikvision/src/addon.ts
  - packages/addon-provider-reolink/src/addon.ts
  - packages/addon-provider-amcrest/src/addon.ts
---

## Context

A clip's `labels` (person, vehicle, …) came from CamStack's object events only
on the recorder's own visits: `visitsToClips` attaches every event whose
padded window crosses the visit and ranks the classes. A clip the CAMERA
recorded — Hikvision, Reolink or Amcrest onboard storage, listed by the device
provider (D549) — carried only what its firmware said. On 1439 (Hikvision)
the operator saw a person in our events and nothing on the camera's clip of
the same minute.

D569 made a camera's clip source exclusive: one source on screen, never a
merge of two clip LISTS, and "they must have no connection". Labels are not a
second list: the rows stay the camera's, and only their annotation reads our
detections.

Two places could do the join:

1. **The `videoclips` cap mount** (`device-collection-dispatch.ts`), once for
   every provider. Rejected: a cap mount routes; it never composes addon
   output with other state (root `AGENTS.md`), and it would make the server
   reach `pipelineAnalytics` on every `listClips` of every source — the
   recorder's own visits included, which already carry labels.
2. **The provider**, each through its own `ctx.api`. Chosen. The provider owns
   its rows (D224) and addons reach each other only through `ctx.api`.

A copy of the overlap rule in each provider was the failure to avoid: three
native providers and the recorder attaching by four slightly different rules.

## Decision

**The overlap rule and the label ranking live once, in `@camstack/types`**
(`eventOverlapsClipWindow`, `dominantClipLabels`), and the recorder's visits
use them. **A native clip provider registers its `videoclips` provider through
`withClipEventLabels(provider, clipEventLabelDepsFromApi(ctx.api, ctx.logger))`**:
every listing reads our slim object events across the padded span of the
clips it answered (the canonical `EVENT_PAD_MS`) and joins them at READ time.

The source's own labels come first, ours follow when it did not say them,
capped at `MAX_CLIP_LABELS`; `nativeTypes` stays the firmware's lossless copy.
A clip nothing overlapped is returned untouched. A failed event read changes
nothing (D49): the clips go out as the source listed them and a warning,
tagged with `deviceId`, says so.

## Consequences

- One `getObjectEvents` read per native listing, bounded at 5 000 rows; a
  truncated read is logged.
- HKSV clips (`addon-export-hap`) are not wrapped: they are recordings of OUR
  stream made by HomeKit, and joining them is a separate question.
- Each native provider addon must be redeployed for its clips to carry labels;
  the helper travels inside the addon bundle (bare `@camstack/types`, D15).

## Enforcement

`packages/types/src/clips/__tests__/clip-event-labels.spec.ts` (the rule, the
merge, the failed read), and a wiring spec in each of the three provider
addons that fails when the registration is not wrapped.
