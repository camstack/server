---
title: addon-provider-homeassistant — package notes
covers:
  - packages/addon-provider-homeassistant/**
---

# addon-provider-homeassistant — package notes

Moved verbatim from `packages/addon-provider-homeassistant/AGENTS.md` on 2026-10-09 so that root +
package `AGENTS.md` stay inside the 32 KiB Codex reads. That file keeps
the intro and the skill pointers and links here; edit the notes HERE.

## Four things that are a wire format

Change one and an operator's Home Assistant loses an entity, its recorder
history and its dashboard placement, with nothing in any log.

1. **`unique_id`** — `<deviceId>_<entity>`, or `<deviceId>_<zoneId>_<macro>_<suffix>`
   for a zone entity, or `<deviceId>_consumable_<rawKey>_<level|status|remaining|reset>`
   for a consumable item (the RAW provider key, while the entity/topic segment
   is its slug). Derived from the NUMERIC device id, never from `stableId`:
   `(addonId, stableId)` is the addon-facing identity and this export was the
   only place it left the hub. Alexa (`endpointId`), HomeKit
   (`camstack:camera:<deviceId>`) and Google (`id`) all key on the number; this
   is the fourth export aligning with the other three.
2. **The component key** — `<platform>-<entity-kebab>`. The component computes
   its entity's identity as `<device_id>_<component_key>`, so the key is as
   load-bearing as the `unique_id`.
3. **The topics** — built only in `src/ha-export/topics.ts`. Never derive one by
   editing another; the previous exporter did (`stateTopic.replace(…)`) and it
   broke the moment two components had different layouts.
4. **`device_id` / `dev.ids[0]`** — `camstack-<deviceId>`, built ONLY by
   `deviceKeyFor`. Changing it makes HA create a second device and orphan every
   entity on the first. A synthetic device has no numeric id and is the one
   documented exception: `camstack-<syntheticId>`, via `syntheticDeviceKeyFor`.

**The claim that used to justify (1) and (4) — "numeric ids are reallocated by a
re-sync" — is false.** `allocateNextDeviceId`
(`@camstack/system`, `builtins/device-manager/device-meta-store.ts`) is a
monotonic counter: `nextDeviceId ?? 1`, then `current + 1`. A freed id is never
re-issued, so the worst case after a re-adoption is an ORPHANED entity, never a
mis-addressed one — the same worst case a changed `stableId` already had. Do not
reinstate it.

**The component composes the key in exactly one place**, `CamStackDevice.device_key`
(`custom_components/camstack/coordinator.py`), and only because the camera entity
comes from the export MEMBERSHIP, which carries no `dev.ids[0]`. Every pushed
entity takes the key verbatim off the wire. The two compositions are pinned to the
same literal by `__tests__/entity-catalog.spec.ts` ("the cross-side identity
contract") and `tests/test_entities.py::test_the_device_key_matches_the_hub_rule`.

Two namespaces that look alike and are not: **entity/topic segments are snake**
(`person_last_image`), **component keys are kebab** (`image-person-last-image`).

## Every value has a listener. Here is which one.

The operator's requirement is that nothing in Home Assistant polls the hub.
Every entity below is fed by a subscription in `ha-export.addon.ts`; anything
not in this table is fed by the reconcile only, and that is stated rather than
implied.

| Entity | Source | Kind |
| --- | --- | --- |
| `online` | `device.online` / `device.offline`, plus the `device-status` slice on `device.state-changed` | event |
| `triggered` | `motion.on-motion-changed` and `pipeline-analytics.track-lifecycle` | event |
| `motion_detected`, `motion_last_detection` | `motion.on-motion-changed` (+ the `motion` slice) | event |
| `<macro>_detected` / `_last_detection` / `_last_image` | `pipeline-analytics.track-lifecycle` | event |
| `<macro>_last_label` | same event — `label` for person/animal, `plateText` for vehicle | event |
| `last_detection`, `last_image` | same event | event |
| `<zone>_<macro>_detected` / `_last_detection` / `_last_image` | same event, via `zonesVisited` | event |
| `<zone>_<macro>_objects` | `zone-analytics.occupancy-changed` | event |
| `battery`, `charger`, `sleeping` | the `battery` slice on `device.state-changed` | event |
| `objects`, `<macro>_objects` | `zone-analytics.occupancy-changed` — the FRAME scope | event |
| `<zone>_objects` | same event — the zone's own `totalObjects` | event |
| `audio_last_sound`, `audio_volume` | `pipeline.audio-inference-result` | event |
| `doorbell_pressed`, `doorbell_last_pressed`, `doorbell_press_count` | the `doorbell` slice on `device.state-changed` | event |
| `consumable_<key>_level` / `_status` / `_remaining` (one set per item, any device type) | the `consumables` slice on `device.state-changed`; minted per item by `ITEM_ENTITY_MAP` (`item-entities.ts`) | event — an item set that moved re-announces the device (debounced 2s); a removed item leaves HA only after two agreeing reads (D49) |
| the control switches | `pipelineOrchestrator.getCameraSwitches` | **reconcile only** |
| every synthetic-device entity | `notificationRules.*`, `nodes.topology`, `addons.list`, `serverManagement.getServerPackageStatus` | **reconcile only** — polled numbers, no event exists |
| `reboot`, `ptz_*` buttons | no state — command only | — |
| `consumable_<key>_reset` buttons (resettable items only) | no state — `consumables.reset({ key })` with the provider's raw key | — |

Structure (`entity_change`) is re-derived on `device.registered`,
`device.unregistered`, `device.bindings-changed`, `device.meta-changed` and
`broker.status-changed`, debounced 2s.

### Spec entities that still have NO source

Named here rather than shipped looking implemented:

- **`snapshots_enabled`** — the spec asks for it; there is no authority. There is
  no "snapshots on/off" boolean anywhere in the model (the `snapshot` cap has
  only `getSnapshot` / `invalidateCache`). **Not created**, rather than created
  dead. Creating it would need a new authority first, not a new entity.
- **`snooze` current state** and **`ptz_preset` current state** — both are
  commandable and neither reports back. The `select` shows the last option HA
  sent. `notificationRules.listSnoozes` could feed the first on the reconcile;
  PTZ has no "current preset" concept at all.
- **`audio_detected`** — the entity exists but the track lifecycle rarely
  carries an audio macro; audio arrives on `pipeline.audio-inference-result` and
  the audio event rows. Wire that source before trusting the entity.
- **`package_detected`** — fed only when a track's best class is `package`.
  `pipeline-analytics.package-delivered` / `package-picked-up` are the real
  signals and are not yet subscribed.
- **The synthetic devices** — "Notification Center" and "CamStack Server" from
  the spec's addendum are NOT built. The catalog has no synthetic path yet; the
  sources all exist (`notificationRules.listRules` / `setRuleEnabled`,
  `nodes.topology`, `addons.list`, `alerts.list` for the liveness findings,
  `serverManagement.getServerPackageStatus`).
- **The derived half is a first pass.** `CAP_ENTITY_MAP` covers the base kinds;
  `alarm_control_panel` is mapped but its state is not projected, and nothing
  pushes a value for a derived entity yet — the derived plan announces, the
  reconcile does not yet read those slices.

## Rules that cost real time when broken

- **Never write an authority directly.** The camera switches are rendered from
  `getCameraSwitches` and commanded through `setCameraSwitch`. An HA toggle that
  wrote `recording.setDeviceConfig` itself would be the second knob that
  disagrees with the admin UI ([D62](../../docs/decisions/adr-0062.md)).
- **An unavailable switch produces NO entity.** `available: false` means the
  source did not answer or the function is not configured — a control defaulted
  to `on` is exactly the lie `CameraSwitch.available` exists to prevent. Proven
  on the live hub: 101's `privacy-mask` is `not-configured` and gets no switch.
- **Every value on the wire is a STRING.** The component lowercases binary
  values verbatim; a JSON number or boolean raises inside its state callback,
  which it swallows — the entity then silently never updates again.
- **Images are a URL, never bytes.** The push transport collapses anything over
  2048 characters to `__image_updated__:<ts>`. Image entities carry a signed,
  expiring link that HA fetches on demand from the `ha-media` data plane.
- **The dedup cache is cleared when the link returns — and that is only HALF the
  recovery.** The reference implementation never invalidates its cache, so an HA
  that restarted stayed blank until each value happened to change. Do not
  "simplify" that away. Clearing it stops the sender suppressing values; it does
  not send any, and shipping only that half left every entity blank for up to
  `reconcileIntervalSec` (300s) after each reconnection. `onLinkRestored` →
  `ReachabilityReconciler` → a full reconcile is the other half.
- **A reachability re-announce is bounded and DEFERRED, never dropped.** One run
  per 30s (the heartbeat interval, and the floor `startTimer` already clamps the
  reconcile to), coalesced across brokers because the reconcile is fleet-wide. A
  request inside the window waits for its edge: the dedup cache is already gone
  by then, so dropping it recreates the defect the class exists to fix.
- **`enabled_by_default` is a decision, never inferred.** It is a required field
  on every `EntitySpec`. It used to be derived from the entity's name and
  platform — a rule written for the camera fan-out (~73 entities per camera,
  ~880 per fleet) that then applied to every device, so every derived sensor
  exported **disabled**: a thermometer's temperature arrived switched off. The
  derived half is 228 entities across 115 devices on the live hub — 2 per device,
  3 at most — and has no fan-out to protect against, so everything there arrives
  enabled. Never flip the camera fan-out on to "fix" the derived half.
- **The `broker` pin has exactly two rules, and "pin everything" is not one of
  them.** Both halves of this bundle were pinned wholesale on 2026-08-09 and it
  took the hub down for 20 minutes. What is true:

  1. **The EXPORT half pins an ID-KEYED call — and from a forked addon that pin
     currently does NOTHING.** `getBrokerConfig({ id })` unpinned is answered by
     the first-registered provider — Homematic here — which returns `null` for a
     broker it does not own, indistinguishable from "no such broker". The pin
     fixes that **on the hub's tRPC surface only**:

     ```
     hub,   getBrokerConfig {id:'ha_001'}                              → null
     hub,   getBrokerConfig {id:'ha_001', addonId:'provider-…'}        → the config
     addon, getBrokerConfig {id:'ha_001', addonId:'provider-…'}        → null   ← !
     ```

     The third row is the whole finding, measured on the live hub 2026-08-09:
     from a forked addon the pinned call returns exactly the UNPINNED answer.
     `parent-unowned-call.ts` lifts only `nodeId` and `deviceId` out of a child's
     args into a route (`CapRouteOpts` has no `addonId` field at all), so for a
     scalar method on a collection cap the resolver picks one provider and the
     `addonId` is silently discarded. Every earlier measurement that "proved the
     pin works" was taken from the hub surface, never from the addon's.

     Consequence, until it was fixed: `ha-export: broker returned no
     configuration, not exporting to it {brokerId=ha_001}` on every reconcile,
     and no operator setting could change it. Fixed in the kernel, not here
     ([D105](../../docs/decisions/adr-0105.md)) — and note the shape, because
     the first attempt fixed only `onUnownedCall` and changed nothing:
     `LocalChildRegistry`'s sibling short-circuit runs FIRST and was answering
     the call from `provider-homematic` before the router was ever consulted.
     Do not "work around" any of this by importing the provider half.
  2. **Nothing else pins.** Not the enumeration, not the provider half.

  **Never pin an enumeration.** `list`'s contract is already a fan-out UNION, so
  a pin converts this provider's absence from "returns fewer rows" into
  `BAD_REQUEST: Capability "broker" has no provider with addonId
  "provider-homeassistant"`. That took the operator from "one instance, switched
  off" to "no instance at all".

  **Never pin a cap this addon PROVIDES.** This is the one that actually broke
  the hub. `addon.ts` registers `broker`, `device-adoption`,
  `notification-output` and `addon-routes` by RETURNING them at the end of
  `initialize()` — so they do not exist for the whole of its own boot, and
  `registry.restore()` runs inside that window, activating 239 devices that each
  call `broker.subscribe` / `broker.getState`. Pinned, those calls name a
  provider that cannot exist yet: the cap cannot register until restore
  finishes, restore cannot finish until the pin resolves. `initialize()` never
  completed again across two restarts and all four capabilities stayed
  unregistered while the addon still reported `running` with 12 declared caps.
  In-process a pin buys nothing anyway — `localProviderLink` short-circuits any
  cap the calling process already provides, so the call never reaches the
  resolver a pin would steer.

  `scripts/check-collection-cap-pin.ts` enforces exactly this split: an id-keyed
  call must pin, an enumeration need not, and a package is exempt for the caps
  its own manifest entry declares. The reasoning lives in
  `src/ha-broker-source.ts`. Keep the guard: the pin is right on the hub path and
  will be right everywhere once the kernel honours it — but until then it is
  enforcing an intent, not a behaviour, and no code should read it as proof that
  a forked addon reaches the provider it named.
- **This addon runs ALONE — no `execution.group`.** It was given
  `group: 'notifiers'` on 2026-07-15 as "purely a process-count optimization"
  (9b895fb5f), which is precisely what D29 forbids for a device provider. On
  2026-08-09 a sibling in that group (`advanced-notifier`) was quarantined by
  renaming its directory while its entry stayed in `/data/addons/manifest.json`;
  the shared runner then died on `Failed to load "advanced-notifier": No
  package.json at …`, five times, and the crash circuit-breaker stopped
  respawning it. The Home Assistant provider went with it: `broker.list` lost
  `ha_001` for ~2h50m, `notification-output` lost ALL THREE providers, and three
  `restartAddon` calls answered `{success:true}` without ever spawning a process.
  `scripts/check-runner-group-isolation.ts` now refuses the regression.
- **The instance switch GATES the per-device panel, and the switch is stored
  under a dynamic key.** `exportTo:<brokerId>` cannot be in `DEFAULT_CONFIG`
  (one key per broker the hub happens to know), and `BaseAddon.resolveConfig`
  copies only keys present in the defaults — so reading it off `this.config`
  yields `undefined` for ever. It shipped that way: `getGlobalSettings` returned
  `value: true` (the FORM reads the store), every reconcile logged `brokers=0`,
  and the device Export tab rendered its "Not configured" card, with no operator
  action able to change either. Read these keys through `resolveGlobalStore()` —
  `enabledBrokerIds` in `membership.ts` is the only derivation.
- **The echo guard outranks membership.** A device whose `addonId` is
  `provider-homeassistant` is never exported back, even if selected.

## Membership

`brokerId → deviceId[]`, in the export addon's own settings, and it is the ONLY
export-membership store. The per-device Export panel renders one switch per
enabled broker over it; the `device-export` cap's `exposeDevice` /
`unexposeDevice` apply to every enabled broker at once, because the cap is the
common surface across export targets and has no notion of a broker.

Field keys in the device Export tab are namespaced `haExport:<deviceId>:<brokerId>`.
The device-details form flattens fields by `key` across every contributing
section, so a bare `enabled` collides with the Alexa and HomeKit exporters'
identically-named fields — last writer wins, and the operator sees another
exporter's value in this one's toggle.

## Retired

`@camstack/addon-export-ha-mqtt` was deleted on 2026-08-09 and deprecated on
npm. Its exposed set was empty (`linkState: unlinked`, `exposedDeviceCount: 0`),
so nothing was migrated. Its capability-map discipline survives in
`entity-catalog.ts` — `CAP_ENTITY_MAP` + `CAPS_NOT_EXPORTED` + `unclassifiedCaps()`,
still with no default branch ([D48](../../docs/decisions/adr-0048.md)).
