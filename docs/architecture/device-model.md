---
title: The device model
applies-to:
  - packages/types/src/device/**
  - packages/types/src/device-extension/**
  - packages/types/src/composition/**
  - packages/types/src/capabilities/group-status.cap.ts
  - packages/types/src/capabilities/motion.cap.ts
  - packages/system/src/builtins/composer/composition-runtime.ts
  - packages/system/src/builtins/composer/composed-device.ts
  - packages/system/src/builtins/composer/graft-host.ts
  - packages/system/src/builtins/composer/composer.addon.ts
  - packages/system/src/builtins/core-blocks/composition-api.ts
  - packages/system/src/builtins/core-blocks/composition-sources.ts
covers:
  - packages/addon-provider-*/**
  - packages/system/src/builtins/device-manager/removal-cleanup.ts
last-verified: 2026-10-26
---

# The device model

A device is an instance of a `BaseDevice` subclass, created by a provider addon.
It registers its own device-scoped capabilities and owns its configuration and its
cached state.

Key files: `packages/types/src/device/base-device.ts`,
`device-config.ts`, `device-runtime-state.ts`, `runtime-state-helpers.ts`.

`linked-device-resolve.ts` sits beside them and is a different concern: the
PURE rules for which devices a camera's linked set resolves to — same-location
membership, and a container standing in for its primary child. It lives in
`@camstack/types` rather than in the device-manager builtin because two
writers need the same answer (the hub's boot backfill and the admin UI's
per-room rebuild), and a second copy would be a second definition of what a
room contains.

## Three kinds of per-device state, and which to use

| | Where | For |
| --- | --- | --- |
| **Config** | `this.config` (`DeviceConfig`) | operator intent — credentials, name, options |
| **Runtime state** | `this.runtimeState` slices | cached, observable device state |
| **Nothing** | — | anything derivable on demand |

`DeviceConfig.setAll(partial)` **already merges**. Never write
`setAll({ ...manualSnapshot, ...patch })` — pass the patch alone. For a typed
snapshot read `this.config.values`.

## Runtime state is the per-device cache

A capability declaring `runtimeState: SomeSchema` gets a kernel-managed slice:
validated, persisted across restarts, observable. Providers **must not** keep
parallel `private cachedX` fields — read and write through
`this.runtimeState.{getCapState, setCapState, patchCapState}`.

The slice must include `lastFetchedAt: z.number()`. Convention:
`runtimeState = StatusSchema.extend({ lastFetchedAt: z.number() })`.

**A numeric reading is stored in the base unit of its quantity (D944 §4).**
The quantity and an optional display precision live on the declaration
(`.meta({ quantity, precision })`), not as `unit` / `precision` siblings on
the slice. A polymorphic reading (`numeric-sensor`, a numeric `control`)
stores the quantity once on `SourceInfo`. Providers convert on ingest; an
unknown unit is logged with `tags: { deviceId }` and published as null.
Display unit (°F, imperial) is a read-time preference and defaults to metric.
The control panel and an automation threshold show that display unit and
commit the base: the operator's number is converted once, on the write.
`formatReading` / `resolveSensorDisplay` are the only place a label is chosen.
Every device-native number declares a quantity, or `none` when it is
dimensionless. A second reading (Ecowitt battery voltage) is its own field
(`battery.volts`), not a companion sensor.

