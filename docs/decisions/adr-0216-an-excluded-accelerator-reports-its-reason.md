---
id: D216
title: An excluded accelerator REPORTS its reason — the view carries the dispatcher's own verdict, never a UI re-derivation
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/inference-device-model.ts
  - packages/addon-admin-ui/src/components/pipeline/node-load-model.ts
---

## Context

`resolveInferenceDeviceEligibility` already computed WHY each of a node's
inference devices is not a camera-root candidate — `disabled`, `unavailable`,
`cannot-host-camera-root`, `accelerator-preferred` (D215). That verdict went to
a log line and nowhere else. The operator-facing read,
`getNodeInferenceDevices`, returned only `enabled` / `available` / `weight`.

The obvious shortcut — let the admin UI infer the reason from the row — is
wrong, and wrong in the direction that hides the interesting cases. Two of the
four reasons are not visible in the row at all:

- **`accelerator-preferred` is a NODE-WIDE rule.** After D215 a CPU stored
  `enabled: true` with a live probe reporting `available: true` still never
  receives a session, because an accelerator is serving. A UI reading that row
  would render "enabled, available" and the operator would keep asking why the
  CPU shows zero work. This is exactly the question D215 was written to answer.
- **`cannot-host-camera-root` needs the node's model catalog**, which the UI
  does not have and should not fetch to second-guess a decision already made.

And a re-derivation is a second implementation of a placement rule. The moment
the two disagree, the screen is lying about the balancer.

## Decision

The reason list is a CAP CONTRACT: `INFERENCE_DEVICE_EXCLUSION_REASONS` lives in
`@camstack/types`, `getNodeInferenceDevices` carries `exclusion` (the reason, or
`null` for a candidate) on every device, and the value is produced by the SAME
`resolveInferenceDeviceEligibility` the dispatcher runs — transported by the
pure `annotateInferenceDeviceExclusions`, never recomputed. The orchestrator's
`InferenceDeviceExclusionReason` derives from the tuple rather than restating
it. A surface that shows a node's accelerators shows every one of them, with the
reason when it is excluded; hiding an excluded device is forbidden, because an
accelerator that silently vanishes from the candidate set is indistinguishable
from one that was never configured.

## Consequences

- A new exclusion reason is a cap-schema change (`npm run codegen`), not a local
  union edit — deliberate friction, since it is now rendered.
- `getNodeInferenceDevices` now also reads the node's model catalog to build the
  root-capability guard. It stays read-only: unlike
  `resolveEligibleInferenceDevices`, it does NOT record node usability, so
  opening an admin page can never move placement state.
- The hub does not need re-releasing for the field to appear: the kernel cap
  router deliberately omits `.output(schema)` (`cap-router-builder.ts`,
  2026-07-11), so a redeployed addon's extra field passes through verbatim.
- Because the reason is now the answer to "why is my accelerator idle", the
  query is cached on a long `staleTime` and its writes MUST invalidate it. The
  two `setAgentInferenceDevices` invalidations used a flat query key that could
  never match tRPC's nested key; that was a no-op masked by polling, and is
  fixed.

## Enforcement

`packages/addon-pipeline-orchestrator/src/__tests__/inference-device-exclusion-view.spec.ts`
pins all four reasons through the annotation, including the two a UI could not
derive, and `node-inference-devices-cap.spec.ts` asserts the field on the cap
output itself. The UI side is pinned by
`packages/addon-admin-ui/src/components/pipeline/__tests__/node-load-model.spec.ts`
("keeps an excluded accelerator visible, out of the share, and carrying its
reason"). No guard script — review only for the "do not hide an excluded
device" half of the rule.
