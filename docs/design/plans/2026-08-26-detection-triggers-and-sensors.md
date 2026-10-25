# Plan — triggers from object detection and from sensors

> **For the implementer:** REQUIRED SKILL — use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans`. The steps use checkboxes
> (`- [ ]`) for tracking.

**Goal:** give an `events` band two more trigger sources —
**object detection** filtered on the three macro classes, and **sensor** on the
rising edge of a linked device — extending the ONE authority that today decides
whether to record (`band-decision.shouldRecordAt`), without placing a second one
beside it.

**Architecture:** four tracks. **0** is a prerequisite that adds no
functions: it makes a hole already present noisy (`audioThresholdDbfs` is a knob
that nobody feeds) and places the guard that prevents repeating the same
mistake with the two new sources. **A** (object detection) and **B**
(sensors) share a refactor of `TriggerState` that is the first step of A.
**C** is the UI, and depends on A and B.

**Stack:** TypeScript 5.7+, Zod 4, vitest, npm workspaces + nx.

## Global constraints

The rules of `CLAUDE.md` apply. In addition, verbatim:

- **No casts.** No `as any`, `as unknown as X`, `as never`. Exceptions: `as
  const` and a documented type boundary. Use discriminated unions and type guards.
  A bus event payload is **not** an exception: the precedent in house
  is `parseTopologySnapshotNodes` (`runtime/wire-subscriptions.ts:255`, *"A type
  GUARD, not a cast"*), not `ev.data as SensorStateChangedData` two lines below.
- **`z.infer<>` for Zod schemas** — never duplicate a shape by hand.
- **Named types**: no inline types on signatures or return values.
- **Every log line about a device carries `tags: { deviceId }`** with the numeric id.
  For a sensor trigger the `deviceId` is **the CAMERA**, and the sensor goes in
  `meta.sourceDeviceId` — it is the convention already chosen by
  `sensor-marker-projector.ts:30-32` (*"because the question always arrives as
  'why did 102 get a marker and 101 did not'"*).
- **A branch that silently throws work away logs it.** It holds for every verdict
  `qualified: false` and for every `edge: 'none'`.
- **Addons do not import each other.** `ctx.api` is the only layer. Framework
  packages (`@camstack/types`, `@camstack/system`) are **not**
  addons: `addon-pipeline` already depends on both
  (`packages/addon-pipeline/package.json:252` and `:258`).
- **`npm run codegen` after every touch to a `*.cap.ts`.** `RecordingConfigSchema`
  lives in `interfaces/`, but it is the input/output of `recording.getDeviceConfig` /
  `recording.setDeviceConfig` (`recording.cap.ts:293,326`): changing its shape
  is a change of tRPC surface. Run `codegen` and check the diff on
  `packages/types/src/generated/`.
- **A green test is not proof.** After every fix, DISARM the fix and confirm
  the test turns red. Report that you did.
- **Never `git --no-verify`, never `git add -A`, never `git stash`.** Explicit
  pathspecs. The tree is shared.
- **No task here touches the production hub.** Only code and tests.

---

## 1. The map of how it is today

### 1.1 Mode → schema → consumer

There is no `recordingMode` field. The authorised intent is a **list of
bands**; each band carries `mode: 'continuous' | 'events'` and, for `events`, its
`triggers`. "Off" is the ABSENCE of a band covering the instant.

| Mode | Where it is declared (schema) | Who writes it | Who READS it to decide whether to record |
| --- | --- | --- | --- |
| `continuous` | `RecordingBandModeSchema` — `packages/types/src/interfaces/recording-config.ts:59` | `RecordingSettings.tsx:62-69` → `alwaysBand('continuous')`; wire via `recording.setDeviceConfig` (`recording.cap.ts:326`) | `band-decision.ts:260` — `if (band.mode === 'continuous') return true` |
| `events` + **motion** | `RecordingTriggersSchema.motion` — `recording-config.ts:47` | `RecordingBandsEditor.tsx:151-152` | `band-decision.ts:225` — `if (band.triggers?.motion && fresh(latestTriggerMs(triggers, 'motion')))` |
| `events` + **audio** | `RecordingTriggersSchema.audioThresholdDbfs` — `recording-config.ts:48` | `RecordingBandsEditor.tsx:159-172` (default `-30` at the tick) | `band-decision.ts:226` — **and nothing else: the `'audio'` source is never fed.** See §1.4 |
| "off" | none — `bands: []` | `RecordingSettings.tsx:64` | `band-decision.ts:256` — `if (!bands || bands.length === 0) return false` |
| `mode` (`off/events/continuous`) | `RecordingStorageModeSchema` — `recording-config.ts:42` | **nobody**: DERIVED, stamped by the recorder in `config-store.ts:168-185` | nobody decides on it; it is only a summary (`deriveRecordingMode`, `recording-config.ts:213`) |

### 1.2 The full chain, from schema to the ffmpeg writer

```
motion.on-motion-changed                 (EventCategory:523)
  └─ subscribeEventCapture               recorder/event-capture.ts:48-53
        gate: markerFromMotion → data.detected === true   (event-capture.ts:17)
     └─ onMotion(deviceId, timestamp)    recorder/addon/index.ts:1237-1241
        └─ controller.onTrigger(deviceId, 'motion', atMs)
              recording-controller.ts:1010
           ├─ postBufferMsFor(deviceId, atMs)      :1055  ← band active at atMs
           ├─ recordTriggerWindow(...)             :1075
           │    └─ recordTrigger(state,'motion',atMs,postMs)  band-decision.ts:164
           └─ evaluateDevice(deviceId)             :1108
                └─ shouldRecordAt(config, triggers, now)  band-decision.ts:254
                     └─ eventsBandDemanded(band, triggers, atMs)  :222
                   → attach/detach of the SegmentWriters
```

Durable reconcile (D8/D11), because an event is telemetry and can drop:

```
reconcileTriggerHistory(deviceId)         recording-controller.ts:765
  └─ deps.loadMotionEvents(...)           recorder/addon/index.ts:701-710
       └─ ctx.api.pipelineAnalytics.getMotionEvents.query({ ..., projection:'slim' })
     └─ foldDurableTriggers(state,'motion',rows,postMs)  band-decision.ts:414
```

Retention gate (where `preBufferSec` acts, retroactive):

```
handleFinalizedSegment                    recording-controller.ts:~1745
  └─ segmentRetainedForEvents(...)        band-decision.ts:322-341
     not retained → fs.unlink, never indexed
```

Point-in-time alarm to close the window:

```
nextDecisionChangeAt                      decision-schedule.ts:166
  └─ eventsWindowCloseMs(band,triggers,now)  decision-schedule.ts:138-156
```

**Five points rewrite the same `motion` / `audio` if-ladder:**
`band-decision.ts:52-57` (`eventsBandCanEverDemand`), `:222-229`
(`eventsBandDemanded`), `:338-340` (`segmentRetainedForEvents`), `:368-372`
(`segmentMissedByMs`), `decision-schedule.ts:150-153` (`eventsWindowCloseMs`).
Adding two sources would mean five copies of a four-branch ladder. Task A1
collapses them into a single function.

### 1.3 Persistence and tRPC surface

- Collection: `RECORDING_CONFIGS_COLLECTION = 'recorder:recording-configs'`
  (`recorder/addon/config-store.ts:44`), one row per camera, PK
  `String(deviceId)`.
- `.strict()` write schema (`recording-config.ts:196`) — a partial patch
  is rejected, every writer sends the WHOLE config. `.strip()` read schema
  (`config-store.ts:68`).
- tRPC: `recording.getDeviceConfig` (query, admin) / `recording.setDeviceConfig`
  (mutation, admin).
- Hot read: `deps.loadConfig` is bound to `loadConfigLastKnownGood`
  (`recorder/addon/index.ts:690`) — a failed read serves the last good config,
  not the default.

### 1.4 The hole that ALREADY exists, and that this plan must not widen

`audioThresholdDbfs` is **authorised by the UI, read by every pure function, and
fed by nobody.**

- The only non-test call site of `onTrigger` is `recorder/addon/index.ts:1239`,
  with the string `'motion'`.
- `subscribeEventCapture` (`event-capture.ts:34-46`) exposes only `onMotion`.
- Consequence: `triggers.audio` is `[]` forever; `latestTriggerMs(…, 'audio')`
  answers `null` forever; an `events` band with ONLY the audio trigger records
  nothing, ever.
- And nobody notices: `eventsBandCanEverDemand` (`band-decision.ts:52`)
  considers `audioThresholdDbfs !== undefined` a valid trigger, so
  `reportUnrecordable` (`recording-controller.ts:1186-1211`) does **not** fire.

This is exactly the shape that D62 forbids — a switch that writes a store
that nobody reads. Adding two keys beside it without declaring it
would mean shipping three.

### 1.5 The "3 macro classes", with the source

`ObjectEvent.className` of a detection `source: 'pipeline'` is **always** a
macro: `COCO_TO_MACRO.preserveOriginal = false`
(`packages/types/src/catalogs/coco-classmap.ts:162`) and the executor discards every
unmapped class (`executor.ts:582-602`, `reason: 'class-filter'`).

The THREE the operator means are the offer of the `object-detection` step,
`packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts:183` (lines 183-188):

```ts
options: [
  { value: 'person', label: 'Person' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'animal', label: 'Animal' },
],
default: ['person', 'vehicle', 'animal'],
```

with the reason why `package` is NOT offered written above, at lines 174-182
(*"owned by the dedicated `package-detection` step… offering the same word twice
let an operator tick a box that turned on the proxy and left the real detector
off"*).

The same three exist as a TYPE, with no runtime value, in
`packages/types/src/types/detection.ts:136`:

```ts
export type FirstLevelMacro = 'person' | 'vehicle' | 'animal'
```

And a third list of the same three lives in the viewer as a display fallback:
`camstack/src/components/camera/theater/event-highlights.ts:33-58`
(`FALLBACK_MACRO`, *"the three theater macros"*).

`MACRO_LABELS` (`coco-classmap.ts:86-96`) has **four** — it includes
`package` — and feeds `DETECTION_MACRO_CLASSES` / `isDetectionMacroClass`
(`:115-121`). It is not the right list for this trigger: `package` is not
an output of the `object-detection` step that the operator can enable.

**So: the list to reuse is the one of the three, and today it is hand-written in
two places (the offer in `step-definitions.ts`, the union in `detection.ts`). Task A0
makes it ONE.**

### 1.6 How the rising edge of synthetic tracks really works

There are **two distinct mechanisms**, in two different processes, and only the
second has an edge.

**(a) The projection of the synthetic track — NO edge.**
`packages/addon-post-analysis/src/pipeline-analytics/runtime/wire-subscriptions.ts:235` (lines 235-246)
subscribes to `DeviceStateChanged`, filters on `EVENT_KIND_BY_CAP[data.capName]` and
that is all. `ingestSensorStateChange` (`services/event-kinds.ts:475-514`) saves the
raw slice in `SensorEvent.value` without looking inside it;
`projectSensorMarkers` (`services/sensor-marker-projector.ts:152-215`) never
inspects the slice. It is **level**, deduplicated only by the debounce per
`(camera, kind)` (`synthetic-track.ts`, `DEFAULT_DEBOUNCE_MS = 10_000`). A
contact that CLOSES produces a track exactly like one that opens.

**(b) The rising edge per device type — `DoorbellTriggerEngine`.**
`packages/system/src/builtins/doorbell/trigger-engine.ts`. Two tables and a <!-- drift-ok: deleted in slice 6 (D671), task 17 -->
predicate:

```ts
// trigger-engine.ts:22-33
export const SOURCE_CAP_ACTIVE_FIELD: Readonly<Record<string, string>> = {
  contact: 'entryOpen',
  binary: 'on',
  switch: 'on',
  motion: 'detected',
  flood: 'flooded',
  gas: 'detected',
  smoke: 'detected',
  'carbon-monoxide': 'detected',
  vibration: 'detected',
  tamper: 'tampered',
}

