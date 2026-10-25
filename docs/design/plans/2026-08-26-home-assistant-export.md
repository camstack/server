# Plan — update the Home Assistant export

> **For the implementer:** REQUIRED SKILL — use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans`. The steps use checkboxes
> (`- [ ]`) for tracking.

**Goal:** bring into Home Assistant the three things the system knows and the
export does not say — *a switched-off switch is off, not broken*; *this camera is
recording*; *the cluster has a problem or the disk is filling up* — and free the
export from the last deprecated pair that holds it hostage
([D113](../../decisions/adr-0113.md) phase 4).

**Architecture:** four tracks. **A** retires `getCameraSwitches` /
`setCameraSwitch`: every HA switch moves to writing the authority that already
owns the function ([D62](../../decisions/adr-0062.md)), **without changing a
single `unique_id`**. **B** closes the holes where an entity exists and cannot
receive a value — the founding sin of this export — and puts a guard on it. **C**
adds two entities per camera, both with a question the operator really asks. **D**
fills the two synthetic devices, which have no fan-out. **A must precede C** (they
share the same read); B and D are independent of everything.

**Stack:** TypeScript 5.7+, Zod 4, vitest, npm workspaces + nx.

## Global constraints

The rules of `CLAUDE.md` apply. In addition, verbatim:

- **No casts.** No `as any`, `as unknown as X`, `as never`. Exceptions: `as
  const` and a documented type boundary. Discriminated unions and type guards.
- **`z.infer<>` for Zod schemas** — never duplicate a shape by hand.
- **Named types**: no inline types on signatures or return values.
- **Every log line about a device carries `tags: { deviceId }`** with the numeric
  id.
- **A branch that silently throws work away logs it.**
- **Addons do not import each other.** `ctx.api` is the only layer. The reference
  that used to be here — the admin UI's local derivation, indicated as a model NOT
  to import — is gone with
  [D544](../../decisions/adr-0544-the-switch-group-is-the-one-surface-on-both-clients.md):
  that derivation was the second catalogue, and the admin UI now renders the group
  composed by the hub as the viewer does. The model to look at is
  `packages/addon-pipeline-orchestrator/src/camera-switch-service.ts`, which
  writes the authority of each function.
- **`unique_id` and entity id are WIRE FORMAT.** Renaming one orphans the entity
  in the operator's installation, taking away the recorder history and the
  dashboard position. See `ha-export/types.ts:1-12`.
- **No task touches `@camstack/types`.** Framework packages travel in the
  `@camstack/server` train; everything here is addon-local and goes live with
  `camstack deploy packages/addon-provider-homeassistant`.
- **No task touches the HA component** (`camstack/homeassistant-component`,
  another repo). All the new entities of this plan use only `sensor`,
  `binary_sensor` and `select`, which are in `LEGACY_PLATFORMS`
  (`ha-export/component-support.ts:47-56`): they also work on a 0.3.x component.
  No new platform, no new field on the wire.
- **A green test is not proof.** After every fix, DISARM the fix and confirm the
  test turns red. Report that you did.
- **Never `git --no-verify`, never `git add -A`, never `git stash`.** Explicit
  pathspecs.
- **No task touches the production hub nor the operator's Home Assistant.** Only
  code and tests.
- **Outside the physical perimeter**: `packages/addon-benchmark/**`,
  `packages/addon-post-analysis/**`, `packages/addon-pipeline/src/recorder/**`,
  `packages/addon-admin-ui/**`, the `camstack/` submodule. They are read, not
  touched.

---

## 1. What is exported today

Measured on 2026-08-26 by reading the live tables
(`npx tsx scripts/check-export-coverage.ts` is **green**: *"export coverage:
every device capability is decided"*).

### 1.1 The capabilities

| | n. | where |
| --- | --- | --- |
| total capabilities (every scope) | 149 | `packages/types/src/capabilities/index.ts` |
| device-scoped that declare `deviceTypes` | 77 | same |
| in `CAP_ENTITY_MAP` (exported) | 48 | `ha-export/entity-catalog.ts:916` |
| in `CAPS_NOT_EXPORTED` (excluded with a written reason) | 32 | `ha-export/entity-catalog.ts:1997` |
| undecided | **0** | — |

The 32 excluded include 3 device-scope caps without `deviceTypes`
(`device-status`, `device-ops`, `feature-probe`), which the guard does not look at
but the catalogue classified all the same.

### 1.2 The entities, by family

| Family | Entities | Source of the value |
| --- | --- | --- |
| Camera, base | `triggered`, `online`, `last_image`, `objects`, `last_detection`, `audio_last_sound`, `audio_volume`, `audio_level_rms` (8) | track lifecycle, `device-status`, zone occupancy, audio window |
| Camera, macro | 6 macros × (`_detected`, `_last_image`, `_last_detection`, `_objects`) + `_last_label` on person/vehicle/animal = **27** | `pipeline-analytics.track-lifecycle` |
| Camera, zones | per zone: `<z>_objects` + 3 macros × 4 = **13/zone** | `zoneAnalytics.getCurrentSnapshot` + track |
| Camera, switches | up to **8**, one per available `CameraSwitch` | `pipelineOrchestrator.getCameraSwitches` ⚠️ deprecated |
| Camera, controls | `snooze` (select), `reboot` (button, if `rebootable`), PTZ 6 buttons + `ptz_preset` (select) | commands |
| Camera, battery | `battery`, `charger`, `sleeping` (3, only if the slice exists) | `battery` slice |
| Camera, doorbell | `doorbell_pressed`, `doorbell_last_pressed`, `doorbell_press_count` (3, if cap bound) | `doorbell` slice |
| Camera, stream | one `camera` entity per stream of `webrtcSession.listStreams` (3–7) | the component denies by itself ([D152](../../decisions/adr-0152.md)) |
| Camera, derived caps | `intercom` (2), `day-night` (3), `ptz-autotrack` (1) | slice, via `CAP_ENTITY_MAP` |
| Non-camera | derived from `CAP_ENTITY_MAP`, ~2 on average and 3 at most per device | slice |
| Synthetic *Notification Center* | `snoozed`, `rules_enabled`, one `switch` per rule | poll on `notificationRules` |
| Synthetic *CamStack Server* | `cluster_healthy`, `nodes_online/total`, `addons_healthy/running/failed`, `server_version`, `update_available`, + per node `online/cpu/memory/uptime` | poll on `nodes.topology`, `addons.list`, `serverManagement` |

Last measurement on the wire: `devices=4 entities=175` (2026-08-14, two cameras
plus the two synthetics — (planning repo: sessions/2026-10.md:2496)). <!-- drift-ok: moved to the private planning repo -->

---

## 2. What is missing, in order of value

Each line says **why it is worth it** and **what feeds it**. Lines without a source
are in §5, not here.

1. **An entity that says OFF instead of BROKEN.** The system composes
   `CameraStatus.switchedOff` from the authorities
   (`pipeline-orchestrator.cap.ts:495`), and its comment says in so many words that
   it is *"the difference between a switched-off camera and a dead camera"*. None
   of this reaches HA: there is `online` (reachability) and there are the 8
   switches. A camera with detection switched off by a person and a camera with
   detection stopped because the node went down produce in HA **the very same
   picture**. It is rule D62 repeated outside the repo. → **Track C.**
2. **`recording_active`.** «Is it recording now?» is the second question one asks
   of a camera. `CameraStatus.recording.active` exists and is already composed.
   → **Track C.**
3. **The export is the last caller of the deprecated pair.** `ha-export` is the
   only entry left in the *phase-4 ledger* of
   `scripts/check-switch-successor-surfaces.ts`; seven surfaces have already made
   the switch. As long as it remains, phase 4 cannot start and the pair cannot be
   deleted. → **Track A.**
4. **Three entities that exist and cannot receive a value.** It is exactly the
   defect that killed the previous export (177 devices out of 293) and for which
   `scripts/check-export-coverage.ts` exists; it came back through the back door,
   on the **hand-written** side of the catalogue, which no guard looks at:
   - `snooze` (select, writable): no projector publishes its state —
     `grep snooze state-projector.ts` finds nothing. A snooze set from the viewer
     does not show up, and the select stays `unknown` until someone writes it
     from HA.
   - `audio_detected`: fed **only** by `projectTrackLifecycle`, which publishes
     `<macro>_detected` only if `macroOf(className)` answers `audio` — something an
     object track practically never does. The catalogue comment
     (`entity-catalog.ts:443`) says the audio window is *"the source that
     `audio_detected` never had"*, but `projectAudioWindow`
     (`state-projector.ts:565-600`) publishes volume, RMS and label — and
     `audio_detected` **does not**. It is a leftover that describes the right
     design: it reads as verification.
   - `ptz_preset` (select): declares a `state_topic` and nobody writes it; there is
     no read of the current preset.
   → **Track B.**
5. **The conditions nobody has stated.** `alerts.list`
   (`packages/types/src/capabilities/alerts.cap.ts:61`, auth `view`) carries the
   liveness monitor's *findings* as persistent alerts with a stable id. They are
   literally the conditions that stayed mute during the four-hour blackout.
   → **Track D.**
6. **The disk.** `recording.getStorageUsage()`
   (`recording.cap.ts:289`) gives `totalUsedBytes`, per location
   `availableBytes`/`totalBytes`, and per device `oldestMs`. A «disk above 90%»
   automation is among the first three an operator writes. → **Track D.**
7. **Agents that fall behind.** `serverManagement.getServerPackageStatus`
   accepts `{ nodeId }` (`packages/types/src/generated/addon-api.ts:258`) and the
   export **today calls it without**: it reports only the hub
   (`ha-export.addon.ts:1090`). `nodes.topology[].rootPackage.version` is already
   in the payload the export downloads — zero extra calls. → **Track D.**
8. **The global snooze as a `select`.** The synthetic device has the read half
   (`snoozed` binary) and not the control; the camera has the select but not the
   state (point 4). The two halves close together. → **Track B + D.**
9. **`imageContract`** (`server-management.cap.ts:60-106`): catches *«the running
   version is up to date but the container image is weeks old»*, the 2026-08-02
   failure. One sensor, diagnostic. → **Track D.**

---

## 3. The entity count

The constraint is real: HA slows visibly at thousands of entities, and the camera
catalogue already makes ~73 entities per camera with three zones.

| Addition | Per camera | Per node | Global |
| --- | --- | --- | --- |
| C1 `status` | +1 | | |
| C2 `recording_active` | +1 | | |
| D1 alerts (`alerts_active`, `alerts_active_count`, `alerts_last_title`) | | | +3 |
| D2 disk (`<n>_footage_used_bytes`, `<n>_footage_free_percent`) | | +2 | |
| D2 disk (`oldest_footage`) | | | +1 |
| D3 updates (`<n>_version`, `<n>_update_available`, NON-hub nodes only) | | +2 (agent) | |
| D3 `image_contract` | | | +1 |
| D4 global `snooze` (select) | | | +1 |
| **Total** | **+2** | **+2 hub / +4 agent** | **+6** |

Tracks A and B add **zero** entities: A only changes who writes under the same
`unique_id`, B makes a value reach entities that already exist.

Worked out:

| Scenario | New entities | Out of how many |
| --- | --- | --- |
| Today (2 exported cameras, hub + 1 agent) | 4 + 6 + 6 = **16** | 175 → 191 (+9%) |
| 15 cameras, hub + 1 agent | 30 + 6 + 6 = **42** | ~1100 → ~1140 (+4%) |
| 30 cameras, hub + 2 agents | 60 + 6 + (2+4+4) = **76** | ~2200 → ~2280 (+3.5%) |

For comparison, the thing we do **not** do: per-rule state on every camera (§5.1)
would be 8 rules × 4 entities × 30 cameras = **960 entities**, more than half of
the current export, for a datum that no source can produce.

**The valve rule.** The two new camera entities arrive **enabled**: `status` and
`recording_active` are what one automates on, not detail. The synthetic ones
arrive enabled by the rule already written in `synthetic-devices.ts:86-93` (there
is no fan-out there). No new entity is a counter.

**Identity and disappearance.** `unique_id` stays `<stableId>_<entity>` and the
entity id stays `<entity>`, minted in a single place (`ha-export/topics.ts`). No
new entity has an id that depends on a value that changes: no id per alert, no id
per rule-on-camera, no id per audio class — **an entity that appears and
disappears with the data breaks the automation that leans on it**, and in this
export an entity that disappears is not removed: the component marks everything
*unavailable* when the heartbeat is missing, and the `entity_change` plan always
carries the complete set, so a component that stops being announced **stays in
HA's registry as unavailable**, it is not deleted. This is the reason the
per-alert fan-out is excluded (§5.6) and why the per-node set is acceptable: nodes
are few and stable, alerts are not.

---

## File structure

| File | Responsibility | Track |
| --- | --- | --- |
| `packages/addon-provider-homeassistant/src/ha-export/camera-functions.ts` | **NEW** — pure derivation of the 8 switches from the authority reads + write resolution | A | <!-- drift-ok: this plan creates it -->
| `.../ha-export/camera-function-writes.ts` | **NEW** — performs the write on the authority via `ctx.api`; it is the file the D113 guard points at | A | <!-- drift-ok: this plan creates it -->
| `.../ha-export/__tests__/camera-functions.spec.ts` | **NEW** | A | <!-- drift-ok: this plan creates it -->
| `.../ha-export/__tests__/camera-entity-feeds.spec.ts` | **NEW** — the guard: no camera entity with a `state_topic` without something feeding it | B | <!-- drift-ok: this plan creates it -->
| `.../ha-export/ha-export.addon.ts` | collects the authorities, reads `getCameraStatuses`, stops calling the deprecated pair, new synthetic reads | A, B, C, D |
| `.../ha-export/state-projector.ts` | `projectCameraFunctions`, `projectCameraStatus`, `projectSnooze`, `audio_detected` | A, B, C |
| `.../ha-export/entity-catalog.ts` | `CatalogSwitch` → functions, +2 camera entities, reason for `privacy-mask`, `attributes` leftover | A, B, C |
| `.../ha-export/synthetic-devices.ts` | alerts, disk, per-node version/update, snooze select | D |
| `.../ha-export/command-routes.ts` | `camera-switch` → `camera-function` | A |
| `.../ha-export/types.ts` | `CatalogSwitch` → `CatalogFunctionSwitch`, drop `json_attributes_topic` | A, B |
| `.../ha-export/topics.ts` | drop `attributesTopic` | B |
| `scripts/check-switch-successor-surfaces.ts` | 7 new rows in `SUCCESSORS`, `ha-export` out of the ledger | A |

---

## Track A — the export stops going through the retired group

Today the export does three things with the deprecated pair:
`loadSwitches()` (`ha-export.addon.ts:1396`) for the announcement, a second
`getCameraSwitches` (`:1243`) for the state, and `setCameraSwitch` (`:1819`) for
the command. After this track it does none of them, **and nothing moves in Home
Assistant**: the same eight `unique_id`s, the same labels, the same topics.

### Task A1: the pure derivation of the eight functions

The reads are the same ones `readSwitchAuthorities` makes
(`packages/addon-pipeline-orchestrator/src/switch-authorities.ts:417`) — **but we
read the privacy table from the SLICE**, without calling the camera: the
`privacy-mask` slice is already in the snapshot that the reconcile downloads
(`runtimeState: PrivacyMaskStatusSchema`, `privacy-mask.cap.ts:146`) and the
freshness of a camera fact lives in the provider that owns it
([D224](../../decisions/adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)).
Zero new dialers towards the camera.

**Files:**
- Create: `packages/addon-provider-homeassistant/src/ha-export/camera-functions.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-provider-homeassistant/src/ha-export/__tests__/camera-functions.spec.ts` <!-- drift-ok: this plan creates it -->

**Interfaces:**
- Produces: `deriveCameraFunctions(reads: CameraFunctionReads): readonly CameraFunction[]`
- Produces: `resolveCameraFunctionWrite(id, on, reads): CameraFunctionWrite | null`
- Consumes: `CameraSwitchId` from `@camstack/types` — **survives phase 4**,
  because it is the vocabulary of `CameraStatus.switchedOff`, which stays.

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, expect, it } from 'vitest'
import {
  deriveCameraFunctions,
  resolveCameraFunctionWrite,
  type CameraFunctionReads,
} from '../camera-functions.js'

const ALL_READ: CameraFunctionReads = {
  deviceDisabled: false,
  bindableCapNames: ['detection-pipeline', 'audio-analysis'],
  wrappedCapNames: ['detection-pipeline', 'audio-analysis'],
  wrapperAddonIdByCap: new Map([
    ['detection-pipeline', 'pipeline'],
    ['audio-analysis', 'pipeline'],
  ]),
  recordingEnabled: true,
  notificationsMuted: false,
  privacy: { maskEnabled: false, audioEnabled: true },
  brokerAudioMuted: false,
}

function byId(reads: CameraFunctionReads, id: string) {
  return deriveCameraFunctions(reads).find((fn) => fn.id === id)
}

describe('deriveCameraFunctions', () => {
  it('renders the eight functions with the labels HA already has', () => {
    const ids = deriveCameraFunctions(ALL_READ).map((fn) => fn.id)
    expect(ids).toEqual([
      'stream-broker',
      'object-detection',
      'privacy-mask',
      'device-audio',
      'broker-audio',
      'audio-analysis',
      'recording',
      'notifications',
    ])
    expect(byId(ALL_READ, 'stream-broker')?.label).toBe('Camera')
    expect(byId(ALL_READ, 'device-audio')?.label).toBe('Camera microphone')
  })

  it('a source that did not answer does NOT produce a control that is on', () => {
    // The rule this export has already written: a control that is `on` because
    // nobody answered tells the operator that a function is running.
    const blind: CameraFunctionReads = { ...ALL_READ, recordingEnabled: null }
    expect(byId(blind, 'recording')?.available).toBe(false)
  })

  it('a wrapper that no addon provides is not a control', () => {
    const noWrapper: CameraFunctionReads = { ...ALL_READ, wrapperAddonIdByCap: new Map() }
    expect(byId(noWrapper, 'object-detection')?.available).toBe(false)
  })

  it('a cap that is not bindable for this device type produces no row', () => {
    const noAudio: CameraFunctionReads = { ...ALL_READ, bindableCapNames: ['detection-pipeline'] }
    expect(byId(noAudio, 'audio-analysis')?.available).toBe(false)
  })

  it('the polarity of broker-audio is inverted: muted=true means off', () => {
    expect(byId({ ...ALL_READ, brokerAudioMuted: true }, 'broker-audio')?.enabled).toBe(false)
  })

  it('the polarity of privacy-mask is NOT inverted: enabled=true is the mask active', () => {
    // `addon-export-hap` mirrors `patch.enabled` verbatim and a HomeKit toggle
    // that disagrees with HA's for the same camera is worse than neither.
    const masked: CameraFunctionReads = { ...ALL_READ, privacy: { maskEnabled: true, audioEnabled: true } }
    expect(byId(masked, 'privacy-mask')?.enabled).toBe(true)
  })

  it('audioEnabled null is UNKNOWN, never microphone off', () => {
    const unknownMic: CameraFunctionReads = {
      ...ALL_READ,
      privacy: { maskEnabled: false, audioEnabled: null },
    }
    expect(byId(unknownMic, 'device-audio')?.available).toBe(false)
  })

  it('without a privacy slice there is neither the mask nor the microphone', () => {
    const noPrivacy: CameraFunctionReads = { ...ALL_READ, privacy: null }
    expect(byId(noPrivacy, 'privacy-mask')?.available).toBe(false)
    expect(byId(noPrivacy, 'device-audio')?.available).toBe(false)
  })
})

describe('resolveCameraFunctionWrite', () => {
  it('sends each function to ITS authority', () => {
    expect(resolveCameraFunctionWrite('stream-broker', false, ALL_READ)).toEqual({
      kind: 'device-disabled',
      disabled: true,
    })
    expect(resolveCameraFunctionWrite('object-detection', false, ALL_READ)).toEqual({
      kind: 'wrapper-binding',
      capName: 'detection-pipeline',
      wrapperAddonId: 'pipeline',
      active: false,
    })
    expect(resolveCameraFunctionWrite('recording', false, ALL_READ)).toEqual({
      kind: 'recording-enabled',
      enabled: false,
    })
    expect(resolveCameraFunctionWrite('notifications', false, ALL_READ)).toEqual({
      kind: 'notification-mute',
      muted: true,
    })
    expect(resolveCameraFunctionWrite('privacy-mask', true, ALL_READ)).toEqual({
      kind: 'camera-mask',
      enabled: true,
    })
    expect(resolveCameraFunctionWrite('device-audio', false, ALL_READ)).toEqual({
      kind: 'camera-audio',
      enabled: false,
    })
    expect(resolveCameraFunctionWrite('broker-audio', false, ALL_READ)).toEqual({
      kind: 'broker-audio-mute',
      muted: true,
    })
  })

  it('refuses the write on an unavailable function instead of persisting it', () => {
    const blind: CameraFunctionReads = { ...ALL_READ, recordingEnabled: null }
    expect(resolveCameraFunctionWrite('recording', false, blind)).toBeNull()
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/addon-provider-homeassistant camera-functions`
      Expected: `Cannot find module '../camera-functions.js'`.

- [ ] **Step 3 — write the module.**

```ts
/**
 * The eight per-camera functions, derived from the AUTHORITIES that already own
 * them ([D62](../../../../docs/decisions/adr-0062.md),
 * [D113](../../../../docs/decisions/adr-0113.md)).
 *
 * This module stores nothing and normalises nothing. It is the pure reading of
 * eight answers, exactly as
 * `addon-admin-ui/.../camera-function-switches.ts` is of its three — which is the
 * MODEL, not a dependency: addons do not import each other.
 *
 * The labels are copied verbatim from `CAMERA_SWITCH_CATALOG` because they are
 * the friendly names the entities ALREADY have in Home Assistant. They live here
 * and not there because phase 4 of D113 deletes that catalogue; `CameraSwitchId`
 * instead survives, it is the vocabulary of `CameraStatus.switchedOff`.
 *
 * The rule for which the `null`s exist: **a source that did not answer is
 * unknown, never a value set to "on"**.
 */