**One exception: a camera's `motion` slice (D696).** No camera provider writes
it, not even a boot seed. The orchestrator is its only writer, with the
EFFECTIVE motion (the camera's own motion combined with its attached sensors),
on the hub. So a camera provider's local `this.runtimeState` holds no `motion`
slice, and its `motion.isDetected` answers from the hub through
`readHubMotionDetected` (`packages/types/src/device/hub-motion-read.ts`). An
unreadable hub, or a slice nobody has published yet, makes the call fail: it
never answers `false`. A SENSOR device (HA binary sensor, Homematic, Matter,
Alexa import) still writes its own `motion` slice.

A device provider SAYS that it writes no camera's `motion` slice:
`deviceProvider.getStatus` answers `motionSliceWriter: 'orchestrator'`, set by
`BaseDeviceProvider.getStatus` (`packages/types/src/device/base-device-provider.ts`).
Every provider bundles that class (self-contained build), so only a provider
built from D696-amended code says it; absent means an older provider that may
still write. The orchestrator's per-camera provider gate reads it for the four
providers that wrote the slice before D696 (D696, "The provider gate").

## The provider trampoline

When a capability declares `runtimeState`, the provider is a thin trampoline over
it — not a set of methods that hit the device on every call:

```ts
import { createRuntimeStateBridge } from '@camstack/types'

private registerMyCap(): void {
  const refreshFromCamera = async (): Promise<void> => {
    // single-flight round-trip; then
    // runtimeState.setCapState(CAP_NAME, { ...status, lastFetchedAt: Date.now() })
  }

  const bridge = createRuntimeStateBridge({
    runtimeState: this.runtimeState,
    cap: myCapability,
    ownDeviceId: this.id,
    refresh: refreshFromCamera,
    staleMs: 10_000,
    empty: (): MyStatus => ({ /* cold-start defaults */ }),
  })

  const provider: InferNativeProvider<typeof myCapability> = {
    getStatus: bridge.getStatus,
    getSettings: async ({ deviceId }) => {
      if (deviceId !== this.id) return null
      await bridge.ensureFresh()
      return this.runtimeState.getCapState<MyRuntimeState>(CAP_NAME)?.settings ?? null
    },
    setEnabled: async ({ enabled }) => {
      await this.client.setX(enabled)
      await refreshFromCamera()
    },
  }
  this.ctx.registerNativeCap(myCapability, provider)
}
```

Do **not**: keep cache fields on the device class; persist cold-start fallbacks
into the config blob; implement `getStatus` as a fresh fetch every call.

## DeviceProxy

`createDeviceProxy(api, binding, opts?)` returns a typed facade. The second
argument is the `DeviceBinding`, not a bare id: the proxy injects `binding.deviceId`
— and the pinned `nodeId` where the cap takes one — into every call, so it works
identically for a cluster-global, hub-resident or forked provider. The facade
itself is generated (`packages/types/src/generated/device-proxy.ts`) — regenerate
after touching a capability.

## Reading state from the client side

`SliceHandle.value` is **undefined on cold start** for a lazily-fetched tRPC
source. It is populated by `refresh()` or `subscribe()`.

There are three sources behind the same handle shape
(`packages/types/src/device/device-state-handle.ts`):

- `createLazyTrpcSource` is the default for **browser / SDK** clients
  (`refresh()` round-trips through `deviceState.getCapSlice`, subscribe via
  `live.onEvent`).
- `createEventBusSliceSource` is what a **forked addon child** must use
  (`ctx.eventBus.subscribe({ category: 'device.state-changed' })`). That
  subscribe is what fills `RegisterMessage.eventPatterns`. `live.onEvent` is
  a hub-main tRPC subscription and never declares UDS interest, so a zone
  edit sat invisible to analytics for 30 s (device 102, 2026-07-16) until the
  reconcile timer ran. See [D232](../decisions/adr-0232-a-forked-deviceproxy-listens-on-the-event-bus.md).
- `createMirrorSource` — passed in by a `SystemManager` via `opts.stateSource`
  so every proxy shares one map — is push-only and its `refresh()` is a
  **no-op**. A cold read there is answered by the warm-boot snapshot and the
  `device.state-changed` push loop, not by awaiting a refresh.

This is worth stating loudly because it produced a bug that survived its own test
suite: a battery-camera sleep gate read `handle.value` without awaiting
`handle.refresh()`, so the gate never fired in production — while the test fake
pre-seeded `value`, keeping the suite green. When a gate depends on remote state,
the test must not supply that state for free.

## A slice whose authority is elsewhere must be hydrated at boot

Some slices are not written by the device at all: an addon owns the durable
truth and MIRRORS it into the slice. `zones` and `zone-rules` work that way —
the catalogue lives in the orchestrator's per-device settings store.

For those, writing the slice only on mutation is a bug, not an optimisation. A
device whose runtime-state row was never written then has no slice at all, and
`refresh()` faithfully returns `null` forever, because the only thing that would
ever write it is an operator action that is not coming. The push channel does
not save you: `device.state-changed` is telemetry and never re-sends what it
never sent ([D8](../decisions/adr-0008.md)).

So the owner reconciles its mirror off the READ path and sweeps the fleet once at
boot (`zones-provider.ts` / `zone-rules-provider.ts` /
`zone-mirror-hydration.ts`), under the usual rule that a read which FAILED writes
nothing ([D49](../decisions/adr-0049.md)). Cost of missing it: camera 102's drawn
zone was invisible to occupancy, to both runner-side zone gates and to the admin
Zones tab, while `zones.listZones` returned it the whole time.

That boot sweep lands BEFORE most providers have reloaded their devices, and
the runtime-state row is written WHOLE. So the hub never writes a device's row
until it has READ it in this process: the row writer reads it before its first
write and fills memory's gaps from it (memory wins per cap), and writes nothing
while it cannot read it. The slice itself is applied and emitted at once — a
loaded claims index that clears a device vouches for its claims, which is all
the live path needs, and nothing about its row. Cost of trusting it: the sweep's one-slice write
replaced the whole row, and 15 cameras lost every restored cap nobody re-wrote
soon after boot, at 65 of 82 restarts
([D677](../decisions/adr-0677-the-runtime-state-row-writer-never-writes-a-row-this-process-has-not-read.md)).

## A battery device has THREE states, and only passive evidence may say which

`online` is a boolean and a battery camera does not fit in it. Camera 106 sat at
`online: true` for 30 hours unreachable, because `online` is written once at
probe and nothing passive ever demotes it — while a camera that is merely asleep
must not be painted as broken at all ([D62](../decisions/adr-0062.md)).

The obvious fix is the one thing forbidden: a reachability poll would answer the
question, and on a UDP battery camera **the login IS the wake**, so the poll that
proves the camera is alive is the poll that flattens it
([D173](../decisions/adr-0173-a-battery-camera-is-woken-by-demand-only-and-asleep-is-not-gone.md)).

So the slice records the CONTACT and a pure function reads it:

- `BatteryStatus.lastContactAt` — the last time the device proved reachability
  WITHOUT us reaching for it: an inbound firmware push, an observed wake, a
  round-trip somebody else's demand already paid for. Never written by a poll
  issued to answer this question. Writers quantise it (5 min in the Reolink
  provider) so a value meaning "recently" cannot cost a commit per round-trip.
- `deriveBatteryPresence` (`packages/types/src/device/battery-presence.ts`) is
  THE derivation of `awake` / `sleeping` / `unreachable`. Every surface calls it
  — the snapshot courtesy frame, the stream error, the badge — so they cannot
  disagree about what a camera is doing. Storing the verdict instead would
  create a second authority that goes stale the moment nobody rewrites it.

The failure direction is toward `sleeping`. A device that has reported no
contact at all — freshly adopted, slice lost — answers `sleeping`, never
`unreachable`: "we know nothing" must not become a fault badge. `unreachable` is
a fault and is meant to be believed.

## A camera whose stream is BUILT on demand: the lazy source, and the materialize round-trip

Some cameras have no stream to dial until something is done to them: a
battery camera that sleeps, a robot whose camera streams through a cloud relay
that carries video only between `open()` and `close()`. The broker already has
the shape for them (Reolink Baichuan native streams; the Dreame robot camera,
[D370](../decisions/adr-0370.md)), and every piece of it is load-bearing —
this is the procedure, and after it the list of ways it was got wrong.

1. **The device is a battery camera to the broker.** `DeviceFeature.BatteryOperated`
   in `features` (prebuffer off, the viewer's play disc IS the wake), and the
   `battery` cap registered on the device: `sleeping` = "the session is
   closed", `lastContactAt` refreshed on every sign of life (the broker refuses
   to wake a camera silent for hours — `deriveBatteryPresence`), and
   `wakeForStream` = open the session inside the caller's bound, single
   in-flight (a second play joins, it does not cold-start the camera twice).
2. **The stream is ALWAYS listed.** `stream-catalog.getCatalog` returns the
   stream in both states, as `pull-rfc4571`: while CLOSED the url is the
   broker's sentinel `lazy:rfc4571:<camStreamId>` and `metadata.sdp` a
   codec-only SDP (no `sprop-parameter-sets`); while OPEN the real
   `tcp://<host>:<port>` and the SDP built from the first keyframe. The
   sentinel is what keeps the stream on the device page and definable for the
   broker without dialling anything.
3. **The broker's first dial asks you to build it.** A dial of the sentinel
   emits `stream-broker.onRequestStreamSourceRefresh` (flat 1 s polls for
   20 s, then backoff). The device subscribes and, closed, OPENS the session;
   open, re-publishes what stands. Opening = start the vendor stream, wait for
   the first keyframe, put a `Rfc4571Muxer` (nodelink) on a TCP server bound to
   `0.0.0.0`, then `streamBroker.publishCameraStream` with the real url and
   SDP. Advertise a host another node can reach (the hub's `cluster` address
   from `local-network`, `pickHubHostname`), never bare loopback while one is
   known: the ingest owner can be a different node from the provider.
4. **The provider owns the session, and the consumer leaving closes it.** The
   TCP server knows when the broker's reader detaches (a short grace, 4 s,
   absorbs reconnects); that closes the session. A duration cap backs it up.
   On close, `publishCameraStream` the SENTINEL back; retract only when the
   device is removed.

