---
id: D345
title: A migration is bounded, idempotent, and disturbs only its two devices
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/migrate-device.ts
  - packages/system/src/builtins/device-manager/migrate-guard.ts
  - packages/system/src/builtins/device-manager/migrate-reload.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/types/src/device/base-device-provider.ts
---

## Context

D339's migration is correct and proved itself live on 2026-09-01 (camera
3836 ↔ 614) — and the same run measured what it costs: ~3.5 minutes, of which
under one second is real work, plus a blast radius nobody asked for. Four
defects, one incident:

- **The `stream-broker` switch burned ~60 s per phase — by dialling
  ourselves.** Its authority is `deviceManager.setDisabled` (D62), and the
  migration reached it through `pipelineOrchestrator.setCameraSwitch`: out
  over UDS to the orchestrator, back over UDS into hub-main, onto the SAME
  non-reentrant meta write lock the migration holds for its whole run. A
  self-deadlock, resolved only by the transport's 60 s default — three
  phases, three minutes, regardless of camera health (the up-phase burned its
  60 s on the healthy NEW camera). Worse: the timed-out handler was still
  parked on the FIFO lock and its write GHOST-LANDED after the swap, against
  whichever hardware then wore the number. The `unreachable` it reported was
  a lie twice over.
- **The cap declared no `timeoutMs`**, so the forward used the 60 s default
  against a minutes-long handler. The client died with
  `UND_ERR_HEADERS_TIMEOUT`, something retried, and a second full cycle ran:
  two swaps cancel out ("nothing happened", no error), and with different
  timing two live cameras keep each other's identity with no way to tell.
- **The flush was a whole-provider restart, run sequentially per owner**
  (62 s of pure serialization). Migrating one camera between two providers
  restarted `provider-reolink` (28 devices) and `provider-amcrest` (1); the
  same morning ~27 devices' native caps failed to return after a provider
  restart until the operator restarted both providers by hand, twice. The
  restart's own defence — every in-memory `id → addon` map must be flushed,
  and never by a droppable event (D8) — is sound about the REQUIREMENT and
  says nothing about the RADIUS.

## Decision

**Bounded.** Every forwarded switch write races a 15 s bound
(`SWITCH_WRITE_TIMEOUT_MS`); a write that outlives it is reported
`unreachable` — NEVER folded into `off`/`on`, even if it lands late (every
switch authority is idempotent under a duplicate write). The `stream-broker`
switch never crosses the api at all: the migration wiring writes the
`disabled` flag in-process under the lock it already holds
(`writeDisabledFlagUnderLock` + the same transition-gated events), so its
outcome is honestly `off`/`on` and nothing ghost-lands. The cap declares
`timeoutMs: 12 * 60_000`, kept above the worst-case sum for the same reason
`applyServerUpdate` declares 16 min.

**Idempotent.** `migrate-guard.ts`: a second call touching either device
while a migration is in flight is REFUSED before it can queue on the FIFO
lock — never parked, never silently run after. A repeat of a COMPLETED swap
is a no-op returning the original report, matched on the
`addonId`/`stableId` fingerprint the swap left on both rows, within a 15 min
window. The window separates an automated retry (arrives inside the
transport-timeout envelope) from an operator deliberately re-swapping later;
the row fingerprint makes the replay refuse the moment anything else has
touched either device. A replay flushes nothing — the rows did not move.

**Two devices, nothing else.** The flush is per-device
(`migrate-reload.ts`): `deviceProvider.reloadDevice({ stableId })` at each
owning runner — an RPC, never an event — decommissions the ONE live instance
and re-creates it from the persisted rows, the same teardown/rehydrate pair
graceful shutdown + boot restore already use (`BaseDeviceProvider`
implements it once; first-class children come back via the restore's pass 2,
accessory children via `getAccessoryChildren()`). The hub patches its own
id-keyed state for exactly the two numbers: `idToAddonId` (what
`resolveDeviceOwnerSync` answers from — stale until provider re-registration
in the restart era), the push-fed `remoteNativeCaps` cache, and hub-local
native-cap registrations. It runs AFTER the migration's lock section by
necessity — the reload dials back into `allocateDeviceId`/`registerDevice`,
which take the same lock — and the in-flight guard spans it. The whole-addon
restart survives only as the per-addon FALLBACK when a reload fails
(provider unreachable, or a deployed closure too old to serve
`reloadDevice`), still logging `devicesTakenDown`.

## Consequences

- A healthy migration is seconds of work plus two concurrent per-device
  reloads; a dead source costs at most 15 s per camera-plane switch write,
  not 60 s per phase. No unrelated camera on either provider is interrupted.
- The outgoing box (the target number) now genuinely ends switched OFF —
  before this, the disable never landed during the run and a ghost
  `setDisabled` briefly disabled the NEW camera after the swap.
- The guard is in-memory by design: the retry that matters reaches the same
  hub process; a hub restart empties the guard AND kills every client call
  that could still be retrying against it. A deliberate swap-back of the
  same pair within 15 min is absorbed as a replay (logged loudly).
- The handshake-fed `HubNodeRegistry` fallback can serve a stale native-cap
  entry for a migrated id until the next re-handshake — the same transient
  every worker-restart window has always had, now smaller.
- Known residual dishonesty, out of scope here: the orchestrator's refusal
  for an unavailable switch says "not available", which `classify()` maps to
  `not-offered` even when the reason was `source-unreachable` — a dead
  camera's camera-plane switches can escape `sourceStillLive`.
- All of it is framework-tier (`@camstack/types` + `@camstack/system`): live
  only via a `@camstack/server` release, not via any `camstack deploy`.
  Against an older runner the reload RPC fails and the fallback restart
  preserves the old guarantee.

## Enforcement

`migrate-device.spec.ts` pins the bound (a write resolving after the bound is
`unreachable`, never `off`). `migrate-device-wiring.spec.ts` pins that no
`stream-broker` write crosses the api (with real transitions and final flag
state), that exactly the two migrated identities are reloaded — a bystander
on the same provider and any restart fail the test — that the owner map
answers post-swap immediately, that the fallback restarts only the affected
addon (concurrently, with the blast-radius line), that a mid-flight duplicate
is refused, and that a completed-swap repeat re-runs nothing.
`base-device-provider-reload.spec.ts` pins the runner side (one decommission,
re-create under the row's current id, pass-2 children, accessory refusal).
`migrate-guard.spec.ts` pins the overlap/fingerprint/window rules. Each was
proven RED against its reverted fix.