import type { CameraSwitchId } from '@camstack/types'

export interface CameraFunctionReads {
  /** `deviceManager.listAll()` → `disabled`. `null` = failed read. */
  readonly deviceDisabled: boolean | null
  /** `deviceManager.listBindableCapsForDeviceType({ deviceType })`. */
  readonly bindableCapNames: readonly string[] | null
  /** `deviceManager.getBindings()` → entries with `kind: 'wrapped'`. */
  readonly wrappedCapNames: readonly string[] | null
  /** cap → addon that must appear in `setWrapperActive`. */
  readonly wrapperAddonIdByCap: ReadonlyMap<string, string>
  /** `recording.getDeviceConfig()` → `enabled`. */
  readonly recordingEnabled: boolean | null
  /** `notificationRules.listDeviceMutes()` ∋ deviceId. */
  readonly notificationsMuted: boolean | null
  /** The `privacy-mask` slice already in the snapshot. `null` = cap not present. */
  readonly privacy: CameraPrivacyReads | null
  /** `streamBroker.getDeviceAudioMute()` → `muted`. */
  readonly brokerAudioMuted: boolean | null
}

export interface CameraPrivacyReads {
  readonly maskEnabled: boolean
  /** `null` = this camera has no writable microphone, or did not answer. */
  readonly audioEnabled: boolean | null
}

