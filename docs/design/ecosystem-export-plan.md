---
title: Ecosystem export — HomeKit, Home Assistant, Alexa across every device type
last-verified: 2026-08-26
covers:
  - packages/addon-provider-homeassistant/src/ha-export/**
  - packages/addon-export-hap/src/**
  - packages/addon-export-alexa/src/**
  - packages/addon-export-hap/package.json
  - packages/types/src/capabilities/device-export.cap.ts
  - packages/types/src/device/device-control-resolution.ts
  - packages/types/src/device/device-type.ts
  - packages/types/src/ffmpeg/invocation.ts
  - packages/types/src/utils/export-reconciler.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-panel-device.ts
  - scripts/check-export-coverage.ts
---

# Ecosystem export — HomeKit, Home Assistant, Alexa

> Analysis and executable plan, written 2026-08-13 from the code,
> not from the roadmap's summaries — where the two disagree, the code won.
>
> **What this is now: HISTORY.** The plan was executed (see the 2026-08-14
> status paragraphs below) and is no longer a to-do list. It therefore claims
> `covers:` and not `applies-to:` — it speaks about the export addons without
> vouching that anyone re-read them on `last-verified`
> ([D145](../decisions/adr-0145.md)). Every census, matrix and verdict below is
> frozen at 2026-08-13 and must be read as of that date; the status notes are
> frozen at the dates they name. For what the exporters do TODAY, read
> `docs/reference/capabilities.md` and the addons themselves.
>
> **Status 2026-08-28: a native Google Home exporter now exists, which this
> document argued against.** §verdict 1 and §3.2 both treat Google as something
> HA delivers for free, and by the same reasoning §verdict 3 says to build no
> native Alexa. `packages/addon-export-google` was built anyway, and the
> departure rests on one fact this document itself measures in §1.3: HAP returns
> `['camera']` and Alexa `['camera', 'doorbell']`, so the entire NON-camera
> fleet reaches any of these ecosystems only while Home Assistant is up. The new
> addon covers exactly that gap — switches, dimmable lights, locks, covers — and
> deliberately does not export cameras
> ([D268](../decisions/adr-0273-one-capability-is-one-trait-row-that-declares-reads-and-writes.md))
> or hold any Google credential
> ([D269](../decisions/adr-0269-a-google-export-that-holds-no-google-credential.md)).
> It does not change anything this document says about HA, HAP or Alexa.
>
> **Status 2026-08-14 (second pass): T4 was rebuilt and the Tier B controls
> were routed.** A camera now reaches Home Assistant as one entity per STREAM
> carrying a WebRTC target ([D152](../decisions/adr-0152.md) — the RTSP shape
> in §T4 shipped and produced zero entities), and the six native sub-controls
> Tier B declared but never routed (`fan_mode`, `preset`, `source`,
> `fan_speed`, the two `mode`s and the lock latch, plus `setTargetRange`) now
> write ([D153](../decisions/adr-0153.md)).
>
> **Status 2026-08-14: the first wave and both tiers are BUILT.** The three bugs
> in §verdict 5 are fixed, Tier A gave every writable capability its own command
> route and every derived entity a push path, and Tier B shipped ten native Home
> Assistant platforms behind a negotiated handshake
> ([D140](../decisions/adr-0140.md), component `0.4.0`). HomeKit was widened to
> switches, lights, locks and sensors. Alexa was NOT built, on purpose, for the
> reason in verdict 3 — treat that as a decision, not a backlog item.
> **Departed from a second time on 2026-09-13:** `alarm-panel` now exports
> natively to BOTH HomeKit (`Service.SecuritySystem`) and Alexa
> (`Alexa.SecurityPanelController`, as its own `${deviceId}__alarm` endpoint,
> chosen on the BOUND CAP rather than the device type). So verdict 3's "build no
> native Alexa" has now been overridden twice — once by
> `packages/addon-export-google`, once here — and should be read as the
> 2026-08-13 recommendation it was, not as standing policy. Coverage is
> now enforced rather than argued: `scripts/check-export-coverage.ts` runs in CI
> and fails when a device capability neither exports nor carries a written reason.
> The plan text below is preserved as the reasoning; it is no longer a to-do list.
>
> **Re-verified 2026-08-26** against `packages/addon-provider-homeassistant/src/ha-export/`
> after (camera `status` now distinguishes `switched_off` from
> `unknown`/`degraded`; the phase-4 `CameraSwitch` ledger this document never
> named is now empty; `snooze`/`audio_detected` gained real feeds; `ptz_preset`
> stays an explicit non-goal; `getServerPackageStatus` is called per-node) and
>  (six Notification Center entities). Nothing below names any of
> those specifics, so nothing here contradicts them — this document's per-cell
> claims about writable HA controls (§2's "write broken" entries for `light`,
> `siren`, `lock`, `alarm-panel`) were already superseded by T1 on 2026-08-14,
> which the status paragraph above already says; §2 itself was never updated
> to match and still reads as current on a skim. Treat every HA cell in §2
> as pre-T1/T2/T3/T4 history, exactly as the sentence above already instructs.

## The verdict in five lines

1. **Home Assistant export is the multiplier and it is the only one worth
   widening across all 31 device types.** Everything it exposes reaches Alexa,
   Google and even HomeKit for free through bridges the operator already runs.
2. **`export-hap`'s moat is cameras, and it already holds it** — SRTP streaming,
   HKSV recording, doorbell, PTZ, battery, privacy. Widening it to switches and
   sensors duplicates HA's own HomeKit Bridge. Do it, but *last*, and for the
   reason in §3.2 — not because the matrix has holes.
3. **Alexa needs no new infrastructure.** The expensive half — a published skill,
   the hub as OAuth server, the LWA Event Gateway, proactive `ChangeReport`s —
   **already exists and is live**. Native Alexa for non-camera types is a small
   additive change, and mostly *redundant* with HA↔Alexa. Recommendation: **do
   not build it**; spend the same hours on HA.
4. **The single largest blocker is not in this repo.** New Home Assistant
   platforms (`cover`, `climate`, `lock`, `fan`, `vacuum`, …) require matching
   code in `camstack/homeassistant-component`, whose shipped 0.2.0 source is not
   checked out on this machine. §3.1 splits every task into **Tier A** (works
   with the nine platforms the component already knows) and **Tier B** (blocked
   on that repo).
5. **Three of the four highest-value fixes are bugs, not features** — a write
   path that silently calls the wrong cap, entities publishing to topics nothing
   subscribes to, and HomeKit accessories named "Interruttore N". They are the
   first wave.

---

## 1. Census — what actually exists

### 1.1 The internal device model

`packages/types/src/device/device-type.ts` declares a 31-member `DeviceType`
enum: `camera, hub, light, siren, switch, sensor, thermostat, climate, button,
event-emitter, update, generic, notifier, script, automation, lock, cover, valve,
humidifier, water-heater, fan, media-player, alarm-panel, control, presence,
weather, vacuum, lawn-mower, container, image, pet-feeder`.

Three companion axes matter to an exporter, and skipping any of them produces a
wrong mapping:

- **`DeviceFeature`** (47 members, same file) — `battery-operated`,
  `doorbell-button`, `two-way-audio`, `pan-tilt-zoom`, `cover-positionable`,
  `cover-tilt`, `climate-dual-setpoint`, `fan-speed`, `lock-open`, … A `Cover`
  without `cover-positionable` is a HAP `WindowCovering` with no target position
  and an HA `cover` with no `set_position`.
- **`DeviceRole`** (~48 members) — the sub-type. `Sensor` alone says nothing;
  `motion-sensor` vs `leak-sensor` vs `power-sensor` is the whole mapping.
- **Capabilities** — 80 device-scoped caps in
  `packages/types/src/capabilities/`. **This is the real axis.** The doctrine is
  already written into the live exporter
  (`packages/addon-provider-homeassistant/src/ha-export/ha-export.addon.ts`,
  `SUPPORTED_DEVICE_KINDS` docblock): *coverage is decided by a device's
  capabilities, not its type, and restricting the picker by type is what confined
  the previous exporter to cameras.* Every plan below obeys it — a table keyed on
  `DeviceType` is a UI filter, never a coverage decision.

There is **no `Doorbell`, `Garage`, `Smoke` or `AirQuality` device type**: those
are `Button` + `DeviceRole.Doorbell`, `Cover` + role, `Sensor` + the `smoke` cap,
`Sensor` + `air-quality-sensor`. An exporter that switches on type misses all
four.

**`NcAlarmPanelDevice`** (`packages/addon-post-analysis/src/notification-center/alarm/alarm-panel-device.ts`)
is CamStack's own alarm panel and the one `alarm-panel` device not imported from
Home Assistant. It is deliberately an ordinary `BaseDevice` carrying the
`alarm-panel` cap natively — its own docblock names the three exporters as the
reason. Two facts an exporter must respect: modes are `home | away | night` only
(a strict subset of the cap's schema, which also allows `vacation` and
`custom_bypass`), and `arm` **can be refused** (`NcAlarmArmRefusedError`) when
contacts are open. An exporter that treats `arm` as fire-and-forget will report
"armed" over a refusal.

### 1.2 The shared contract, and how little is shared

`packages/types/src/capabilities/device-export.cap.ts` — 107 lines, system-scoped,
`mode: 'collection'`, `providerKind: 'device-export'`. Five methods
(`getStatus`, `listSupportedDeviceKinds`, `listExposedDevices`, `exposeDevice`,
`unexposeDevice`) plus the three auto-injected device-settings methods that
`exposesDeviceSettings: true` brings. `listSupportedDeviceKinds` is **only a UI
filter** — nothing enforces it on `exposeDevice`.

Three implementors, and:

| | `listSupportedDeviceKinds` returns | mapping layer |
| --- | --- | --- |
| `export-hap` | `['camera']` | imperative builders mutating a hap-nodejs `Accessory` (~10k lines under `packages/addon-export-hap/src/mappers/`) |
| `export-alexa` | `['camera', 'doorbell']` | hand-assembled interface lists in `packages/addon-export-alexa/src/endpoints/builder.ts` |
| `homeassistant-export` | 28 kinds — effectively every type | **`CAP_ENTITY_MAP`**, a declarative `Record<capName, descriptor>` in `packages/addon-provider-homeassistant/src/ha-export/entity-catalog.ts` |

**The three exporters share no code.** Across all three `src/` trees every
`@camstack/*` import is `@camstack/types` or `@camstack/types/node`. The one
nominally shared helper, `packages/types/src/utils/export-reconciler.ts`, says in
its own docblock that it is "shared by the camera export addons (Alexa, HAP)" —
in practice only HAP uses it; Alexa replaced it with
`packages/addon-export-alexa/src/endpoint-signature.ts`, and HA uses neither.
That comment is a leftover describing a design that is not real.

The only shared *conventions* are copy-pasted and enforced by prose: the
`tabs: [{ id: 'export', … }]` block, the namespaced settings keys
(`hap:<id>:enabled`, `alexa:<id>:enabled`, `haExport:<id>:<brokerId>`), and
`getDeviceLiveContribution: async () => null`. Each of the first two carries an
independently-written comment explaining the same collision bug.

`packages/types/src/device/device-control-resolution.ts` is the structural
precedent for a shared table — framework-free, exhaustive over `DeviceType`,
compile-time guarded — but **no exporter imports it**, and it keys on type, not
capability. It also **disagrees with `CAP_ENTITY_MAP` on field names**:
`temperature-sensor` → `celsius` there vs `temperature` in the catalog,
`humidity-sensor` → `percent` vs `humidity`, `ambient-light-sensor` → `lux` vs
`illuminance`. One of those pairs is wrong against the cap status schemas. That
must be settled before either becomes a source of truth (task T8).

### 1.3 `export-hap` — HomeKit

`packages/addon-export-hap`, 17,289 lines (11,284 production, 5,794 test across
32 spec files). `@homebridge/hap-nodejs@^2.1.6` (2.1.7 resolved) + `werift-rtp`.
`hub-only`, one capability: `device-export`.

**Not a bridge.** Every camera is published as its own standalone HAP accessory
with its own mDNS advertisement and a deterministic MAC derived from
`sha256("camstack:hap:" + accessoryUUID)` — see
`packages/addon-export-hap/src/accessory-publisher.ts`. Pairing state: the
addon's own identity in the kernel addon store, hap-nodejs's node-persist blobs
under `ctx.dataDir/hap-store/`. Dynamic add/remove works; re-expose is
idempotent; `unexposeDevice` only wipes pairing files on genuine withdrawal,
because wiping them on a settings rebuild made cameras vanish from the Home app.

**What it maps today** — one mapper kind, `'camera'`, with capabilities
auto-detected from the binding entries:

| cap / signal | HAP service |
| --- | --- |
| `camera-streams` | `CameraRTPStreamManagement` ×2 (H.264, SRTP) |
| `snapshot` | delegate `handleSnapshotRequest` |
| `doorbell` | `DoorbellController` + `Doorbell`, category `VIDEO_DOORBELL` |
| `intercom` | `Microphone` + `Speaker` (two-way audio) |
| `motion-detection` | `MotionSensor` (controller-owned under HKSV) |
| `motion-detection` + HKSV | `CameraRecordingManagement` + `CameraOperatingMode` + `DataStreamManagement` |
| `ptz` | one momentary `Switch` per preset, four direction `Switch`es |
| `ptz-autotrack` | stateful `Switch` |
| `battery` | `Battery` |
| `privacy-mask` | `Switch` |
| child with `switch` (+`brightness`, type Light/Generic) | `Lightbulb` **on the parent accessory** |
| child with `switch`, other types | `Switch` on the parent accessory |

**HKSV is real and shipped** (2026-08-07): a genuine `CameraRecordingDelegate`,
a permanent per-camera fMP4 ffmpeg child, and a hard refusal for any camera it
cannot `-c:v copy` — measured 0.7 % of a core / 30 MB on copy vs 89.9 % / 577 MB
transcoding, so the copy branch is the only one taken. **Do not defer HKSV: it
is done.** What is *not* done is the Developer-Preview HEVC/WebRTC successor;
`packages/addon-export-hap/src/hksv-preview/` was 803 lines and 44 tests with <!-- drift-ok: deleted 2026-08-13 by T5, which this line describes the case for -->
**zero production imports**, behind a `hksvPreview` flag that changes nothing.

**The 110-retry manifest fix is live.** (2026-08-12) renamed the
entry to `./dist/hap-export.addon.js` and made hap-nodejs a real dependency;
five publish commits have shipped since, and `origin/main..HEAD` is empty. The
root cause was fixed independently 1h47m later
(`packages/system/src/kernel/addon-loader.ts` now keys the cache-buster on
version + entry hash instead of an mtime that `npm pack` pins to a constant),
with a regression test. **Two leftovers to clean:** the `_entryRenameNote` in
`packages/addon-export-hap/package.json` describes a bug that no longer exists,
and the package description still says *"MotionSensor in this MVP; Camera /
Doorbell / Switch / Light follow"* for an addon that ships all of them.

**Gap:** 30 of 31 device types. `isCameraDevice` hard-gates the Export tab, so a
composed non-camera device reaches HA and Alexa but is invisible to HomeKit.

### 1.4 `homeassistant-export` — Home Assistant

**Correction to the brief: `addon-export-ha-mqtt` no longer exists.** It was
deleted 2026-08-09 and deprecated on npm; its exposed set was
empty so nothing migrated. On disk only an untracked `dist/` remains. The live
exporter is a second manifest entry inside `packages/addon-provider-homeassistant`
(one package, two runners, sharing the URL and token but never importing each
other).

**Transport is not MQTT.** It is an HTTP push to a custom component:
`POST <haBaseUrl>/api/camstack/push` with a bearer token, from
`packages/addon-provider-homeassistant/src/ha-export/push-client.ts`. Credentials
come through the `broker` cap, never by import. There is no LWT — availability is
one 30 s heartbeat, and when it stops the component marks every entity
unavailable. There is no retain — durability comes from three places instead:
`entity_change` always carries the *complete* component set rather than a delta,
a full reconcile runs every 300 s, and the link returning triggers a full
re-announce. Batching is a 1 s window with per-topic dedup; values over 2048
chars collapse to `__image_updated__:<ts>`.

**What it maps today.** Two halves by design
(`packages/addon-provider-homeassistant/src/ha-export/entity-catalog.ts`):
cameras are hand-written (~73 entities each: motion, per-macro detected /
last-image / last-detection / objects, per-zone fan-out, audio, doorbell,
battery, PTZ buttons, snooze select, camera switches), and everything else is
derived from `CAP_ENTITY_MAP` — 27 capabilities covering `switch`, `button`,
`brightness`, twelve binary sensors, six numeric sensors, `battery`,
`power-meter`, `air-quality-sensor`, `enum-sensor`, `numeric-sensor`,
`doorbell`, `alarm-panel`, plus an `online` diagnostic on every device. Two
**synthetic devices** (Notification Center with a writable switch per rule, and
CamStack Server with cluster/node/addon health) are exporter-owned, not camstack
devices.

Live on the hub since 2026-08-09: `devices=4 entities=142`.

**Three real defects, all in the write path or the topic grammar:**

- `lock-control`, `siren`, `alarm-panel` and `brightness` are declared
  `writable` in `CAP_ENTITY_MAP`, but `resolveCommand`
  (`packages/addon-provider-homeassistant/src/ha-export/command-routes.ts`)
  funnels every non-button writable cap into `kind: 'cap-switch'`, and the
  dispatcher calls `device.switch.setState` unconditionally. A lock without a
  `switch` provider gets `noProvider` and a 422; `brightness` is a `number`,
  fails `parseBool`, and never routes at all. **Four capabilities advertise a
  control that cannot work.**
- Derived entity slugs are the cap name (`camstack/<key>/motion`), but the
  projectors publish `motion_detected` / `triggered`. Same mismatch for
  `doorbell`. Only `battery` and `online` line up — **so a non-camera motion or
  contact device creates an entity that never receives a value.** This is the
  exact failure mode the 2026-08-05 audit measured on the old exporter (177 of
  293 devices), reproduced in the new one on a narrower set.
- `HaPlatform` declares `'camera'` and it is **never emitted**. No HA `camera`
  entity exists; the only visual surface is the `image` platform carrying a
  signed 6 h URL into the addon's own media plane.

**Gap:** whole platforms never emitted — `camera`, `lock`, `cover`, `climate`,
`siren`, `fan`, `vacuum`, `humidifier`, `event`, `text`, `device_tracker`,
`update`, `light`. Capabilities with no mapping at all: `climate-control`,
`fan-control`, `cover`, `valve`, `humidifier`, `water-heater`, `vacuum-control`,
`lawn-mower-control`, `media-player`, `color`, `weather`, `update`, `image`,
`consumables`, `pet-feeder`, `script-runner`, `automation-control`,
`event-emitter`, `intercom`, `notifier`. Plus 15 camera caps classified as
neither exported nor excluded, which the addon's own guard warns about on every
reconcile.

The **echo guard** matters for every plan below: any device whose `addonId` is
`provider-homeassistant` is refused by the exporter even if selected. Devices
imported *from* HA are never exported back.

### 1.5 Alexa — it already exists, and it is live

`packages/addon-export-alexa`, 10,236 lines, 37 source files. **This is not a
stub.** Topology: Alexa Cloud → an operator-owned AWS Lambda → HTTPS
`POST /addon/export-alexa/directive` on the hub, which verifies its own OAuth
token.

Everything expensive is already built:

- The **hub is the OAuth 2.0 authorization server**
  (`packages/addon-export-alexa/src/oauth-integration.ts`), redirect prefixes for
  layla/pitangui/alexa.amazon.co.jp, no PKCE (confidential client, secret in the
  Lambda), refresh tokens that never expire by operator decision.
- A **published, shared CamStack skill** whose credentials are committed on
  purpose (`packages/addon-export-alexa/src/public-skill.ts`), with a
  `skillMode: 'custom'` escape for operators running their own.
- The **Alexa Event Gateway** (`packages/addon-export-alexa/src/lwa-event-gateway.ts`,
  1091 lines): NA/EU/FE regional endpoints, LWA refresh, 401→refresh→retry,
  doorbell throttling, proactive `ChangeReport`s with a falling-edge motion hold,
  and `AddOrUpdateReport` / `DeleteReport` discovery sync.
- Live streaming through `streamBroker.acquireEgressTranscode` +
  `webrtcSession.handleOffer`. Confirmed rendering on an Echo 2026-08-07.

Coverage is camera-centric: `Alexa.CameraStreamController`,
`RTCSessionController`, `DoorbellEventSource`, `MotionSensor`,
`BatteryLevelSensor`, PTZ as `ModeController`/`ToggleController`. Camera children
become separate `parent__child` endpoints with `PowerController` +
`BrightnessController`. `Alexa.SmartVision.ObjectDetectionSensor` and
`SnapshotProvider` are written but **commented out of the endpoint** pending
their prerequisites — with the lesson recorded in D76 that 223 posts returned 202
and every one was discarded, because Alexa validates only the envelope.

`packages/addon-import-alexa` is the opposite direction (Alexa appliances as
camstack devices, poll-only over the unofficial `alexa-remote2`), and
`packages/addon-matter-broker` is a Matter **controller**, not a bridge —
nothing is exposed *over* Matter, and Matter cameras are shelved with an explicit
trigger (Apple has announced no support).

### 1.6 Streaming primitives, for any new consumer

Available with **zero new plumbing**:

| Need | Primitive |
| --- | --- |
| Live RTSP at any codec/resolution | `streamBroker.acquireEgressTranscode` → dialable url + refcounted `pipelineKey` |
| Live per-profile RTSP, no transcode | `cameraStreams.getProfileRtspEntries` → `rtsp://host:8554/<token>` |
| WebRTC to a cloud or browser peer | `webrtcSession.handleOffer` (already has `nonTrickle` / `disableTurn` / `disableIpv6` for cloud peers) |
| JPEG still, RPC | `snapshot.getSnapshot` |
| JPEG still, **public signed HTTP URL** | `snapshot.getSnapshotLinks` → `/addon/snapshot/link/<id>.jpg?w&v&exp&sig`, 120 s TTL |
| Event clip (mp4/gif) | `streamBroker.produceEventMedia` + `fetchEventMedia` |

Requiring new plumbing: **MJPEG** (no camera-facing endpoint exists — the only
MJPEG server in the repo is `packages/addon-terminal/src/terminal-camera-relay.ts`,
which is a good template but touches nothing camera-related), **live HLS** (HLS
exists only for recorded playback), and a **WHEP HTTP route** (`handleOffer` is
already the exact WHEP semantic; this is HTTP glue, not protocol work). Note that
`packages/addon-admin-ui/src/components/shared/WebRtcPlayer.tsx` points at
`/api/webrtc?src=`, a route that does not exist server-side.

Two traps that are measured, not theoretical, and that every new consumer hits:

- `streamCatalog.getCatalog` returns the camera's **native URL with the password
  inline** (`rtsp://admin:<password>@…`). Exporting it writes the camera password
  into the consumer's registry and its debug logs. Use the broker restream.
- The broker restream defaults to `127.0.0.1` unless `hostname` is passed. The
  broker is hub-only and Home Assistant is not on the hub. This fails exactly the
  way the image entities did before `publicBaseUrl` was set: entities that exist
  and never load.

For SRTP (HomeKit) and fMP4 (HKSV) the sinks exist in
`packages/types/src/ffmpeg/invocation.ts` (`rtp-outputs`, `FfmpegFmp4Sink`) but
are **not reachable from the cap** — an addon must build its own
`FfmpegInvocation` and spawn its own child, which is what `export-hap` does.

---

## 2. The gap matrix

Legend — **state**: ✅ exported and working · ⚠️ partial or broken · ❌ absent ·
— not meaningful. **Effort** for closing the cell: S ≤ ½ night · M ≈ 1 night ·
L > 1 night. **†** = was blocked on `camstack/homeassistant-component`; the ten
platforms named in §5 landed there on 2026-08-14 (component 0.4.0).

| Device type | HomeKit | HA | Alexa |
| --- | --- | --- | --- |
| `camera` | ✅ streams + HKSV + doorbell + PTZ + battery + privacy | ⚠️ ~73 entities, **no `camera` entity** — M | ✅ stream + RTC + doorbell + motion + battery + PTZ |
| `light` | ⚠️ only as a camera child — M | ⚠️ `brightness`→`number`, write broken; `color` unmapped — S / L† | ⚠️ only as a camera child — S |
| `switch` | ❌ — M | ✅ | ⚠️ only as a camera child — S |
| `siren` | ❌ — S | ⚠️ →`switch`, **write broken** — S | ⚠️ only as a camera child — S |
| `sensor` (16 caps) | ❌ — M | ✅ | ❌ — M |
| `button` | ❌ (`StatelessProgrammableSwitch`) — S | ✅ | ❌ — S |
| `lock` | ❌ (`LockMechanism`) — S | ⚠️ →`switch`, **write broken** — S / L† | ❌ (`LockController`) — S |
| `cover` | ❌ (`WindowCovering`) — M | ❌ — M / L† | ❌ — M |
| `alarm-panel` | ❌ (`SecuritySystem`) — S | ⚠️ entity yes, **write broken** — S | ❌ (`SecurityPanelController`) — S |
| `thermostat` / `climate` | ❌ (`Thermostat`/`HeaterCooler`) — M | ❌ — M / L† | ❌ — M |
| `fan` | ❌ (`Fanv2`) — S | ❌ — S / L† | ❌ — S |
| `valve` | ❌ (`Valve`) — S | ❌ — S / L† | ❌ — S |
| `humidifier` | ❌ (`HumidifierDehumidifier`) — S | ❌ — S / L† | ❌ — S |
| `water-heater` | ❌ (`HeaterCooler`) — S | ❌ — S / L† | ❌ — S |
| `presence` | ❌ (`OccupancySensor`) — S | ✅ as `binary_sensor` (`device_tracker` is L†) | ❌ — S |
| `media-player` | ❌ (`Television`) — L | ❌ — M / L† | ❌ — L |
| `vacuum` | — (no HAP service) | ❌ — M / L† | ❌ — M |
| `lawn-mower` | — | ❌ — M / L† | ❌ — M |
| `pet-feeder` | — | ❌ — S | — |
| `script` | ❌ (momentary `Switch`) — S | ❌ — S | ❌ (`SceneController`) — S |
| `automation` | ❌ (`Switch`) — S | ❌ — S | ❌ — S |
| `control` | ❌ — M | ❌ — M | ❌ (`Range`/`ModeController`) — M |
| `event-emitter` | ❌ (`StatelessProgrammableSwitch`) — S | ❌ — S / M† | — |
| `update` | — | ❌ — S / M† | — |
| `image` | — | ❌ — S | — |
| `weather` | — | ❌ — M† | — |
| `notifier` | — | — (a service, not an entity) | — |
| `hub` / `container` / `generic` | — structural | — structural | — structural |

**Reading the matrix.** The Alexa column is almost entirely ❌ and almost
entirely **low value**: the operator's non-camera devices largely arrive *from*
Home Assistant, the echo guard already refuses to send those back, and everything
that does reach HA reaches Alexa through the operator's existing HA↔Alexa link.
The HomeKit column is the same argument one step weaker — HA's HomeKit Bridge
covers the non-camera rows, but the direct path has lower latency and one fewer
failure domain.

---

## 3. The night plan

### 3.1 The two constraints that shape every task

**Constraint 1 — the component repo.** `HaPlatform`
(`packages/addon-provider-homeassistant/src/ha-export/types.ts`) allows exactly
nine platforms: `binary_sensor`, `sensor`, `image`, `switch`, `button`,
`select`, `camera`, `alarm_control_panel`, `number`. Anything else needs code in
`camstack/homeassistant-component`, and its shipped 0.2.0 source is **not
checked out here** (the local clones are a 0.1.7 panel-only build and an
unrelated 0.1.0). Its own file header is explicit that a rename here is a
migration, not an edit — `unique_id` and the component keys *are* the entity
identity, and changing one orphans every entity in an operator's installation
along with its recorder history and dashboard placement.

So: **tonight touches only the nine existing platforms.** That is not as
limiting as it sounds — the exporter already projects `lock-control` and `siren`
onto `switch`. A cover becomes `number` (position) + `button` ×3 + `sensor`
(state); a climate becomes `number` (setpoint) + `select` (mode) + `sensor`;
a fan becomes `switch` + `number` + `select`. Degraded fidelity, full
automatability, zero cross-repo coupling. Tier B upgrades those to native
platforms later.

**Constraint 2 — the train.** Framework packages (`types`, `system`, `sdk`,
`ui-library`) travel inside the published `@camstack/server` closure: a change
there is not live until a `@camstack/server` containing it is installed. **No
task tonight may modify `@camstack/types`.** Everything below is addon-local and
ships with `camstack deploy`. The shared descriptor table (§3.4) is deliberately
deferred to a train, and the field-name disagreement in §1.2 is resolved by a CI
guard rather than by a hoist.

### 3.2 Priority, with the honest reasoning

1. **Home Assistant, everything.** One multiplier: HA→Alexa, HA→Google,
   HA→HomeKit Bridge, plus dashboards and automations. Three of its four
   highest-value items are bug fixes.
2. **HomeKit generic accessories.** Not because the matrix has holes — HA's
   bridge fills them — but because `export-hap` is the only path that does not
   depend on Home Assistant being up, and because the camera path is finished so
   the addon has capacity. Do it after HA lands.
3. **Alexa: extend nothing structural.** The recommendation is to spend zero
   nights on native non-camera Alexa. If the operator disagrees, the smallest
   useful increment is §3.3 T7, which is additive to
   `packages/addon-export-alexa/src/endpoints/builder.ts` and costs one agent.

### 3.3 Wave 1 — five agents, disjoint file ownership

File ownership is assigned so no two agents edit the same file. Commit with
`git commit --only <paths>` and never `git add`.

---

#### T1 — HA: make the command dispatch capability-generic
**Owner files**
```
packages/addon-provider-homeassistant/src/ha-export/command-routes.ts
packages/addon-provider-homeassistant/src/ha-export/ha-export.addon.ts   (dispatch block only)
packages/addon-provider-homeassistant/src/ha-export/__tests__/command-routes.spec.ts
```
**Problem.** `resolveCommand` collapses every non-button writable cap to
`kind: 'cap-switch'`, and the dispatcher calls `device.switch.setState`
unconditionally. `lock-control`, `siren`, `alarm-panel` and `brightness` are
declared writable and none of them can work.

**Do.** Replace the `cap-switch` collapse with a route resolved from the
descriptor itself: `{ capName, field, valueKind: 'bool' | 'number' | 'enum' }`,
and dispatch through the `DeviceProxy` method the cap actually declares —
`lockControl.setLocked`, `brightness.setLevel`, `alarmPanel.arm/disarm`,
`switch.setState`. **A cap with no route refuses with a named reason and logs
it** (a branch that drops work silently logs it); it must not fall through to
`switch.setState`. `alarm-panel` needs the arm-refusal path from §1.1: a
refused `arm` returns the refusal, never a silent success.

**Every log line carries `tags: { deviceId }`** with the numeric id.

**Test.** Extend the existing spec: one case per writable cap asserting the
dispatched method name; one case asserting an unrouted cap refuses rather than
calling `switch.setState`; one asserting a refused `arm` surfaces as a failure.
**Then delete the fix and confirm the tests fail** — a green suite is not proof.

**Done when.** `npm run test -w packages/addon-provider-homeassistant` green,
`npm run typecheck` green, and on the live hub a lock or the NC alarm panel
toggles from HA and reads back correctly. **Requires `camstack deploy
packages/addon-provider-homeassistant`.**

---

#### T2 — HA: the entities that exist and never receive a value
**Owner files**
```
packages/addon-provider-homeassistant/src/ha-export/state-projector.ts
packages/addon-provider-homeassistant/src/ha-export/topics.ts
packages/addon-provider-homeassistant/src/ha-export/__tests__/state-projector.spec.ts
```
> Coordinate with T1: **T1 owns `ha-export.addon.ts`.** If T2 needs a
> subscription added there, hand the diff to T1 rather than editing the file.

**Problem.** Derived entity slugs are the cap name, but the projectors publish
`motion_detected` / `triggered` / doorbell-specific topics. Only `battery` and
`online` line up. A non-camera motion, contact, smoke, leak or doorbell device
gets an entity that is permanently unavailable. Separately, `onSliceChanged` handles only
four caps (`device-status`, `battery`, `doorbell`, `motion`) — the other 23
entries in `CAP_ENTITY_MAP` have **no push path at all** and move only on the
300 s reconcile.

**Do.** (a) Make the derived-entity topic and the projector topic come from one
function in `topics.ts`, so they cannot disagree. (b) Add a **generic
`DeviceStateChanged` projector**: for any cap present in `CAP_ENTITY_MAP`, read
the descriptor's `field` out of the changed slice and publish to the descriptor's
own topic. That single change gives every derived capability a push path,
including the ones T3 adds.

**Test.** A table-driven spec walking every `CAP_ENTITY_MAP` entry and asserting
the projected topic equals the catalog's topic for that entry. This test is the
guard — it fails the moment a future entry drifts.

**Done when.** Suite green; on the hub, a non-camera contact or motion sensor
shows a real state in HA within one push window (not one reconcile). **Requires
deploy.**

---

#### T3 — HA: widen `CAP_ENTITY_MAP` to every remaining capability (Tier A)
**Owner files**
```
packages/addon-provider-homeassistant/src/ha-export/entity-catalog.ts
packages/addon-provider-homeassistant/src/ha-export/__tests__/entity-catalog.spec.ts
```
**Do.** Add descriptors, using only the nine allowed platforms. Suggested
projections — deviate where a cap's status schema says otherwise, and read the
`*.cap.ts` before writing each row:

| capability | platform(s) |
| --- | --- |
| `cover` | `number` position (+`number` tilt if `cover-tilt`), `button` open/close/stop, `sensor` state |
| `climate-control` | `number` target (two if `climate-dual-setpoint`), `select` hvac mode, `select` fan mode if `climate-fan-mode`, `sensor` current temp / action |
| `fan-control` | `switch` on, `number` speed if `fan-speed`, `select` preset if `fan-preset`, `switch` oscillating if `fan-oscillating` |
| `humidifier` / `water-heater` | `switch` + `number` target + `sensor` current |
| `valve` | `switch` open, `number` position if `valve-positionable` |
| `vacuum-control` / `lawn-mower-control` | `sensor` state, `sensor` battery, `button` start/pause/return |
| `media-player` | `sensor` state, `select` source if `media-player-select-source`, `number` volume, `button` play/pause/next/prev |
| `color` | `number` hue + `number` saturation (a real `light` is Tier B) |
| `update` | `binary_sensor` update-available + `sensor` latest version + `button` install |
| `image` | `image` |
| `script-runner` | `button` |
| `automation-control` | `switch` |
| `event-emitter` | `sensor` last-event + `sensor` last-event-at (`event` is Tier B) |
| `pet-feeder` | `button` feed + `sensor` level |
| `consumables` | one `sensor` per consumable |
| `weather` | `sensor` per measurement (a real `weather` is Tier B) |
| `presence` | keep `binary_sensor` (`device_tracker` is Tier B) |

**Every new entry that is writable must name a route T1 can resolve.** If T1's
route table has no entry for a cap, mark the descriptor read-only rather than
shipping a control that lies — D62's rule generalises: a switch that writes
nothing is worse than no switch.

**Also.** Classify the 15 unclassified camera caps into `CAPS_NOT_EXPORTED` with
a written reason each (`audio-analysis`, `camera-pipeline-config`,
`camera-streams`, `day-night`, `detection-pipeline`, `image-settings`,
`intercom`, `motion-detection`, `motion-zones`, `osd`, `pipeline-analytics`,
`stream-catalog`, `stream-params`, `videoclips`, `webrtc-session`). `day-night`
and `intercom` are the two an operator would automate on — consider exporting
those rather than excluding them. The guard exists to force a written decision;
answer it.

**Fan-out discipline.** Everything an operator would not automate on ships
`enabled_by_default: false`. The camera path already carries ~73 entities; this
must not double it for a device nobody controls.

**Test.** A completeness spec: every capability in
`packages/types/src/capabilities/` that declares `deviceTypes` appears in
`CAP_ENTITY_MAP` **or** `CAPS_NOT_EXPORTED`, never neither. That test replaces
the runtime warning with a build failure.

**Done when.** Suite green, `unclassifiedCaps` empty in the reconcile log, and
one real device of at least three new families appears in HA with live values.
**Requires deploy.**

---

#### T4 — HA: live `camera` entities
**Owner files**
```
packages/addon-provider-homeassistant/src/ha-export/camera-entities.ts   (new)
packages/addon-provider-homeassistant/src/ha-export/media-url.ts
packages/addon-provider-homeassistant/src/ha-export/__tests__/camera-entities.spec.ts
```
> The catalog wiring is one call site inside `entity-catalog.ts`, which T3 owns.
> Write the module and the test; hand T3 the two-line wiring diff.

> **This task shipped as written on 2026-08-14 and produced ZERO entities.**
> It was rebuilt the same day; the plan below is preserved as the reasoning
> that was wrong, and [D152](../decisions/adr-0152.md) is what the export does
> now. Do not re-derive the RTSP design from this section.
>
> Measured on the operator's Home Assistant: `platform: camstack` held 165
> entities and exactly **two** `camera` ones, for two exported cameras, while
> the hub announced twelve components. The component builds its cameras from
> the export MEMBERSHIP and has never read `cmps` — its video is native
> WebRTC (`webrtcSession.handleOffer`) and it has no use for an RTSP address.
> Both url traps below were therefore real and irrelevant: they guarded a
> value with no reader, and trap 2's gate refused a camera entity outright on
> a hub with no reachable base url.
>
> What replaced it: one component per `webrtcSession.listStreams` entry —
> adaptive, each profile, each raw substream — carrying the WebRTC `target`
> and no url at all, with the ADAPTIVE one deliberately unannounced because
> the membership entity already owns its `unique_id`.

**Do.** One `camera` component per **active** profile, muted and unmuted, up to
three profiles — at most six per camera, the **first enabled and the rest
registered-and-off**. Video source from the broker restream; still image from the
existing `ha-media` plane.

**Two traps, both measured, both fatal if skipped:**
1. Never use `streamCatalog.getCatalog` — it returns the native URL with the
   camera password inline, which would write that password into HA's registry and
   its debug logs. Use `cameraStreams.getProfileRtspEntries`.
2. Pass `hostname` explicitly. The broker is hub-only and defaults to
   `127.0.0.1`; Home Assistant is not on the hub. Skipping this produces entities
   that exist and never load — the identical failure the image entities had
   before `publicBaseUrl`.

**Test.** Assert no minted URL ever contains `@` or `127.0.0.1`; assert the
enabled/registered-and-off split; assert exactly one entity per (profile, mute)
pair.

**Done when.** A live camera renders in a Lovelace card. **Requires deploy.**

---

#### T5 — HomeKit: a generic (non-camera) accessory path
**Owner files**
```
packages/addon-export-hap/src/mappers/index.ts
packages/addon-export-hap/src/mappers/generic-accessory.ts          (new)
packages/addon-export-hap/src/mappers/builders/generic/*.ts         (new)
packages/addon-export-hap/src/mappers/__tests__/generic-accessory.spec.ts (new)
packages/addon-export-hap/src/hap-export.addon.ts                   (kind gate + supported kinds)
```
**Do.** `pickMapperKind` currently returns `'camera'` unconditionally, ignoring
its argument — make it real, and add a second kind. The generic mapper is a
**capability→service table**, not a type switch, mirroring `CAP_ENTITY_MAP`'s
shape so the two can be unified later:

`switch`→`Switch` · `switch`+`brightness` on a `Light`→`Lightbulb` ·
`switch` on a `Siren`→`Switch` · `lock-control`→`LockMechanism` ·
`cover`→`WindowCovering` (or `GarageDoorOpener` by role) ·
`climate-control`→`Thermostat` / `HeaterCooler` by feature ·
`fan-control`→`Fanv2` · `valve`→`Valve` · `humidifier`→`HumidifierDehumidifier` ·
`water-heater`→`HeaterCooler` · `alarm-panel`→`SecuritySystem` ·
`button`→`StatelessProgrammableSwitch` · `presence`→`OccupancySensor` ·
`contact`→`ContactSensor` · `motion`→`MotionSensor` · `smoke`→`SmokeSensor` ·
`carbon-monoxide`→`CarbonMonoxideSensor` · `flood`→`LeakSensor` ·
`temperature-sensor`→`TemperatureSensor` · `humidity-sensor`→`HumiditySensor` ·
`ambient-light-sensor`→`LightSensor` · `air-quality-sensor`→`AirQualitySensor` ·
`battery`→`Battery`.

Then widen `listSupportedDeviceKinds` past `['camera']` and lift the
`isCameraDevice` gate on the Export tab.

**Do not touch the camera path.** It is finished, it is the addon's moat, and it
has 346 tests standing on it.

**Traps.** Structural changes bump the accessory config number, so the addon
must restart for iOS to re-read; the export fingerprint does not currently
rebuild on binding changes; iOS caches aggressively, so a device paired under an
older shape may need removing and re-adding.

**Also in this task, since it owns the package:** delete
`packages/addon-export-hap/src/reconcile/plan.ts` (`planHapReconcile` has no <!-- drift-ok: deleted 2026-08-13 by this very task -->
production caller) and `packages/addon-export-hap/src/hksv-preview/` (803 lines, <!-- drift-ok: deleted 2026-08-13 by this very task -->
zero imports, behind a flag that changes nothing), and remove the `hksvPreview`
config field with them. The addon's own design doc names exactly this failure —
*a leftover that describes the right design reads as verification*. Update the
package description and the `bridgeName` setting text, which describe an MVP and
a bridge model that no longer exist, and drop the `_entryRenameNote` whose stated
precondition for removal was met.

**Done when.** Typecheck + tests green, a switch and a sensor pair into the Home
app and actuate. **Requires `camstack deploy packages/addon-export-hap`.**

---

#### T6 — HomeKit: "Interruttore N"
**Owner files**
```
packages/addon-export-hap/src/mappers/builders/service-label.ts
packages/addon-export-hap/src/mappers/builders/__tests__/service-names.spec.ts
```
> Small and isolated. If T5's agent has capacity, it takes this second — the
> files do not overlap with T5's.

**Do.** `Name` is set and reaches the accessory; iOS ignores it on secondary
services. `ConfiguredName` was removed because hap-nodejs logged *"not in
required or optional characteristic section … Adding anyway"* — **that is a
warning, not a rejection**, and modern iOS Home uses `ConfiguredName` for
user-visible names on secondary services. Set both on all services (today
`MotionSensor` and `Battery` deliberately get `Name` only — include them in the
experiment), re-pair one camera, look.

**This is a hypothesis to test, not a fix to assume.** If iOS still shows
"Interruttore N", record the negative result in the design doc so nobody
re-runs it.

**Done when.** One re-paired camera shows operator-set names, or the negative
result is written down. **Requires deploy + a manual re-pair.**

---

#### T7 — Alexa: **optional, operator-gated** (see §4)
**Owner files**
```
packages/addon-export-alexa/src/endpoints/builder.ts
packages/addon-export-alexa/src/handlers/discovery.ts
packages/addon-export-alexa/src/endpoints/__tests__/builder.spec.ts
```
**Do only if the operator says yes.** Extend the endpoint builder to
camstack-**originated** non-camera devices — never devices whose `addonId` is
`provider-homeassistant` (apply the same echo guard the HA exporter uses, for the
same reason). `PowerController`, `BrightnessController`, `LockController`,
`ThermostatController`, `TemperatureSensor`, `ContactSensor`, `MotionSensor`,
`RangeController`, `ToggleController`, `SecurityPanelController` for the NC alarm
panel.

**The rule from D76 governs the whole task: never declare an interface you cannot
serve `ReportState` for.** Declaring `retrievable: true` without implementing
retrieval is a candidate explanation for Alexa previously rejecting an entire
endpoint. Add the interface **last**, after the state path answers.

**Done when.** `SUPPORTED_KINDS` widened, discovery returns the new endpoints,
one device responds to a voice command and to a `ReportState`. **Requires
`camstack deploy packages/addon-export-alexa`.**

---

#### T8 — Guard: export coverage, and the field-name disagreement
**Owner files**
```
scripts/check-export-coverage.ts   (new)
.github/workflows/ci.yml
```
**Do.** Two checks, CI-only — no train, no deploy.

1. **Coverage.** Every device-scoped capability appears in
   `CAP_ENTITY_MAP` or `CAPS_NOT_EXPORTED`. Same for the HAP generic table once
   T5 lands. A new `*.cap.ts` then fails CI until someone writes down whether it
   exports. Prefer a guard to a paragraph.
2. **The field-name disagreement.** `packages/types/src/device/device-control-resolution.ts`
   and `entity-catalog.ts` disagree on three sensor field names
   (`celsius`/`temperature`, `percent`/`humidity`, `lux`/`illuminance`). Resolve
   both against the cap status schemas — **the schema is the authority** — fix
   whichever is wrong, and add an assertion that every mapped `field` exists in
   its cap's status schema. That check would have caught the bug the HA export
   already shipped and fixed once, where audio labels were read from field names
   that do not exist.

**Done when.** `npm run lint && npm run typecheck && npm run test` green and the
guard is wired into `.github/workflows/ci.yml`. **No deploy.**

---

### 3.4 Explicitly out of scope tonight

- **A shared `@camstack/types` descriptor table.** It is the right end state —
  `CAP_ENTITY_MAP` generalised to a target-neutral descriptor, sitting beside
  `device-control-resolution.ts`, with each exporter binding it to its own
  vocabulary — but `@camstack/types` is train-bound and a half-migrated shared
  layer overnight is worse than two honest tables plus T8's guard. Revisit once
  T3 and T5 have both settled and the tables can be diffed.
- **Tier B HA platforms.** Ten LANDED on 2026-08-14 — `cover`, `climate`,
  `lock`, `fan`, `vacuum`, `valve`, `humidifier`, `water_heater`,
  `media_player` and `alarm_control_panel` — in component 0.4.0, negotiated
  rather than assumed ([D140](../decisions/adr-0140.md)). What remains blocked
  on the component is `siren`, `light`, `event`, `text`, `device_tracker` and
  `update`.
- **Matter export.** Shelved with an explicit trigger — matter.js 0.17.3 is
  vendored and the commands map ~1:1 onto `webrtc-session`, but Apple has shipped
  no Matter camera support and announced none.
- **HKSV Developer Preview** (HEVC + WebRTC). T5 deletes the transcription.
  Re-derive it from the spec when Apple ships, not from a stale copy.
- **MJPEG and live HLS.** No consumer needs them once T4 lands `camera` entities
  on the RTSP restream.

---

## 4. Operator decisions — batched, with a recommendation each

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | **Native Alexa for non-camera devices — build it?** The skill, OAuth and Event Gateway already exist, so it is additive rather than a project. But most non-camera devices arrive *from* HA, and HA↔Alexa already relays everything HA has. | **No.** Skip T7. Revisit only for camstack-originated devices HA never sees. |
| 2 | **Home Assistant component: can `camstack/homeassistant-component` be worked on?** Every Tier B platform is blocked on it, and the shipped 0.2.0 source is not on this machine. | **Get it checked out.** It roughly doubles the achievable HA fidelity and nothing else unblocks it. Until then Tier A is the ceiling. |
| 3 | **HomeKit non-camera accessories — direct, or via HA's HomeKit Bridge?** Direct is one fewer failure domain and lower latency; the bridge is free and already available. | **Direct (T5)**, but *after* HA lands. If nights are scarce, cut T5 before cutting any HA task. |
| 4 | **Entity fan-out budget.** Cameras already produce ~73 entities each; T3 adds a family per non-camera device. | **Cap it by defaulting aggressively to `enabled_by_default: false`**, as the camera path already does. Say if a per-device ceiling is wanted. |
| 5 | **`_2`-suffixed entity ids.** The old integration still owns the good ids. Previously accepted. | **Leave it.** Reclaiming them means removing the old integration first, which is an operator action, not a code change. |
| 6 | **`day-night` and `intercom`** are the two of the 15 unclassified caps an operator would plausibly automate on. Export them, or exclude them with a reason? | **Export both**; exclude the other 13 as transport rather than state. |

---

## 5. Reading further

- HomeKit diagnosis, the falsified beliefs, and the Matter trigger:
  [`2026-08-05-homekit-export-diagnosis-and-matter-plan.md`](./2026-08-05-homekit-export-diagnosis-and-matter-plan.md)
- HKSV and the Alexa SmartVision gap, incl. D76:
  [`2026-08-07-alexa-events-and-hksv-assessment.md`](./2026-08-07-alexa-events-and-hksv-assessment.md)
- What "complete" means for HA export, and the audit that killed the MQTT one:
  [`2026-08-05-home-assistant-native-export.md`](./2026-08-05-home-assistant-native-export.md)
- OAuth onboarding for the HA component:
  [`2026-08-08-ha-oauth-onboarding.md`](./2026-08-08-ha-oauth-onboarding.md)
- The ten items the HA export owes, measured on the live hub:
  [`../roadmap.md`](../roadmap.md) §5
- Per-camera switches must name an existing authority:
  [`../decisions/adr-0062.md`](../decisions/adr-0062.md)