5. **If the device knows when it wants to be recorded, it says so as a LEVEL.**
   Register `recording-signal` and write `active: true` while the device is
   in function (the robot: `cleaning`/`returning`), `false` otherwise — only
   on a change, never per push. The camera's recording mode
   `on-device-decision` (`RecordingConfig.deviceDecision`, D380 — a MODE, not a
   band: there is no hour to program)
   then holds the source open for the whole job and the attach wakes the
   camera through step 1 like any consumer; the recorder leaving is what
   closes the session. A duration cap the provider keeps for viewers must not
   cut that recording — re-arm it while the level is up, under an absolute
   bound ([D371](../decisions/adr-0371-a-device-signal-is-a-level-the-recorder-holds-and-a-publisher-names-the-slot-its-stream-is.md)).
6. **A single stream says which slot it IS.** The broker ranks one stream to
   `mid`, which no storage class owns and scrub never reads. A 720p relay is
   the camera's `low`: put `profileHint: 'low'` on the descriptor and the
   automatic ranking honours it before the pixel heuristic (same record).

What went wrong, each once, on 2026-09-06 — the reasons the steps are what they are:

- An EMPTY catalog while closed: the stream vanished from the device page,
  nothing dialled, nothing woke.
- A real `tcp://` url left registered after the session closed: the next play
  dialled it, the reader connected to nothing, the WebRTC session answered
  "answered but NO source media reached the session" — and never woke the
  camera, because a registered broker is one the play dials, not one it wakes.
