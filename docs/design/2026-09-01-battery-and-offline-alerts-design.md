---
title: Battery-low and offline alerts — design
date: 2026-09-01
status: implemented 2026-09-01 (decisions taken; viewer mirror + codegen still outstanding — see §5b)
covers:
  - packages/addon-post-analysis/src/notification-center
  - packages/types/src/capabilities/battery.cap.ts
  - packages/types/src/capabilities/device-status.cap.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
---

# Battery-low and offline alerts

The ask: extend the system events with (a) **low battery**, threshold
configurable, telling **binary** indicators apart from **numeric** levels, and
(b) **device offline** — both with a **schedule**: how often to re-send.

Everything below that is stated as fact was read in the code or measured against
the live hub on 2026-09-01. Anything I could not verify is labelled
**HYPOTHESIS** and says so.

## TL;DR

- **The offline half is already built and already shipping.** `device-offline`
  is an existing `NcSystemEventKind`, produced by the intake, debounced by a
  5-minute trailing hold-off, deduplicated by a durable ledger, and the operator
  already has a live rule firing on it. Nothing about "how do I know a device is
  offline" is missing. What is missing is **the noise scope** and **the
  re-send**.
- **The battery LEVEL exists on every device that has one**, in one uniform
  place (`battery` runtime-state slice), and the binary/numeric distinction is
  already a schema field (`BatteryStatus.binary`). There is no low-battery
  event, no threshold, and no operator surface for one.
- **The digest (`quietSeconds` / `maxWindowSeconds`, defaulted to 60 s / 300 s
  by) is NOT reusable for this.** It is a motion-driven collection
  window that renders a mosaic of tracks. The requested "every N hours, remind
  me" is a **re-notify interval**, and no such mechanism exists anywhere in the
  Notification Center.
- **The real risk is not the threshold, it is the population.** Measured on the
  live hub: **100 devices are `online: false` right now**, 96 of them accessory
  children whose parent container is online, 78 of which flipped in the same
  minute. An unscoped offline alert delivers ~100 notifications on the first
  tick.

---

## 1. The fleet, measured (2026-09-01 ~13:56 CEST)

One call: `deviceState.getAllSnapshots` (the whole runtime-state mirror, 1014
device ids) joined with `deviceManager.listAll {projection:'slim'}` (1022
devices). Raw analysis scripts were scratch-only.

### 1.1 Battery

| | count |
| --- | --- |
| devices with a `battery` runtime-state slice | **70** |
| of which **binary** (`binary: true`) | **9** |
| of which **numeric** | **61** |
| devices declaring the `battery-operated` **feature** | **46** |
| slice but no feature | 25 |
| feature but no slice | 1 |

**The feature and the slice are two different sets.** `DeviceFeature.BatteryOperated`
is on 46 devices; 70 have a level. Neither is a superset of the other. A watcher
that iterates "battery-operated devices" would skip 25 devices that report a
level; one that iterates slices would skip 1 that declares the feature. The
slice is the authority for "does this device have a readable level".

Providers, by device: **HA containers** (`@camstack/addon-provider-homeassistant`)
supply 46 of the 70, **ecowitt** 22, **reolink** 4 (Baby monitor 640, Campanello
4263, Camera laundry 3628, Camera porta retro 3629 — the four
battery cameras).

Current readings worth knowing about:

| device | form | pct | note |
| --- | --- | --- | --- |
| 3255 Sensore contatto finestra cameretta Person B | NUM | 0 | `lastUpdated: 0` — **never written** |
| 3279 Sensore contatto gazebo | NUM | 0 | `lastUpdated: 0` — **never written** |
| 3609 Termometro mansarda | NUM | 0 | `lastUpdated: 0` — **never written** |
| 3615 Termometro sala server | NUM | 0 | `lastUpdated` fresh — a real 0 |
| 3560 Termostato bathroom bedroom | **BIN** | 15 | **LOW right now** |
| 3581 Termostato bathroom camerette | **BIN** | 15 | **LOW right now** |
| 3602 Termostato frigorifero | NUM | 23 | closest genuine numeric to a 20 % floor |
| 1837 / 4172 / 1847 / 640 / 1869 / 3621 / 4263 | NUM | 81–98 | healthy |
| the other 56 | NUM/BIN | 100 | healthy (or a binary reading "normal") |

