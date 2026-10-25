---
title: Home Assistant native export — what "complete" means, and the entity map that delivers it
last-verified: 2026-08-26
covers:
  - packages/addon-provider-homeassistant/src/ha-export/**
---

# Home Assistant native export (MQTT) — SUPERSEDED

> **What this is:** a dated design and measurement, written 2026-08-05 against
> the MQTT exporter, superseded four days later and never deployed. It is
> HISTORY — kept for the measurements and the capability→entity reasoning that
> shaped the successor, not as a description of code anyone should verify
> against. It therefore claims `covers:` and not `applies-to:`: it speaks about
> `ha-export/` without vouching that anyone re-read that directory
> ([D145](../decisions/adr-0145.md)). The re-verification notes below are frozen
> at the dates they name.

> **Superseded on 2026-08-09** by
> `../superpowers/specs/2026-08-04-ha-native-export-design.md` (planning repo: superpowers/specs/2026-08-04-ha-native-export-design.md).
> The MQTT exporter (`@camstack/addon-export-ha-mqtt`) was retired and its
> package deleted; Home Assistant is now served over one path only, an HTTP push
> to a custom component. Everything below is kept for the MEASUREMENTS and the
> capability→entity reasoning it records — the file paths it names no longer
> exist, and are written here without backticked paths for that reason.
>
> **Status, re-verified 2026-08-14 against
> `packages/addon-provider-homeassistant/src/ha-export/`.**
>
> **Re-verified again 2026-08-26**, against the same directory, after
>  (the `status` sensor now distinguishes `ok` / `switched_off` /
> `degraded` / `unknown` — D62 applied to a camera's own HA entity; the
> deprecated `CameraSwitch.getCameraSwitches`/`setCameraSwitch` pair is gone,
> replaced by `camera-function-writes.ts` + `camera-functions.ts`; `snooze`
> and `audio_detected` gained real feeds; `ptz_preset` stays an explicit,
> guarded non-goal; `getServerPackageStatus` is now called per-node) and
>  (six entities added to the Notification Center synthetic
> device). None of this contradicts anything below — none of it is
> mentioned below, since this document's file inventory (§ next paragraph)
> and entity map were written before those modules existed. Nothing here
> needed correcting; the applies-to glob simply moved.
>
> **BUILT.** The successor shipped, in two tiers, and it kept this document's
> load-bearing idea: an entity comes from a capability slice (§3), the map is an
> allowlist keyed by capability name, and everything it will not map is DATA with
> a reason rather than a silent `default: sensor`. Where to read it now:
> `entity-catalog.ts` (the map plus the unmapped list, both typed),
> `state-projector.ts` (slice → value), `command-routes.ts` (writable → cap
> method), `topics.ts` (every topic string), `camera-entities.ts`,
> `synthetic-devices.ts`, `membership.ts`, `reconcile-fingerprint.ts` and
> `push-client.ts`. **Tier B** — the native platforms — landed 2026-08-14:
> `native-platforms.ts` binds capabilities to ten real Home Assistant platforms
> (`cover`, `valve`, `lock`, `alarm_control_panel`, `climate`, `fan`,
> `humidifier`, `water_heater`, `vacuum`, `media_player`), built by component
> 0.4.0 and negotiated per broker by `component-support.ts` rather than assumed
> from a version — [D140](../decisions/adr-0140.md).
>
> **Therefore mostly false below, and left standing only as the reasoning that
> led here:** §5.3's deferred list. `climate-control`, `fan-control`,
> `vacuum-control`, `lawn-mower-control`, `alarm-panel`, `water-heater`,
> `media-player`, `script-runner`, `automation-control`, `event-emitter`,
> `pet-feeder`, `motion-trigger` and `ptz-autotrack` all carry a row in
> `CAP_ENTITY_MAP` today. `ptz` and `snapshot` also reach Home Assistant, but
> through `camera-entities.ts` rather than the derived plan, which is why they
> sit in `CAPS_NOT_EXPORTED` with that as their stated reason.
>
> **NOT built, and deliberately.** Everything in §4 marked *never* is still
> never — a track, a media handle and a zone polygon are not entities. Of §5.3's
> deferred list, `consumables`, `audio-metrics`, `audio-analysis` and `notifier`
> are still unexported, and `cover`, `valve`, `humidifier`, `color` and
> `weather` never were CamStack capability names at all: those Home Assistant
> platforms are fed by `control`/`switch` slices absorbed by
> `native-platforms.ts`. §5.7's `via_device` bridge device and per-NODE
> availability were never built.
>
> **Dropped with the transport.** Every MQTT-shaped mechanism in §5: the topic
> algebra (§5.1), retained state, the Last Will and the three availability levels
> (§5.4, C5), the birth message (C4), and §5.6's argument for owning an
> `mqtt.js` client. The push component replaced all of it — availability now
> follows the component's own reachability, reconciled by
> `reachability-reconcile.ts`. §5.6b's namespaced device-settings keys survived
> the transport change and are still the rule.

`@camstack/addon-export-ha-mqtt` has existed for months. Nobody ever wrote down
what it was supposed to do when it was finished, so nobody could tell that it
wasn't. This document fixes that first, then designs against the definition.

Everything below was measured against the live cluster on 2026-08-05 — 293
devices, 16 device types, 14 device roles, one live HA broker (`ha_001`). No
shape in this document is invented.

## 1. The measurement that motivates the rework

`resolveExportedKind` in
_(deleted with the MQTT exporter)_ maps a
**`DeviceType`** to one of five kinds, and everything it does not recognise
falls through to `'sensor'`. Run that function over the live inventory:

| Device type | Count | Today's kind | Does the entity ever get a state? |
| --- | ---: | --- | --- |
| `switch` | 106 | `switch` | **yes** |
| `siren` | 7 | `switch` | yes (but HA has a `siren` component it should use) |
| `light` | 3 | `switch` | yes |
| `camera` | 12 | `camera` | **no** — `image_topic` is declared and nothing ever publishes to it |
| `sensor` | 92 | `sensor` | **no** — see below |
| `switch`… | | | |
| `control` | 34 | `sensor` | no |
| `container` | 12 | `sensor` | no |
| `button` | 11 | `sensor` | no (`role` is `null` on all 11, so the doorbell branch never fires) |
| `climate` | 5 | `sensor` | no |
| `image` | 3 | `sensor` | no |
| `hub` | 2 | `sensor` | no |
| `vacuum` | 2 | `sensor` | no |
| `lawn-mower` | 1 | `sensor` | no |
| `alarm-panel` | 1 | `sensor` | no |
| `event-emitter` | 1 | `sensor` | no |
| `presence` | 1 | `sensor` | no |

**116 of 293 devices work. 177 would appear in Home Assistant as an entity
that never receives a value.**

The 92 sensors are worse than empty. `StatePump` publishes to a `sensor`
route from exactly two feeds — `MotionOnMotionChanged` and
`BatteryOnStatusChanged` — and both write to the *same* `stateTopic`. 51 of the
92 sensors have a `battery` slice bound. So "Indoor Temperature" would publish
`100`, and an operator reading their dashboard would see a battery percentage
under a temperature label. A wrong value is a worse failure than a missing one:
nothing about it looks broken.

None of this is a bug in the sense of a mistake. It is what happens when the
finish line was never drawn.

## 2. What "complete" means

Eight criteria. Each one is stated so that it can fail — if a criterion cannot
be violated by a plausible implementation, it is not a criterion, it is a
sentiment.

### C1 — Coverage is by capability, and the gaps are named

Every capability slice a device carries either **maps to an HA component**, or
appears in a published **unmapped list with a reason**. There is no fallback
kind. An unmappable slice produces no entity at all, rather than an entity that
never speaks.

The failure this prevents is exactly §1: a `default:` branch that manufactures a
`sensor` for a `vacuum`.

### C2 — Fidelity: the discovery payload carries what CamStack actually knows

`device_class`, `unit_of_measurement`, `state_class`, `options`, `min`/`max`/
`step` and `suggested_display_precision` are read **from the live slice**, not
hardcoded per kind. CamStack already carries them: `control` puts
`options`/`unit`/`min`/`max`/`step`/`precision` in the slice on purpose
(`packages/types/src/capabilities/control.cap.ts` says so in prose), and
`numeric-sensor`, `temperature-sensor`, `humidity-sensor` and `pressure-sensor`
each carry a live `unit` that overrides the canonical one.

The failure this prevents: a Fahrenheit feed rendering as `°C` because the
exporter hardcoded the role's canonical unit.

### C3 — Grouping: one CamStack device tree is one HA device

Entities are attached to an HA `device` block keyed on the **root** of the
CamStack parent chain, stopping before a `hub`-type ancestor. On the live
cluster this yields:

- the 30-odd entities of `318:container:Robot primo piano` (vacuum, 3 switches,
  4 controls, a map image) as **one** HA device;
- `585:siren` under `103:camera`, so the camera's siren is a control on the
  camera's card;
- `291:sensor:Indoor Temperature` under `290:container` and **not** under
  `289:hub:Ecowitt Gateway`, so the eight Ecowitt sub-stations stay distinct
  devices instead of collapsing into one.

The failure this prevents: 293 orphan entities in a flat list.

### C4 — Liveness: correct within a debounce window, and correct after either side restarts

Three mechanisms, all required:

1. **Retained state.** Every state publish is retained, so a fresh HA
   subscribes and immediately has values.
2. **Reconcile on connect.** On every broker (re)connect the exporter reads
   `deviceState.getAllSnapshots` and republishes every entity. Events are
   telemetry and may be dropped (D8, D11) — a pump alone is not a contract.
3. **Birth message.** The exporter subscribes to `<prefix>/status` and
   republishes discovery **and** state when HA announces `online`. HA discards
   its discovery cache on restart if the broker did not retain; without this the
   entities come back as `unavailable` and stay there.

The failure this prevents: the exporter is "working" and HA shows a stale value
from two days ago, because the only path to HA was a bus event that was dropped.

### C5 — Availability has three levels, and all three are wired

| Level | Topic | Set by |
| --- | --- | --- |
| Bridge | `<statePrefix>/bridge/availability` | MQTT **Last Will** — the broker publishes `offline` when the exporter's socket dies |
| Device | `<statePrefix>/device/<deviceId>/availability` | the `device-status` slice's `online` flag |
| Entity | (removal) | an empty retained payload on the discovery topic |

Every entity declares **both** the bridge and its device topic with
`availability_mode: "all"`, so an entity is available only when the exporter is
running *and* the device is online.

The bridge level is the one that matters for the brief in the queue: *"an
offline node does not leave stale entities."* Today the exporter publishes
`online` once at expose time and never publishes `offline` at all — there is no
Last Will, so a killed runner leaves 116 entities reading their last value
forever.

### C6 — Commands round-trip, and a failed command does not lie

Every writable entity's HA command reaches a capability method, and the
confirmed value is echoed to the state topic **after** the cap call resolves.
A cap call that throws publishes nothing and logs — HA's optimistic update is
then corrected by the next reconcile rather than silently confirmed.

The failure this prevents: `optimistic: false` in the payload while the code
acks unconditionally, which is the same as `optimistic: true` with extra steps.

### C7 — Idempotence, and no echo

Republishing the full plan is a no-op for HA (retained, same `unique_id`, same
payload). And devices whose `addonId` is `provider-homeassistant` are **never
exported** — on the live cluster that is `1025:event-emitter`,
`1026:container` and `1027:presence`, all of which came *from* HA. Exporting
them back creates a device that mirrors itself across the bridge.

### C8 — The non-goals are written down

§4. A criterion that says "expose everything" is not a definition, it is an
absence of one.

## 3. The principle: an entity comes from a capability slice, not a device type

This is the single structural change, and it is not a new idea in this repo —
it is [D12](../decisions/adr-0012.md) applied to exports: *per-device
aggregation walks `getBindings(deviceId)` only, never a global list*, because
cap names are shared across vendors and a device type tells you almost nothing.

Measured on the live cluster: **twelve** capabilities are bound to all 293
devices regardless of type — `audio-analysis`, `camera-pipeline-config`,
`camera-streams`, `detection-pipeline`, `device-ops`, `device-status`,
`feature-probe`, `motion-detection`, `pipeline-analytics`, `snapshot`,
`videoclips`, `webrtc-session`. What actually distinguishes a vacuum from a
thermostat is the *rest* of the binding list.

Two consequences:

1. **The map is an allowlist, keyed by capability name.** A denylist would have
   to be updated every time a new universal wrapper cap appears — and it would
   fail open, publishing a garbage entity. An allowlist fails closed.
2. **A device can produce many entities.** `103:camera` carries `motion`,
   `battery`, `doorbell`, `intercom`, `ptz`, `snapshot` and more. The unit of
   export is `(deviceId, capName)`, not `deviceId`.

The read path is `deviceState.getSnapshot` / `getAllSnapshots`, which returns
exactly `Record<capName, slice>`; the change feed is
`EventCategory.DeviceStateChanged`, which carries `{deviceId, capName, slice}`.
The kernel already publishes the shape this design needs, for every capability,
uniformly. No per-cap event subscription is required, which is why the previous
pump's four hand-wired subscriptions covered four of the twenty-odd caps that
matter.

## 4. What has no Home Assistant equivalent

Stated as decisions, with the reason, because "not yet" and "never" are
different commitments.

### A track is not an entity — **never**

A CamStack track is a time-bounded observation: it begins, accumulates
best-shot media and enrichment (faces, plates, zones), and ends. Home
Assistant's entity model is a *thing with a current state*. There is no HA
entity whose state is "an occurrence that existed between t0 and t1". Forcing
one produces an entity whose state is an opaque id and whose recorder history
is meaningless — it cannot be graphed, templated or used in a numeric
condition.

What is exportable, and what this design exports instead:

- the **aggregate** — `zone-analytics` object counts per zone → `sensor` with
  `state_class: measurement`, which *is* a thing with a current state;
- the **occurrence** — HA's `event` MQTT platform (`event_types`), which exists
  precisely for momentary happenings and is the correct home for a doorbell
  press and for a classified detection. An event is not an entity with a
  lifetime; it is a timestamped fact with attributes, which is what a track's
  *emission* is.

The track's identity, its media handles and its enrichment stay on the CamStack
side. HA gets told that a person was seen, not handed the object that says so.

### Media is not an entity — **never**

Clips, recorded segments, best-shot crops, thumbnails, embeddings, face and
plate galleries. These are bytes addressed by handle. HA can display a still
(`camera` / `image` components take a topic or a URL) and that is the whole of
the mapping; a clip has no HA type and inventing a `sensor` whose state is a
file path helps nobody.

### Geometry is not an entity — **never**

Motion zones, privacy masks, detection regions, line-crossing definitions.
`MaskShape` is `rect | polygon | grid | line`. HA has no polygon entity. The
*derived* per-zone occupancy count is a sensor and is exported as one; the
polygon that defines the zone is configuration and stays in the admin UI.

### The execution graph is not an entity — **deferred, not never**

Pipeline steps, decode sessions, inference engines, per-device pipeline
switches. Several of these are genuine booleans an operator might want to
automate on ("disable detection while I'm home"). They are deferred because
they are *infrastructure* toggles whose semantics change with the pipeline, and
a retained HA switch pointed at a renamed step is a switch that silently does
nothing. Revisit once the per-device pipeline switches settle.

### Node and runner health — **deferred**

A CamStack node's online state is a real thing HA could show, but it belongs to
a *bridge device* this design does not yet publish (see §5, `via_device`).

## 5. The design

### 5.1 Topic algebra

One module owns every topic string. The current code derives state topics by
string-surgery on the discovery topic
(`entry.stateTopic.replace(/\/[^/]+$/, '/availability')`), which breaks the
moment a component's topic layout differs — and it already does, for `light`.

```
<discoveryPrefix>/<component>/<objectId>/config      # HA discovery, retained
<statePrefix>/bridge/availability                    # LWT, retained
<statePrefix>/device/<deviceId>/availability         # device-status.online, retained
<statePrefix>/device/<deviceId>/<entityKey>/state    # retained
<statePrefix>/device/<deviceId>/<entityKey>/attrs    # retained, optional
<statePrefix>/device/<deviceId>/<entityKey>/set      # subscribed, HA → CamStack
```

`objectId` = `<idPrefix>_<deviceId>_<entityKey>`, e.g. `camstack_871_control`.
`entityKey` is the capability name with `/` and `.` normalised, plus a suffix
for caps that fan out to more than one entity (`brightness` → the `light`
entity's brightness topics, not its own entity).

State topics deliberately live under their **own** prefix, not under
`homeassistant/`. The discovery prefix is HA's namespace for configuration; the
current code publishes device state into it, so an HA `discovery_prefix` change
orphans every retained state message as well as every config.

### 5.2 The entity map

Read as: *this capability slice, on a device, produces these entities.*
The authoritative copy is _(deleted with the MQTT exporter)_
— this table is the argument, that file is the contract.

| Capability | HA component | State | Writable via |
| --- | --- | --- | --- |
| `switch` (on `DeviceType.Switch`) | `switch` | `ON`/`OFF` from `on` | `switch.setState` |
| `switch` (on `DeviceType.Siren`) | `siren` | `ON`/`OFF` from `on` | `switch.setState` |
| `switch` + `brightness` (on `DeviceType.Light`) | `light` (`schema: json`) | `{state, brightness}` from both slices | `switch.setState`, `brightness.setBrightness` |
| `lock-control` | `lock` | the five states, verbatim | `lock`/`unlock`/`open` |
| `control` `kind: numeric` | `number` | `value`, with `min`/`max`/`step`/`unit` from the slice | `control.setValue` |
| `control` `kind: select` | `select` | `value`, `options` from the slice | `control.setValue` |
| `control` `kind: text` | `text` | `value` | `control.setValue` |
| `control` `kind: datetime` | `sensor` `device_class: timestamp` | ISO `value` | — (see note) |
| `button` | `button` | *(stateless)* | `button.press` |
| `binary` | `binary_sensor`, `device_class` from `DeviceRole` | from `on` | — |
| `connectivity` | `binary_sensor` `connectivity` | from `connected` | — |
| `motion` | `binary_sensor` `motion`, `off_delay` from `autoClearAfterMs` | from `detected` | — |
| `contact` | `binary_sensor` `door` | from `entryOpen` | — |
| `flood` | `binary_sensor` `moisture` | from `flooded` | — |
| `smoke` · `gas` · `carbon-monoxide` · `vibration` | `binary_sensor`, matching class | from `detected` | — |
| `tamper` | `binary_sensor` `tamper` | from `tampered` | — |
| `temperature-sensor` | `sensor` `temperature` | `celsius`, unit from slice `unit` ?? `°C` | — |
| `humidity-sensor` | `sensor` `humidity` | `percent`, `%` | — |
| `pressure-sensor` | `sensor` `pressure` | `hpa`, `hPa` | — |
| `ambient-light-sensor` | `sensor` `illuminance` | `lux`, `lx` | — |
| `numeric-sensor` | `sensor` | `value`, unit + precision from the slice | — |
| `enum-sensor` | `sensor` (`timestamp`/`date` when `format` is set) | `value` | — |
| `battery` | `sensor` `battery` `%`; a `binary_sensor` when `binary === true` | `percentage` | — |
| `power-meter` | one `sensor` per PRESENT metric (power, energy, voltage, current) | the metric | — |
| `air-quality-sensor` | one `sensor` per PRESENT metric (CO₂, VOC, PM2.5, PM10) | the metric | — |
| `doorbell` | `event` (`event_types: ["press"]`) | `{event_type:"press"}`, unretained | — |
| `presence` | `device_tracker` | `home` / `not_home` / zone from `state` | — |
| `snapshot` | `camera` (`image_topic`, `image_encoding: b64`) | periodic JPEG from `snapshot.getSnapshot` | — |
| `image` | `image` (`url_topic`) | `url` | — |
| `update` | `update` `firmware` | `{installed_version, latest_version}` | — |
| `native-object-detection` | one `binary_sensor` per `supportedClasses` entry, `off_delay: 30` | from `lastByClass` | — |
| `privacy-mask` | `binary_sensor` (diagnostic) | from `enabled` | — |
| `zone-analytics` | `sensor` | `frame.totalObjects` | — |

Notes on the judgement calls:

- **`control` `kind: datetime` maps to a read-only `sensor`, not HA's
  `datetime`.** HA's MQTT integration has no `datetime` platform (the
  `datetime` domain exists but is not MQTT-discoverable). Publishing a `text`
  entity for a timestamp gives an operator a free-text box that can produce a
  value `control.setValue` rejects. A read-only timestamp sensor is honest.
- **`battery` with `binary: true` must not be a percentage sensor.** The cap
  documents that `percentage` is then a coarse stand-in (100 = normal). A
  `sensor device_class: battery` reading `100` for a device whose battery is
  merely "not low" is the same class of lie as §1's temperature-showing-battery.

### 5.3 The unmapped list, in code

Not prose — `UNMAPPED_CAPS` in
_(deleted with the MQTT exporter)_ is a typed record with a
`reason` of `deferred` / `no-ha-equivalent` / `infrastructure` and a note.
`deviceExport.getStatus` reports the counts, so the answer to "why is there no
vacuum entity" is one lookup away rather than one archaeology session away.

The distinction is a commitment. `deferred` means a correct payload exists and
the work is scoped — `climate-control`, `fan-control`, `vacuum-control`,
`lawn-mower-control`, `alarm-panel`, `cover`, `valve`, `humidifier`,
`water-heater`, `media-player`, `color`, `consumables`, `pet-feeder`,
`weather`, `script-runner`, `automation-control`, `event-emitter`, `ptz`,
`ptz-autotrack`, `motion-trigger`, `notifier`, `audio-metrics`,
`audio-analysis`. `no-ha-equivalent` means §4 applies.

A capability in **neither** list is `unclassified`, logged as a warning on every
reconcile and surfaced in `getStatus`. That is the signal the previous design
had no way to produce: a new capability landed nowhere, produced no entity, and
said nothing about it.

### 5.4 Availability, concretely

- The MQTT client connects with
  `will: { topic: bridgeAvailabilityTopic, payload: 'offline', retain: true, qos: 1 }`.
  On successful connect it publishes `online` retained. On a clean shutdown it
  publishes `offline` retained **before** `end()`, because a graceful
  disconnect suppresses the Will.
- Device availability is published from the `device-status` slice — on the
  connect-time reconcile for every exposed device, and on every
  `DeviceStateChanged` whose `capName` is `device-status`. `device-status` is
  bound to all 293 devices, so this is universal and needs no per-provider
  support.
- Unexpose publishes an empty retained payload to each of the device's
  discovery topics, which is how HA is told to delete an entity, and then
  clears the retained state topics so a later re-expose does not resurrect a
  stale value.

### 5.5 Lifecycle

```
boot ─▶ connect (with LWT) ─▶ publish bridge online
                              ─▶ subscribe <discoveryPrefix>/status
                              ─▶ subscribe every command topic
                              ─▶ RECONCILE
reconnect ────────────────────▶ (same)
HA birth (`online` on status) ▶ RECONCILE
DeviceStateChanged ───────────▶ debounce 250ms per (deviceId, entityKey) ─▶ publish
periodic (default 5 min) ─────▶ RECONCILE
```

`RECONCILE` = read `deviceState.getAllSnapshots` once, re-plan every exposed
device, publish discovery for entities whose plan changed, publish state and
availability for all of them, and retract discovery for entities that no longer
exist. It is the D8 reconcile that makes the event feed an optimisation rather
than a contract.

### 5.6 Transport: the exporter keeps its own MQTT client

The `broker` cap carries `publish` / `subscribe` / `unsubscribe` / `getState`,
so routing every message through the MQTT broker addon looks attractive — one
connection instead of two.

It is not available, and it would be wrong even if it were.

**Not available:** `packages/addon-mqtt-broker/src/mqtt-broker.addon.ts`
implements the unified cap's four pub/sub methods as throws. Its header states
the contract — the addon is a broker *registry*, not a pub/sub proxy, and
consumers "fetch the details with `getBrokerConfig({id})` and spin up their OWN
`mqtt.js` client".

**Wrong anyway:** the Last Will belongs to the exporter's own socket. C5's
bridge level is only meaningful if `offline` fires when *this addon's* process
dies. A shared connection would fire the Will when the *broker addon* dies — a
different and much rarer event — so the exporter could be dead for hours with
every entity reading a stale value, which is exactly what C5 exists to prevent.

So: read parameters via `broker.getBrokerConfig`, resolving the owning
`addonId` from `broker.list` first (without it, the system-collection fallback
hits the first-registered broker provider, which returns `null` for a broker it
does not own), and own the client.

One consequence for status: `EventCategory.BrokerStatusChanged` is emitted only
by the Home Assistant broker provider — the MQTT provider emits nothing. The
exporter therefore learns about its own connection from its own client's
events, and about the *broker entry* by polling, never by waiting for a bus
event that will not arrive.

`broker.add`'s optional `id` belongs to the operator story, not this one: a
broker deleted by a bad rollout can be restored under its original id, so the
exporter's stored `brokerId` still resolves and nothing has to be re-exposed.
Note the MQTT provider currently **rejects** an adopted id (only the HA
provider honours it), so that recovery path does not yet exist for this
exporter's broker kind.

### 5.6b Device-settings field keys must be namespaced

Not a new design point — a live defect this rework has to fix on the way past.
The device-details form **flattens fields by `key` across every contributing
section**. `addon-export-alexa` learned this the expensive way and namespaces
its keys (`alexa:${deviceId}:enabled`); its code says so, and says the symptom:
"the Alexa switch rendered HAP's value".

`export-ha-mqtt` uses bare `enabled`, `streamPreference`, `discoveryPrefix` and
`entityIdPattern`. On any hub with two export addons installed the HA-MQTT
toggle shows — and writes — whichever exporter's value happened to land last.
Keys become `haMqtt:${deviceId}:<field>`.

### 5.7 `via_device` is deliberately absent

`via_device` requires the referenced device to already exist in HA's registry,
which means publishing a bridge device first and ordering the publishes.
Getting it wrong produces an HA warning per entity and no grouping. Deferred
together with node health (§4).

## 6. What this change delivers, and what it leaves

**Delivered**

| | Where |
| --- | --- |
| The entity map, driven by capability bindings, with the unmapped list as data | _(deleted with the MQTT exporter)_ |
| Plan derivation + the root-device grouping rule + the echo guard | _(deleted with the MQTT exporter)_ |
| Pure command decoding, including the refusals | _(deleted with the MQTT exporter)_ |
| Guarded slice reads — no casts on a cross-process payload | _(deleted with the MQTT exporter)_ |
| One place that owns every topic string | _(deleted with the MQTT exporter)_ |
| Discovery rendering with dual availability and the device block | _(deleted with the MQTT exporter)_ |
| Retraction diff — the only persisted state | _(deleted with the MQTT exporter)_ |
| Dispatch, with no ack on a failed call | _(deleted with the MQTT exporter)_ |
| One-category state pump with a cross-cap slice cache | _(deleted with the MQTT exporter)_ |
| LWT, birth message, reconcile, snapshot pump, per-device availability | _(deleted with the MQTT exporter)_ |

115 tests, in _(deleted with the MQTT exporter)_. The entity-map
fixtures are verbatim `deviceState.getSnapshot` responses from the live cluster
(devices 291, 103, 837, 871), not shapes this code produced for itself.

**Left, on purpose**

- The deferred capabilities of §5.3. None is a research problem; each is a
  command surface worth its own pass, and `getStatus` now names them.
- The `event` platform for classified detections. The doorbell press is wired;
  detection classes need the event-kinds taxonomy, which is a queued task of
  its own.
- Per-camera snapshot cadence (one global interval today). Worth noting that
  `snapshot.getSnapshotOverview` returns an `etag` per device from cache
  without ever triggering a capture — the right primitive for skipping an
  unchanged frame, and the obvious next step.
- `via_device` and a bridge device (§5.7), and with them per-NODE availability.
- Nothing here was ever deployed. The MQTT exporter was retired before this
  rework shipped; read the banner for what replaced it.