- The relay's own url in the catalog: a cloud relay is often RTMP only in name
  (Aliyun LinkVisual: private handshake byte, 60 KB chunks, pipelined
  connect/play) and a standard client is closed right after `play`. The vendor
  library speaks it; the broker must not have to.
- Polling the broker's client list to decide idleness: the detection pipeline
  is a consumer too and would hold a cloud relay open on a battery for as long
  as the stream existed. The socket you own tells you when the viewer is gone.
- A re-publish (the sentinel going back) can itself trigger one dial and one
  wake when a consumer is still attached to the assignment; it settles on its
  own. Expect one extra open in the log, not a loop.

## A per-device binding question reads ONE device, and rides an event mirror

`deviceManager.getAllBindings` is a fleet call, and on a real deployment it is
not cheap: 524 devices measured ~900 ms, ~370 KB and ~500 log lines **per
call**. It has exactly one honest caller shape — a one-time warm seed. Anything
periodic must not be built on it.

Until 2026-08-30 it was far worse than "not cheap", and for a reason no payload
number showed. The per-device resolver read the persisted wrapper-activation
blob ITSELF, and on hub-main `ctx.settings.readAddonStore` is
`createDoorSettingsView` — an RPC to the isolated `sqlite-settings` child. So
the sweep cost one settings-door round trip **per device**: 1 020 of them on a
1 019-device hub, measured at ~2.9 s each while a storage drain was running.
`SystemMirror.init` gives it 15 s; it did not answer in 240 s, and the admin UI
would not boot. The blob is a single fleet-wide record of ~775 bytes keyed by
deviceId — the same bytes for every device in the sweep — so it is now read
once per pass and handed down (`BindingsPass` in `device-bindings-store.ts`),
together with the ledger's emptiness count. `getBindings`,
`getBindingsBatch` and `getAllBindings` each cost exactly **two** store reads,
issued in parallel, whatever the fleet size.

The generalisable part: a fleet call's cost is its ROUND TRIPS, not its bytes.
`getBindingsBatch` measured 5.78 s for one id and 17.16 s for eight — a slope
of 1.63 s per additional device — on a call whose payload is 4.5 KB a row. A
per-device `await` on a store is the shape to look for; the payload is a
distraction.

The pattern that replaces a sweep is a mirror refreshed off
`EventCategory.DeviceBindingsChanged`, seeded once and thereafter re-reading
**the one device the event names** with `getBindings(deviceId)`
([D12](../decisions/adr-0012.md)). `DetectionCoverageCache`
(`packages/addon-post-analysis/src/pipeline-analytics/runtime/detection-coverage-cache.ts`)
is the worked example: it answers "does this camera carry a *wrapped*
`detection-pipeline` binding" for the notification centre's device directory,
which used to re-derive that from a fleet-wide `getAllBindings` on every 30 s
rule-reload tick. `SystemMirror.refreshBinding`
(`packages/types/src/device/system-mirror.ts`) was converted the same way, and
its remaining `getAllBindings` call is the warm boot.

The persisted side of that blob has a matching rule on the WRITE. It is ONE
record for the whole fleet, so a writer that means to touch camera 101 rewrites
every camera's row — and `setWrapperActive`, `removeDevice`'s purge,
`addLocation`, `removeLocation`, `setRoleDisplayDefaults` and the `nextDeviceId`
bump all read-modify-write the same `addon-settings` key range. Each holds
`withAddonStoreWriteLock` for the whole read-compute-write; readers take
nothing. Unordered, two toggles on DIFFERENT cameras lost each other, and what
went missing was the `{ wrapperAddonId: null }` marker — so the camera came back
ON ([D309](../decisions/adr-0309-a-fleet-wide-record-is-read-modify-written-under-one-lock-or-two-cameras-lose-each-other.md)).