export interface CameraFunction {
  readonly id: CameraSwitchId
  /** The friendly name the entity already has in HA. Renaming it is a migration. */
  readonly label: string
  readonly available: boolean
  /** Meaningless when `available` is false. */
  readonly enabled: boolean
}

export type CameraFunctionWrite =
  | { readonly kind: 'device-disabled'; readonly disabled: boolean }
  | {
      readonly kind: 'wrapper-binding'
      readonly capName: string
      readonly wrapperAddonId: string
      readonly active: boolean
    }
  | { readonly kind: 'recording-enabled'; readonly enabled: boolean }
  | { readonly kind: 'notification-mute'; readonly muted: boolean }
  | { readonly kind: 'camera-mask'; readonly enabled: boolean }
  | { readonly kind: 'camera-audio'; readonly enabled: boolean }
  | { readonly kind: 'broker-audio-mute'; readonly muted: boolean }

const DETECTION_CAP = 'detection-pipeline'
const AUDIO_ANALYSIS_CAP = 'audio-analysis'

/** Rendering order: widest radius of action first, source before consumer. */
const ORDER: readonly CameraSwitchId[] = [
  'stream-broker',
  'object-detection',
  'privacy-mask',
  'device-audio',
  'broker-audio',
  'audio-analysis',
  'recording',
  'notifications',
]