// trigger-engine.ts:47-58 — `motion` calls its `lastDetectedAt`, the others `lastChangedAt`
export const SOURCE_CAP_CHANGED_AT_FIELD: Readonly<Record<string, string>> = { … }
```

```ts
// trigger-engine.ts:87-94 — no truthiness coercion: `typeof === 'boolean'`
function sliceActiveValue(capName: string, slice: Record<string, unknown>): boolean | null {
  const field = SOURCE_CAP_ACTIVE_FIELD[capName]
  if (field === undefined) return null
  const raw = slice[field]
  return typeof raw === 'boolean' ? raw : null
}
```

```ts
// trigger-engine.ts:234-261 — THE edge
    const key = `${deviceId}:${capName}`
    const prior = this.lastValues.get(key)
    this.lastValues.set(key, value)

    if (prior === undefined) {
      if (!value) return ignoredResult('baseline-seeded-inactive')
      if (!this.roseAfterWeStartedWatching(capName, slice)) {
        return ignoredResult('baseline-seeded-stale-active')
      }
      return this.matchAndDebounce(deviceId)
    }
    if (prior === value) return ignoredResult('no-change')
    if (!value) return ignoredResult('falling-edge')
    return this.matchAndDebounce(deviceId)
```

The memory is a `Map` in RAM (`:192`), lost at every restart. The case of the
FIRST slice already active is handled explicitly (`:267-272`): it counts as an edge
only if the UPSTREAM timestamp of the transition is later than `startedAt` **and**
within `DEFAULT_FIRST_SIGHTING_FRESHNESS_MS = 30_000` (`:150`). The ambiguous case
**errs towards silence** and declares it (`baseline-seeded-stale-active`).

Deliberately EXCLUDED from the table: `presence` (string state
`home`/`not_home`), `connectivity` (*"a reconnect is not a doorbell press"*,
`:17-21`). They have no boolean; `lock-control`, `doorbell`, `button`,
`event-emitter`, `enum-sensor` neither (respectively an enum state, a `lastPressedAt`
pulse, no `runtimeState`, a `lastEvent`, a string).

There is **a second table** cap→field, with a different vocabulary:
`DEVICE_STATE_READERS` in `packages/types/src/catalogs/device-state-vocabulary.ts:40` (lines 40-49)
(it includes `presence`, `cover`, `alarm-panel`, and calls `lock` what the other
calls `lock-control`). It serves another question (the state WORD for a
rule), not the edge. **Do not unify them in this plan** — see §5.

### 1.7 How linked devices are enumerated

There is no link table. The association is DERIVED at read from three
inputs: the children of the device tree (`parentDeviceId`), the `location` of the
camera, and two reserved keys in the camera's config blob —
`packages/system/src/builtins/device-manager/device-linked-devices.ts:33` (lines 33-40):

```ts
export const LINKED_MODE_CONFIG_KEY = '_linkedDevicesMode'
export const LINKED_IDS_CONFIG_KEY = '_linkedDeviceIds'
export const LINKED_TRACKED_IDS_CONFIG_KEY = '_linkedDeviceTrackedIds'
```

The pure resolver is `resolveLinkedDeviceIds` (`:75-99`); the cap surface is
`deviceManager.getLinkedDevices` / `getLinkedDevicesBatch`
(`packages/types/src/capabilities/device-manager.cap.ts:648`, lines 648-672), schema
`LinkedDeviceSchema` (`:177-188`).

**D12, verbatim from `CLAUDE.md`:** *"Per-device aggregation walks
`getBindings(deviceId)` only — never the global cap list. Cap names are shared
across vendors."* So to know WHICH of the linked devices are candidates for a
trigger one goes through `deviceManager.getBindings({ deviceId: linkedId })`
(`device-manager.cap.ts:756`) and intersects the `entries[].capName` with
`SOURCE_CAPS`. Never `getAllBindings`, never a global list of caps.

The docblock of `getBindings` (`device-manager.cap.ts:758-783`) carries the
measurement of 2026-08-25: 75 concurrent `getBindings` = 1211 ms, `getBindingsBatch`
on the same set is the shape to use when the devices are more than one.

### 1.8 Where the mode is configured today in the UI

- **Admin UI**: `packages/addon-admin-ui/src/pages/Recordings.tsx:48` mounts
  `CameraRecordingSettingsSection`, which renders the composites of `ui-library`:
  `RecordingSettings.tsx` (the Off/Events/Continuous shortcuts, `:14-18`) and
  `RecordingBandsEditor.tsx` (the bands table + the trigger ticks, `:146-201`).
  The form state is in `recording-config-form.ts`.
- **Viewer**: authorises none of this. `camstack/src/` does not contain a
  single reference to `audioThresholdDbfs` nor to a band editor; it only reads
  availability (`src/recording/recording-availability.ts`).
- **D14 does not apply.** `recording` is `scope: 'system'`, `mode: 'singleton'`
  (`recording.cap.ts:248-250`), it is not a `deviceConfig` cap. Its
  `getDeviceSettingsContribution` (`recording-provider.ts:1131-1136`) returns
  a static schema and its `applyDeviceSettingsPatch` (`:1138-1147`) ignores
  every patch logging *"widget owns settings"*. The triggers UI is by hand, by
  design, and stays by hand.

---

## 2. File structure

| File | Responsibility | Track |
| --- | --- | --- |
| `scripts/check-recording-trigger-fed.ts` | **NEW** — every key of `RecordingTriggersSchema` has an `onTrigger` that feeds it | 0 <!-- drift-ok: this plan creates it --> |
| `packages/addon-pipeline/src/recorder/addon/recording-controller.ts` | `reportUnrecordable` reports the audio-only band; `onTrigger` takes a `TriggerSource` | 0, A, B |
| `packages/types/src/types/labels.ts` | `FIRST_LEVEL_MACRO_CLASSES` — THE list of the three | A |
| `packages/types/src/types/detection.ts` | `FirstLevelMacro` derived from the tuple, not rewritten | A |
| `packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts` | the `enabledMacroClasses` offer derived from the tuple | A |
| `packages/types/src/interfaces/recording-config.ts` | `RecordingTriggersSchema` gains `objectClasses` and `sensorDeviceIds` | A, B |
| `packages/addon-pipeline/src/recorder/addon/band-decision.ts` | `TriggerSource` union, key-based `TriggerState`, `bandTriggerSources` | A, B |
| `packages/addon-pipeline/src/recorder/addon/decision-schedule.ts` | window close on every listened source | A, B |
| `packages/addon-pipeline/src/recorder/object-trigger.ts` | **NEW** — qualifies a `detection-event` | A <!-- drift-ok: this plan creates it --> |
| `packages/types/src/catalogs/sensor-active-state.ts` | **NEW** — the cap→"high" table + the edge evaluator, MOVED | B <!-- drift-ok: this plan creates it --> |
| `packages/system/src/builtins/doorbell/trigger-engine.ts` | re-exports from `types`, does not redeclare | B | <!-- drift-ok: deleted in slice 6 (D671), task 17 -->
| `packages/addon-pipeline/src/recorder/sensor-trigger.ts` | **NEW** — edge memory + source→cameras reverse index | B <!-- drift-ok: this plan creates it --> |
| `packages/addon-pipeline/src/recorder/addon/index.ts` | the two new subscriptions + the two durable reconciles | A, B |
| `packages/ui-library/src/composites/cap-settings/RecordingBandsEditor.tsx` | two new controls | C |
| `packages/ui-library/src/composites/cap-settings/recording-config-form.ts` | the form state carries them | C |

> **Do not touch** `packages/addon-post-analysis/**`,
> `packages/types/src/capabilities/pipeline-analytics.cap.ts`,
> `packages/addon-pipeline/src/stream-broker/recorded/**`,
> `packages/addon-admin-ui/**` — as of 2026-08-26 other agents are working there.
> No task here needs them: the triggers UI lives in `ui-library`, and the
> two durable queries (`getObjectEvents`, `getSensorEvents`) **already exist**
> on the analytics cap (`pipeline-analytics.cap.ts:1448,1492`) — they are called, not
> added.

---

## Track 0 — do not ship a third dead key

### Task 0.1: a band that listens ONLY to audio is reported

Today `eventsBandCanEverDemand` (`band-decision.ts:52-57`) accepts
`audioThresholdDbfs !== undefined` as a valid trigger, so the band passes the
check and `reportUnrecordable` stays silent. The camera records nothing, forever,
without a line.

**Files:**
- Modify: `packages/addon-pipeline/src/recorder/addon/band-decision.ts`
- Modify: `packages/addon-pipeline/src/recorder/addon/__tests__/band-decision.spec.ts`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { eventsBandCanEverDemand, UNFED_TRIGGER_KEYS } from '../band-decision.js'
import type { RecordingBand } from '@camstack/types'

const band = (triggers: RecordingBand['triggers']): RecordingBand => ({
  days: [], start: '00:00', end: '23:59', mode: 'events', triggers,
})

describe('eventsBandCanEverDemand — unfed sources', () => {
  it('rejects a band that listens ONLY to audio: nobody calls onTrigger(_, audio)', () => {
    // It is not a judgement on the knob: it is the fact that the only call site of
    // `onTrigger` in production (recorder/addon/index.ts:1239) passes 'motion'.
    // As long as it stays so, this band cannot open a window.
    expect(eventsBandCanEverDemand(band({ audioThresholdDbfs: -30 }))).toBe(false)
  })

  it('accepts motion + audio — motion is enough to open the window', () => {
    expect(eventsBandCanEverDemand(band({ motion: true, audioThresholdDbfs: -30 }))).toBe(true)
  })

  it('names audio in the list of unfed keys, so the guard reads it', () => {
    expect([...UNFED_TRIGGER_KEYS]).toEqual(['audioThresholdDbfs'])
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/addon-pipeline band-decision`
      Expected: the first case answers `true`, and `UNFED_TRIGGER_KEYS` does not exist.

- [ ] **Step 3 — implement the minimum.**

```ts
/**
 * Keys of `RecordingTriggers` that are AUTHORISED by the UI and that nobody
 * feeds with an `onTrigger`.
 *
 * `audioThresholdDbfs` has been here since 2026-08-26 and not just since today: it is read by this
 * file (`:226`), by the retention gate (`:339`) and by the scheduler
 * (`decision-schedule.ts:152`), while the only call site of `onTrigger` in
 * production passes `'motion'` (`recorder/addon/index.ts:1239`) and
 * `subscribeEventCapture` exposes only `onMotion` (`event-capture.ts:45`).
 *
 * The list is READ by `scripts/check-recording-trigger-fed.ts`: adding a
 * key here is a dated declaration, not a shortcut. Removing one
 * requires having written the feed.
 */
export const UNFED_TRIGGER_KEYS: ReadonlySet<string> = new Set(['audioThresholdDbfs'])

export function eventsBandCanEverDemand(band: RecordingBand): boolean {
  if (band.mode !== 'events') return true
  return bandTriggerSources(band).length > 0 && resolveBandBufferMs(band).postMs > 0
}
```

> `bandTriggerSources` does not exist yet: at Task 0.1 write it in the minimal
> form (only `motion`), and Task A1 extends it. Excluding audio from
> `bandTriggerSources` is what makes `eventsBandCanEverDemand` false for the
> audio-only band AND fires the `'no trigger configured'` branch of
> `reportUnrecordable` (`recording-controller.ts:1206-1209`) — the line that
> was missing.

```ts
/**
 * THE sources this band listens to. The only place where the `triggers` of a
 * band become sources: before they were five copies of the same if-ladder
 * (`eventsBandCanEverDemand`, `eventsBandDemanded`, `segmentRetainedForEvents`,
 * `segmentMissedByMs`, `eventsWindowCloseMs`), which with four sources
 * would have become five four-branch ladders.
 *
 * A key in {@link UNFED_TRIGGER_KEYS} produces no sources: the band that
 * listens only to that "can never ask", and that is how the recorder
 * reports it instead of staying silent.
 */