Two properties are not optional, and both are [D49](../decisions/adr-0049.md):

- **Unknown never excludes.** A cold or failed seed answers `undefined` for
  every id, and the consumer must treat that as "no opinion" — the alarm's
  coverage check excludes a camera only on an explicit `false`.
- **The destructive direction needs a second read.** A `true → false` flip is
  the one that takes work away, so it lands only when a second `getBindings`
  agrees; a read that throws keeps the previous value. One bad `getBindings`
  looks exactly like an unbind.

## Extensions: what a device is extended with by OTHER devices

A camera's linked devices are "this device, extended by those devices", and
they used to live in a hand-written settings section (beside a second one for
the virtual doorbell's trigger devices, retired with it in slice 6, D671).
[D648](../decisions/adr-0648-a-device-extension-is-a-slot-declared-by-the-cap-that-owns-the-function-and-served-over-its-existing-store.md)
puts them in one place without adding a store, and
[D655](../decisions/adr-0655-the-old-linked-devices-and-doorbell-sections-are-retired-the-extensions-slots-are-the-only-editor.md)
retired the two sections: the Extensions widget is the only editor.

- **A slot is declared by the cap that owns the function** — `extensionSlots` in
  its `*.cap.ts` (`linked-devices` in `device-manager.cap.ts`, today the only
  slot). `npm run codegen` folds them into
  `packages/types/src/generated/extension-slots.ts`: the id enum, the table, the
  value union keyed on `slot`, and the host device types.
- **`device-extension` is the contract** — a device-scoped collection (the
  `videoclips` shape, D554). Its providers are the slot owners; a camera's owners
  are its bindings. `listSlots` fans out and an owner that throws is an
  `unreachable` row, never an absence. `listCandidates` / `setSlot` route by the
  `slotRef` prefix (`<source>:<slotId>`).
- **Each owner serves its slot over the store it already has**, through the
  owner's one write path (`applyLinkedDevicesPatch`).
  Nothing is migrated. The `linked-devices` value also carries the
  tracked-event opt-in (`trackedDeviceIds` over `_linkedDeviceTrackedIds`,
  what `producesTrackedEvents` reads): absent on a write means untouched, a
  present list replaces it, and a NEW opt-in must be a linked device while a
  stored one is always accepted (a read writes back unchanged). The row's
  `impliedSources` are what the owner links by structure — tree children, a
  picked container's child, never the container (D356) — so the card offers
  the old section's toggles. A save of the old section's keys from a stale
  page is refused by name, never dropped. The Locations page's room rebuild
  writes the list through the same slot.
- **The section is a widget**, `host/extensions-panel` in ui-library, declared by
  the cap's `deviceConfig` (D14). It stores nothing, and after a save it
  re-reads its own `listSlots` — no other surface shows these stores. Neither
  `device-manager` nor `doorbell` declares `exposesDeviceSettings` any more.

Adding a kind: a descriptor (named export, value schema named export) in the
owning `*.cap.ts`, one `defineExtensionSlotProvider('<id>', …)` in the owning
addon whose manifest declares `device-extension`, and `npm run codegen`.
`scripts/check-extension-slots.ts` refuses a slot with no owner or two, and a
contract method shaped like a store.

Every slot is an `association`. D648 reserved a `graft` shape — a whole
capability gained by the host from other devices — with a `projects` cap and an
`enabled` switch; none was ever implemented, and it was retired (D663, amends
D648): a host that gains a capability from other devices is a composition or a
customization (below), not a slot.

## Composed devices: a device built from other devices' fields

[D659](../decisions/adr-0659-a-composed-device-is-a-composition-block-run-by-the-shared-composer-and-every-field-owns-its-availability.md).
A composition is a core block (`source.kind === 'composition'`) that declares a
NEW device and gives every state field of each of its caps one source: `from`
(copy a field of another device) or `expression` (the salvaged engine, plus
`within` / `any` / `all` / `latest`, and `number(x)` — a finite number or a
numeric string as a number, anything else `null`, the bridge from a
string-valued source such as an HA sensor with a unit and no `device_class`). The contract, the evaluator and the
validator live in `packages/types/src/composition/`; the runtime is the
`composer` builtin (`packages/system/src/builtins/composer/`), one isolated
runner (a group of one) for every declarative composition. Existing devices are customized under
[D663](../decisions/adr-0663-a-customization-owns-single-fields-by-a-claim-at-the-hub-write-chokepoint-and-removing-it-restores-the-native-slice.md).

- **Sources are `{ addonId, stableId }`**, never numeric ids (`stableId` is
  unique only per addon); the tracker resolves them and follows
  re-registration under a new id.
- **A composed cap is a native provider on the composed device** with no
  methods of its own; `getStatus` is the kernel default over the runtime slice,
  so a composed device is read like any other: `getBindings` lists it,
  `getProviderForDevice` resolves it, the status aggregate shows it. Writes are
  a seed, then merges.
- **Every field owns its availability.** Source offline, a failed or empty
  re-read, a deactivated sole wrapper → stale, last value kept. A cap the
  provider unregistered, or not bound on a device whose row exists →
  unavailable (never a stale number) but NOT fatal: a provider restart looks
  exactly like that, and the source's `native-registered` re-reads it. Only a
  source device GONE (two index reads agreed) is fatal: `null` where the schema
  allows it, else the device goes offline; the block goes `failed` naming the
  source, and stays so until the operator edits or restarts it.
- **No polling, no timers waiting for a source.** Sources are read once to
  hydrate; events do the rest, and the reconcile for a dropped event is the
  source's own (re)registration. A time window arms one deadline, and every
  evaluation is stored so a moved deadline reaches it. The tracker's copy of a
  source value is derivation input only, served to nobody (D224).
- **A composed device is never deleted by a read that failed** (D49): nothing is
  declared or withdrawn while the `core_blocks` store has not loaded, a
  withdrawal needs two agreeing applies (the gate is seeded from persisted
  rows), and a row that fails to parse or whose plan no longer resolves (a
  release renamed a cap) is held by a capless placeholder, `failed`.
- **Saves are validated** (`coreBlocks.validateComposition`, the same verdict
  `createComposition` / `updateComposition` reach): capability fit, kinds,
  nullability, sources, cycles — refused by name. Reads answer `not-loaded`
  before the store loads (D315); writes are serialized and an update carries
  `expectedUpdatedAt`. Commands and media passthrough (slice 3) and code
  fields (slice 4) are in the wire shape and refused by name today.
- **An EXISTING device can be the target (slice 2, D663, D944).** Nothing is
  declared. A feature ADDS a capability the device lacks and the composer
  CLAIMS those fields on the hub under the block id (`deviceState.claimFields`).
  A stored feature that would replace a capability the device already serves
  is refused (`native-capability-replace`), logged with `tags: { deviceId }`
  and the block id. A built device (`target.kind: 'new'`) is unchanged. A claim
  is handed back only when
  two applies agree (seeded from the claims index; a failed release is retried
  on every apply until it lands). The target's own REPLACED or uncomposed
  fields are read in the NATIVE view, so "invert state" never reads its own
  output; a read of the composition's OWN output (a cap it ADDS, or a field of
  its composed device) is answered by the composer runtime's record, never
  through the hub — through the hub it waited on the claim it creates, and
  camera 101's doorbell went unserved for 12 h (D670 amendment); whether a
  `device.state-changed` of such a cap is the native follows the claim the hub
  actually holds, not the plan. A field is handed back to the provider only
  when its source's unavailability is CONFIRMED (the row gone, or an
  unregistration a bindings re-read agrees with) and the block then reports
  `degraded`; a failed, first or empty read holds the field on its last value,
  its claim kept, and the block reports `starting` naming it (D49). The target
  row gone fails the block by name.