const LABELS: Readonly<Record<CameraSwitchId, string>> = {
  'stream-broker': 'Camera',
  'object-detection': 'Object detection & tracking',
  'privacy-mask': 'Privacy mask',
  'device-audio': 'Camera microphone',
  'broker-audio': 'Audio distribution',
  'audio-analysis': 'Audio detection & classification',
  recording: 'Recording',
  notifications: 'Notifications',
}

interface Resolved {
  readonly available: boolean
  readonly enabled: boolean
}

const UNAVAILABLE: Resolved = { available: false, enabled: true }

function resolveWrapper(capName: string, reads: CameraFunctionReads): Resolved {
  if (reads.bindableCapNames === null || reads.wrappedCapNames === null) return UNAVAILABLE
  if (!reads.bindableCapNames.includes(capName)) return UNAVAILABLE
  if (reads.wrapperAddonIdByCap.get(capName) === undefined) return UNAVAILABLE
  return { available: true, enabled: reads.wrappedCapNames.includes(capName) }
}

function resolveOne(id: CameraSwitchId, reads: CameraFunctionReads): Resolved {
  switch (id) {
    case 'stream-broker':
      return reads.deviceDisabled === null
        ? UNAVAILABLE
        : { available: true, enabled: !reads.deviceDisabled }
    case 'object-detection':
      return resolveWrapper(DETECTION_CAP, reads)
    case 'audio-analysis':
      return resolveWrapper(AUDIO_ANALYSIS_CAP, reads)
    case 'recording':
      return reads.recordingEnabled === null
        ? UNAVAILABLE
        : { available: true, enabled: reads.recordingEnabled }
    case 'notifications':
      return reads.notificationsMuted === null
        ? UNAVAILABLE
        : { available: true, enabled: !reads.notificationsMuted }
    case 'privacy-mask':
      // Polarity NOT inverted: `on` = the mask is obscuring.
      return reads.privacy === null
        ? UNAVAILABLE
        : { available: true, enabled: reads.privacy.maskEnabled }
    case 'device-audio':
      return reads.privacy === null || reads.privacy.audioEnabled === null
        ? UNAVAILABLE
        : { available: true, enabled: reads.privacy.audioEnabled }
    case 'broker-audio':
      // Inverted polarity: the switch is "audio is distributed".
      return reads.brokerAudioMuted === null
        ? UNAVAILABLE
        : { available: true, enabled: !reads.brokerAudioMuted }
  }
}

export function deriveCameraFunctions(reads: CameraFunctionReads): readonly CameraFunction[] {
  return ORDER.map((id) => ({ id, label: LABELS[id], ...resolveOne(id, reads) }))
}

/** `null` = unavailable: the write must be REFUSED, not approximated. */
export function resolveCameraFunctionWrite(
  id: CameraSwitchId,
  on: boolean,
  reads: CameraFunctionReads,
): CameraFunctionWrite | null {
  if (!resolveOne(id, reads).available) return null
  switch (id) {
    case 'stream-broker':
      return { kind: 'device-disabled', disabled: !on }
    case 'object-detection':
    case 'audio-analysis': {
      const capName = id === 'object-detection' ? DETECTION_CAP : AUDIO_ANALYSIS_CAP
      const wrapperAddonId = reads.wrapperAddonIdByCap.get(capName)
      if (wrapperAddonId === undefined) return null
      return { kind: 'wrapper-binding', capName, wrapperAddonId, active: on }
    }
    case 'recording':
      return { kind: 'recording-enabled', enabled: on }
    case 'notifications':
      return { kind: 'notification-mute', muted: !on }
    case 'privacy-mask':
      return { kind: 'camera-mask', enabled: on }
    case 'device-audio':
      return { kind: 'camera-audio', enabled: on }
    case 'broker-audio':
      return { kind: 'broker-audio-mute', muted: !on }
  }
}
```

- [ ] **Step 4 — run again: green.**
- [ ] **Step 5 — DISARM.** Replace `UNAVAILABLE` with
      `{ available: true, enabled: true }` and confirm that the tests «a source
      that did not answer» and «refuses the write» turn red. Put it back.

### Task A2: executing the write, with the pin on the right node

`broker-audio` is the only one that must travel *pinned*: brokers live on the node
that owns the camera's source, and `stream-broker` is a per-node singleton — an
unrouted write lands on a node that serves nothing for that camera. The node is
`CameraStatus.assignment.sourceNodeId`
(`pipeline-orchestrator.cap.ts:299`), which Track C reads anyway.

**Files:**
- Create: `packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts` <!-- drift-ok: this plan creates it -->
- Modify: `.../ha-export/__tests__/camera-functions.spec.ts`

**Interfaces:**
- Produces: `applyCameraFunctionWrite(api, deviceId, write, sourceNodeId): Promise<void>`

- [ ] **Step 1 — the test, with a fake api that records the calls.**

```ts
import { describe, expect, it, vi } from 'vitest'
import { applyCameraFunctionWrite } from '../camera-function-writes.js'

function fakeApi() {
  return {
    deviceManager: { setDisabled: { mutate: vi.fn() }, setWrapperActive: { mutate: vi.fn() } },
    recording: {
      getDeviceConfig: { query: vi.fn().mockResolvedValue({ enabled: true, bands: ['B'] }) },
      setDeviceConfig: { mutate: vi.fn() },
    },
    notificationRules: { setDeviceMuted: { mutate: vi.fn() } },
    privacyMask: { setMask: { mutate: vi.fn() }, setAudioEnabled: { mutate: vi.fn() } },
    streamBroker: { setDeviceAudioMute: { mutate: vi.fn() } },
  }
}

describe('applyCameraFunctionWrite', () => {
  it('recording touches `enabled` and leaves `bands` byte for byte', async () => {
    // `bands` is the only intention written by the operator and `mode` derives
    // from it: emptying them to say "off" destroys the schedule and switching
    // back on would no longer record anything.
    const api = fakeApi()
    await applyCameraFunctionWrite(api, 101, { kind: 'recording-enabled', enabled: false }, 'hub')
    expect(api.recording.setDeviceConfig.mutate).toHaveBeenCalledWith({
      deviceId: 101,
      config: { enabled: false, bands: ['B'] },
    })
  })

  it('broker-audio is PINNED on the node that owns the source', async () => {
    const api = fakeApi()
    await applyCameraFunctionWrite(api, 101, { kind: 'broker-audio-mute', muted: true }, 'agent-1')
    const [input, opts] = api.streamBroker.setDeviceAudioMute.mutate.mock.calls[0]
    expect(input).toEqual({ deviceId: 101, muted: true })
    expect(opts).toBeDefined()
  })

  it('refuses broker-audio without a node instead of writing to the hub', async () => {
    const api = fakeApi()
    await expect(
      applyCameraFunctionWrite(api, 101, { kind: 'broker-audio-mute', muted: true }, null),
    ).rejects.toThrow(/source node/)
    expect(api.streamBroker.setDeviceAudioMute.mutate).not.toHaveBeenCalled()
  })

  it('the mask writes only `enabled`, never the regions', async () => {
    const api = fakeApi()
    await applyCameraFunctionWrite(api, 101, { kind: 'camera-mask', enabled: true }, 'hub')
    expect(api.privacyMask.setMask.mutate).toHaveBeenCalledWith({
      deviceId: 101,
      patch: { enabled: true },
    })
  })
})
```

- [ ] **Step 2 — verify it FAILS** (`Cannot find module`).
- [ ] **Step 3 — write the module.** Each branch names a single method; no
      fallthrough onto `switch.setState`, which is the defect for which
      `command-routes.ts` exists.

```ts
import { nodePin } from '@camstack/types'
import type { CameraFunctionWrite } from './camera-functions.js'