export function bandTriggerSources(band: RecordingBand): readonly TriggerSource[] {
  const t = band.triggers
  if (t === undefined) return []
  const sources: TriggerSource[] = []
  if (t.motion === true) sources.push({ kind: 'motion' })
  return sources
}
```

- [ ] **Step 4 — run the test: it PASSES.** Then put `audioThresholdDbfs` back in
      `bandTriggerSources` and confirm the first case turns RED again.

### Task 0.2: the guard that prevents the fourth dead key

- [ ] **Step 1 — write `scripts/check-recording-trigger-fed.ts`.** <!-- drift-ok: this plan creates it -->

```ts
/**
 * Every key of `RecordingTriggersSchema` must have a feed.
 *
 * The failure this guard prevents has already cost: `audioThresholdDbfs`
 * is shipped, authorisable from the UI, read by four pure functions and fed
 * by nobody — a band that listens only to audio records nothing, forever,
 * and before 2026-08-26 it did not even produce a line.
 *
 * The check: for every key of the schema there is a `kind` of `TriggerSource`
 * that `bandTriggerSources` can emit for it, AND at least one `onTrigger(` with
 * that `kind` outside the tests in `packages/addon-pipeline/src/recorder/`.
 * An exception is declared in `UNFED_TRIGGER_KEYS`, in code, with the reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { RecordingTriggersSchema } from '@camstack/types'
import {
  TRIGGER_KEY_TO_SOURCE_KIND,
  UNFED_TRIGGER_KEYS,
} from '../packages/addon-pipeline/src/recorder/addon/band-decision.js'

const RECORDER_SRC = path.resolve('packages/addon-pipeline/src/recorder')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(full)
    }
    return full.endsWith('.ts') ? [full] : []
  })
}

const corpus = sourceFiles(RECORDER_SRC)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')

const failures: string[] = []
for (const key of Object.keys(RecordingTriggersSchema.shape)) {
  if (UNFED_TRIGGER_KEYS.has(key)) continue
  const kind = TRIGGER_KEY_TO_SOURCE_KIND[key]
  if (kind === undefined) {
    failures.push(`${key}: no TriggerSource.kind declared in TRIGGER_KEY_TO_SOURCE_KIND`)
    continue
  }
  if (!corpus.includes(`kind: '${kind}'`)) {
    failures.push(
      `${key} → kind '${kind}': no onTrigger feeds it under ${RECORDER_SRC}. ` +
        `Write the feed, or declare it in UNFED_TRIGGER_KEYS with the reason.`,
    )
  }
}

if (failures.length > 0) {
  console.error('check-recording-trigger-fed: trigger keys without a feed\n' + failures.join('\n'))
  process.exit(1)
}
console.log(`check-recording-trigger-fed: ok (${Object.keys(RecordingTriggersSchema.shape).length} keys)`)
```

> ⚠ CORRECTION 2026-08-27. Track 0 was shipped BEFORE this session
> and the guard already exists, wired into `.github/workflows/ci.yml`. Its real
> shape is stronger than the one below: it demands a real `onTrigger(` in
> production (not a generic `kind: '…'` in the corpus) and reads
> `TRIGGER_KEY_TO_SOURCE_KIND`. With the object union of Track A1 its
> pattern became `onTrigger\([^)]*kind:\s*'<kind>'`.

- [ ] **Step 2 — declare the key→kind map in `band-decision.ts`.**

```ts
/** Which `TriggerSource.kind` feeds each key of `RecordingTriggers`.
 *  Read by the guard; it is the bridge between the wire shape and the internal shape. */
export const TRIGGER_KEY_TO_SOURCE_KIND: Readonly<Record<string, TriggerSourceKind>> = {
  motion: 'motion',
  audioThresholdDbfs: 'audio',
}
```

- [ ] **Step 3 — verify that the guard is TRUE**: remove `audioThresholdDbfs`
      from `UNFED_TRIGGER_KEYS`, run `npx tsx scripts/check-recording-trigger-fed.ts`,
      confirm exit 1 with the right message, put it back.
- [ ] **Step 4 — wire the guard** in `.github/workflows/ci.yml`, next to
      `check-event-kind-coverage.ts`.

---

## Track A — object detection as a trigger source

### Task A0: ONE list of three macro classes

Today the three are hand-written twice: the offer in
`step-definitions.ts:183-188` and the union `FirstLevelMacro` in
`detection.ts:136`. The trigger would be the third. `MACRO_LABELS`
(`coco-classmap.ts:86`) is not suitable: it contains `package`, which this step does not
offer for a written reason (`step-definitions.ts:174-182`).

**Files:**
- Modify: `packages/types/src/types/labels.ts`
- Modify: `packages/types/src/types/detection.ts`
- Modify: `packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts`
- Create: `packages/types/src/types/__tests__/first-level-macro.spec.ts` <!-- drift-ok: this plan creates it -->

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { FIRST_LEVEL_MACRO_CLASSES, CLASS_MAP_MACRO_TARGETS } from '../labels.js'

describe('FIRST_LEVEL_MACRO_CLASSES', () => {
  it('is exactly the offer of the object-detection step', () => {
    expect([...FIRST_LEVEL_MACRO_CLASSES]).toEqual(['person', 'vehicle', 'animal'])
  })

  it('does NOT contain package — it is owned by the package-detection step', () => {
    // step-definitions.ts:174-182: offering the same word twice has already
    // made an operator turn on the COCO proxy while leaving the real
    // detector off.
    expect(FIRST_LEVEL_MACRO_CLASSES).not.toContain('package')
  })

  it('is a subset of the targets a classMap can resolve', () => {
    // If a first-level macro were not a valid target, the executor
    // could never produce it and the trigger on it would be mute.
    for (const macro of FIRST_LEVEL_MACRO_CLASSES) {
      expect(CLASS_MAP_MACRO_TARGETS).toContain(macro)
    }
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/types first-level-macro`
      Expected: `FIRST_LEVEL_MACRO_CLASSES` is not exported from `labels.ts`.

- [ ] **Step 3 — implement.** In `packages/types/src/types/labels.ts`, next
      to `CLASS_MAP_MACRO_TARGETS`:

```ts
/**
 * The FIRST-LEVEL macro classes: the ones an object detector emits and that an
 * operator can select.
 *
 * They are the three offered by the `object-detection` step
 * (`step-definitions.ts`, `enabledMacroClasses`). `package` is in
 * {@link CLASS_MAP_MACRO_TARGETS} and in `MACRO_LABELS` — it is a true macro — but
 * NOT here: it belongs to the `package-detection` step, whose enabling is
 * driven by zones, and offering the same word twice has already made an operator
 * turn on the COCO proxy (suitcase/backpack/handbag) while leaving the dedicated
 * detector off.
 *
 * ONE list. Before today the same three were hand-written in the step's offer
 * and a second time as the union `FirstLevelMacro`; a third copy
 * for the recording trigger would have made the next divergence invisible.
 */
export const FIRST_LEVEL_MACRO_CLASSES = ['person', 'vehicle', 'animal'] as const
export type FirstLevelMacroClass = (typeof FIRST_LEVEL_MACRO_CLASSES)[number]

/** True when `value` is a first-level macro. Type guard, not cast: a
 *  `className` arriving from the bus is any string until it passes through here. */
export function isFirstLevelMacroClass(value: string): value is FirstLevelMacroClass {
  return FIRST_LEVEL_MACRO_CLASSES.some((macro) => macro === value)
}
```

  In `packages/types/src/types/detection.ts:136`, replace the hand-written
  union:

```ts
import type { FirstLevelMacroClass } from './labels.js'

/** First-level macro classes produced by object detectors.
 *  Alias of {@link FirstLevelMacroClass} — the list lives in `labels.ts`. */
export type FirstLevelMacro = FirstLevelMacroClass
```

  In `step-definitions.ts`, derive the offer:

```ts
        options: FIRST_LEVEL_MACRO_CLASSES.map((value) => ({
          value,
          label: value.charAt(0).toUpperCase() + value.slice(1),
        })),
        default: [...FIRST_LEVEL_MACRO_CLASSES],
```

> ⚠ CORRECTION 2026-08-27 (implementation). `packages/addon-pipeline/src/detection-pipeline/**`
> was in the hands of another session and was NOT touched, so the offer is
> still hand-written. In its place a GUARDIAN was put outside that
> directory —
> `packages/addon-pipeline/src/__tests__/first-level-macro-offer.spec.ts` — which
> reads `getStep('object-detection').getConfigSchema()` at runtime and demands that
> `options` and `default` coincide with `FIRST_LEVEL_MACRO_CLASSES`. Whoever really
> derives the offer deletes that test; until then, the divergence is red
> instead of invisible.

- [ ] **Step 4 — run the entire `types` and `addon-pipeline` suite.** No existing
      test must change: if `tree-builder-defaults.spec.ts:75`
      (*"enabledMacroClasses defaults to all three"*) or
      `executor-per-model-class-map.spec.ts:90` break, the derivation changed
      behaviour and must be redone.
- [ ] **Step 5 — `npm run codegen`** and verify that the diff on
      `packages/types/src/generated/` is empty (no `*.cap.ts` changed,
      but `labels.ts` is re-exported: confirm it, do not assume it).

### Task A1: `TriggerState` becomes KEY-based, and the five ladders become one

`TriggerState` is today `{ motion: TriggerWindow[], audio: TriggerWindow[] }`
(`band-decision.ts:105-108`). With four sources, two of them
PARAMETRIC (one per macro class, one per source device), two fixed fields
are not enough.

**Why parametric and not a single `object` bucket.** Motion is a single signal.
Detection is a flow in which the MAJORITY of events are of the wrong class: with
a single bucket, a band that listens to `person` would record on every passing
car — a permanent and silent over-recording that reads as "the class filter does
not work". With a key per class, the live gate and the retention gate read the
same truth.

**Files:**
- Modify: `packages/addon-pipeline/src/recorder/addon/band-decision.ts`
- Modify: `packages/addon-pipeline/src/recorder/addon/decision-schedule.ts`
- Modify: `packages/addon-pipeline/src/recorder/addon/recording-controller.ts`
- Modify: the existing tests that build a literal `TriggerState`
  (`__tests__/band-decision.spec.ts`, `__tests__/decision-schedule.spec.ts`)

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import {
  EMPTY_TRIGGER_STATE,
  latestTriggerMs,
  recordTrigger,
  pruneTriggerHistory,
  triggerKey,
  type TriggerSource,
} from '../band-decision.js'

const person: TriggerSource = { kind: 'object', macroClass: 'person' }
const vehicle: TriggerSource = { kind: 'object', macroClass: 'vehicle' }
const sensor42: TriggerSource = { kind: 'sensor', sourceDeviceId: 42 }