- **How a claim is served (D663).** The row keeps the native slice and, beside
  it, `$owned: { owner, mode, fields, values }`; the hub mirror keeps the
  native write as a shadow and serves the MERGED slice to every event and read,
  so no consumer changes and a release restores the native exactly. The
  claimed field set is explicit; a claimed field with no value yet is `held`,
  never native. The claims index is a listing projection written before the
  row (and after it on a release); a loaded index is authoritative, a
  malformed one is `not-loaded`. The native shadow is owner-only:
  `device.native-shadow-changed` reaches the composer alone, and
  `getNativeCapSlice` is admin-only. `getStatus` of a claimed cap is the merged
  slice for every caller that reaches the hub — the D13 resolver wraps the
  provider in a `Proxy`, and every transport entry that resolves by name asks
  `answerClaimedGetStatus` first; an agent-resident consumer of an
  agent-resident device does not reach the hub and sees the native. A device
  under customization cannot be migrated.
- **A replaced field whose source is confirmed unavailable is handed back**:
  the native value shows, the block is `degraded` naming source and field, and
  the field is re-claimed when the source returns (one authority at a time,
  D393). An ADDED field has no native to hand back to: it says `null` /
  `'unknown'`. One composition per existing device, by block id; its name
  (`customize:<addonId>/<stableId>`) is derived by the server and never shown.
- **An added cap is GRAFTED** onto the foreign device as a method-serving
  native (`DeviceContext.unregisterNativeCap` takes it back). A native always
  wins: a native that appears replaces the graft and the composer never
  re-grafts; a refused graft is named in the block verdict. **Rolling back
  below D663 needs every customization released first** — an older hub stops
  merging and native values reappear.