/** The slice of `ctx.api` this write uses. Injected, so it is testable. */
export interface CameraFunctionWriteApi {
  readonly deviceManager: {
    readonly setDisabled: { mutate(input: { deviceId: number; disabled: boolean }): Promise<unknown> }
    readonly setWrapperActive: {
      mutate(input: {
        deviceId: number
        capName: string
        wrapperAddonId: string
        active: boolean
      }): Promise<unknown>
    }
  }
  readonly recording: {
    readonly getDeviceConfig: { query(input: { deviceId: number }): Promise<RecordingConfigShape> }
    readonly setDeviceConfig: {
      mutate(input: { deviceId: number; config: RecordingConfigShape }): Promise<unknown>
    }
  }
  readonly notificationRules: {
    readonly setDeviceMuted: { mutate(input: { deviceId: number; muted: boolean }): Promise<unknown> }
  }
  readonly privacyMask: {
    readonly setMask: {
      mutate(input: { deviceId: number; patch: { enabled: boolean } }): Promise<unknown>
    }
    readonly setAudioEnabled: {
      mutate(input: { deviceId: number; enabled: boolean }): Promise<unknown>
    }
  }
  readonly streamBroker: {
    readonly setDeviceAudioMute: {
      mutate(input: { deviceId: number; muted: boolean }, opts?: unknown): Promise<unknown>
    }
  }
}

/** Opaque on purpose: here it is read and rewritten, not interpreted. */
export type RecordingConfigShape = Readonly<Record<string, unknown>> & { readonly enabled: boolean }

export async function applyCameraFunctionWrite(
  api: CameraFunctionWriteApi,
  deviceId: number,
  write: CameraFunctionWrite,
  sourceNodeId: string | null,
): Promise<void> {
  switch (write.kind) {
    case 'device-disabled':
      await api.deviceManager.setDisabled.mutate({ deviceId, disabled: write.disabled })
      return
    case 'wrapper-binding':
      await api.deviceManager.setWrapperActive.mutate({
        deviceId,
        capName: write.capName,
        wrapperAddonId: write.wrapperAddonId,
        active: write.active,
      })
      return
    case 'recording-enabled': {
      // Re-read and re-send: `bands` belongs to the operator, `mode` derives from it.
      const config = await api.recording.getDeviceConfig.query({ deviceId })
      await api.recording.setDeviceConfig.mutate({
        deviceId,
        config: { ...config, enabled: write.enabled },
      })
      return
    }
    case 'notification-mute':
      await api.notificationRules.setDeviceMuted.mutate({ deviceId, muted: write.muted })
      return
    case 'camera-mask':
      // `enabled` and nothing else: `regions` is the operator's drawing.
      await api.privacyMask.setMask.mutate({ deviceId, patch: { enabled: write.enabled } })
      return
    case 'camera-audio':
      await api.privacyMask.setAudioEnabled.mutate({ deviceId, enabled: write.enabled })
      return
    case 'broker-audio-mute':
      if (sourceNodeId === null) {
        throw new Error(
          `refusing an unrouted broker audio write for device ${String(deviceId)}: no source node`,
        )
      }
      await api.streamBroker.setDeviceAudioMute.mutate(
        { deviceId, muted: write.muted },
        nodePin(sourceNodeId),
      )
      return
  }
}
```

- [ ] **Step 4 — green.**
- [ ] **Step 5 — DISARM** the `sourceNodeId === null` branch (write without the
      pin) and confirm that the «refuses broker-audio without a node» test turns
      red.

### Task A3: wire the addon and remove the three deprecated calls

**Files:**
- Modify: `.../ha-export/ha-export.addon.ts` (`loadSwitches` `:1396`,
  `currentStateFor` `:1243`, `dispatch` `:1819`, `buildCatalogDevice` `:1284`)
- Modify: `.../ha-export/types.ts` (`CatalogSwitch` → `CatalogFunctionSwitch`,
  and the comment that says *"commands back through `setCameraSwitch`"*)
- Modify: `.../ha-export/entity-catalog.ts` (`device.switches`, and the reason for
  `privacy-mask` in `CAPS_NOT_EXPORTED:2005`)
- Modify: `.../ha-export/command-routes.ts` (`kind: 'camera-switch'` →
  `'camera-function'`)
- Modify: `.../ha-export/state-projector.ts`
  (`projectCameraSwitches` → `projectCameraFunctions`)

- [ ] `readCameraFunctions(deviceId, deviceType, snapshot)` in the addon: **one**
      collection per camera per reconcile, reused by both the announcement and the
      state (today they are two separate `getCameraSwitches`). Every read is
      `.catch(() => null)` with a WARN carrying `tags: { deviceId }`: a branch that
      silently degrades a control is exactly what this repo pays for.
- [ ] The reads: `deviceManager.listAll` (already in hand, `disabled` field),
      `deviceManager.getBindings({ deviceId })`,
      `deviceManager.listBindableCapsForDeviceType({ deviceType })` (once per TYPE,
      not per device — memoise it in the pass),
      `recording.getDeviceConfig({ deviceId })`,
      `notificationRules.listDeviceMutes({})` (once per pass, it is a flat list),
      `streamBroker.getDeviceAudioMute({ deviceId }, nodePin(sourceNodeId))`,
      and the `privacy-mask` slice **from the snapshot already downloaded**.
- [ ] `privacy` comes from `snapshot['privacy-mask']`:
      `{ maskEnabled: enabled === true, audioEnabled: typeof audioEnabled === 'boolean' ? audioEnabled : null }`.
- [ ] The catalogue keeps building one entity per **available** function,
      with `entity: toSlug(fn.id)` and `label: fn.label` — unchanged.
- [ ] The command: `resolveCameraFunctionWrite` → `applyCameraFunctionWrite`.
      An unavailable function logs the refusal and answers `false`: no optimistic
      ack, the next reconcile corrects HA.
- [ ] Test: `getCameraSwitches` and `setCameraSwitch` no longer appear in any
      file of `ha-export/` (`grep -rn 'CameraSwitch\.' packages/addon-provider-homeassistant/src`
      must find only `CameraSwitchId`).
- [ ] Identity non-regression test: `buildCameraPlan` on a camera with all eight
      functions available produces the **same** component keys and the **same**
      `unique_id`s as before the track. Fix the expected values by hand in the
      test (`switch-stream-broker`, `switch-recording`, …): a test that recomputes
      them from the same expression proves nothing.

### Task A4: the guard records the switch, and the ledger empties

**Files:**
- Modify: `scripts/check-switch-successor-surfaces.ts`

- [ ] Add seven rows to `SUCCESSORS` pointing at
      `packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts`, <!-- drift-ok: Task A2 creates it -->
      one per authority, each with the token that appears only if the write is
      really there: `deviceManager.setDisabled.mutate`,
      `deviceManager.setWrapperActive.mutate` (two rows: `object-detection` and
      `audio-analysis`), `recording.setDeviceConfig.mutate`,
      `notificationRules.setDeviceMuted.mutate`, `privacyMask.setMask.mutate`,
      `privacyMask.setAudioEnabled.mutate`,
      `streamBroker.setDeviceAudioMute.mutate`. Rows with the same `switchId` are
      legitimate: the guard iterates them independently, and that is how two
      surfaces of the same function defend each other.
- [ ] **Empty `KNOWN_LEGACY_CALLERS`** and update the comment above it: it is no
      longer «`ha-export` is the big one», it is «the shipped viewers remain».
- [ ] `npx tsx scripts/check-switch-successor-surfaces.ts` must print green
      **without** the *phase-4 ledger* section.
- [ ] **DISARM:** rename `applyCameraFunctionWrite` and confirm the guard turns
      red on seven rows. Put it back.

> What this track does NOT do: it does **not delete** `getCameraSwitches` /
> `setCameraSwitch`. They stay for the shipped viewers (v1.0.305), which nobody
> can redistribute from here. This track removes the last caller *in the repo*,
> which is the condition that was missing for phase 4.

---

## Track B — an entity that cannot receive a value is a build error

### Task B1: the per-camera snooze state

The `snooze` `select` exists, is writable and **nobody publishes its state**.
There is nowhere to store it — and there must not be: the authority is
`notificationRules.listSnoozes`, and the snooze carries `startedAt` and
`expiresAt`, so the chosen duration is reconstructible.

**Files:**
- Modify: `.../ha-export/state-projector.ts`
- Modify: `.../ha-export/__tests__/state-projector.spec.ts`
- Modify: `.../ha-export/ha-export.addon.ts` (`currentStateFor`, and after
  `applySnooze` `:1879`)

- [ ] **Step 1 — the test.**

```ts
import { projectSnooze } from '../state-projector.js'

