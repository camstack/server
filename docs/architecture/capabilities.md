---
title: The capability system
applies-to:
  - scripts/codegen.ts
  - scripts/generate-cap-mounts.ts
  - scripts/check-cap-history-declared.ts
  - scripts/check-device-scoped-wrapper-mounts.ts
  - scripts/check-capability-union-complete.ts
  - server/backend/src/__tests__/guards/core-router-classification.expectations.ts
  - scripts/generate-method-access-map.ts
  - packages/system/src/kernel/capability-registry.ts
  - packages/system/src/kernel/cap-router-builder.ts
  - server/backend/src/api/trpc/scope-access.ts
  - server/backend/src/api/trpc/cap-router-runtime.ts
  - server/backend/src/api/trpc/trpc.router.ts
  - packages/types/src/capabilities/capability-definition.ts
  - packages/types/src/capabilities/doorbell.cap.ts
  - packages/types/src/capabilities/cap-router-predicates.ts
  - packages/types/src/capabilities/index.ts
  - packages/types/src/composition/composition-events.ts
  - packages/system/src/builtins/composer/composition-runtime.ts
  - packages/types/src/__tests__/default-active-device-types.spec.ts
covers:
  - packages/types/src/capabilities/**
last-verified: 2026-10-04
---

# The capability system

A capability is a named, typed contract. It is the **only** way one part of
CamStack talks to another.

Current inventory: [reference/capabilities.md](../reference/capabilities.md)
(generated).

## Naming a provider, and the four places that must agree

A collection capability has several providers, so a caller may NAME the one it
wants. Two spellings exist and they hold the same kind of value — an addon id:

- **`addonId`**, on a GLOBAL collection, injected by the codegen as part of the
  `{nodeId?, addonId?}` selector. On a non-collection cap the same word is
  ordinary DATA (`addons.getLogs({addonId})` names whose logs you want), which
  is why `addonPinOf` guards with `isGlobalCollection` before treating it as
  routing.
- **`provider`** (`PROVIDER_PIN_FIELD` in `capability-definition.ts`), on a
  DEVICE collection such as `videoclips`, where naming it is REQUIRED (D554).

**Four layers dispatch such a call, and a pin honoured by fewer than all of
them is honoured by none.** Between 2026-09-21 and 2026-09-22 each of these
was found answering a pinned clip read from the wrong provider, and each was
fixed on its own evidence:

| layer | reads the pin in | record |
| --- | --- | --- |
| the hub's tRPC mount | `device-collection-dispatch.ts` (`pinnedProvider`) | D552, D592 |
| the Moleculer transport link | `trpc-links.ts` (`narrowToPinnedProvider`) | D593 |
| the parent's UDS route | `cap-router-runtime.ts` (`devicePinOf`) | D594 |
| the sibling short-circuit, which runs BEFORE that route | `cap-routing-hints.ts` (`liftRoutingHints`) | D595 |

The last row is the one that keeps being missed: the short-circuit is handed
the lifted ENVELOPE, not the args, so a pin the envelope does not carry is a
pin the decision cannot see. `addonPinOf`'s docblock states the rule and the
probe that proves it — a deliberately bogus pin, refused by name if the
selector routes and answered by a stranger if it is discarded.

## The pipeline, end to end

```
packages/types/src/capabilities/foo.cap.ts     ← you write this
        │  npm run codegen  (16 derived artifacts)
        ▼
cap-router TYPE map · CapStatusTypeMap · DeviceProxy/SystemProxy facades
· method-access, method-device-selector, scope-preset, input-default and
  collection maps · …
        │  hub boot: buildCapRouters(primitives, services) — it walks
        │            ALL_CAPABILITY_DEFINITIONS itself
        ▼
mounted on the tRPC router — no hand-written line anywhere
        │
        ▼
addon registers a provider → CapabilityRegistry → callers via ctx.api
```

Two tracks live in `server/backend/src/api/trpc/trpc.router.ts`: hand-written core
API routers (single implementation, e.g. `auth`, `logs`, `capabilities`) and the
capability routers. The cap track is built **at runtime** — the server's
`buildRuntimeCapRouters` (`server/backend/src/api/trpc/cap-router-runtime.ts`)
supplies the tRPC primitives and provider resolution to `buildCapRouters` in
`packages/system/src/kernel/cap-router-builder.ts`, which constructs one router
per live cap def. The codegen'd `server/backend/src/api/trpc/generated-cap-routers.ts`
and `generated-cap-mounts.ts` are the AppRouter **TYPE** source of record only;
their value is never called. That is why a capability change ships through
`@camstack/types` + `@camstack/system` with no `@camstack/server` rebuild. Do not
add a capability to the first track.

There is a second reason not to. A hand-written core router has no entry in
`METHOD_ACCESS_MAP`, and an unmapped path **skips the scope matcher** — that
branch is fail-open by construction, so a core procedure is only as tight as
the builder it was written with. Each of those routers is therefore classified
(admin-only, device-filtered, mixed, session-self) in
`server/backend/src/__tests__/guards/core-router-classification.expectations.ts` and the classification is enforced
against the source in CI; adding one, or growing a bare `protectedProcedure`
inside an admin-only one, fails the build until the classification is updated.

## Adding one

1. **Define** `foo.cap.ts` in `packages/types/src/capabilities/`, re-export it as a
   **value** from `capabilities/index.ts`, and add it to the `AnyCapability` union
   in that same file — `CapabilityName` is `AnyCapability['name']`, so a cap left
   out of the union is invisible to every consumer keyed on a cap name while
   nothing turns red. `scripts/check-capability-union-complete.ts` refuses all
   three failure modes and runs inside `npm run codegen`.
2. **`npm run codegen`.** Skipping this is silent drift; CI's `codegen:check`
   catches it, which is not the same as catching it in time.
3. **Implement**: `ctx.registerProvider(capName, impl)` for system scope, or
   `ctx.registerNativeCap(cap, impl)` from a `BaseDevice` subclass for device
   scope.
4. **Declare** the capability **by name** in the addon's `package.json` under
   `camstack.addons[].capabilities`. Behavioural metadata goes in the cap
   definition only ([D4](../decisions/adr-0004.md)).
5. **Mounting is automatic.** Set an explicit `mount` hint only when resolution is
   not scope/mode-derivable (`server-provided`, `hub-only`, `skip`); a
   `server-provided` capability also needs a factory in `buildServerProviders`.
6. **Ship it**: a new or changed capability is a framework change. The hub reads
   `ALL_CAPABILITY_DEFINITIONS` from **`@camstack/system`**, not `@camstack/types`
   (see the import comment in `server/backend/src/main.ts`), so the carrier in a
   workspace checkout is `camstack deploy packages/system`. On a deployed hub the
   framework upload is refused: it ships as a published `@camstack/server` closure
   ([update-and-release.md](update-and-release.md)).
7. **Spec it** in `server/backend/src/__tests__/cap-routers/`.
8. **Phrase it** in the cap vocabulary (`packages/types/src/device/cap-vocabulary/`,
   [D920](../decisions/adr-0920-a-devices-vocabulary-is-one-cap-keyed-map-outside-the-caps.md)):
   a system cap says why it is not a device's vocabulary; a device cap names its
   actions, state and event triggers in English and Italian, or excuses each
   operate method and event with a reason. The map's type refuses a missing cap;
   `scripts/check-cap-vocabulary.ts` refuses an unphrased operate method or event.

The router builder does **not** re-validate output — it is a structural
pass-through. The provider owns the payload shape.

## Every method carries an auth tier, and omitting it is still a choice

`method(input, output, options)` takes two independent access fields, both
declared in `packages/types/src/capabilities/capability-definition.ts`:

| Field | Values | Default |
| --- | --- | --- |
| `auth` | `'public'` · `'protected'` · `'admin'` | **`'protected'`** — reachable by every authenticated non-admin |
| `access` | `'view'` · `'create'` · `'delete'` | derived: a destructive verb prefix (`delete`, `remove`, `revoke`, `purge`, `reset`, …) → `delete`; else `query`/`subscription` → `view`, `mutation` → `create` |

`auth` chooses the procedure builder in the generated router
(`publicProcedure` / `protectedProcedure` / `adminProcedure`). `access` never
reaches the router: it is what `scripts/generate-method-access-map.ts` writes
into `METHOD_ACCESS_MAP` (`packages/types/src/generated/method-access-map.ts`),
the table the scope matcher consults for a non-admin caller. Only override
`access` when the verb lies about what the method does.

**The default is the trap.** A method with no `auth` line is born `protected`,
and nothing in review reliably catches a tier nobody typed. So every method's
tier is pinned in an explicit baseline that CI diffs, and a widening
(`admin` → `protected` → `public`) is reported separately from a new method, so
the risky lines are the ones a reviewer sees first. Accepting a change is
deliberate (`--update`), not a shrug.

### A system-scope method that names a device is device-filtered too

The matcher used to read `input.deviceId` only for a cap declared
`scope: 'device'`, which left every system-scope method that happens to take a
camera — recordings, galleries, orchestrator and vector-store reads — reachable
for ANY camera by anyone holding a `category:system` grant.
`METHOD_DEVICE_SELECTORS`
(`packages/types/src/generated/method-device-selectors.ts`, from
`scripts/generate-method-device-selectors.ts`) now records where those device
references live, found by **Zod introspection of the input schema** — never a
source-text heuristic — and `server/backend/src/api/trpc/scope-access.ts` gates
a system-scope call on every device it names.

The gate only ever SUBTRACTS: it is a check on top of an already-passing
capability grant, and a caller with unrestricted device reach (admin,
`category:device`, or a `{ kind: 'all' }` selector) is unaffected. Device-scope
caps keep their existing cross-device capability-grant semantics deliberately.

Two consequences when writing a new method:

- **Name the field, and keep it top-level.** The recogniser matches a top-level
  field resolving to a number or array of numbers, named `deviceId`,
  `deviceIds`, `camDeviceId`, `childDeviceId(s)`, `parentDeviceId`,
  `linkDeviceId`, `sourceDeviceId` or `targetDeviceId`. One further shape is
  mapped: a top-level **array of objects** whose elements carry one of those
  field names as a number (`targets[].deviceId`, the batch shape
  `snapshot.getSnapshotLinks` uses) — recognised whatever the array itself is
  called, because the element field is what names a device. Nothing deeper: the
  middleware walks `element[field]` flat, so a device id under a plain object,
  or two levels down, or spelled anything else, is invisible to the gate — the
  method then reaches the whole fleet for anyone holding the cap.
- **A read that names a camera can be `protected` because of it.**
  `recording.getAvailability` / `getDaysWithRecordings` / `getPlaybackManifest`
  are the Viewer's timeline, calendar and playback reads and were re-tiered
  from `admin` to `protected` on exactly that reasoning. `getStorageUsage` is a
  deployment-wide figure and stays `admin`.

## Definition checklist

For a capability holding device-scoped state:

- **`status: { schema, kind }`** — `kind` is `'command-driven' | 'poll' | 'push'`.
- **`runtimeState: SomeSchema`** — a kernel-managed slice: validated, persisted,
  observable. Must include `lastFetchedAt: z.number()`. Convention:
  `runtimeState = StatusSchema.extend({ lastFetchedAt: z.number() })`.
- **`history`** (D850) — mandatory next to `runtimeState`: `'none'` or
  `{ fields }` naming the `runtimeState` fields recorded as long-term series
  (`gauge`, `counter` = monotonic hardware meters only, `boolean`). A path goes
  through fixed objects (`cleanWater.level`), never into an array or a record keyed
  by runtime ids; it unwraps to a number or boolean and is not a clock. A field
  carries `unit` or `unitFrom` (a sibling string/enum field holding the device's
  own unit), `deadband` (absolute) and/or `deadbandPct` (relative), `minIntervalMs`
  (the capture floor is 10 s for gauges and counters, none for booleans; `0` opts
  out) and `excludeDeviceTypes` (`motion.detected` is not captured for cameras).
  Availability has ONE series: `device-status.online`. `scripts/check-cap-history-
  declared.ts` enforces it; codegen projects it into `generated/history-catalog.ts`
  and the `History` column of `docs/reference/capabilities.md`.
- **`deviceConfig: { ui }`** for camera-config capabilities — the D14 archetype.
  `ui.kind: 'derived-form'` (needs a registered `builderId`) or `'widget'` (one
  embedded live component). Mutually exclusive with `exposesDeviceSettings`.
- **`exposesDeviceSettings: true`** — the older escape hatch; adds three framework
  methods for ad-hoc settings UIs.
- **`settings: { bindings: [...] }`** — declarative auto-form for simple
  capabilities. See `switch.cap.ts`, `osd.cap.ts`.
- **`kind: 'wrapper'` + `defaultActive`** — when providers register as wrappers
  (they appear in `device-manager.getBindings` and auto-bind to devices).
  A `defaultActive` wrapper **must also declare `deviceTypes`**: the auto-bind
  reads it to decide which devices it may claim, and a cap that declares none is
  claimed by *every* device type. Nine camera caps once bound themselves onto
  every switch, sensor and button in the fleet that way. Enforced by
  `packages/types/src/__tests__/default-active-device-types.spec.ts`.
- **`deviceTypes`** — the allowed `DeviceType`s for a `scope: 'device'` cap.
  Consulted by `listDeviceScopedCapsForType`, the synthesize-target half of
  `getWireableFields`, and the `defaultActive` auto-bind. Omitting it means "every
  type" — harmless on a cap nothing auto-binds, fleet-wide on one that does.

## The `getOptions` availability convention

A per-camera configurability capability must advertise what a **given** camera
supports, because [D14](../decisions/adr-0014.md) makes the UI derive from it — a
dishonest descriptor renders a control that silently does nothing.

The surface is a triplet: `getOptions` (query) + `getStatus` (auto-injected) + one
`set<X>` mutation. Descriptor shapes:

| Shape | Form | Example |
| --- | --- | --- |
| Boolean availability | `hasX` / `supportsX` | `hasZoom`, `supportsGop` |
| Numeric range | `{ min, max, step }` | `motion-zones` sensitivity |
| Choice set | array | `codecs: ['h264','h265']` |

Values must be camera-probed, never hardcoded.

Two exceptions, both pre-existing and not to be copied: `stream-params`
`bitrateRange` uses a `[min, max]` tuple; array-of-descriptor capabilities like
`osd` carry availability per item (`availablePositions`, `readOnly`) instead of a
top-level `getOptions`.

## Resolution and registries

- One resolver: `CapabilityRegistry.getProviderForDevice(capName, deviceId)`.
  Never branch on `DeviceBindingEntry.kind` ([D13](../decisions/adr-0013.md)).
- **`getStatus` of a CLAIMED cap is the hub mirror's merged slice, for every
  caller.** The device-manager installs a `StatusOverlay` over its
  `DeviceStateMirror` and claims index (`registry.setStatusOverlay`);
  `getNativeProvider` and `getProviderForDevice` — the `nativeFallback` branch
  the HA feeder takes included — hand back a `Proxy` whose `getStatus` awaits
  `registry.resolveClaimedStatus(cap, device)` (parsed with `status.schema`; a
  held or unparseable slice is `null`, "not reported") and whose every other
  property is the provider's own. Never a spread: the fallback's native is
  `new Proxy({}, { get })` and its spread is `{}`. A device KNOWN to carry no
  claim pays one in-memory `peek` and gets the very same object; a device whose
  claims are not yet known (row not read, index not loaded) has them resolved
  when `getStatus` is called — the index, then its row once, single-flight —
  and is never answered native; a row that cannot be read is `null`
  (D315, D49). There is no single chokepoint for the calls that resolve a cap BY
  NAME straight to the owning runner, so the three entries ask the same
  question through one shared `answerClaimedGetStatus`
  (`kernel/transport/claimed-get-status.ts`): the `LocalChildRegistry` sibling
  short-circuit (a hub-local child calling a device owned by another —
  exporters, the notification center), `createParentUnownedCallHandler`
  (no sibling owns it) and `MoleculerService.callCapabilityOnNode` (the hub's
  own tRPC with a `nodeId` pin, and `deviceCapResolverLink`). A pin does not
  bypass it. `scripts/check-claimed-get-status.ts` fails a production file that
  calls `resolveCapRoute` / `resolveChildId` / `callCapOnChild` without asking.
  Known gap: an agent-resident child calling an agent-resident device is
  answered on the agent with no hub round-trip (D663 open item).
- Per-device aggregation walks `getBindings(deviceId)` only — never the global
  capability list ([D12](../decisions/adr-0012.md)).
- `HubNodeRegistry` is the single cluster-wide authority. No shadow maps
  ([D3](../decisions/adr-0003.md)).
- Never call `addonRegistry.getAddon()` from a router. Use the registry.
- Capability methods are **flat**. No nested sub-objects on providers.

### Persisted operator preferences arrive after the first providers (D675)

`registerProvider` consults the preference readers (`capabilities.singleton.*`,
`capabilities.collection.*`) at the moment a provider registers. On the hub
those preferences live behind the async settings door, read ONCE into memory
when the door is wired; until that read settles a reader answers "no
preference" and the default wins. When it settles, the addon registry calls
`CapabilityRegistry.applyPersistedPreferences` once: a registered singleton
choice becomes active, a disabled collection provider is disabled again. Infra
capabilities are skipped (they need a restart, as `setPreference` says). A
failed read leaves every preference UNKNOWN until the next boot, and
`capabilities.getPreference` reports `state: 'unknown'` rather than "unset".

### An unregister must prove it owns the registration

`(capability, addonId)` is **not an identity over time**
([D188](../decisions/adr-0188-an-unregister-carries-proof-of-ownership.md)).
`resolveRunnerId` is deterministic, so a replaced runner reconnects under the
same key — and on 2026-08-20 a mass update let the successor handshake first and
the predecessor's teardown land afterwards, unregistering `recording`,
`storage-evictable` and `recording-export` out from under a process that was
healthy and writing segments. `recording.getAvailability` answered "provider not
available" for ~7 hours while the recorder ran perfectly.

So a registration may declare a `ProviderOwnerToken` naming the INCARNATION that
made it (`hub/recorder#7` — connection-scoped, never derived from the node id
alone), and `unregisterProvider` deletes only on an exact match. A different
token, or none, is a **logged no-op**. Two obligations ride with it:

- Whoever can observe an incarnation must supply it. A generation that TAKES
  OVER an unchanged registration must re-stamp it (`reassignProviderOwner`) —
  leaving the dead generation's token on a live registration turns this rule
  into a permanent leak, because nothing the live process could present would
  ever match.
- An ownerless registration behaves exactly as before, deliberately: the token
  means something only where the key is reused across process generations, and
  an in-process builtin's `addonId` is already unique.

Consequence worth knowing before you touch teardown: a hub-local child's caps
are now cleaned up by the UDS `onChildGone` path **only**. Moleculer's
`$node.disconnected` cannot observe which incarnation died, presents no token,
and is refused against an owned registration — correct while a child's death
always closes its UDS socket, and a leak the day that stops being true.

## Wrapper mounts must resolve per device

A `kind: 'wrapper'` + `scope: 'device'` cap is one active provider **per
device**, substitutable through `deviceManager.setWrapperActive`. The runtime
resolver for that is `CapabilityRegistry.getProviderForDevice(capName, deviceId)`.

`resolveCapMount` derives **`{ kind: 'device-scoped' }`** for such a cap (since
2026-09-20, [D552](../decisions/adr-0552-a-device-scoped-wrapper-mount-dispatches-only-the-methods-that-name-a-device.md)),
and the runtime `getLocalProvider`
(`server/backend/src/api/trpc/cap-router-runtime.ts`) serves it through the same
`requireDeviceScoped` dispatcher `device-native` uses: native first, then the
D13 `getProviderForDevice`, which falls back to the global active singleton for
a device with no binding. It is derived, never a per-cap `mount:` hint — a hint
on one cap leaves the next one broken by default. `scripts/generate-cap-mounts.ts`
now calls `resolveCapMount` instead of re-deriving, so the type-only
`generated-cap-mounts.ts` cannot classify a cap differently from the builder
that runs.

**What it was, and why it is worth knowing:** the derivation used to fall
through to `{ kind: 'singleton' }`, so `getSingleton(name)` — `state.activeAddonId`
— answered every camera. `setWrapperActive` persisted, `getBindings` reported it,
and the router served the global provider anyway. Silent; the D62 shape (a knob
that wrote a store nobody read).

**The mount applies per METHOD.** The per-device dispatcher demands a numeric
`deviceId` on every call, so a `device-scoped` cap's method resolves per device
only when its input declares a top-level REQUIRED numeric `deviceId`
(`objectInputDeclaresRequiredDeviceId`, Zod introspection). Everything else —
a batch over `deviceIds`, a fleet-wide count, a job id — resolves the cap's
SYSTEM provider, the destination `systemOnly` names explicitly. Without that,
the derivation would have 400'd 39 existing methods (37 on `pipeline-analytics`
alone). On `device-native` there is no such rule: a deviceId-less method there
is a definition error whose fix is `systemMethod()`, as `snapshot` does.

Eight caps resolve `device-scoped` today: `audio-analysis`,
`camera-pipeline-config`, `camera-streams`, `detection-pipeline`,
`motion-detection`, `pipeline-analytics`, `scene-monitor`, `videoclips`.
`scripts/check-device-scoped-wrapper-mounts.ts` (CI) refuses a new one that
resolves `singleton`. `videoclips` also declares
`deviceTypes: [DeviceType.Camera]` (the lightbulb auto-bind is closed).

**A per-device wrapper may hold SEVERAL providers per device** — since
2026-09-20, [D554](../decisions/adr-0554-a-per-device-wrapper-that-becomes-a-collection-stays-per-device-and-its-sources-are-fanned-out-not-picked.md).
`videoclips` is the first: `mode: 'collection'` on a `scope:'device'` +
`kind:'wrapper'` cap means a device's providers are SOURCES, listed beside each
other. Two rules follow, and both are guarded:

- **The mount stays `device-scoped`.** `resolveCapMount` tests the
  device-wrapper rule BEFORE `mode: 'collection'` — cardinality says how many
  sources one device has, never that the cap left the device. The opposite
  order sends the cap to the GLOBAL collection mount (every provider, every
  caller) and undoes this whole section.
- **The dispatcher is `requireDeviceCollection`**
  (`server/backend/src/api/trpc/device-collection-dispatch.ts`), selected by the
  cap's mode inside `case 'device-scoped'`. `requireDeviceScoped` resolves ONE
  provider, and on a collection cap `getProviderForDevice` answers with
  whichever addon registered first. The device's sources come from
  `resolveCollectionForDevice` (enabled ∩ the per-device collection FILTER,
  `setDeviceCollectionFilter`) — not from `setWrapperActive`'s store, which
  holds one addon per `(device, cap)` and cannot express two. Array methods fan
  out and concatenate (one failing source loses only its own rows, and says
  so); scalar methods route by the source named inside the id they carry; one
  source is passed through verbatim.

`scripts/check-device-scoped-wrapper-mounts.ts` (CI) refuses a device-scoped
wrapper that resolves `singleton`, and a device-scoped wrapper COLLECTION whose
runtime switch never reaches `requireDeviceCollection`.

- **A method may be OPTIONAL on a source.** `providerOptional: true` on a
  method of a collection cap makes it optional on `InferProvider`, because a
  source's ABSENCE of it can be a fact about that source rather than an
  omission: the recorder's `analytics` source is a time WINDOW over footage
  with no file behind it, so `videoclips.readClipBytes` has nothing to read.
  The runtime already named that case — `callSource` answers a missing method
  with `NOT_IMPLEMENTED` naming cap, source and method, and
  `isCollectionArrayMethod` lets a missing ARRAY method contribute `[]` rather
  than emptying the fan-out. Demanding it instead buys a throwing stub, and a
  throwing stub reads exactly like a method somebody forgot. Never use it to
  soften a method nobody has got round to writing.

A clip is a query-time window (`listClips` visit grain
`VISIT_MERGE_GAP_MS` 30 s when availability exists, else per-event
`EVENT_PAD_MS` −5 s/+10 s). `kind: 'native'` is a placeholder. The viewer plays
a clip in its own layer, structurally detached from the playback machine
([D570](../decisions/adr-0570-a-clip-plays-in-the-cameras-own-frame-and-the-playback-machine-is-structurally-detached-while-it-does.md));
a body of files has no time axis, so no epoch reaches a clip and it does not
call `getClipPlayback` (HLS). The admin `EventDetailPanel` is the only HLS
consumer.

**Who persists a clip file is a property of the SOURCE.** The recorder's
`analytics` source persists nothing — do not give it clip files or a clip
retention sweep, see
[post-analysis.md](post-analysis.md#disk-wins-reconcile) and
[2026-08-08-videoclips-timeline.md](../design/2026-08-08-videoclips-timeline.md).
The `homekit` source is the opposite by construction: it is registered by the
addon that TEED the bytes, so it owns the files it lists, on its own
`homekitClips` location and under its own per-camera retention (`keepClips`,
`clipRetentionDays`, defaulting to 14 days)
([D571](../decisions/adr-0571-the-homekit-clip-source-is-registered-by-the-addon-that-teed-the-clips-so-there-is-no-hand-off-and-its-states-are-the-five-that-already-exist.md)).

## A composition emits only explicitly planned capability events (D670)

A capability event may declare a `fromState` rule: the event is represented by
a strict numeric advance of one runtime-state field. This keeps the event name,
payload schema and state relationship with the capability that owns them. A
composition does not infer an `EventCategory` from that name; the composition
planner maintains an explicit mapping and refuses an event without one. It also
refuses a payload it cannot construct from the composed device id and advancing
timestamp.

The planner emits events only for new or added capabilities. A replacement
continues to use the native provider's event stream and cannot become a second
authority. At runtime a finite target seed does not emit; a strictly newer
finite value advances the event high-water. The composer emits that event
before its owned-field write, so a failed write retry cannot lose or duplicate
the event. See [D670](../decisions/adr-0670-compositions-derive-events-from-numeric-state-advances-and-key-stateful-calls-by-ast-path.md)
and the [device-model composition rules](device-model.md#composed-devices-a-device-built-from-other-devices-fields).

## A collection is not complete until every declarer has registered

A collection cap is rebuilt from the providers registered *at that moment*. An
addon registers only after its runner has forked and initialised, so between hub
start and that moment a collection is legitimately short — and a consumer that
reads "absent" as "does not exist" will be wrong, loudly, on every restart.

The registry knows more than the collection does. `declareFromManifest` runs at
addon-**load** time, so the hub knows which addons *owe* a capability long before
they supply one:

```ts
const outstanding = registry
  .getManifestDeclarers(capName)
  .filter((addonId) => !registry.hasProvider(capName, addonId))
```

Non-empty means "not yet"; empty means "this is all there is". Use it wherever
absence would otherwise be reported as a final answer to a caller — never to
wait, poll or retry, which is still forbidden ([D3](../decisions/adr-0003.md)).
`/api/oauth2/authorize` is the worked example: outstanding declarers turn a
`400 unknown integration` into a `503 temporarily_unavailable` that names the
addon, and `GET /api/oauth2/integrations` reports `complete: false`
([D101](../decisions/adr-0101.md)).

An addon that is installed but **disabled** stays outstanding forever. That is
deliberate — it is the diagnosis — but a caller must not present it as a
condition that resolves on its own.
