---
id: D552
title: A device-scoped wrapper mount dispatches only the methods that NAME a device; the rest resolve the cap's system provider
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/types/src/capabilities/capability-definition.ts
  - packages/types/src/capabilities/cap-router-predicates.ts
  - packages/system/src/kernel/cap-router-builder.ts
  - server/backend/src/api/trpc/cap-router-runtime.ts
  - scripts/generate-cap-mounts.ts
  - scripts/check-device-scoped-wrapper-mounts.ts
---

## Context

`resolveCapMount` derived `{ kind: 'singleton' }` for every `scope: 'device'` +
`kind: 'wrapper'` capability, so the tRPC router served `getSingleton(cap)` —
`state.activeAddonId`, the same provider for every camera.
`deviceManager.setWrapperActive` persisted, `getBindings` reported the binding,
and the route ignored it. Silently. That is the [D62](adr-0062.md) shape and it
is why [D549](adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
decision 3 makes the fix the gate on every later slice of the
external-videoclips line. The fix itself was already settled by
`docs/design/2026-08-17-videoclips-implementation.md` § 2 (M1–M6): a DERIVED
`device-scoped` mount kind, not a per-cap `mount:` hint — a hint on `videoclips`
alone would leave the next such cap broken by default.

What the design did not know, because it was written from reading, is **how
many caps that derivation moves and what it would break**. Measured on the
live defs: not two caps but **eight** — `audio-analysis`,
`camera-pipeline-config`, `camera-streams`, `detection-pipeline`,
`motion-detection`, `pipeline-analytics`, `scene-monitor`, `videoclips` — and
among their methods **39 carry no `deviceId` at all**: `pipeline-analytics`
alone has 37 (`listRecentTracks({deviceIds})`, `getEventStoreFootprint()`,
`cancelRelocateMedia({jobId})`, the whole storage-migration and retrain
surface), plus `scene-monitor.listScenesBatch({deviceIds})` and
`motion-detection.reset()`. The per-device dispatcher (`requireDeviceScoped`)
demands a numeric `deviceId` on EVERY call and answers BAD_REQUEST without one,
so the derivation as written would have made all 39 unreachable — a flip from
"one knob does nothing" to "37 working methods 400", which is worse than the
defect being fixed.

Three ways out were real:

1. **Mark the 39 methods `systemOnly: true`.** The explicit vocabulary already
   exists (`systemMethod()`, used by `snapshot.getSnapshotOverview`). Rejected:
   it is 39 cap-def edits in a slice whose whole content is the mount, and
   `systemOnly` is not only a routing flag — it also makes a method optional on
   `InferNativeProvider` and changes what `device-cap-proxy.ts` does with it. A
   type-surface change to three caps, to express a fact their input schemas
   already state.
2. **Opt each cap into the new mount by hand.** Rejected for the reason the
   design gives: it is a per-cap hint wearing a derived kind's clothes, and the
   next device-scoped wrapper is born broken.
3. **Decide per METHOD, structurally** — the one taken.

## Decision

A `scope: 'device'` + `kind: 'wrapper'` cap with no explicit `mount:` resolves
to the **`device-scoped`** mount kind, and the runtime serves it through the
SAME dispatcher `device-native` uses (`requireDeviceScoped` → native first,
then the D13 `getProviderForDevice`, which falls back to the global active
singleton for a device with no binding). Per METHOD, the cap's mount applies
only when the method's input declares a top-level **required numeric
`deviceId`** (`objectInputDeclaresRequiredDeviceId`, Zod introspection, never a
name heuristic over source text); every other method resolves through the cap's
system/wrapper provider — the same destination `systemOnly` names explicitly,
and the one it already had before the mount moved. The rule applies to
`device-scoped` only: on `device-native` a deviceId-less method is a definition
error whose fix is `systemMethod()`, and `snapshot` shows it being fixed that
way.

## Consequences

- Per-device bindings take effect for eight caps, not one. For a device with no
  binding nothing changes: `resolveForDevice` returns the global active
  provider, which is what `getSingleton` returned. For a device WITH a binding
  the operator's choice is finally honoured — that is the fix, and it is a
  routing change on live caps (`camera-streams`, `detection-pipeline`,
  `pipeline-analytics`), not only on `videoclips`.
- The remote-proxy fallthrough is gone for those caps' per-device methods:
  `requireDeviceScoped` returns a Proxy that is never null, so a call that
  resolves nothing now fails `PRECONDITION_FAILED "not registered for
  device N"` instead of falling through to `remoteProxy(cap, 'hub')`. Accepted
  knowingly (design § 2.3): the hub's root registry holds a proxy provider for
  every forked child's caps (the D3 `registerNode` handshake registers one), so
  the fallthrough was a boot-window path whose other end is a Moleculer
  discovery timeout. The named per-device error is the better answer.
- A method that grows a `deviceId` later silently BECOMES per-device. That is
  the intent — the schema is the declaration — but it means an input change on
  a device-scoped wrapper cap is a routing change, and the cap-router spec is
  where that is noticed.
- `scripts/generate-cap-mounts.ts` now branches on `resolveCapMount` instead of
  re-deriving from `deviceNative`/`mode`, so the type-only file and the runtime
  builder can no longer classify a cap differently. One exception is preserved
  deliberately: a cap declaring `mount: { kind: 'skip' }` keeps its old
  mode-derived line, because the builder never mounts it and this file's value
  is never called — four inert lines (`log-channels`, `login-method`,
  `load-contribution`, `failure-contribution`) that would otherwise have
  changed shape inside a slice that is about the mount.
- Ships on the framework train (`@camstack/types` + `@camstack/system`); no
  method signature changed, so no SDK regeneration and no viewer release.

## Enforcement

- `scripts/check-device-scoped-wrapper-mounts.ts`, in CI's guard list: a
  device-scoped wrapper resolving to `singleton`, a `cap-router-runtime.ts`
  without `case 'device-scoped'`, or a generated mount still reading
  `getSingleton` for such a cap, each fail the build. Proven red by reverting
  each of the three.
- `server/backend/src/__tests__/cap-routers/videoclips-two-provider-dispatch.spec.ts`
  — two providers, one binding, the real registry and the real
  `createCapRouterServices`: the bound camera gets the second provider, the
  unbound one keeps the first, `getClipPlayback` dispatches the same way.
- `packages/system/src/kernel/__tests__/cap-router-builder.spec.ts` pins the
  per-method rule in both directions: `videoclips.listClips` resolves
  `device-scoped`, `pipelineAnalytics.listRecentTracks` resolves `singleton`.
- `packages/types/src/__tests__/device-scoped-wrapper-mount.spec.ts` pins the
  derivation and its three escape hatches (`deviceNative`, an explicit `mount`,
  system scope).