describe('snooze', () => {
  const T = (mins: number) => ({ startedAt: 1_000_000, expiresAt: 1_000_000 + mins * 60_000 })

  it('no active snooze publishes Off, not silence', () => {
    // Silence in HA reads as "the last value still holds".
    expect(at(projectSnooze(KEY, null), 'camstack/camstack-reolink-101/snooze')).toBe('Off')
  })

  it('publishes the option whose duration is the chosen one', () => {
    expect(at(projectSnooze(KEY, T(60)), 'camstack/camstack-reolink-101/snooze')).toBe('1 hour')
    expect(at(projectSnooze(KEY, T(1440)), 'camstack/camstack-reolink-101/snooze')).toBe('24 hours')
  })

  it('a duration the select cannot express publishes NOTHING', () => {
    // HA rejects a state outside `options` and would render it wrong anyway;
    // `unknown` is the truth about a snooze created by the viewer with 7 minutes.
    expect(projectSnooze(KEY, T(7))).toEqual([])
  })
})
```

- [ ] **Step 2 — red.** **Step 3 — implement:** inverse map of
      `SNOOZE_MINUTES`, `Math.round((expiresAt - startedAt) / 60_000)`, no
      approximation to the nearest preset.
- [ ] **Step 4** — wire it in `currentStateFor` (filter `listSnoozes` by
      `scope === 'device' && deviceId === entry.deviceId`, take the one that
      expires latest) and republish it right after `applySnooze`, so the select
      does not stay 300 s behind after a write from HA.
- [ ] Log at `debug` with `tags: { deviceId }` the inexpressible duration: it is a
      branch that does not publish, and silence reads as «it never happened».
- [ ] **Step 5 — DISARM** the `null → 'Off'` branch and confirm red.

### Task B2: `audio_detected` moves

**Files:**
- Modify: `.../ha-export/state-projector.ts` (`projectAudioWindow`)
- Modify: `.../ha-export/__tests__/state-projector.spec.ts`

- [ ] **Step 1 — the test.**

```ts
it('a window with a classification raises audio_detected', () => {
  const v = projectAudioWindow(KEY, { detections: [{ className: 'dog', confidence: 0.9 }], dbfs: -21 })
  expect(at(v, 'camstack/camstack-reolink-101/audio_detected')).toBe('true')
  expect(at(v, 'camstack/camstack-reolink-101/audio_last_sound')).toBe('dog')
})

it('a silent window lowers it, and does NOT clear the last sound', () => {
  // "what noise was it?" is asked after the noise is over.
  const v = projectAudioWindow(KEY, { detections: [], dbfs: -70 })
  expect(at(v, 'camstack/camstack-reolink-101/audio_detected')).toBe('false')
  expect(at(v, 'camstack/camstack-reolink-101/audio_last_sound')).toBeUndefined()
})
```

- [ ] **Step 2 — red** (today `audio_detected` appears in neither of the two).
      **Step 3** — one line in `projectAudioWindow`:
      `{ topic: stateTopic(deviceKey, 'audio_detected'), value: bool(best !== null) }`.
- [ ] **Step 4** — fix the comment at `entity-catalog.ts:441-447`: today it
      states that the window is the source of `audio_detected`, and it was not.
      A leftover that describes the right design is worse than nothing.
- [ ] **Step 5 — DISARM** and confirm red.

### Task B3: the guard — no camera entity without something feeding it

`state-projector.spec.ts` already walks every entry of `CAP_ENTITY_MAP` and checks
that the announced topic is the published one. The **hand-written** half of the
catalogue — the ~50 entities of a camera — has nothing like it, and it is where
the two defects above were born.

**Files:**
- Create: `.../ha-export/__tests__/camera-entity-feeds.spec.ts` <!-- drift-ok: this plan creates it -->

- [ ] **Step 1 — write the guard. It fails immediately, and that is the point.**

```ts
/**
 * Every camera entity that declares a `state_topic` must be in the union of the
 * topics the projectors know how to publish — or be declared here, with the
 * reason. A published entity that cannot receive a value reads, from the
 * operator's chair, as a broken integration: 177 of those, once.
 *
 * The union is COMPUTED by running the projectors, not listed: a hand-written
 * table would be a second copy, and diverges the day someone renames a topic on
 * one side only.
 */
const COMMAND_ONLY: Readonly<Record<string, string>> = {
  ptz_preset:
    'Command only. `ptz.getPresets` lists the presets, no cap says which one is ACTIVE ' +
    'right now: publishing the last one written from here would be a parallel store that ' +
    'disagrees with the first manual movement.',
}

it('no camera entity with a state_topic is without a source', () => {
  const feedable = new Set<string>(
    [
      ...projectDeviceStatus(KEY, true),
      ...projectBatterySlice(KEY, { percentage: 50, charging: 'ac', sleeping: false }),
      ...projectMotion(KEY, { detected: true, timestamp: 1 }),
      ...projectDoorbellSlice(KEY, { lastPressedAt: 1, pressCountSinceStart: 1 }, true),
      ...projectAudioWindow(KEY, {
        detections: [{ className: 'dog', confidence: 1 }],
        dbfs: -20,
        rms: 0.01,
      }),
      ...projectSnooze(KEY, null),
      ...projectCameraFunctions(KEY, ALL_FUNCTIONS),
      ...projectCameraStatus(KEY, HEALTHY_STATUS),
      ...EXPORTED_MACROS.flatMap((macro) =>
        projectTrackLifecycle(
          KEY,
          { deviceId: 101, trackId: 't', phase: 'start', classes: [macro],
            lastSeen: 1, label: 'x', zonesVisited: [ZONE.id] },
          'https://hub/media.jpg',
        ),
      ),
      ...projectZoneOccupancy(KEY, {
        zones: [{ zoneId: ZONE.id, totalObjects: 1, byClass: SCENE_CLASSES }],
        scene: { totalObjects: 1, byClass: SCENE_CLASSES },
      }),
      ...CAMERA_DERIVED_CAPS.flatMap((cap) =>
        capEntities(cap).map((ref) => ({ topic: stateTopic(KEY, ref.entity), value: '' })),
      ),
    ].map((v) => v.topic),
  )

  const orphans = Object.values(buildCameraPlan(MAXIMAL).cmps)
    .filter((c) => c.state_topic !== undefined && !feedable.has(c.state_topic))
    .map((c) => c.state_topic ?? '')
    .filter((topic) => COMMAND_ONLY[topic.split('/')[2] ?? ''] === undefined)

  expect(orphans).toEqual([])
})
```

- [ ] `MAXIMAL` is a camera with everything on: `features: ['rebootable']`,
      `boundCaps` with `ptz`, `doorbell`, `day-night`, `intercom`,
      `ptz-autotrack`, one zone, all functions available, `slices` with
      `battery`. `SCENE_CLASSES` covers the six macros
      (`{ person: 1, car: 1, dog: 1, package: 1, motion: 1, audio: 1 }`).
- [ ] **Step 2** — with B1 and B2 already done the only orphan must be
      `ptz_preset`, covered by the waiver. If others show up, **they are defects**:
      decide them one by one, do not widen `COMMAND_ONLY`.
- [ ] **Step 3 — DISARM:** remove `audio_detected` from `projectAudioWindow` and
      confirm the guard finds it. Put it back.

### Task B4: remove the three attribute leftovers

`attributesTopic` (`topics.ts:39`), `EntitySpec.attributes` (`entity-catalog.ts:224`)
and `HaComponent.json_attributes_topic` (`types.ts:97`) exist and **are called by
nobody**: `buildComponent` never emits that field. They describe a capability the
export does not have, and they read as verification — it is the reason why in §3
attributes are not a way to «not multiply entities».

- [ ] Delete all three. `grep -rn 'attributesTopic\|json_attributes_topic\|attributes?:' packages/addon-provider-homeassistant/src/ha-export`
      must find nothing anymore.
- [ ] If anyone wants attributes, it is work on the component (another repo) and
      an ADR: the field here has never carried them.

---

## Track C — two entities per camera, and they are the right ones

> Depends on A2: the same `getCameraStatuses` read serves both.

### Task C1: `status` — off is not broken

**Files:**
- Modify: `.../ha-export/state-projector.ts`
- Modify: `.../ha-export/entity-catalog.ts` (`cameraSpecs`)
- Modify: `.../ha-export/ha-export.addon.ts` (`currentStateFor`)

- [ ] **Step 1 — the test.**

```ts
import { projectCameraStatus } from '../state-projector.js'