- **A composition may derive capability events from state (D670).** The
  capability declares the event and its numeric advancing state field;
  composition planning maps supported names explicitly to event categories.
  A native capability is not replaced (D944), so its provider remains the event
  authority. The runtime seeds the existing target before ownership side
  effects, evaluates stateful calls with per-field transactional memory, then
  advances the event high-water, emits to the event bus and writes the owned
  field in that order. A failed write cannot re-emit an already advanced event.
- Stateful expression calls use structural AST paths (`root/left`,
  `root/arg:0`, etc.), never source offsets or traversal counters. `rose`
  shares the sensor catalogue's rising-edge and first-sighting freshness rule;
  rises across one output field share a 2-second default debounce. `count`
  seeds from the target's effective value without counting the seed and only
  increments on a strict finite advance. If an accumulator source is
  unavailable after a value exists, its last value remains stale.
- **Disabled features remain stored but inert.** They are structurally
  validated, but excluded from source resolution, dependency/cycle graph,
  field/event planning, declarations, grafts, claims, writes and emits. An
  all-disabled composition can be running without a runtime.
- **A camera is a doorbell natively or by customization (D671).** The doorbell
  cap has no wrapper and no extension slot any more: a camera without a native
  doorbell gets one from a composed `doorbell` feature in its customization
  (the generic pulse card, `compilePulseOverride`, sources by stable
  `{ addonId, stableId }` refs). The `virtual-doorbell` addon and the
  one-shot migration that moved its numeric sources into such features were
  removed in slice 6. Releasing that removal requires the passive preflight —
  no `doorbell` binding naming `virtual-doorbell` — recorded in D671 as the
  operator's gate; it was NOT run when the code was removed. A stored
  activation that still names a retired wrapper is ignored (the cap resolves
  to its native) and WARNed once per (device, cap) with the call that clears it
  (`stale-wrapper-activations.ts`).
- **Rolling back below D659 erases compositions**: an older build strips
  `source` and rewrites the row. Export them first.

### Helpers: a group is a template, not an expression

[D944](../decisions/adr-0944-customize-attaches-a-fixed-set-of-extensions-and-everything-else-is-a-built-device.md).
A helper is an ordinary built device (`target.kind: 'new'`). The editor stores
a `composition.helper` spec — template id, reducer, members as
`{ addonId, stableId }` plus the field they read — and `compileHelper` projects
that onto features the composer already runs. Reading the block back returns
the spec, so the editor does not reopen it as an expression. A composition
with no `helper` is a free expression: device 4603's room average is that, and
`avg` / `any` still include a stale value.

Phase 1a is group templates, one per base reading (temperature, humidity,
pressure, illuminance, power, energy, battery, numeric) and one per binary
reading (motion, contact, leak, smoke, occupancy, binary), plus one appliance
template. That template is not a group reducer: one power reading (W) becomes
a washer, dryer or dishwasher whose running state is power at or above a
threshold, with a stop dwell long enough to ride over a wash pause. A numeric group
reduces by mean, median, min, max or sum. A binary group reduces by any or
all. Members are one device type (`Sensor`) and one catalog field. Occupancy
reads `motion.detected` or `binary.on`; a presence zone is not a boolean and
is not a member.

The projection is a field source `kind: 'aggregate'`, not `avg(...)`. Offline,
stale and unknown members are excluded and counted. They are never read as 0
or false (D393). The counts are the `group-status` capability (`included`,
`excluded`, `total`), session durability, no history — the series a later
statistic reads is the output cap's own history block. The output stays in the
members' base unit. A save that finds two quantities on one group is refused
`mixed-quantity`. Nobody reporting writes `null` on a nullable reading, omits
an optional one (`power-meter.watts`, `kwhTotal` — the slice is replaced so
the previous number does not linger), or takes a non-nullable boolean device
offline rather than publishing false. A member that is gone fails the field.