**Three devices read 0 % and have never reported.** `{percentage: 0, charging:
'none', sleeping: false, lastUpdated: 0}` is exactly the cap's declared
`status.empty` (`battery.cap.ts`). A rule written as `percentage <= threshold`
fires on all three the moment it is enabled, about devices whose battery is
unknown, not flat. **A low-battery gate must require `lastUpdated > 0`.**

`lastContactAt` is present on only **4 of 70** slices (the reolink cameras).
`deriveBatteryPresence` therefore answers `sleeping` for the other 66 — correct
by its own design (it never paints "we know nothing" as a fault) but it means
`unreachable` is not a signal that exists on the HA/ecowitt half of the fleet.

### 1.2 Offline

| | count |
| --- | --- |
| devices with a `device-status` slice | **1013** |
| `online: false` right now | **100** |
| of those, `disabled: true` | **0** |
| of those, from `@camstack/addon-provider-homeassistant` | **100 (all)** |
| of those, having a `parentDeviceId` | **96** |
| distinct parents of those | 35 — **32 of them ONLINE** |

By device type: `button=39 sensor=36 event-emitter=13 control=6 container=3
cover=1 presence=1 switch=1`. **Zero cameras.**

When they flipped: **78 in the single minute 09:19**, 20 more at 13:29, 2 at
13:27. Nothing older than 24 h, nothing newer than 5 minutes.