const S = (topic: string, v: readonly StateValue[]) => at(v, `camstack/camstack-reolink-101/${topic}`)

describe('camera status', () => {
  it('all in order is ok', () => {
    const v = projectCameraStatus(KEY, { switchedOff: [], degradedStages: [], recording: { active: true } })
    expect(S('status', v)).toBe('ok')
  })

  it('a function switched off by a person is switched_off, not degraded', () => {
    const v = projectCameraStatus(KEY, {
      switchedOff: ['object-detection'],
      degradedStages: [],
      recording: { active: true },
    })
    expect(S('status', v)).toBe('switched_off')
  })

  it('a stage that did not answer is degraded', () => {
    const v = projectCameraStatus(KEY, { switchedOff: [], degradedStages: ['detection'], recording: null })
    expect(S('status', v)).toBe('degraded')
  })

  it('if the SWITCHES stage did not answer the answer is unknown, never ok', () => {
    // An empty `switchedOff` list is a POSITIVE statement only when
    // `degraded` does not name `switches`. Saying `ok` here is the D62 failure
    // inside the very field that exists to prevent it, and D237 says a check
    // must be able to say "I do not know".
    const v = projectCameraStatus(KEY, { switchedOff: [], degradedStages: ['switches'], recording: null })
    expect(S('status', v)).toBe('unknown')
  })
})
```

- [ ] **Step 2 — red.** **Step 3 — implement** in the order of the tests:
      `switches` degraded → `unknown`; non-empty `switchedOff` →
      `switched_off`; non-empty `degradedStages` → `degraded`; otherwise `ok`.
- [ ] **Step 4 — the entity.** In `cameraSpecs`, before `snooze`:
      `{ entity: 'status', platform: 'sensor', label: 'Status', icon: 'mdi:cctv', enabledByDefault: true }`.
      **No `device_class`**: `enum` in HA wants `options`, and a `select` here
      would be a control that cannot be written.
- [ ] **Step 5 — DISARM** the `switches`→`unknown` branch and confirm red.

### Task C2: `recording_active`

- [ ] `projectCameraStatus` also publishes `recording_active` **when it can**:
      `recording` block present → `active`; block absent and `degraded` does **not**
      name `recording` → `false` (the camera has no active recording, it is the
      truth); block absent and degraded stage → **nothing**, which HA renders as
      `unknown`.
- [ ] Test of the three branches, including the one that does not publish.
- [ ] The entity: `{ entity: 'recording_active', platform: 'binary_sensor', label: 'Recording', deviceClass: 'running', enabledByDefault: true }`.
- [ ] **DISARM** the third branch (publishes `false` on the degraded) and confirm
      the test turns red: it is the same lie as C1, one floor lower.

### Task C3: a single read for the whole pass

- [ ] In `runReconcile`, after `listAll`, one call:
      `pipelineOrchestrator.getCameraStatuses.query({ deviceIds })` with **only**
      the ids of the exported cameras. Never without `deviceIds`: the optional
      input means «the whole fleet», and it is the read this repo has just
      finished removing from hot paths.
- [ ] Three things come out of it: `switchedOff` + `degraded` (C1), `recording`
      (C2) and `assignment.sourceNodeId` (A2). If the call fails: WARN once per
      pass, **no** `status` and **no** `recording_active` published, and
      `broker-audio` unavailable. No invented value.
- [ ] Measure and write in the reconcile log the time of the call
      (`meta: { cameraStatusMs, cameras }`). It is the number that says whether
      this read holds at 30 cameras; §6 names it as unknown.

---

## Track D — the synthetic devices, where there is no fan-out

All the new entries live on `SYNTHETIC_DEVICES` and update at the reconcile
cadence, like the others: they are polled statistics, not events, and inventing
an event to make them seem reactive would be a second authority over numbers the
topology already owns.

### Task D1: the alerts nobody has stated

- [ ] `buildSynthetic` reads `alerts.list.query({ unreadOnly: false, limit: 50 })`,
      best-effort like the others.
- [ ] Three entities on *CamStack Server*: `alerts_active`
      (`binary_sensor`, `device_class: 'problem'`, on when an alert exists with
      `status === 'active'` and `severity` in `warning|error`), `alerts_active_count`
      (`sensor`), `alerts_last_title` (`sensor`, `entityCategory: 'diagnostic'`
      — the title of the most recent active alert by `updatedAt`).
- [ ] Test: does severity `info` not raise `alerts_active` but count in
      `alerts_active_count`? **No** — it counts only what the automation must
      see: both entities count `warning|error`, and the test fixes it. A counter
      that rises on an `info` teaches people to ignore the badge.
- [ ] Test: no alert → `false`, `0`, and `alerts_last_title` does not publish
      (it does not publish `''`: HA renders it as a valid state).

### Task D2: the disk

- [ ] For every node of `nodes.topology`:
      `recording.getStorageUsage.query({}, nodePin(node.id))` — the return carries
      its own `nodeId`.
- [ ] Two entities per node: `<slug>_footage_used_bytes`
      (`sensor`, `device_class: 'data_size'`, `unit: 'B'`, from `totalUsedBytes`)
      and `<slug>_footage_free_percent` (`sensor`, `unit: '%'`), computed on the
      location with **less** space: `(availableBytes / totalBytes) * 100`.
- [ ] One global: `oldest_footage` (`sensor`, `device_class: 'timestamp'`), the
      minimum of `devices[].oldestMs` across all nodes.
- [ ] **`locations` is optional** (`recording.cap.ts:128-136`): a hub on an older
      train does not send it. Absent → `footage_free_percent` **is not
      published**. Explicit test: no `NaN`, no `0` that reads as «disk full».
- [ ] `oldestMs` is optional **and** nullable: skip both, and if none is left do
      not publish.

### Task D3: nodes that fall behind

- [ ] `<slug>_version` (`sensor`, diagnostic) from
      `nodes.topology[].rootPackage.version` — **zero extra calls**, it is already
      in the payload. Nullable on an offline node: do not publish.
- [ ] `<slug>_update_available` (`binary_sensor`, `device_class: 'update'`) from
      `serverManagement.getServerPackageStatus.query({ nodeId })`.
- [ ] **Only for NON-hub nodes.** The hub already has `server_version` and
      `update_available`, which have always been its own: two more entities
      saying the same thing are two entities that will one day disagree.
- [ ] `image_contract` (`sensor`, diagnostic) from `imageContract.state`, only
      for the hub. Absent on old trains → do not publish.

### Task D4: the global snooze, as a control

- [ ] On the *Notification Center* device, a `select` `snooze` with the same
      `SNOOZE_OPTIONS` as the camera, writable.
- [ ] State: the same derivation as B1 on `listSnoozes` filtered
      `scope === 'all'`. Reuse `projectSnooze` — two expressions of the same rule
      in two files is how the mute entities were born.
- [ ] Write: `createSnooze({ snooze: { scope: 'all', durationMinutes } })`,
      and `Off` deletes every `scope === 'all'` snooze, exactly as
      `applySnooze` already does for the camera.
- [ ] Test: the synthetic's command topic is routed
      (`isSyntheticDeviceKey`) and does not end up in the device branch.

---

## 5. What NOT to export, and why

A plan that exports everything has decided nothing. These are decisions, not
deferrals: if one changes, it changes with a written reason.

1. **Per-rule state on every camera** (`<rule> triggered`,
   `<rule> last triggered`, `<rule> last image`), which is the biggest item of the
   gap with the reference integration. Two reasons, each sufficient. *There is no
   source:* `EventCategory.NotificationDispatched` exists in the enum
   (`event-category.ts:647`) and **has not a single publisher nor a single
   subscriber** in the whole repo; `notificationRules.getHistory` is a poll on an
   outbox table and its projection `outboxEntryToHistory` **throws away
   `artifacts`**, that is, precisely the image. *And the count:* 8 rules × 4 × 30
   cameras = 960 entities, more than half of today's export. Feeding it first
   needs an emitter and a field, that is work in `addon-post-analysis`.
2. **Fine audio classes as entities** (`bark`, `crying`, `speech`, …). They are
   18 entities per camera, and their identity depends on the classifier's
   vocabulary: a new class would be a new entity, a renamed class an orphan
   entity. The label already arrives, in full, on `audio_last_sound` — a template
   on that value is one line, an entity that appears and disappears is a broken
   automation.
3. **The face as its own subject** (`face detected`, `face last recognized`).
   The recognised name already arrives in `person_last_label`. A second entity on
   the same question is the double source this repo has already paid for twice;
   if «it is buried» is the problem, it is a dashboard problem, not an export
   one.
4. **Track groups.** The feature **no longer exists**: implemented on
   2026-08-24, deactivated the same day and **deleted** on 2026-09-01 by operator
   decision ([D330](../../decisions/adr-0330-a-kill-switched-feature-is-deleted-or-it-is-re-opened.md)).
   `listGroups` / `getGroup` are no longer on the wire. The notification
   center's burst merge ([D143](../../decisions/adr-0143.md)) is another
   mechanism and stays on.
5. **The `events` cap and the HA `event` platform.** The component does not
   build it (`component-support.ts`, `KNOWN_PLATFORMS`), and the component is
   another repo with another train. Same reason for `device_tracker`, `text`,
   `light` and native `siren`.
6. **A `binary_sensor` for every liveness finding.** It is what the roadmap
   asked for, and it is wrong here: `alerts.list` returns the **active** alerts,
   not the catalogue of possible findings, so the entities would appear and
   disappear with the fault. In this export a component that stops being
   announced stays in HA as `unavailable` forever. Three aggregate entities
   (D1) answer the same question and do not dirty the registry.
7. **`consumables` and `scene-monitor`.** The reason written on 2026-08-13 holds
   unchanged: the entity set is *per device* and changes when the operator adds a
   region or the supplier a filter. It needs a mint at reconcile time keyed on the
   device — a project, not a table row.
8. **`accessories`.** The written reason has been **verified**: every child is a
   real device, with its `stableId` (`<parent>-<suffix>`), its numeric id and its
   bindings (`spawnAccessoryChild`,
   `packages/system/src/kernel/moleculer/device-cap-proxy.ts:752`), appears in
   `deviceManager.listAll` and has a membership row of its own. Two postscripts
   are however missing from the reason and must be written there: `hiddenChildIds`
   is parent state that nobody else owns (intended loss), and **`accessories` is
   not the *linked device* relation** — that one is
   `deviceManager.getLinkedDevices` (location + `_linkedDeviceIds`), and nobody
   exports it.
9. **The camera → linked device relation**, for now. The right shape in HA is
   `via_device` on the device block, that is **zero entities** — but it is a
   field the component must build, and we do not know whether it accepts it. It
   is in §6, not here.
10. **`videoclips` and `recording-export`.** Media by handle with expiring URLs:
    a `sensor` carrying a dead URL after six hours is worse than no sensor. Clips
    reach the operator by notification and from the viewer.
11. **Detection fps, `queueDepth`, `avgInferenceMs` per camera.** They are
    diagnostics nobody automates on, and they multiply by the fleet. The question
    the operator really asks — «is it off or is it broken» — is answered by
    `status` with a single entity.
12. **`storage-evictable`** (`internal: true`) and every `internal` cap. They exist
    for internal fan-out; [D240](../../decisions/adr-0240-an-internal-cap-floors-its-unannotated-methods-to-admin.md)
    also raises their auth floor.
13. **`camera-credentials` and `stream-catalog`.** The strongest exclusions in the
    file, and they stay: they carry the camera password in clear, and an entity
    would write it into HA's registry and into every debug log it keeps, on a host
    that camstack does not own.

---

## 6. What remains unknown, and must be measured

- **The cost of `getCameraStatuses` at 30 cameras.** It is a bounded fan-out but
  with remote reads per stage (broker, decoder, detection, recording). At 2
  cameras you do not see it; at 30, every 300 s, it might show. Track C3 makes it
  measured and written in the log **before** deciding a separate cadence. Do not
  optimise in advance: the read is needed anyway, and raising the cadence without
  the number is the same trust that produced twelve camera components and two
  entities.
- **Whether the component accepts `via_device`** in the `dev` block. If it does,
  the camera → siren/light/contact hierarchy costs **zero entities** and is
  probably the best value/cost ratio left. It must be read in the component's
  repo, not guessed: the lesson of [D152](../../decisions/adr-0152.md)
  is that the platform probe cannot say «I build this thing, but elsewhere».
- **`doorbell_last_image` stays owed and stays out.** The frame already exists —
  the synthetic marker track carries the `keyFrameSmall` and the notification
  shows that photo — but `persistSyntheticTrack` does not emit
  `pipeline-analytics.track-lifecycle`, the only event from which this addon
  takes frames. The fix lives upstream, in `addon-post-analysis`, which this plan
  **does not touch** (four agents work there). Do **not** solve it by taking a
  second snapshot on the push: it would be a different photo from the one in the
  notification.
- **Whether `alerts.list` and `recording.getStorageUsage` really answer from
  `ctx.api` inside this addon.** `getStorageUsage` is `auth: 'admin'`; there is
  precedent (`serverManagement.getServerPackageStatus` is admin and the export
  already calls it successfully), but it is a precedent, not a proof. If one
  answers with an authorisation refusal, the right line is a WARN that **says**
  so, not a `catch` that silently degrades.
- **How many cameras are really exported.** The last measurement is `devices=4`
  of 2026-08-14, that is two cameras. The counts in §3 hold at 15 and at 30, but
  membership is per broker and chosen by the operator: if they turn on thirty at
  once, the first reconcile announces ~2200 entities in one go. It is worth one
  `entity_change` per device (already so) and an eye on the component's log.
- **`EXPORTED_MACROS` for audio.** The decision «the six macros and not the 21
  fine classes» was taken for **objects**. For audio the question is open and
  this plan's answer is §5.2 — but it is a decision, not a measurement: if the
  operator says they need `bark` and `crying` as booleans, the cost is known (18
  entities per camera) and so is the way.

## Out of scope, on purpose

- **Do not delete `getCameraSwitches` / `setCameraSwitch`.** The shipped viewers
  call them. Track A removes the last caller in the repo; the deletion is another
  session, with its own verification.
- **Do not touch `@camstack/types`.** None of the new entities needs it, and
  doing so would tie the whole plan to a train.
- **Do not touch the Home Assistant component.** Every entity here uses only the
  platforms that every released component builds.
- **Do not add a new `CameraSwitch`** (snapshot, light-on-motion,
  siren-on-motion). The group is being retired: adding a row is building on the
  surface that is disappearing. If a function deserves a switch, it deserves the
  authority that owns it, and then it is a row in `camera-functions.ts` **plus**
  the authority that must exist first.
- **Do not rewrite `EXPORTED_MACROS`.** See §6.

## At the end

- [ ] `npm run typecheck`, `npm run test`, `npm run lint`.
- [ ] `npx tsx scripts/check-export-coverage.ts` — green, and the exceptions list
      has **not grown** (it is a ratchet, it only shortens).
- [ ] `npx tsx scripts/check-switch-successor-surfaces.ts` — green and **without**
      the *phase-4 ledger* section.
- [ ] A new ADR (copy `docs/decisions/template.md`): *an exported switch writes
      the authority, not a group* — it is the generalisation of D62 to surfaces
      outside the repo, and it is what stops the next exporter (HomeKit, Alexa)
      from rebuilding a group for convenience.
- [ ] (planning repo: sessions/sessions.md): the three mute entities and the guard that finds <!-- drift-ok: moved to the private planning repo -->
      them. It is the same lesson as the 177, arrived through the back door.
- [ ] Invoke the `sync-docs` skill.