`motion.isDetected` on a composed group reads `detected` from the slice and
throws when that field is unknown. The common source selector (#236) is asked
through `sourcePickForTemplate`: one device type, the catalog fields, up to
64 members. A switch or light group uses the same template: the operator
picks `at-least-one` or `all`, and a command is sent to every member that
binds that capability, including one that is offline. One member's failure
is recorded on `group-commands` and does not cancel the others. A light
exposes brightness and colour only while every member binds them; colour
modes are the features they all share. The live set follows membership and
`device.bindings-changed`. Fan, cover, valve, lock, media player and climate
are not this slice either: their commands are not an on/off fan-out.

### Statistics and an integral (D944)

A statistic reads one historised numeric field and publishes min, max, a
time-weighted mean, the sum of a counter's deltas, the sample count, or the
change, over a rolling window or a calendar period in the hub's timezone. An
integral accumulates a gauge — watts become kWh, any other gauge becomes a
meter in base-unit seconds — and resets daily, weekly, monthly, or never.
Both are computed from device history and its rollups, never from an
in-memory buffer, and the same query after a restart publishes the same
number. A window longer than the reading's retention is refused at save. A
gap is not filled with zero: the statistic writes null, and the integral
holds its last total and counts the gap on `group-status.excluded`. The
source has to declare history; the selector says so when it does not.

## Deleting a device: who cleans what (D864)

Every delete (`remove`, the child cascade, `removeByIntegration`, a provider's
`remove`) converges on `deviceManager.removeDevice`. It deletes the row (identity,
name, location assignment), then runs one INDEPENDENT step per store it owns —
`keychain-secrets` (every owner's `device/<id>` values), `device-config`,
`runtime-state` (mirror first, then the slice), `field-claims`, `bindings` — via
`removal-cleanup.ts`. A step that throws does not skip the others and does not fail
the removal (the row is gone, so the operator could not retry it); it is logged once
and retried on a bounded schedule (30 s, 2 min, 10 min, then an error line). The
summary is one info line per device, `tags: { deviceId }`, with counts per store.
There is no boot-time sweep.

Per-device **settings** of every addon (`addon-device-settings`, written through
`ctx.settings.*DeviceStore`, the same rows in every process, D870) are cleared by the
`addon-device-settings` step in one statement (D865): no addon needs a settings handler.
Per-camera state is a key of the camera's settings (the broker's `probeSnapshots`,
`brokerProfile`, `rtspTokens`; the notification mute `notificationMuted`), so it goes with
them; the stream-broker and pipeline-analytics (notification centre rows) also implement
`device-removal-hook` for what is not a key. Per-device **data** that is not
settings (footage, events and their media, analytics rows, history) is removed by the
`device-removal-hook` capability, which device-manager calls on every provider after a
delete, with the same bounded retry. Both rest on a **tombstone** device-manager writes
for every delete (`device-manager:tombstones`: id, `deletedAt`, `providerAddonId`;
90 days; first removal step). An implementer that was down catches up from
`deviceManager.listDeletedSince({ sinceMs })` at hub link and every 6 h — from
tombstones only, never from a device being absent from a list. A device that is
unregistered, offline or whose provider is restarting is NOT deleted and gets neither
a tombstone nor a hook call. Training and retrain datasets are kept.

Data of devices deleted before tombstones is cleaned by an admin action, System ->
Data -> Deleted devices (`deviceManager.cleanupDeletedDevicesData`): a dry run with
counts per store, then an explicit confirm; the absence check needs two answered reads
of the device ledger and does nothing when one fails.

The rest of what other addons keep (stream-broker slot maps, snapshot cache,
notification rules, composer links, exporters) is still cleaned by that addon off
`DeviceUnregistered`, with its own reconcile as the backstop. The full per-store table
is in
[D864](../decisions/adr-0864-deleting-a-device-cleans-its-data-at-delete-time-store-by-store-and-the-keychain-is-purged-by-device-scope.md);
the split between settings and data is
[D865](../decisions/adr-0865-a-deleted-device-is-a-recorded-fact-settings-are-cleared-centrally-and-device-data-is-removed-by-a-hook-driven-by-tombstones.md).

## How a device is named

A device has one stored name. What a screen paints is a different string, from one function (`formatDeviceName` in `@camstack/ui-library`, mirrored in the viewer at `camstack/src/data/device-name.ts`).

A child under a container is named from its role or type, in the active locale's short form (Motion / Movimento, Battery / Batteria, Camera / Telecamera). A stored name that is only that stock word is replaced by the short noun. A name the operator wrote (`display.label`, or a remainder that is not a stock word) is kept. The compact form is the container's name alone when this child is the container's only meaningful child, or when the child's own name is the container's name. Otherwise it is `container · noun`. The full form is `container · noun` unless the noun is the container's name. Nested, under the parent row, is the noun alone. A room is appended only by the `with-location` form, and only when that room is not already one of the segments.

Diagnostic children (battery, temperature, humidity, illuminance, signal, last-seen, a plain number or enum, an update) do not count as the container's meaningful child. Parent names come from one slim device list shared by the page, never a query per row. Until that list has answered, the stored name is shown. Search still matches the stored name.

## Reading further

- Aggregation is binding-driven: [D12](../decisions/adr-0012.md)
- One resolver, never branch on `kind`: [D13](../decisions/adr-0013.md)
- Device-config UI is derived: [D14](../decisions/adr-0014.md)