**Why so many, verified in code:** `ha-base-child-device.ts:363` —
`const reachable = state.state !== 'unavailable' && state.state !== 'unknown'`.
An HA `button` entity has no meaningful state and reads `unknown`, so it is
permanently offline by this rule. 39 of the 100 are buttons ("Tapparella kitchen
Manual open", "Doorbell Restart", "Identifica"…).

The operator's existing rule survives this only because it is scoped:
`Eventi di sistema` carries `deviceTypes: ['camera']`. Confirmed in
`notificationRules.listRules`, and confirmed in the delivery history — 55 rows
over the last 5 h contain 4 `stream-offline`, 4 `stream-online`, 2 `node-offline`,
2 `node-online`, **0 `device-offline`**, while 100 devices sat offline.

---

## 2. What already exists, and must be REUSED

### 2.1 The system-event pipeline is complete end to end

| Piece | Path |
| --- | --- |
| The kind vocabulary | `packages/types/src/capabilities/notification-rules.cap.ts` → `NcSystemEventKindSchema` (`device-online`/`device-offline`/`stream-*`/`node-*`/`detection-blind`/`addon-crash-loop`/alarm/update kinds) |
| Which bus categories are watched | `packages/addon-post-analysis/src/pipeline-analytics/runtime/wire-subscriptions.ts` → `NC_SYSTEM_EVENT_CATEGORIES` |
| Bus event → frozen subject | `packages/addon-post-analysis/src/notification-center/event-intake.ts` → `incomingFromSystemEvent` / `systemSubject` |
| Which rule filter speaks about which kind | `packages/types/src/notification/system-event-filters.ts` → `systemEventFilterApplies` (+ guard `scripts/check-nc-system-filter-scope.ts`) |
| Where the notification's tap lands | `packages/addon-post-analysis/src/notification-center/system-event-tap-url.ts` (+ guard `scripts/check-notification-tap-targets.ts`) — this is D305 |
| The "apply these updates" button | `packages/addon-post-analysis/src/notification-center/addon-update-buttons.ts` + `nc-actions.ts` → `NcActionGrant` — this is D324 |
| Sentences | `packages/addon-post-analysis/src/notification-center/texts/{en,it}.json`, keys `system.<kind>.{title,body}` (+ guard `scripts/check-nc-text-catalog.ts`) |
| Authorable list, admin | `packages/addon-admin-ui/src/pages/system/notification-system-events.ts` |
| Authorable list, viewer (hand mirror) | `camstack/src/components/notifications/rule-editor.ts` → `NC_SYSTEM_EVENT_VALUES` |

**Adding a kind is a six-surface change with a train cost.** The enum lives in
`@camstack/types`, which travels inside the published `@camstack/server`
closure — so a new kind is not live on a hub until a server carrying it is
installed, and the viewer needs an OTA for its mirror before the hub offers the
kind (that ordering is the `check-viewer-condition-mirror.ts` rule; the audio
condition shipped viewer-first for exactly this reason). This cost is the main
input to decision **D-1** below.

### 2.2 The offline half already has its noise control

Two mechanisms, both already live, both directly reusable:

- **`DeviceLivenessHoldoff`** —
  `packages/addon-post-analysis/src/notification-center/liveness-holdoff.ts`.
  `DEVICE_LIVENESS_HOLDOFF_MS = 5 * 60_000`. A trailing timer: a device
  liveness flip is held 5 minutes, and if the state bounced back to the last
  notified one, **nothing is sent**. Node liveness is deliberately excluded.
  This is the hub-side equivalent of the viewer's `OfflineDebouncer`, and it
  already exists.
- **`NcLivenessLedger`** —
  `.../liveness-ledger.ts`. Durable, per subject (`device:<id>`), three verdicts:
  `seeded` (first observation ever — notify nothing), `no-flip` (duplicate —
  discard), `flip` (notify). Plus `seedFromDirectory` (D141) so a camera whose
  first observation ever is its own death is not swallowed.

So the debounce the brief asks for **exists and is 5 minutes**. What does not
exist is any way for the operator to see or change it, and any repetition after
it fires once.

### 2.3 The digest is a collection window, not a schedule

 ("Default a new motion digest to 1 minute quiet and a 5 minute
ceiling") touched `packages/addon-admin-ui/src/pages/system/notification-summaries.helpers.ts`
only — `emptySummaryForm()` now seeds `quietSeconds: 60`, `maxWindowSeconds: 300`
(was 300 / 3600). The mechanism behind those two fields is
`packages/addon-post-analysis/src/notification-center/summary/summary-window.ts`:

```
motionWindowCloseAt = min(lastMotion + quietMs, openedAt + maxWindowMs)
```

That is **coalescing**: open a window on motion, extend it while motion keeps
arriving, hard-close at a ceiling, then render one mosaic of the tracks the
window contained. It is bound to `listTracks`, to the track-close barrier
(`decideSummaryWindow`), and to a mosaic renderer.

**It answers "group a burst into one notification". It does not answer "remind
me again in 6 hours about a condition that is still true".** Reusing it would
mean rewriting everything but the two field names.

What *is* reusable from that neighbourhood is the **producer shape**, not the
window: `NcSummaryProducer` ticks every `SUMMARY_TICK_MS = 60_000`, asks a store
"when did I last deliver for this rule", and **stamps last** so a failed render
leaves the work eligible. The timelapse scheduler is the same shape. A
re-notify sweep is that shape with a different question.

### 2.4 Where thresholds and mutes live today

- **No numeric threshold is operator-configurable anywhere in the system-event
  path.** `DetectionBlindMonitor` (`packages/addon-pipeline-orchestrator/src/detection-blind-monitor.ts`)
  has `DETECTION_BLIND_THRESHOLD_MS = 60 * 60_000` as a **constructor
  parameter with a default**, and `orchestrator-bootstrap.ts:904` constructs it
  as `new DetectionBlindMonitor()` — no settings surface is wired. Its docblock
  says a per-camera surface *could* drive it. Nobody built one. This is the
  closest existing precedent and it is unfinished.
- **The rule's own brakes** are `throttle.cooldownSec` / `scope` /
  `granularity` (`cooldownKey`, and for system events `systemEventCooldownScope`
  = `s:<subject>:k:<kind>`, D141 — the direction is part of the key, so offline
  and online do not silence each other). The operator's live rule uses
  `cooldownSec: 60`, `scope: 'rule-device'`.
- **Per-camera mute** — `.../device-mute-store.ts`, collection
  `notification-center:device-mutes`, read/written by
  `notificationRules.listDeviceMutes` / `setDeviceMuted`. Its gate is the FIRST
  thing in `evaluateAndEnqueue`. It is a device id list, indefinite, admin-only.
- **Snooze** — `.../snooze-*.ts`, keyed `(deviceId, classes[])`, bounded 24 h.
- The existing threshold-shaped constants that already exist elsewhere:
  `LOW_BATTERY_THRESHOLD_PCT = 20` in `packages/addon-export-hap/src/mappers/builders/battery.ts`,
  and `BINARY_BATTERY_LOW_PCT = 15` / `BINARY_BATTERY_NORMAL_PCT = 100` in
  `packages/addon-provider-homeassistant/src/devices/ha-container-device.ts`.

### 2.5 How the battery is represented

**One cap, one slice, one shape, cross-provider.** `batteryCapability`
(`packages/types/src/capabilities/battery.cap.ts`), `scope: 'device'`,
`deviceTypes: [Camera, Sensor, Button, Switch]`, `durability: 'restored'`,
`volatileStateFields: ['lastUpdated']`. `BatteryStatus`:

| field | meaning |
| --- | --- |
| `percentage` | 0..100, firmware-reported |
| `charging` | `'dc' \| 'solar' \| 'none'` |
| `sleeping` | firmware in low-power mode |
| `lastUpdated` | ms epoch of the last observation — **0 means never** |
| `lastContactAt?` | last PASSIVE proof of reachability; feeds `deriveBatteryPresence` (D173) |
| `binary?` | **the field the brief asks for.** `true` = the source is a binary `LOW_BAT` indicator with no real charge level; `percentage` is a stand-in and the UI "MUST render Normal/Low instead of a misleading exact percentage" |

The cap docblock is explicit: *"Consumers build their own low battery alerting
on top — the cap deliberately does NOT enforce a threshold."*

**Where each form comes from:**

- **HA** — `packages/addon-provider-homeassistant/src/devices/ha-container-device.ts`.
  `isBatteryEntity` (role `BatterySensor` or `device_class: 'battery'`),
  `isBinaryBattery` (the `binary` capability without `numeric-sensor` — i.e. a
  `binary_sensor` with `device_class=battery`, the HA `LOW_BAT` shape, e.g.
  HomeMatic HmIP-DLD). `selectBatteryEntity` **prefers numeric over binary**
  when a device exposes both. `deriveBatteryStatus` maps binary `on`→15 %,
  `off`→100 %, `binary: true`; numeric = `Number(state)` clamped to [0,100].
- **Ecowitt** — `packages/addon-provider-ecowitt/src/ecowitt-mapping.ts`
  (`batteryModeForUnit`): a `'percent'` battery gets the real `battery` cap; a
  **voltage** battery deliberately does NOT ("a voltage has no honest
  percentage") and is surfaced as a `numeric-sensor` instead. So an ecowitt
  V-battery device is invisible to any percentage-based alert — by design.
- **Reolink** — the battery cameras, the only four carrying `lastContactAt`.

**Read surfaces**, in order of cheapness:

1. `device.state-changed` on the bus, `capName: 'battery'`, `data.slice` = the
   whole `BatteryStatus`. **This already reaches the Notification Center.**
   `EventCategory.DeviceStateChanged` is in `NC_SYSTEM_EVENT_CATEGORIES`, so
   `onSystemEvent` sees every battery slice write today and
   `incomingFromSystemEvent` returns `null` for it (`capName !== 'device-status'`).
   **A battery-low event needs no new bus category and no producer-side change.**
2. `deviceState.getCapSlice({deviceId, capName:'battery'})` / `getSnapshot` /
   `getAllSnapshots` — the hub-side mirror, one round trip for the whole fleet.
3. `battery.getStatus({deviceId})` — the auto cap method. **Do not use this on a
   battery camera**: D173's whole point is that asking is the damage.
4. **A per-device battery TIME SERIES already exists.**
   `AnalyticsLts` (`packages/addon-post-analysis/src/pipeline-analytics/store/lts-store.ts`), <!-- drift-ok: deleted when device-history replaced the LTS tier (D850) -->
   series `'battery'`, fed from the same `device.state-changed` tap
   (`wire-subscriptions.ts:241`, `batteryPercentage` is a type guard that
   contributes **nothing** rather than a fabricated 0). 5-minute buckets, ~1 year
   cap, `read(query)`. Discharge slope is therefore already answerable.

---

## 3. What is genuinely missing

1. A **`device-battery-low` system event kind** (and whatever its recovery
   counterpart is, or is deliberately not — see D-4).
2. A **threshold**, and a place to configure it.
3. A representation of **"this source is binary"** on the notification path, so
   the sentence says *"Termostato bathroom: batteria scarica"* and not *"15 %"*.
4. A **re-notify interval** — nothing in the Notification Center re-sends
   anything. Searched: `NcSchedule` is a weekly band (`isScheduleActive`,
   `packages/types/src/notification/schedule.ts`), the cooldown only
   SUPPRESSES, the outbox retries only FAILURES (5 s→300 s, 8 attempts), the
   summary/timelapse producers deliver once per closed window. There is no
   "still true, say it again".
5. A **scope** for the offline alert that does not deliver 100 notifications.
6. **Hysteresis** on the battery threshold — nothing today re-arms an edge.

All six were built; §5b lists where each one landed.

---

## 4. Proposed shape

### 4.1 The battery event: one kind, produced inside the intake

Add `'device-battery-low'` to `NcSystemEventKindSchema`, subject
`battery:<deviceId>` (a **third** device subject family beside `device:<id>`
liveness and `device-switch:<id>`, for D141/D62's reason: a battery notification
and an offline notification about the same device must not share a cooldown slot
and cancel each other out).

Produce it in `incomingFromSystemEvent`, in the existing `device.state-changed`
case, by adding a `capName === 'battery'` branch. Concretely:

```
device.state-changed(capName:'battery', slice) →
    gate: slice.lastUpdated > 0                  ← the never-written trap
    gate: a ledgered edge (see 4.3)
  → systemSubject({ kind:'device-battery-low', subject:`battery:${id}`,
                    titleKey:'system.device-battery-low.title',
                    bodyKey: binary ? '...body.binary' : '...body.level',
                    textParams:{ deviceName, percentage },
                    deviceId, deviceType })
```

Three properties make this cheap and consistent with what is already there:

- **No new bus category, no new producer, no new addon.** The event already
  arrives; it is being dropped.
- **The BODY VARIANT is chosen at intake**, exactly as `systemSubject`'s
  docblock says it must be ("whether a stream event names a profile, whether a
  node is an agent or a worker"). Binary vs numeric is a fact about the event,
  so it picks `bodyKey`, and the catalog stays a flat list of finished
  sentences. Two keys:
  - `system.device-battery-low.body` → `"{{deviceName}}: batteria al {{percentage}}%"`
  - `system.device-battery-low.body.binary` → `"{{deviceName}}: batteria scarica"`
- **`deviceIds` and `deviceTypes` narrowing come free** — both already apply to
  every kind matching `device-*` in `systemEventFilterApplies`, so a
  `device-battery-low` kind inherits the right family with no filter-table
  change. (`scripts/check-nc-system-filter-scope.ts` will confirm; that is a
  thing to check, not a thing to assume.)

### 4.2 Binary vs numeric — the rule that decides

| slice | verdict |
| --- | --- |
| `lastUpdated === 0` | **never reported.** No event, ever. Not low, not normal — unknown. |
| `binary === true` | LOW iff `percentage < BINARY_BATTERY_NORMAL_PCT` (i.e. the provider said "on"). **The operator's numeric threshold is NOT applied.** |
| otherwise | LOW iff `percentage <= threshold` |

The second row is the load-bearing one. Today a binary low reads 15 %, which is
under the conventional 20 % band **on purpose** (`ha-container-device.ts`:
*"below the conventional 20 % warning band so consumers' low-battery alerting
fires"*). That coincidence breaks the moment the operator sets the threshold to
10: the two bathroom thermostats currently reading LOW would go silent, and
nothing would say why. Comparing a stand-in number against an operator's number
is comparing two different things.

Same reason a numeric device must not be judged by the binary rule: 3602
(Termostato frigorifero, 23 %) is a real reading and belongs to the threshold.

### 4.3 The noise: a durable EDGE ledger, not a level test

Reuse the shape of `NcLivenessLedger` (`DurableLedger`,
`packages/addon-post-analysis/src/durable/durable-ledger.ts`) with a new spec —
one row per `battery:<deviceId>`, holding the last **band** the device was in,
not the percentage.

```
observe(subject, band) →  seeded  (first ever: write, notify nothing)
                          no-flip (same band: discard)
                          flip    (notify)
```

with **two bands and hysteresis**: `low` is entered at `<= threshold` and left
only at `>= threshold + hysteresis`. Without the second number a device whose
reading oscillates one point around the threshold re-fires on every crossing.
The write rate is the reason the BAND and not the percentage is what is
ledgered: the runtime-state census (quoted in `battery.cap.ts`) measured
**526 writes of the `battery` slice in 25 minutes with 0 value changes** —
`lastUpdated` alone moving. A ledger keyed on the band discards all of them;
one keyed on the percentage would not.

The D49 failure direction is the ledger's, unchanged: an empty mirror SEEDS,
i.e. fails toward silence. A lost "battery low" costs a day; a phantom flood
costs the operator's trust in every notification the hub sends.

No trailing hold-off is needed here (a battery does not flap in seconds the way
a reconnecting provider does), but the hysteresis is not optional.

### 4.4 The re-notify: a periodic RE-ARM of the ledger, not a second delivery path

The honest way to say "remind me every N" in this codebase is **not** a new
sender. It is a tick that makes the existing edge fire again.

```
every RENOTIFY_TICK_MS (60 s, the summary producer's cadence):
  for each ledger row still in the `low` band (or still `offline`):
      if now - lastNotifiedAt >= renotifyMs:
          re-emit the SAME subject through consumeEvent()
          stamp lastNotifiedAt   ← LAST, after the enqueue succeeded
```

Four properties, each of which is a bug if it is missing:

- **It goes through `consumeEvent`.** Every producer reaches the centre through
  one door; a reminder that bypassed it would bypass the mute, the snooze, the
  rule conditions and the schedule. A reminder at 03:00 that the operator's
  quiet-hours schedule would have suppressed is the feature failing.
- **The stamp is last** — the summary producer's rule, and the reason a failed
  ffmpeg once cost an entire night permanently.
- **The dedup id must differ per reminder.** The outbox dedup key is
  `ruleId:recordId:targetId` held for 7 days; a reminder carrying the same
  `recordId` is swallowed by the exact guarantee that makes the first push
  reliable. The grouping feature already solved this shape — `dedupRef` becomes
  `<groupKey>:v<n>`. A reminder is `battery:<deviceId>:r<n>` (or the window
  index) for the same reason.
- **The interval is ONE cluster setting** (`alertRenotifyMinutes`, default 720,
  0 = say it once). The draft argued for a per-rule interval so that "every 6 h
  for a flat battery" and "every 30 min for an offline camera" stayed two
  sentences; the operator chose one number for both — see **D-2**.

As built, the sweep rides the RULE-RELOAD tick rather than a timer of its own:
same cadence, already gated to the evaluating node, and one less interval to
clear on `stop()`. It re-says only what the durable row still calls true and
never re-derives the condition — a tick that read the battery again would be a
second authority free to disagree with the ledger.

### 4.5 The offline scope

Nothing new is needed on the mechanism — only that the population cannot be
"every device". **The operator chose the strictest available answer** and it is
what shipped: a device with a `parentDeviceId` produces no liveness subject at
all. See **D-5** below for the rule, its measured effect (100 → 4) and the cost
it accepts.

The two alternatives the draft weighed — "exclude a child whose parent is
online", and excluding `button`/`event-emitter` types — were both rejected in
favour of it. The first depends on a second device's mirrored state being fresh
at the instant of the flip; the second hard-codes a policy about Home
Assistant's entity model into the hub, which belongs in the rule's
`deviceTypes` where an operator can change it.

---

## 5. Decisions — TAKEN 2026-09-01, and implemented

The options each decision weighed are in git history; what is below is what the
operator chose and what was built. **Two went against the recommendation in the
draft, and both are marked.**

| | Decision | Where it lives now |
| --- | --- | --- |
| **D-1** | New `NcSystemEventKind` members in `@camstack/types` — the train, not an addon-local rule surface | `notification-rules.cap.ts` → `device-battery-low`, `device-battery-normal` |
| **D-2** | ⚠ **AGAINST the draft.** ONE cluster setting each, not per-rule | `pipeline-analytics/device-alert-settings.ts`, form section *Battery & offline alerts* |
| **D-3** | Re-notify applies to battery AND offline | `alerts/alert-episode.ts`, one reducer for both |
| **D-4** | ⚠ **AGAINST the draft.** The all-clear EXISTS and is configurable, default `true` | `alertNotifyRecovery`; gates `device-battery-normal` and `device-online` |
| **D-5** | ⚠ **STRICTER than the draft.** First-level devices only — an accessory never produces liveness | `device-directory.ts` → `isAccessoryIdentity`, gated in `event-intake.ts` |
| **D-6** | The watcher follows the SLICE, not the `battery-operated` feature | `NcDeviceAlerts.observeBattery`, driven by the bus event |

### D-2 — three cluster settings, and deliberately no fourth

`batteryLowPercent` (default 20), `alertRenotifyMinutes` (default 720, **0 = say
it once**), `alertNotifyRecovery` (default `true`). They sit beside this addon's
other cluster-wide behavioural knobs because the Notification Center has no
general settings collection of its own — `NcAlarmSettings` is stored on the
panel DEVICE, and a new store for three numbers would have been the second home
the operator explicitly refused.

The draft argued for per-rule thresholds so that "30 % for the door locks, 10 %
for the weather station" stayed expressible. That is the capability given up,
and it is worth naming: **there is now one answer to "how low is low" for all 70
battery devices.** What is bought is that two rules can never disagree about it
— the D62 shape, one level up.

The **hysteresis is NOT a setting**. `BATTERY_LOW_HYSTERESIS_PCT = 5`, a constant
in `alerts/battery-band.ts`: a fourth knob whose only job is to stop the third
one misbehaving is a knob nobody can size.

The interval is bounded — 0, or 15 minutes to 7 days. Under 15 minutes a
"reminder" is a flood and the operator would switch the feature off rather than
tune it.

### D-4 — the all-clear, and the hysteresis trap it walks into

It covers both families: a battery back above the threshold
(`device-battery-normal`) and a device back online (the existing `device-online`,
now gated by the same flag). Default `true`, so an untouched install behaves
exactly as it does today.

**The trap the operator named, and how it is closed.** A recovery fired on the
raw value re-crossing the threshold would turn a reading oscillating around the
edge into alternating low/normal PAIRS — the precise noise the band ledger
exists to prevent. So:

- the stored fact is the **band**, never the percentage
  (`alerts/alert-episode.ts` holds `alerting: boolean`, not a reading);
- `low` is entered at `<= threshold` and left only at
  `>= threshold + BATTERY_LOW_HYSTERESIS_PCT`. Hysteresis is **one-directional**:
  a fault is believed the moment it is measured, and only the recovery has to
  clear the edge;
- a binary indicator gets no hysteresis at all — a source with two states cannot
  oscillate within a band it does not have.

`gate 3` in `alerts/__tests__/device-alerts.spec.ts` walks 20 → 21 → 20 → 22 → 24
and asserts exactly one notification.

**Switching the flag off suppresses the message, never the memory.** The ledger
row still moves. A state we never recorded leaving is a state we could never
announce entering again — which is D141's shared-cooldown bug, one level over,
and `nextAlertRow` refuses it explicitly.

### D-5 — first-level devices only

**Stricter than the draft's "exclude a child whose parent is online".** A device
with `parentDeviceId !== null` produces **no liveness subject at all**. One
sentence, and it does not depend on a second device's mirrored state being
fresh.

The cost is accepted and stated rather than hidden: **an accessory that is
genuinely dead is never announced.** The parent still is.

Measured effect on the current fleet: of the 100 devices reading offline, 96 are
accessories, so the rule takes the population to **4**. It gates liveness only —
`device-disabled` / `device-enabled` are the operator's own switch (D62), and
somebody who pressed something is owed the confirmation at whatever level the
device sits.

The drop is REPORTED (`discardedSystemEvent` → `reason: 'accessory'`, with
`tags: { deviceId }` and the parent id), because a branch that drops work
silently reads as an event that never happened.

## 5b. What was built

| Piece | Path |
| --- | --- |
| Band derivation, hysteresis, the never-reported gate | `notification-center/alerts/battery-band.ts` |
| The episode reducer (seed / raise / remind / recover) + record ids | `notification-center/alerts/alert-episode.ts` |
| The service: band → ledger → `consumeEvent`, and the reminder sweep | `notification-center/alerts/device-alerts.ts` |
| The durable rows | `notification-center/alerts/alert-store.ts` (`notification-center:device-alerts`) |
| The subject + the binary/numeric body variant | `event-intake.ts` → `incomingFromBatteryBand` |
| The accessory gate | `device-directory.ts` → `isAccessoryIdentity`, applied in `event-intake.ts` |
| The three settings | `pipeline-analytics/device-alert-settings.ts` + `settings-schema.ts` |
| Sentences (en/it) | `notification-center/texts/{en,it}.json` |
| Authorable kinds, admin | `addon-admin-ui/.../notification-system-events.ts` (its own **Battery** group) |

Three properties worth keeping in mind when reading it:

- **No new bus category and no producer change.**
  `EventCategory.DeviceStateChanged` was already subscribed; a `battery` slice
  already arrived at `onSystemEvent` and was dropped for not being
  `device-status`. Only the branch was missing.
- **A reminder is not a second delivery path.** It re-enters through
  `consumeEvent`, so the per-camera mute, the snooze, the rule conditions and the
  rule's own schedule all still apply — a reminder that bypassed them would
  arrive at 03:00 in a household that had said not to.
- **The reminder rides the rule-reload tick**, not a timer of its own: same
  cadence, already evaluating-node-only, and one less thing to forget to clear
  on `stop()`.

### Still to do before this ships

- **The viewer mirror.** `camstack/src/components/notifications/rule-editor.ts`
  hand-mirrors `NC_SYSTEM_EVENT_VALUES`, and
  `scripts/check-viewer-condition-mirror.ts` requires the viewer to go FIRST —
  publishing the hub kinds before the OTA would cost an operator the condition
  by opening the rule. The viewer is a submodule and was not touched here.
- **`npm run codegen`** was NOT run — see the note in section 7.
- A `device-battery-low` tap target in `system-event-tap-url.ts` (today it lands
  nowhere; `<base>/devices/<deviceId>` is the obvious answer, and
  `scripts/check-notification-tap-targets.ts` is the guard).

## 6. What this does NOT change

- The battery cap stays threshold-free. Its docblock is right: the threshold is
  the consumer's business, and putting one in the cap would put it on every
  provider.
- `deriveBatteryPresence` / `BATTERY_UNREACHABLE_AFTER_MS` (6 h) are a different
  question — "asleep or gone", D173 — and answer it for **4 devices** on this
  fleet (the only ones with `lastContactAt`). A battery-low alert must not be
  built on presence, and a presence alert is a separate feature.
- The `LOW_BATTERY_THRESHOLD_PCT = 20` in the HAP exporter is HomeKit's own
  characteristic and stays where it is. If the operator's threshold and HomeKit
  disagree, that is two ecosystems, not two authorities over one fact — but it
  is worth stating in the editor.

## 7. Open items, and what was NOT verifiable here

- **`npm run codegen` was not run, deliberately.** This worktree has no
  dependency tree of its own (`packages/types/dist` does not exist here; module
  resolution walks up into the main checkout), so codegen would have executed
  against the shared tree. It is also **not needed for this change**: nothing
  under `packages/types/src/generated/` references `NcSystemEventKind` or any of
  its members — codegen's output is about cap METHODS, routers and runtime
  state, and two new members of a `z.enum` inside a cap file change none of it.
  Verified by grep, not assumed. Run it anyway before merging if the branch
  touches a cap's method surface for another reason.

- **The `@camstack/types` half of this change is untested in this worktree.**
  `@camstack/types` resolves to the MAIN checkout's built `dist`, so the two new
  enum members are inert under vitest here. Every test written for this feature
  is therefore built on modules that do not need the new schema at runtime —
  which is honest, but it means **nothing here proves a rule carrying
  `kinds: ['device-battery-low']` parses.** That is the first thing to check on
  a hub running a server built from this branch.

- **29 `pipeline-analytics` spec files fail in this worktree, all
  pre-existing.** 19 fail to import (`AnalyticsGroupDetailSchema` is undefined —
  the symbol exists in this branch's `packages/types/src` and not in the main
  checkout's stale `dist`), 4 are ENOENT on cwd-relative source paths, and 2 are
  genuine assertion failures in `frame-processor.spec.ts` that reproduce
  identically in the untouched main checkout. The `notification-center` suite —
  149 files, 2202 tests, including everything added here — is green.

- Whether the HA container's `online` recompute races its children's flips. It
  no longer matters for the offline gate (D-5 does not read the parent's state),
  but it still governs whether the PARENT reports the outage the accessories no
  longer do.

- Device 3615 (Termometro sala server) reads 0 % with a fresh timestamp.
  `deriveBatteryStatus` returns `null` for a non-finite state, so an `'unknown'`
  would not have been written — **HYPOTHESIS: it is a real 0**, and it is the one
  device besides the two binaries that a low-battery rule would fire on today.

- The 22 ecowitt readings all sit at exactly 100 %. `batteryModeForUnit` gives
  the `battery` cap only to a `'percent'` battery, so these are genuine percent
  readings — but I did not confirm the outdoor array ever varies.

- **The outbox cost of the reminder is bounded by D-5, and that bound is now
  real.** One row per still-true condition per interval per target. At the
  current fleet — 2 binaries low, 1 numeric at 0 %, 4 first-level devices
  offline — a 12-hour interval is ~14 rows/day. The unscoped version the draft
  warned about (4,800 rows/day) is no longer expressible.