describe('key-based TriggerState', () => {
  it('separates two macro classes: a person does not open the vehicles window', () => {
    const { state } = recordTrigger(EMPTY_TRIGGER_STATE, person, 1_000, 30_000)
    expect(latestTriggerMs(state, person)).toBe(1_000)
    expect(latestTriggerMs(state, vehicle)).toBeNull()
  })

  it('separates two sensors on the same camera', () => {
    const a = recordTrigger(EMPTY_TRIGGER_STATE, sensor42, 1_000, 30_000).state
    expect(latestTriggerMs(a, { kind: 'sensor', sourceDeviceId: 43 })).toBeNull()
  })

  it('the key is stable and readable — it is the one that ends up in the logs', () => {
    expect(triggerKey({ kind: 'motion' })).toBe('motion')
    expect(triggerKey(person)).toBe('object:person')
    expect(triggerKey(sensor42)).toBe('sensor:42')
  })

  it('pruning REMOVES the emptied key, it does not leave an empty array', () => {
    // This is what bounds the map: a sensor removed from the band stops
    // occupying a key instead of staying forever at length zero.
    const { state } = recordTrigger(EMPTY_TRIGGER_STATE, sensor42, 1_000, 30_000)
    const pruned = pruneTriggerHistory(state, 30_000, 1_000 + 30_000 + 120_000 + 1)
    expect(latestTriggerMs(pruned, sensor42)).toBeNull()
    expect(pruned.windows.size).toBe(0)
  })

  it('returns the SAME object when nothing has expired', () => {
    const { state } = recordTrigger(EMPTY_TRIGGER_STATE, person, 1_000, 30_000)
    expect(pruneTriggerHistory(state, 30_000, 1_100)).toBe(state)
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/addon-pipeline band-decision`

- [ ] **Step 3 — implement.**

```ts
/** The `kind`s a trigger source can have. */
export type TriggerSourceKind = 'motion' | 'audio' | 'object' | 'sensor'

/**
 * WHICH signal opened a window.
 *
 * Discriminated union and not a string: two sources are PARAMETRIC — one
 * window per macro class, one per source device — and a `${kind}:${param}`
 * typed `string` would let `'object:persno'` compile.
 */
export type TriggerSource =
  | { readonly kind: 'motion' }
  | { readonly kind: 'audio' }
  | { readonly kind: 'object'; readonly macroClass: FirstLevelMacroClass }
  | { readonly kind: 'sensor'; readonly sourceDeviceId: number }

/** The key under which a source keeps its windows. It is also the
 *  string that appears in the logs, so it is readable by design. */
export function triggerKey(source: TriggerSource): string {
  switch (source.kind) {
    case 'motion':
      return 'motion'
    case 'audio':
      return 'audio'
    case 'object':
      return `object:${source.macroClass}`
    case 'sensor':
      return `sensor:${source.sourceDeviceId}`
  }
}

/**
 * History of a device's QUALIFYING triggers, a list of windows per
 * key. The qualification (motion detected / class enabled / rising edge) stays
 * upstream, so this layer is pure timestamp comparison.
 *
 * ## Why a map and not two fields
 *
 * They were `{ motion, audio }`. With object detection a band must be able to
 * listen to `person` and not `vehicle`, and with sensors to device 42 and not 43.
 * A single bucket per source would make the "people only" band record on
 * every car: the live gate and the retention gate would read a signal
 * the band never asked for.
 *
 * ## The limit on KEYS
 *
 * {@link MAX_TRIGGER_WINDOWS} limits the windows per key; the keys are
 * limited by the schema — `motion` + `audio` + at most 3 `objectClasses` (enum)
 * + at most {@link MAX_SENSOR_TRIGGER_DEVICES} `sensorDeviceIds`. And
 * {@link pruneTriggerHistory} DELETES the key that empties, so a sensor
 * removed from the band stops occupying space instead of staying at zero.
 */
export interface TriggerState {
  readonly windows: ReadonlyMap<string, readonly TriggerWindow[]>
}

/** No trigger seen yet for this device. */
export const EMPTY_TRIGGER_STATE: TriggerState = { windows: new Map() }

function windowsFor(state: TriggerState, source: TriggerSource): readonly TriggerWindow[] {
  return state.windows.get(triggerKey(source)) ?? []
}

function withWindows(
  state: TriggerState,
  source: TriggerSource,
  windows: readonly TriggerWindow[],
): TriggerState {
  const next = new Map(state.windows)
  const key = triggerKey(source)
  if (windows.length === 0) next.delete(key)
  else next.set(key, windows)
  return { windows: next }
}

export function latestTriggerMs(state: TriggerState, source: TriggerSource): number | null {
  const windows = windowsFor(state, source)
  return windows[windows.length - 1]?.lastMs ?? null
}

export function pruneTriggerHistory(
  state: TriggerState,
  postMs: number,
  nowMs: number,
): TriggerState {
  const cutoffMs = nowMs - postMs - TRIGGER_HISTORY_MARGIN_MS
  const next = new Map<string, readonly TriggerWindow[]>()
  let changed = false
  for (const [key, windows] of state.windows) {
    const live = windows.filter((w) => w.lastMs >= cutoffMs)
    if (live.length !== windows.length) changed = true
    if (live.length > 0) next.set(key, live)
  }
  return changed ? { windows: next } : state
}
```

  `recordTrigger` changes only its signature (`source: TriggerSource`); the body —
  merge onto the most recent window within `mergeGapMs`, `evicted` beyond
  `MAX_TRIGGER_WINDOWS` — stays **byte for byte today's**
  (`band-decision.ts:170-188`). Likewise `foldDurableTriggers` (`:414-446`).

  And the five ladders become calls to `bandTriggerSources`:

```ts
function eventsBandDemanded(band: RecordingBand, triggers: TriggerState, atMs: number): boolean {
  const { postMs } = resolveBandBufferMs(band)
  return bandTriggerSources(band).some((source) => {
    const lastMs = latestTriggerMs(triggers, source)
    return lastMs !== null && atMs - lastMs <= postMs
  })
}

export function segmentRetainedForEvents(
  segStartMs: number,
  segEndMs: number,
  band: RecordingBand,
  triggers: TriggerState,
  attach: AttachWindow,
): boolean {
  const { preMs, postMs } = resolveBandBufferMs(band)
  const deadlineMs = attachRetainDeadlineMs(attach)
  const overlaps = (window: TriggerWindow): boolean => {
    if (segEndMs < window.firstMs - preMs) return false
    if (segStartMs <= window.lastMs + postMs) return true
    return attach.attachedAtMs <= window.lastMs + postMs && segStartMs <= deadlineMs
  }
  return bandTriggerSources(band).some((source) => windowsFor(triggers, source).some(overlaps))
}

export function segmentMissedByMs(
  segStartMs: number,
  band: RecordingBand,
  triggers: TriggerState,
  attach: AttachWindow,
): number | null {
  const { postMs } = resolveBandBufferMs(band)
  const deadlineMs = attachRetainDeadlineMs(attach)
  const latestKeptStart = (window: TriggerWindow): number => {
    const windowEndMs = window.lastMs + postMs
    return attach.attachedAtMs <= windowEndMs ? Math.max(windowEndMs, deadlineMs) : windowEndMs
  }
  const considered = bandTriggerSources(band).flatMap((source) => [...windowsFor(triggers, source)])
  if (considered.length === 0) return null
  return segStartMs - Math.max(...considered.map(latestKeptStart))
}
```

  In `decision-schedule.ts:138-156`:

```ts
export function eventsWindowCloseMs(
  band: RecordingBand,
  triggers: TriggerState,
  nowMs: number,
): number | null {
  if (band.mode !== 'events') return null
  const { postMs } = resolveBandBufferMs(band)
  // The most RECENT window of each listened source closes last: only
  // that one can keep the live gate open. The older ones serve the retention
  // gate, which reads pre-trigger footage for which the live gate does not reopen.
  const open = bandTriggerSources(band)
    .map((source) => latestTriggerMs(triggers, source))
    .filter((ms): ms is number => ms !== null)
    .map((ms) => ms + postMs)
    .filter((ms) => ms >= nowMs)
  if (open.length === 0) return null
  return Math.max(...open) + GATE_INCLUSIVE_EPSILON_MS
}
```

- [ ] **Step 4 — port the existing tests, mechanically.** Every
      `{ motion: [w], audio: [] }` becomes
      `recordTrigger(EMPTY_TRIGGER_STATE, { kind: 'motion' }, w.lastMs, gap).state`
      (or a `triggerStateOf` helper local to the test file). **The ASSERTIONS do not
      change.** If an assertion has to be touched, the refactor changed
      behaviour and must be redone — not the assertion.
- [ ] **Step 5 — disarm:** make `windowsFor` always read the key
      `'motion'` again and confirm that the test "separates two macro classes" turns red.

### Task A2: the object trigger schema

**Files:**
- Modify: `packages/types/src/interfaces/recording-config.ts`
- Modify: `packages/types/src/interfaces/__tests__/recording-config.spec.ts`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { RecordingTriggersSchema } from '../recording-config.js'

describe('RecordingTriggersSchema.objectClasses', () => {
  it('accepts a subset of the three macro classes', () => {
    const parsed = RecordingTriggersSchema.parse({ objectClasses: ['person', 'vehicle'] })
    expect(parsed.objectClasses).toEqual(['person', 'vehicle'])
  })

  it('rejects an EMPTY array — it is "an events band that never records"', () => {
    // Absent = the source is not listened to. Empty would be the same thing
    // written in a way that looks like a configuration.
    expect(() => RecordingTriggersSchema.parse({ objectClasses: [] })).toThrow()
  })

  it('rejects package — it is not an output of the object-detection step', () => {
    expect(() => RecordingTriggersSchema.parse({ objectClasses: ['package'] })).toThrow()
  })

  it('rejects a repeated class — it would double the count in segmentMissedByMs', () => {
    expect(() => RecordingTriggersSchema.parse({ objectClasses: ['person', 'person'] })).toThrow()
  })

  it('stays compatible: a motion-only band keeps parsing', () => {
    expect(RecordingTriggersSchema.parse({ motion: true })).toEqual({ motion: true })
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/types recording-config`

- [ ] **Step 3 — implement.**

```ts
import { FIRST_LEVEL_MACRO_CLASSES } from '../types/labels.js'

/** The macro classes that can open a recording window — the same
 *  three offered by the `object-detection` step, from ONE list. */
export const RecordingObjectTriggerClassSchema = z.enum(FIRST_LEVEL_MACRO_CLASSES)
export type RecordingObjectTriggerClass = z.infer<typeof RecordingObjectTriggerClassSchema>

/** How many source devices a single band can listen to.
 *
 *  It is not a matter of taste: each source is a KEY in `TriggerState`, and the limit
 *  per key (`MAX_TRIGGER_WINDOWS = 32`) without a limit on keys
 *  would let the map grow with the operator's inventory. 16 sensors on
 *  ONE camera is already beyond any observed installation. */
export const MAX_SENSOR_TRIGGER_DEVICES = 16

const noDuplicates = <T>(values: readonly T[]): boolean => new Set(values).size === values.length

/** Which detectors open an `events` band. */
export const RecordingTriggersSchema = z.object({
  motion: z.boolean().optional(),
  audioThresholdDbfs: z.number().optional(),
  /**
   * The macro classes whose detection opens a window. ABSENT = the source
   * is not listened to; an EMPTY array is rejected, because "events band, object
   * trigger on, no class" is the same "enabled and records
   * nothing, forever" shape against which `eventsBandCanEverDemand` is written.
   *
   * The signal read is ALREADY FILTERED: only `source: 'pipeline'` detections, that is
   * those that went through `enabledMacroClasses`, the
   * `minConfidence<Macro>` and the full-frame guard. See `object-trigger.ts`.
   */
  objectClasses: z
    .array(RecordingObjectTriggerClassSchema)
    .min(1)
    .refine(noDuplicates, { message: 'objectClasses must not repeat a class' })
    .optional(),
})
export type RecordingTriggers = z.infer<typeof RecordingTriggersSchema>
```

- [ ] **Step 4 — `npm run codegen`.** `RecordingConfigSchema` is the input and output
      of two cap methods: check the diff on `packages/types/src/generated/` and
      on `docs/reference/api.md` (generated at commit).

### Task A3: qualify a `detection-event`

The live signal is `EventCategory.PipelineAnalyticsDetectionEvent`
(`event-category.ts:564`), emitted once per persisted object event
(`pipeline-analytics/index.ts:6530-6553`) with a FLAT payload made on purpose:
*"Enriched (flat) so consumers can filter on className / confidence / zones /
source WITHOUT re-fetching the persisted event by id"*.

**The branch that must be rejected, and why.** `source: 'onboard'` is the camera's AI.
`nativeDetectionsToFrame` (`pipeline/native-detection.ts:50-59`) copies the
firmware's class verbatim — `macroClass: d.class` — and that vocabulary includes
`face` and `other` (`native-object-detection.cap.ts:17-24`). It does not go through
the executor, so steps 2, 3 and 4 of the filter chain in
`docs/architecture/object-detection.md` (`enabledMacroClasses`,
`minConfidence<Macro>`, `fullFrameGuardMaxConfidence`) **have never run** on it.
Recording on it would mean recording on a raw signal
while the operator's sliders describe a gated one: two truths about the
same detection.

**Files:**
- Create: `packages/addon-pipeline/src/recorder/object-trigger.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-pipeline/src/recorder/__tests__/object-trigger.spec.ts` <!-- drift-ok: this plan creates it -->

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { qualifyObjectTrigger } from '../object-trigger.js'

const evt = (over: Record<string, unknown> = {}): unknown => ({
  deviceId: 102,
  kind: 'object',
  eventId: 'e1',
  timestamp: 1_700_000_000_000,
  source: 'pipeline',
  className: 'person',
  confidence: 0.9,
  zones: [],
  ...over,
})

describe('qualifyObjectTrigger', () => {
  it('qualifies a pipeline detection of a macro class', () => {
    expect(qualifyObjectTrigger(evt())).toEqual({
      qualified: true,
      deviceId: 102,
      macroClass: 'person',
      atMs: 1_700_000_000_000,
    })
  })

  it('rejects source onboard — it has not gone through any detector gate', () => {
    expect(qualifyObjectTrigger(evt({ source: 'onboard' }))).toEqual({
      qualified: false,
      reason: 'not-pipeline',
    })
  })

  it('treats an absent source as pipeline — legacy rows have none', () => {
    const { source, ...legacy } = { ...(evt() as Record<string, unknown>) }
    expect(qualifyObjectTrigger(legacy)).toMatchObject({ qualified: true })
  })

  it('rejects a kind that is not object (audio, package) on the same topic', () => {
    expect(qualifyObjectTrigger(evt({ kind: 'audio' }))).toEqual({
      qualified: false,
      reason: 'not-object',
    })
  })

  it('rejects a className that is not one of the three macros', () => {
    // E.g. `package`, or a row written before preserveOriginal was false.
    expect(qualifyObjectTrigger(evt({ className: 'package' }))).toEqual({
      qualified: false,
      reason: 'not-a-macro',
    })
  })

  it('normalises spaces and case before deciding', () => {
    expect(qualifyObjectTrigger(evt({ className: ' Person ' }))).toMatchObject({
      qualified: true,
      macroClass: 'person',
    })
  })

  it('rejects a malformed payload instead of crashing the subscription', () => {
    expect(qualifyObjectTrigger(null)).toEqual({ qualified: false, reason: 'malformed' })
    expect(qualifyObjectTrigger({ deviceId: '102' })).toEqual({
      qualified: false,
      reason: 'malformed',
    })
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/addon-pipeline object-trigger`

- [ ] **Step 3 — implement.**

```ts
/**
 * The gate between `pipeline-analytics.detection-event` and "open a
 * recording window".
 *
 * Sibling of `recorder/event-capture.ts` and for the same reason: the qualification
 * has branches, and a branch that discards work without saying so is indistinguishable
 * from a function never wired. Every negative verdict names the reason, and the
 * caller logs it.
 *
 * Pure: no bus, no clock, no config. The choice of WHICH classes to listen to
 * is the band's (`bandTriggerSources`); here we decide only whether
 * the event is a usable detection and of which macro class it is.
 */
import { isFirstLevelMacroClass, type FirstLevelMacroClass } from '@camstack/types'

/** The flat shape that `PipelineAnalyticsDetectionEvent` carries
 *  (`pipeline-analytics/index.ts:6544-6552`). */
interface DetectionEventData {
  readonly deviceId: number
  readonly kind: string
  readonly timestamp: number
  readonly className: string
  readonly source?: string
}

/** Why a `detection-event` opened no window. */
export type ObjectTriggerSkipReason =
  /** The payload does not have the expected shape — emitter of a different version. */
  | 'malformed'
  /** Same topic, other `kind` (audio, package): it is not an object detection. */
  | 'not-object'
  /** `source: 'onboard'` — the camera's AI, which does not go through the executor. */
  | 'not-pipeline'
  /** A `className` outside the three first-level macros. */
  | 'not-a-macro'

export type ObjectTriggerVerdict =
  | {
      readonly qualified: true
      readonly deviceId: number
      readonly macroClass: FirstLevelMacroClass
      readonly atMs: number
    }
  | { readonly qualified: false; readonly reason: ObjectTriggerSkipReason }

/** Type guard, not cast: `ev.data` is `unknown` until it passes through here. */
function isDetectionEventData(value: unknown): value is DetectionEventData {
  if (typeof value !== 'object' || value === null) return false
  if (!('deviceId' in value) || typeof value.deviceId !== 'number') return false
  if (!('kind' in value) || typeof value.kind !== 'string') return false
  if (!('timestamp' in value) || typeof value.timestamp !== 'number') return false
  if (!('className' in value) || typeof value.className !== 'string') return false
  if ('source' in value && value.source !== undefined && typeof value.source !== 'string') {
    return false
  }
  return true
}

export function qualifyObjectTrigger(data: unknown): ObjectTriggerVerdict {
  if (!isDetectionEventData(data)) return { qualified: false, reason: 'malformed' }
  if (data.kind !== 'object') return { qualified: false, reason: 'not-object' }
  // `onboard` is the CAMERA's AI. `nativeDetectionsToFrame` copies the firmware's
  // class verbatim (`macroClass: d.class`, native-detection.ts:55) and that
  // vocabulary includes `face` and `other`; it does not go through the executor, so
  // `enabledMacroClasses`, the `minConfidence<Macro>` and the full-frame guard — the
  // steps 2-4 of the chain in docs/architecture/object-detection.md — have never
  // run on it. Recording on it would be a SECOND truth about the
  // same detection. Absent ⇒ `pipeline` (legacy rows, DetectionSourceSchema).
  if ((data.source ?? 'pipeline') !== 'pipeline') {
    return { qualified: false, reason: 'not-pipeline' }
  }
  const className = data.className.trim().toLowerCase()
  if (!isFirstLevelMacroClass(className)) return { qualified: false, reason: 'not-a-macro' }
  return { qualified: true, deviceId: data.deviceId, macroClass: className, atMs: data.timestamp }
}
```

- [ ] **Step 4 — disarm:** remove the check on `source` and confirm that the
      test "rejects source onboard" turns red.

### Task A4: wire the object source into the recorder

**Files:**
- Modify: `packages/addon-pipeline/src/recorder/addon/index.ts`
- Modify: `packages/addon-pipeline/src/recorder/addon/band-decision.ts`
  (`bandTriggerSources` + `TRIGGER_KEY_TO_SOURCE_KIND`)
- Modify: `packages/addon-pipeline/src/recorder/addon/recording-controller.ts`

- [ ] **Step 1 — integration test, on the existing harness**
      (`__tests__/recording-controller-event-driven.spec.ts` is the model):

```ts
it('a person opens the window of a band listening to person; a vehicle does not', async () => {
  const h = harness({ bands: [eventsBand({ objectClasses: ['person'] })] })
  await h.controller.onTrigger(DEVICE_ID, { kind: 'object', macroClass: 'vehicle' }, h.now())
  expect(h.attached()).toBe(false)
  await h.controller.onTrigger(DEVICE_ID, { kind: 'object', macroClass: 'person' }, h.now())
  expect(h.attached()).toBe(true)
})
```

- [ ] **Step 2 — verify that it FAILS** (the second `expect` is `false`).

- [ ] **Step 3 — implement.** In `bandTriggerSources`:

```ts
  for (const macroClass of t.objectClasses ?? []) sources.push({ kind: 'object', macroClass })
```

  in `TRIGGER_KEY_TO_SOURCE_KIND`: `objectClasses: 'object'`.

  And the subscription, next to `subscribeEventCapture`
  (`recorder/addon/index.ts:1232-1242`):

```ts
    if (this.detectionUnsub === null) {
      this.detectionUnsub = this.ctx.eventBus.subscribe(
        { category: EventCategory.PipelineAnalyticsDetectionEvent },
        (event) => {
          const verdict = qualifyObjectTrigger(event.data)
          if (!verdict.qualified) {
            // Silence reads as "it never happened". `debug` and not
            // `info` because `not-object` and `not-a-macro` travel at bus
            // rate on every camera with the pipeline on; `not-pipeline` is the
            // line that answers "why does the camera with onboard AI
            // never record on the object trigger".
            this.ctx.logger.debug('recorder: detection event did not qualify as a trigger', {
              meta: { reason: verdict.reason },
            })
            return
          }
          void this.controller?.onTrigger(
            verdict.deviceId,
            { kind: 'object', macroClass: verdict.macroClass },
            verdict.atMs,
          )
        },
      )
    }
```

> `qualifyObjectTrigger` does not have the `deviceId` before having validated the payload,
> so the `malformed` line cannot carry `tags: { deviceId }`. It is the only one, and
> by construction: a payload that has no numeric `deviceId` has no
> device to speak of. Every other line of this track has it.

- [ ] **Step 4 — the DURABLE half (D8/D11).** `PipelineAnalyticsDetectionEvent`
      is telemetry and can drop; a window that the retention gate
      never learned means deleted footage. Mirror exactly
      `reconcileTriggerHistory` (`recording-controller.ts:765-817`), which today
      declares *"Motion only"*:

```ts
      /**
       * DURABLE half of the object source. Same shape as `loadMotionEvents`:
       * SQLite rows instead of broadcast, `classFilter` because the band listens to
       * one class at a time.
       *
       * ⚠ CORRECTION 2026-08-27 (implementation). This block said
       * `projection: 'slim'`, *"because only the timestamp is read"*, TOGETHER with the
       * filter on `source`. The two things do not go together:
       * `SLIM_OBJECT_COLUMNS`
       * (`packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts`)
       * **does not select `source`**, so every slim row arrives without it, the
       * `?? 'pipeline'` reads it as pipeline, and the reconcile folds the
       * ONBOARD rows — reopening from SQL exactly the windows that
       * `qualifyObjectTrigger` rejects on the live path. It compiles, no test
       * on the pure functions sees it, and it is the double truth about the same
       * detection that this track exists to avoid. Shipped with
       * `projection: 'full'` — see
       * `docs/decisions/adr-0254-a-durable-reconcile-reads-the-column-its-live-gate-decides-on.md`.
       */
      loadObjectEvents: async (deviceId, macroClass, sinceMs, untilMs) => {
        const events = await this.ctx.api.pipelineAnalytics.getObjectEvents.query({
          deviceId,
          since: sinceMs,
          until: untilMs,
          classFilter: macroClass,
          limit: TRIGGER_RECONCILE_ROW_LIMIT,
        })
        return events
          .filter((event) => (event.source ?? 'pipeline') === 'pipeline')
          .map((event) => event.timestamp)
      },
```

  and in `reconcileTriggerHistory`, after the motion branch, one branch for each
  `{ kind: 'object' }` in `bandTriggerSources(band)`, with the same
  `foldDurableTriggers` and the same recovery `info` line.

- [ ] **Step 5 — update the docblock of `reconcileTriggerHistory`.** It says
      *"Motion only. Audio triggers have no durable counterpart… a reconcile
      that silently covered one source and not the other would read as covering
      both"*. After this task it covers motion **and** object, and not audio. A
      comment that describes the right design but not the code reads as
      verification: rewrite it, do not leave it.
- [ ] **Step 6 — run `npx tsx scripts/check-recording-trigger-fed.ts`**:
      it must pass with `objectClasses` fed.

---

## Track B — the sensor, on the rising edge

> Do not start B before A1 is merged: B adds the second
> parametric source on the same structure, and doing it first means redoing the
> refactor twice.

### Task B1: the cap→"high" table is MOVED, not copied

`SOURCE_CAP_ACTIVE_FIELD` lives inside a builtin
(`packages/system/src/builtins/doorbell/trigger-engine.ts:22`) and its <!-- drift-ok: deleted in slice 6 (D671), task 17 -->
predicates (`sliceActiveValue`, `sliceChangedAt`) are private to the module. The
recorder needs them. Copying them would create the second table, which is exactly
the shape D62 forbids — and a second one with a different vocabulary already exists
(`DEVICE_STATE_READERS`, `catalogs/device-state-vocabulary.ts:40-49`).

**Files:**
- Create: `packages/types/src/catalogs/sensor-active-state.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/types/src/catalogs/__tests__/sensor-active-state.spec.ts` <!-- drift-ok: this plan creates it -->
- Modify: `packages/system/src/builtins/doorbell/trigger-engine.ts` <!-- drift-ok: deleted in slice 6 (D671), task 17 -->

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import {
  evaluateSensorEdge,
  SOURCE_CAP_ACTIVE_FIELD,
  type SensorEdgeInput,
} from '../sensor-active-state.js'

const base = (over: Partial<SensorEdgeInput>): SensorEdgeInput => ({
  capName: 'contact',
  slice: { entryOpen: true, lastChangedAt: 5_000 },
  prior: undefined,
  startedAtMs: 0,
  nowMs: 5_100,
  firstSightingFreshnessMs: 30_000,
  ...over,
})

describe('evaluateSensorEdge', () => {
  it('the rising edge is false→true', () => {
    expect(evaluateSensorEdge(base({ prior: false }))).toEqual({ edge: 'rising', value: true })
  })

  it('the falling edge opens nothing', () => {
    const r = evaluateSensorEdge(base({ prior: true, slice: { entryOpen: false, lastChangedAt: 5_000 } }))
    expect(r).toEqual({ edge: 'none', value: false, reason: 'falling-edge' })
  })

  it('a re-emission with the same value is not an edge', () => {
    expect(evaluateSensorEdge(base({ prior: true }))).toMatchObject({ reason: 'no-change' })
  })

  it('reads the RIGHT field for the device type — motion uses detected', () => {
    const r = evaluateSensorEdge(
      base({ capName: 'motion', prior: false, slice: { detected: true, lastDetectedAt: 5_000 } }),
    )
    expect(r).toEqual({ edge: 'rising', value: true })
  })

  it('does not coerce truthiness: a non-boolean field is not a value', () => {
    const r = evaluateSensorEdge(base({ prior: false, slice: { entryOpen: 'open' } }))
    expect(r).toEqual({ edge: 'none', value: null, reason: 'non-boolean-value' })
  })

  it('first INACTIVE observation: baseline only, nothing to lose', () => {
    const r = evaluateSensorEdge(base({ slice: { entryOpen: false, lastChangedAt: 5_000 } }))
    expect(r).toMatchObject({ reason: 'baseline-seeded-inactive' })
  })

  it('first observation already ACTIVE and FRESH: it is the press itself', () => {
    expect(evaluateSensorEdge(base({}))).toEqual({ edge: 'rising', value: true })
  })

  it('first observation already active but OLD: silence, and it says so', () => {
    const r = evaluateSensorEdge(base({ slice: { entryOpen: true, lastChangedAt: 1 }, nowMs: 10_000_000 }))
    expect(r).toMatchObject({ reason: 'baseline-seeded-stale-active' })
  })

  it('presence and connectivity are not sources — a string state is not an edge', () => {
    expect(SOURCE_CAP_ACTIVE_FIELD['presence']).toBeUndefined()
    expect(SOURCE_CAP_ACTIVE_FIELD['connectivity']).toBeUndefined()
    expect(evaluateSensorEdge(base({ capName: 'presence', slice: { state: 'home' } }))).toMatchObject({
      reason: 'unknown-cap',
    })
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/types sensor-active-state`

- [ ] **Step 3 — MOVE.** In `packages/types/src/catalogs/sensor-active-state.ts` <!-- drift-ok: this plan creates it -->
      copy VERBATIM from `trigger-engine.ts` lines 15-104
      (`SOURCE_CAP_ACTIVE_FIELD`, `SOURCE_CAP_CHANGED_AT_FIELD`, `SOURCE_CAPS`,
      `SOURCE_DEVICE_TYPES`, `isSourceCap`, `sliceActiveValue`, `sliceChangedAt`,
      with their docblocks) and add the pure evaluator:

```ts
/** Why a slice did not carry a rising edge. Same vocabulary that the
 *  virtual-doorbell has reported since 2026-08-05: ONE enum, so "why did nothing
 *  fire" has a single answer, whoever asks. */
export type SensorEdgeIgnoreReason =
  | 'unknown-cap'
  | 'non-boolean-value'
  | 'baseline-seeded-inactive'
  | 'baseline-seeded-stale-active'
  | 'no-change'
  | 'falling-edge'

export interface SensorEdgeInput {
  readonly capName: string
  readonly slice: Readonly<Record<string, unknown>>
  /** Last boolean observed for this `(device, cap)`; `undefined` = never seen. */
  readonly prior: boolean | undefined
  /** When the OBSERVER started watching — the floor for a first
   *  observation already active. Every observer has its own. */
  readonly startedAtMs: number
  readonly nowMs: number
  readonly firstSightingFreshnessMs: number
}

/**
 * `value` is returned on every path on which the slice CARRIED a boolean,
 * even when there is no edge: the caller updates its memory with that
 * and does not re-read the slice. On `unknown-cap` / `non-boolean-value` it is `null` and the
 * memory must not be touched — it is the behaviour of `onStateSlice` today, which
 * returns BEFORE the `lastValues.set`.
 */
export type SensorEdgeVerdict =
  | { readonly edge: 'rising'; readonly value: true }
  | { readonly edge: 'none'; readonly value: boolean | null; readonly reason: SensorEdgeIgnoreReason }

export const DEFAULT_FIRST_SIGHTING_FRESHNESS_MS = 30_000

export function evaluateSensorEdge(input: SensorEdgeInput): SensorEdgeVerdict {
  const value = sliceActiveValue(input.capName, input.slice)
  if (value === null) {
    return {
      edge: 'none',
      value: null,
      reason: isSourceCap(input.capName) ? 'non-boolean-value' : 'unknown-cap',
    }
  }
  if (input.prior === undefined) {
    if (!value) return { edge: 'none', value, reason: 'baseline-seeded-inactive' }
    const changedAt = sliceChangedAt(input.capName, input.slice)
    const floor = Math.max(input.startedAtMs, input.nowMs - input.firstSightingFreshnessMs)
    if (changedAt === null || changedAt < floor) {
      return { edge: 'none', value, reason: 'baseline-seeded-stale-active' }
    }
    return { edge: 'rising', value: true }
  }
  if (input.prior === value) return { edge: 'none', value, reason: 'no-change' }
  if (!value) return { edge: 'none', value, reason: 'falling-edge' }
  return { edge: 'rising', value: true }
}
```

  Then in `trigger-engine.ts`: delete the two tables and the two predicates,
  re-export the public names from `@camstack/types`, and rewrite `onStateSlice`
  as an adapter over `evaluateSensorEdge` that maps the verdict onto its
  `DoorbellIgnoreReason`s and keeps `lastValues` / `matchAndDebounce`.

- [ ] **Step 4 — THE PROOF: the doorbell tests must pass UNCHANGED.**
      `npx vitest run --root packages/system trigger-engine`. If an assertion
      has to be touched, the move changed behaviour and must be redone.
- [ ] **Step 5 — disarm:** in `evaluateSensorEdge` remove the
      `baseline-seeded-stale-active` branch (make the first active observation always
      fire) and confirm that a doorbell test turns red.

### Task B2: the sensor trigger schema

**Files:**
- Modify: `packages/types/src/interfaces/recording-config.ts`
- Modify: `packages/types/src/interfaces/__tests__/recording-config.spec.ts`

- [ ] **Step 1 — write the failing test.**

```ts
describe('RecordingTriggersSchema.sensorDeviceIds', () => {
  it('accepts a selection of source devices', () => {
    expect(RecordingTriggersSchema.parse({ sensorDeviceIds: [42, 43] }).sensorDeviceIds)
      .toEqual([42, 43])
  })

  it('rejects an empty array', () => {
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: [] })).toThrow()
  })

  it('rejects a repeated id — it would be the same key counted twice', () => {
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: [42, 42] })).toThrow()
  })

  it('rejects beyond MAX_SENSOR_TRIGGER_DEVICES — the keys of TriggerState are bounded', () => {
    const tooMany = Array.from({ length: MAX_SENSOR_TRIGGER_DEVICES + 1 }, (_, i) => i + 1)
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: tooMany })).toThrow()
  })

  it('rejects a non-integer or non-positive id', () => {
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: [0] })).toThrow()
    expect(() => RecordingTriggersSchema.parse({ sensorDeviceIds: [1.5] })).toThrow()
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
- [ ] **Step 3 — implement**, in `RecordingTriggersSchema`:

```ts
  /**
   * The LINKED devices whose RISING EDGE opens a window. Absent = the source
   * is not listened to.
   *
   * They are ids of SOURCE devices, not cameras: the band names them, so the hot
   * path makes no RPC. The OFFER from which the operator chooses them is
   * another question, and is resolved with `deviceManager.getLinkedDevices` +
   * `getBindings` per device (D12) — never a global list of caps.
   *
   * What "high" means depends on the device type and is not decided here:
   * `SOURCE_CAP_ACTIVE_FIELD` (`catalogs/sensor-active-state.ts`) is THE table,
   * the same one the virtual-doorbell has used since 2026-08-05.
   */
  sensorDeviceIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_SENSOR_TRIGGER_DEVICES)
    .refine(noDuplicates, { message: 'sensorDeviceIds must not repeat a device' })
    .optional(),
```

- [ ] **Step 4 — `npm run codegen`** and check the diff.

### Task B3: edge memory and reverse index

The recorder must answer two questions on every `DeviceStateChanged`:
*is it a rising edge?* (memory per `(device, cap)`) and *which cameras listen to it?*
(reverse index source→cameras).

**The reverse index is D49.** The gate is in-RAM state updated OFF the
event path: it is rebuilt from `readDeviceConfigs` at boot and from
`onConfigChanged` (which is an RPC, `recording-controller.ts:825-828`), never from
a fallible read on the trigger path.

**The order of the checks is a cost choice.** `DeviceStateChanged` travels at
bus rate for EVERY slice of EVERY device: battery, the native `motion` of every
camera (104 flickers at ~2 Hz), connectivity. First the `Map.get` of the reverse
index (no allocation, no I/O), then `isSourceCap`, then the edge.
Post-analysis makes the same choice and writes it down
(`wire-subscriptions.ts:231-233`: *"The EVENT_KIND_BY_CAP gate runs FIRST so
non-sensor cap churn exits before any async work"*).

**Files:**
- Create: `packages/addon-pipeline/src/recorder/sensor-trigger.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-pipeline/src/recorder/__tests__/sensor-trigger.spec.ts` <!-- drift-ok: this plan creates it -->

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { SensorTriggerRouter } from '../sensor-trigger.js'

const router = (nowMs = 100_000): SensorTriggerRouter =>
  new SensorTriggerRouter({ now: () => nowMs, startedAtMs: 0 })

const openSlice = { entryOpen: true, lastChangedAt: 99_000 }
const closedSlice = { entryOpen: false, lastChangedAt: 99_500 }

describe('SensorTriggerRouter', () => {
  it('routes the rising edge to EVERY camera listening to that sensor', () => {
    const r = router()
    r.setBindings(new Map([[42, new Set([101, 102])]]))
    r.onStateSlice(42, 'contact', closedSlice)
    expect(r.onStateSlice(42, 'contact', openSlice)).toEqual({
      fired: [101, 102],
      skipped: null,
    })
  })

  it('a sensor that no band names exits without touching the edge memory', () => {
    const r = router()
    r.setBindings(new Map())
    expect(r.onStateSlice(42, 'contact', openSlice)).toEqual({
      fired: [],
      skipped: 'not-listened',
    })
    // Not observed: the next time a band names it, the first slice
    // is still a FIRST observation and goes through the freshness rule.
    r.setBindings(new Map([[42, new Set([101])]]))
    expect(r.onStateSlice(42, 'contact', { entryOpen: true, lastChangedAt: 1 }).skipped)
      .toBe('baseline-seeded-stale-active')
  })

  it('the falling edge turns nothing on and says so', () => {
    const r = router()
    r.setBindings(new Map([[42, new Set([101])]]))
    r.onStateSlice(42, 'contact', openSlice)
    expect(r.onStateSlice(42, 'contact', closedSlice)).toEqual({
      fired: [],
      skipped: 'falling-edge',
    })
  })

  it('the memory is per (device, cap): two caps of the same device do not get confused', () => {
    const r = router()
    r.setBindings(new Map([[42, new Set([101])]]))
    r.onStateSlice(42, 'contact', openSlice)
    expect(r.onStateSlice(42, 'tamper', { tampered: true, lastChangedAt: 99_000 }).fired)
      .toEqual([101])
  })

  it('removing the sensor from the band stops routing without clearing the memory', () => {
    const r = router()
    r.setBindings(new Map([[42, new Set([101])]]))
    r.onStateSlice(42, 'contact', openSlice)
    r.setBindings(new Map())
    expect(r.onStateSlice(42, 'contact', closedSlice).skipped).toBe('not-listened')
    r.setBindings(new Map([[42, new Set([101])]]))
    // `prior` is still `true`: the lost closing does NOT become a rising edge.
    expect(r.onStateSlice(42, 'contact', openSlice).skipped).toBe('no-change')
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/addon-pipeline sensor-trigger`

- [ ] **Step 3 — implement.**

```ts
/**
 * From `DeviceStateChanged` to "which cameras must record".
 *
 * Two responsibilities, both in RAM and none durable:
 *  - the edge MEMORY, per `(deviceId, capName)`, which makes `false→true`
 *    distinguishable from a re-emission. The predicate is
 *    `evaluateSensorEdge` (`@camstack/types`) — the same
 *    `SOURCE_CAP_ACTIVE_FIELD` table as the virtual-doorbell, not a copy;
 *  - the source→cameras REVERSE INDEX, a mirrored state updated OFF the
 *    event path (D49): `setBindings` is called at boot by
 *    `readDeviceConfigs` and at every `onConfigChanged`, which is an RPC. A
 *    fallible read on the trigger path could read "nobody listens" and
 *    lose the episode, which is the failure D49 is written against.
 *
 * The order of the checks is deliberate: `DeviceStateChanged` travels at
 * bus rate across the whole fleet (battery, every camera's native `motion`,
 * connectivity). The reverse index is a `Map.get` without allocations and goes
 * first; `isSourceCap` is a second lookup; the edge comes after.
 */
import { evaluateSensorEdge, DEFAULT_FIRST_SIGHTING_FRESHNESS_MS } from '@camstack/types'
import type { SensorEdgeIgnoreReason } from '@camstack/types'

/** Why a slice turned no camera on. */
export type SensorRouteSkipReason = SensorEdgeIgnoreReason | 'not-listened'

export interface SensorRouteResult {
  /** The cameras to wake now. */
  readonly fired: readonly number[]
  /** Set when `fired` is empty; null when an edge was routed. */
  readonly skipped: SensorRouteSkipReason | null
}

export interface SensorTriggerRouterOptions {
  readonly now: () => number
  /** When this router started watching. On a freshly respawned runner it is
   *  "now", and it is the floor of the freshness rule. */
  readonly startedAtMs: number
  readonly firstSightingFreshnessMs?: number
}

export class SensorTriggerRouter {
  /** sourceDeviceId → cameras whose active band names it. */
  private bindings: ReadonlyMap<number, ReadonlySet<number>> = new Map()
  /** Last boolean observed, per `${deviceId}:${capName}`. */
  private readonly lastValues = new Map<string, boolean>()
  private readonly now: () => number
  private readonly startedAtMs: number
  private readonly freshnessMs: number

  constructor(options: SensorTriggerRouterOptions) {
    this.now = options.now
    this.startedAtMs = options.startedAtMs
    this.freshnessMs = options.firstSightingFreshnessMs ?? DEFAULT_FIRST_SIGHTING_FRESHNESS_MS
  }

  /**
   * Replaces the reverse index. Does NOT touch `lastValues`: a sensor removed and
   * put back into a band must find its previous level again, otherwise
   * the first slice after the return would be a "first observation" and a
   * contact that stayed open the whole time would become a rising edge.
   */
  setBindings(bindings: ReadonlyMap<number, ReadonlySet<number>>): void {
    this.bindings = bindings
  }

  /** Which sources the index contains now — for the boot log line. */
  listenedSourceIds(): readonly number[] {
    return [...this.bindings.keys()]
  }

  onStateSlice(
    deviceId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
  ): SensorRouteResult {
    const cameras = this.bindings.get(deviceId)
    if (cameras === undefined || cameras.size === 0) {
      return { fired: [], skipped: 'not-listened' }
    }
    const key = `${deviceId}:${capName}`
    const verdict = evaluateSensorEdge({
      capName,
      slice,
      prior: this.lastValues.get(key),
      startedAtMs: this.startedAtMs,
      nowMs: this.now(),
      firstSightingFreshnessMs: this.freshnessMs,
    })
    if (verdict.edge === 'none') {
      if (verdict.value !== null) this.lastValues.set(key, verdict.value)
      return { fired: [], skipped: verdict.reason }
    }
    this.lastValues.set(key, true)
    return { fired: [...cameras], skipped: null }
  }
}
```

- [ ] **Step 4 — disarm:** make `setBindings` also clear `lastValues` and
      confirm the last test turns red.

### Task B4: wire the sensor source

**Files:**
- Modify: `packages/addon-pipeline/src/recorder/addon/index.ts`
- Modify: `packages/addon-pipeline/src/recorder/addon/band-decision.ts`
- Modify: `packages/addon-pipeline/src/recorder/addon/recording-controller.ts`

- [ ] **Step 1 — test on the controller harness:**

```ts
it('the rising edge of a sensor named by the band attaches the camera', async () => {
  const h = harness({ bands: [eventsBand({ sensorDeviceIds: [42] })] })
  await h.controller.onTrigger(DEVICE_ID, { kind: 'sensor', sourceDeviceId: 42 }, h.now())
  expect(h.attached()).toBe(true)
})

it('a sensor NOT named by the band attaches nothing', async () => {
  const h = harness({ bands: [eventsBand({ sensorDeviceIds: [42] })] })
  await h.controller.onTrigger(DEVICE_ID, { kind: 'sensor', sourceDeviceId: 43 }, h.now())
  expect(h.attached()).toBe(false)
})
```

- [ ] **Step 2 — verify that it FAILS.**
- [ ] **Step 3 — implement.** In `bandTriggerSources`:

```ts
  for (const sourceDeviceId of t.sensorDeviceIds ?? []) {
    sources.push({ kind: 'sensor', sourceDeviceId })
  }
```

  in `TRIGGER_KEY_TO_SOURCE_KIND`: `sensorDeviceIds: 'sensor'`.

  The reverse index, built from the configs the recorder already reads:

```ts
  /**
   * sourceDeviceId → cameras whose bands name it. From ALL the bands, not
   * only from the one active now: the index changes only on a config write,
   * while the active band changes with the clock, and an index that followed
   * the clock would lose the first trigger after every band edge. Whoever filters
   * by band is already the gate — `bandTriggerSources` reads the band active
   * at the instant of evaluation.
   */
  private buildSensorBindings(configs: ReadonlyMap<number, RecordingConfig>): Map<number, Set<number>> {
    const index = new Map<number, Set<number>>()
    for (const [cameraId, config] of configs) {
      if (config.enabled !== true) continue
      for (const band of config.bands ?? []) {
        for (const sourceDeviceId of band.triggers?.sensorDeviceIds ?? []) {
          const cameras = index.get(sourceDeviceId) ?? new Set<number>()
          cameras.add(cameraId)
          index.set(sourceDeviceId, cameras)
        }
      }
    }
    return index
  }
```

  called at boot (after `readDeviceConfigs`, `recorder/addon/index.ts:1262`) and
  in `onConfigChanged`. And the subscription:

```ts
    if (this.sensorUnsub === null) {
      this.sensorUnsub = this.ctx.eventBus.subscribe(
        { category: EventCategory.DeviceStateChanged },
        (event) => {
          const parsed = parseSensorStateChanged(event.data)
          if (parsed === null) return
          const result = this.sensorRouter.onStateSlice(
            parsed.deviceId,
            parsed.capName,
            parsed.slice,
          )
          for (const cameraId of result.fired) {
            this.ctx.logger.info('recorder: sensor rising edge opened a recording window', {
              tags: { deviceId: cameraId },
              meta: { sourceDeviceId: parsed.deviceId, capName: parsed.capName },
            })
            void this.controller?.onTrigger(
              cameraId,
              { kind: 'sensor', sourceDeviceId: parsed.deviceId },
              parsed.atMs,
            )
          }
          if (result.skipped === null || result.skipped === 'not-listened') return
          // `not-listened` is the overwhelming majority of the bus traffic and
          // is not a loss: no band asked for that sensor. Everything else
          // IS an edge that did not become a recording, and
          // `baseline-seeded-stale-active` in particular is the case in which a
          // true edge MAY have been eaten by a runner respawn.
          const level = result.skipped === 'baseline-seeded-stale-active' ? 'warn' : 'debug'
          this.ctx.logger[level]('recorder: sensor state change opened no window', {
            tags: { deviceId: parsed.deviceId },
            meta: { capName: parsed.capName, reason: result.skipped },
          })
        },
      )
    }
```

  with a `parseSensorStateChanged` type guard (same shape as
  `isDetectionEventData`: `deviceId: number`, `capName: string`, `slice` object;
  `atMs` from `event.timestamp`).

- [ ] **Step 4 — the DURABLE half.** `getSensorEvents`
      (`pipeline-analytics.cap.ts:1492-1506`) already exists and accepts
      `{ deviceId, since, until, kinds, limit }`, with `deviceId` = the CAMERA and
      `sourceDeviceId` on every row. In `reconcileTriggerHistory`, for each
      `{ kind: 'sensor', sourceDeviceId }` of `bandTriggerSources(band)`:

```ts
      loadSensorEvents: async (cameraId, sinceMs, untilMs) => {
        const rows = await this.ctx.api.pipelineAnalytics.getSensorEvents.query({
          deviceId: cameraId,
          since: sinceMs,
          until: untilMs,
          limit: TRIGGER_RECONCILE_ROW_LIMIT,
        })
        return rows
      },
```

      **Beware, and it must be measured before writing it:** `SensorEvent` is
      LEVEL, not edge (`event-kinds.ts:475-514` inserts a row on every mapped
      `DeviceStateChanged`, opening AND closing), and its `value` is the raw
      slice. Reconstructing the edge from the rows requires applying
      `sliceActiveValue` to `row.value` and keeping only the `false→true`
      transitions in order. It is feasible with the pieces of Task B1 — but
      `SensorEvent` does not carry the `capName`, only the taxonomy's `kind`, and
      `SOURCE_CAP_ACTIVE_FIELD` is indexed by CAP. **This is a measurable
      unknown, not a detail: see §6.** Until it is resolved, do not
      write this reconcile: write instead the comment that says the
      sensor source is covered by the event path alone, as
      `reconcileTriggerHistory` does today for audio.

      > **MEASURED 2026-08-27 (implementation), outcome: NOT written.** (a) of
      > §6 is resolved and the answer is not enough. `CAP_TO_KIND`
      > (`packages/types/src/capabilities/sensor-event-kinds.ts`) has no two caps
      > sharing a kind — so `kind → capName` IS invertible — but
      > **`binary`, which is a `SOURCE_CAP`, does not appear at all in
      > `CAP_TO_KIND`**: the edges of a `binary` sensor never reach the
      > `SensorEvent` table and would not be recoverable in any case. A
      > reconcile that covers nine sources out of ten reads as if it
      > covered them all. (b) remains unmeasured. The sensor source travels
      > on the event path alone and the docblock of `reconcileTriggerHistory`
      > declares it with this number inside.

- [ ] **Step 5 — declare the OFFLINE behaviour.** In `recorder/addon/index.ts`,
      next to the subscription:

```ts
/**
 * An OFFLINE sensor produces no trigger, and it is not an implicit case.
 *
 * 1. A provider that loses the device does not write the slice: Home Assistant exits
 *    earlier on `unavailable`/`unknown` (`ha-binary-sensor-device.ts:65`), so
 *    there is no `DeviceStateChanged` from which to invent an edge. The
 *    recorder synthesises NOTHING and does NOT keep the window open: a band
 *    that listens only to that sensor simply does not ask.
 * 2. A sensor that goes offline while HIGH and comes back still high reads
 *    `no-change` — no double recording. If it comes back low and then high, it is
 *    a true edge.
 * 3. A runner RESPAWN clears `lastValues` and moves `startedAtMs`. The first
 *    slice already active counts as an edge only if its UPSTREAM transition is
 *    later than `startedAtMs` and within 30 s; otherwise it stays silent and says so
 *    (`baseline-seeded-stale-active`, logged at `warn`).
 *
 * Point (3) is an INHERITED choice, not one decided here, and it is the opposite of
 * the recorder's preference elsewhere ("a failed read serves the last good
 * config, because keeping footage is the conservative choice",
 * `recording-controller.ts:1055-1069`). It is kept identical to the virtual-doorbell
 * because an edge with a timestamp of hours ago is a hydration, and 30 s of
 * useless recording per camera at every respawn across the whole fleet is a
 * measurable cost. If the operator prefers the other polarity, it is changed HERE and in one
 * place only — see §6.
 */
```

- [ ] **Step 6 — `npx tsx scripts/check-recording-trigger-fed.ts`**: it passes with
      `sensorDeviceIds` fed.

---

## Track C — the UI

> After A and B. A control for a trigger that nobody feeds is the defect that
> Track 0 exists to not repeat.

### Task C1: the two macro selections in the form

**Files:**
- Modify: `packages/ui-library/src/composites/cap-settings/recording-config-form.ts`
- Modify: `packages/ui-library/src/composites/cap-settings/__tests__/recording-config-form.spec.ts`

- [ ] **Step 1 — test:**

```ts
it('carries objectClasses and sensorDeviceIds from the events band to the form and back', () => {
  const cfg: RecordingConfig = {
    enabled: true,
    bands: [alwaysBand('events', { triggers: { objectClasses: ['person'], sensorDeviceIds: [42] } })],
  }
  const state = formStateFromConfig(cfg)
  expect(state.triggers.objectClasses).toEqual(['person'])
  expect(state.triggers.sensorDeviceIds).toEqual([42])
  expect(configFromFormState(state).bands[0]?.triggers).toEqual(state.triggers)
})
```

- [ ] **Step 2 — verify that it FAILS** (today `RecordingTriggers` does not have
      those keys, so the test does not compile — it is the right red).
- [ ] **Step 3 — no new code**: `formStateFromConfig:96` already copies
      `eventsBand?.triggers ?? {}` whole and `bandsFromFormState:124` sends it
      back whole. The test LOCKS IT IN. If it fails, someone
      introduced a field-by-field copy and it must be removed.

### Task C2: the controls in `RecordingBandsEditor`

- [ ] **Step 1** — next to the motion/audio ticks (`:146-201`), three chips
      derived from `FIRST_LEVEL_MACRO_CLASSES` (never hand-written), which
      write `objectClasses` — and `undefined` when the selection empties,
      because the schema rejects the empty array.
- [ ] **Step 2** — a `device-multiselect` for `sensorDeviceIds`, fed
      by:
      1. `deviceManager.getLinkedDevices({ deviceId: cameraId })`
         (`device-manager.cap.ts:648`);
      2. `deviceManager.getBindingsBatch({ deviceIds: linkedIds })`
         (`device-manager.cap.ts:~770`, the docblock measures why batch and not
         N calls);
      3. keep the devices whose `entries[].capName` intersect `SOURCE_CAPS`
         (`@camstack/types`). **Never `getAllBindings`, never a global list of
         caps — D12.**
- [ ] **Step 3 — test:** a linked device WITHOUT a cap in `SOURCE_CAPS` does not
      appear in the offer; a device with `presence` does not appear (it has no
      boolean edge); the offer is empty when the camera has no linked devices,
      and the control SAYS so instead of showing an empty list.
- [ ] **Step 4** — the label of the object source says which signal it reads:
      *"Registra quando la pipeline conferma una di queste classi. Le detection
      dell'AI a bordo camera non contano."* [Records when the pipeline confirms one
      of these classes. Detections by the camera's onboard AI do not count.] Without that sentence the operator's first
      question is why the camera with native AI does not record.

---

## What NOT to do, and why

- **Do not add a second place that decides whether to record.**
  `band-decision.shouldRecordAt` (`band-decision.ts:254`) is the authority, and
  `RecordingConfig.bands` the only authorised intent. No new trigger may
  attach a writer on its own, and none of these tasks writes a new store.
  D62.
- **Do not read a RAW detection signal.** Not
  `EventCategory.DetectionResult`, not `DetectionRaw`, not
  `DetectionCameraNative`, not `PipelineAnalyticsFrameTracked`. The only entry
  is `PipelineAnalyticsDetectionEvent` with `source: 'pipeline'`, which is by
  construction downstream of steps 1-4 of the chain in
  `docs/architecture/object-detection.md`. A trigger that read the raw would
  produce two truths about the same detection: the operator's sliders would
  describe one and the recording would follow the other.
- **Do not introduce a fourth list of macro classes.** At least four already exist
  with different contents (`MACRO_LABELS` 4 elements, the step's offer
  3, `FALLBACK_MACRO` in the viewer 3 with `face→person`,
  `RetrainMacroClassSchema` 6). Task A0 merges two of them; the others stay where
  they are and this plan does not touch them.
- **Do not copy `SOURCE_CAP_ACTIVE_FIELD`.** It is moved (Task B1) and the doorbell
  re-exports it. A second table diverges at the first cap added, and the
  symptom — "the sensor rings the doorbell but does not record" — is
  exactly D62.
- **Do not unify `SOURCE_CAP_ACTIVE_FIELD` with `DEVICE_STATE_READERS`**
  (`catalogs/device-state-vocabulary.ts:40`). They answer two different questions
  ("which boolean's edge counts" vs "which is the state WORD for
  a rule"), have deliberately different vocabularies and are both
  documented. That they resemble each other is a job of its own, not of this one.
- **Do not touch the semantics of `preBufferSec` / `postBufferSec`.** The new
  sources reuse `resolveBandBufferMs` unchanged. `preBufferSec` is anchored to
  `RECORDING_PRE_ROLL_MAX_MS` (`recording-config.ts:107-118`) and changing it
  would make two authorities fight over the same footage (D191).
- **Do not make the synthetic track the trigger.** The design is "the same
  triggering MECHANISM", not "the same event". The synthetic track is born
  in `addon-post-analysis`, is LEVEL and not edge (§1.6a), is debounced at 10 s
  per `(camera, kind)` and — above all — is filtered by an opt-in that has nothing to do
  with recording (`_linkedDeviceTrackedIds`, absent ⇒ NONE,
  `device-linked-devices.ts:36-40`). Recording on it would mean that
  turning off the markers on the timeline turns off the recordings.
- **Do not make the sensor hot path do RPC.** `DeviceStateChanged` is at
  bus rate across the whole fleet. The band names the ids; `getLinkedDevices` and
  `getBindings` serve the UI to build the OFFER, not the trigger.

---

## What remains unknown and must be measured or asked, not assumed

1. **The polarity of the error on an ambiguous edge after a respawn.** The
   virtual-doorbell errs towards SILENCE
   (`baseline-seeded-stale-active`); the recorder elsewhere errs towards KEEPING
   footage (`postBufferMsFor`, `recording-controller.ts:1055-1069`). Task B4
   chooses the first for identity with the mechanism the operator cited.
   **Question for the operator:** on a recorder runner respawn, must a contact
   found already open make it record for 30 s or not? It is the only choice of this
   plan that changes observable behaviour and has no answer derivable
   from the code.

2. **The durable reconcile of the sensor source.** `getSensorEvents`
   exists, but the rows are LEVEL and do not carry `capName` — only the taxonomy's
   `kind` (`SensorEventSchema`, `pipeline-analytics.cap.ts`), while
   `SOURCE_CAP_ACTIVE_FIELD` is indexed by cap. **To be measured before
   writing Task B4 Step 4:** (a) is `kind → capName` injective on
   `CAP_TO_KIND` (`sensor-event-kinds.ts:62-80`)? By eye yes except
   `motion → motion-sensor`, but it must be verified by running the inversion, not
   by looking at it. (b) Does `SensorEvent.value` really contain the whole slice on
   live data, or do certain providers leave it `null`? Until (a) and (b) are
   measured, the sensor source travels on the event path alone and the code
   must SAY SO, as it does today for audio.

3. **The volume of `DeviceStateChanged` reaching the recorder process.** Cross-node
   delivery is filtered by interest (`event-bus-core.ts:292-356`),
   so subscribing has a cost. **To be measured, not estimated:** events/second of
   that category on the hub in a typical hour, before shipping the subscription. If
   it were high, the remedy is upstream (a narrower per-category filter), not
   a debounce in the recorder.

4. **`audioThresholdDbfs`: wire it or retire it?** Track 0 makes it
   noisy and nothing else. Wiring it requires knowing what the threshold means
   with respect to the level that `PipelineAudioInferenceResult` carries
   (`event-category.ts:535`) — a unit, not an opinion. Retiring it means
   removing it from the schema and the UI, and then a saved band that contains it
   is REJECTED by the `.strict()` schema on write (reads are
   `.strip()`, so rows already on disk keep loading).
   **Question for the operator:** does anyone have a band with the audio trigger? If so,
   retiring it makes it fail at the first save from the form.

5. **Whether a band should be able to combine object and sensor in OR with motion.**
   The schema as designed allows it (they are independent keys and
   `eventsBandDemanded` is an OR), and it is the natural generalisation of the
   current motion∨audio behaviour. But it was not asked.
   **Question for the operator:** are "object detection" and "sensor" two
   ALTERNATIVE modes to the current ones, or four sources that add up? If they are
   alternatives, the UI must be an exclusive choice and the schema must
   reject the combination — and it is a constraint to be put in the schema, not
   only in the UI.

6. **The debounce.** The virtual-doorbell has one of 2 s per camera
   (`trigger-engine.ts:163`), the synthetic track one of 10 s per
   `(camera, kind)`. The recorder has none: the merge of the windows
   (`recordTrigger`, gap = `postBufferSec`) already makes close triggers
   extend ONE episode instead of opening many, and `evaluateDevice` short-
   circuits on "already recording". This plan does **not** add a
   debounce, and the reason is that it would be a third value disagreeing with the
   other two. **To be confirmed by measuring** the number of windows per camera per
   hour after the first day of operation: if a noisy class produced more
   than `MAX_TRIGGER_WINDOWS` windows in a `TRIGGER_HISTORY_MARGIN_MS`, the
   eviction `warn` line (`recording-controller.ts:1087`) would say so — and it is already
   there.

---

## Operator decisions (2026-08-26) — binding, do not reopen them

The three open questions at the bottom of the plan have an answer. **They change three tasks**,
so they must be read before starting anything.

### 1. The audio trigger is WIRED, not removed

Verified before asking: **none of the thirteen cameras has a band that uses
`audioThresholdDbfs`** (scan via `recording.getDeviceConfig`, 2026-08-26).
The defect is therefore latent and is not losing recordings — but it is still the
D62 shape, and Track 0 remains mandatory BEFORE adding other triggers.

Track 0 changes goal: from *"make it noisy and then remove it"* to **"make it
noisy and then wire it"**. The guard `check-recording-trigger-fed.ts` stays and
becomes more important, not less: with four triggers declared, the way in which
this one broke is exactly the way in which the others will break.

**The unknown to resolve first, and it cannot be bypassed:** with which unit
`audioThresholdDbfs` is compared to the level produced by
`PipelineAudioInferenceResult`. The plan cannot write the comparison until
that is read from the code — dBFS against a normalised value is a comparison
that compiles and is always wrong. **Measure it, do not assume it.**

### 2. All triggers add up in OR

Motion, audio, object-detection and sensor are **additive**. No exclusivity
constraint, neither in the schema nor in the UI. The schema as already designed is
correct; do not add a `.refine()` that makes them mutually exclusive.

Consequence to write in the consumer: `shouldRecordAt` evaluates the four and
the first that says yes is enough. **But the log line must say WHICH one** opened
the window — four sources that open the same window without saying who did it
make it impossible to answer "why does this camera record so much".

### 3. The EDGE gives the input, not the level

The operator's words: *"è l'edge che deve dare l'input: lock che si apre,
sensore che si attiva"* [it is the edge that must give the input: lock that opens,
sensor that activates].

So: **only the `false → true` transition**. A contact found **already open**
at the runner's restart does **NOT** make it record. We err towards silence.

This resolves the polarity that the plan flagged as undecided, and aligns the
sensor trigger with `DoorbellTriggerEngine` — which already does exactly this
(`onStateSlice` at `trigger-engine.ts:234`, `false→true` on an in-RAM Map, with the
first observation after startup counting as an edge only if the UPSTREAM timestamp
is later than `startedAt` and within 30 s, otherwise it stays silent and says so).

**Reuse that engine, do not rewrite it.** It brings with it `SOURCE_CAP_ACTIVE_FIELD`
(cap → boolean field) and `SOURCE_CAP_CHANGED_AT_FIELD` (cap → transition
timestamp), which is precisely the *"depending on the device type"* of the
request. `presence` and `connectivity` stay excluded, for the reason already
written there.

**Not to be used:** the projection of the synthetic tracks
(`projectSensorMarkers` / `ingestSensorStateChange`). It is LEVEL, not edge —
a contact that closes produces a track like one that opens — and it is
debounced at 10 s per `(camera, kind)`. It looks like the right thing and is not.
