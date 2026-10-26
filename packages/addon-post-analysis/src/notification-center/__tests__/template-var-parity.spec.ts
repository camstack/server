/**
 * Producer parity: the template-variable catalog (`NC_TEMPLATE_VARS`) equals
 * exactly what the notification producers supply — no HIDDEN variable (a
 * producer key the catalog does not declare) and no GHOST variable (a
 * declared variable no producer sample ever fills).
 *
 * Three producers, three shapes:
 *  - `buildTemplateVars` (dispatcher.ts) — ONE function for every rule kind.
 *    It fills every key on every row (empty where it has nothing to say), so
 *    only the row's NON-EMPTY keys are checked against "declared".
 *  - `timelapseTemplateVars` / `summaryTemplateVars` — each emits exactly its
 *    own fixed vocabulary, so the full map is checked both ways.
 *
 * SYSTEM rows are never hand-typed here: every sample is built by the real
 * intake (`incomingFromSystemEvent`, `incomingFromBatteryBand`,
 * `incomingFromConsumableBand`, `incomingFromAlarmTransition` fed by the real
 * `buildArm*Announcement` bodies), one per branch that changes the frozen
 * params, and every authorable `NcSystemEventKind` must have one — bar the
 * named `KINDS_AWAITING_PRODUCER`, each owed by a later task. `{{camera}}`
 * is fed the name the dispatcher itself derives (`notificationDeviceName`).
 */
import { describe, expect, it } from 'vitest'
import {
  DeviceType,
  NC_AUTHORABLE_SYSTEM_EVENT_KINDS,
  NcRuleSchema,
  isKnownTemplateVar,
  templateVarsFor,
  type NcSystemEventKind,
  type NcTemplateVarContext,
  type SystemEvent,
} from '@camstack/types'
import { NcTextCatalog } from '../text-catalog.js'
import { NC_STATE_SUMMARY_SECTION_IDS } from '../state-summary/state-model.js'
import { type NcStateSummary, stateSummaryText } from '../state-summary/state-summary.js'
import {
  stateSummarySubject,
  stateSummarySubjects,
} from '../state-summary/state-summary-delivery.js'
import { ncClockText } from '../clock-text.js'
import { withNodeLivenessFacts } from '../node-liveness-text.js'
import {
  buildTemplateVars,
  NC_DEVICELESS_CAMERA_NAME,
  notificationDeviceName,
  resolveZoneLabels,
} from '../dispatcher.js'
import type { NcDeviceLookup } from '../device-directory.js'
import {
  incomingFromAlarmTransition,
  incomingFromBatteryBand,
  incomingFromConsumableBand,
  incomingFromProviderConsumableBand,
  incomingFromSystemEvent,
  type NcIncomingEvent,
  type NcSystemEventFacts,
} from '../event-intake.js'
import type { NcAlarmTransition } from '../alarm/alarm-transitions.js'
import {
  buildArmAnnouncement,
  buildArmingAnnouncement,
  buildArmRefusedAnnouncement,
  type NcAlarmModeCoverage,
  type NcArmAnnouncementText,
} from '../alarm/alarm-mode-coverage.js'
import { timelapseTemplateVars } from '../timelapse/timelapse-delivery.js'
import type { TimelapseDeliveryInput } from '../timelapse/timelapse-delivery.js'
import { footageCoverage } from '../timelapse/footage-coverage.js'
import { countDetections } from '../timelapse/detection-counts.js'
import { summaryTemplateVars } from '../summary/summary-delivery.js'
import type { SummaryDeliveryInput } from '../summary/summary-delivery.js'
import type { NcOutboxEntry } from '../outbox.js'

const texts = new NcTextCatalog({ language: 'en' })

/** No HIDDEN variable: every key a producer emits is declared for its context. */
function expectAllDeclared(
  vars: Readonly<Record<string, string>>,
  ctx: NcTemplateVarContext,
): void {
  const undeclared = Object.keys(vars).filter((name) => !isKnownTemplateVar(name, ctx))
  expect(undeclared).toEqual([])
}

/**
 * No GHOST variable: every declared variable of the context has a value in
 * the sample — minus the named `emptyOnThisSample` carve-outs (a declared
 * name this exact row's producer branch never fills, proven filled by a
 * DIFFERENT sample elsewhere in this file; see the field's doc comment).
 */
function expectAllSupplied(
  vars: Readonly<Record<string, string>>,
  ctx: NcTemplateVarContext,
  emptyOnThisSample?: readonly string[],
): void {
  const ghosts = templateVarsFor(ctx)
    .filter((d) => d.dynamic === undefined && d.name !== 'ai')
    .filter((d) => !(emptyOnThisSample ?? []).includes(d.name))
    .filter((d) => (vars[d.name] ?? '') === '')
    .map((d) => d.name)
  expect(ghosts).toEqual([])
}

// ── Rule-family entry factories ───────────────────────────────────────────

const BASE_ID = { targetId: 'tgt-1', status: 'pending' as const, attempts: 0, nextAttemptAt: 0 }
const AT = 100

/** A GROUPED detection: two people, one recognised, inside a zone — the shape
 *  needed to make `label`, `confidence`, `count` and `detectionSummary` all
 *  non-empty at once. */
function groupedPersonEntryInZone(): NcOutboxEntry {
  return {
    ...BASE_ID,
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    deviceId: 104,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    createdAt: AT,
    updatedAt: AT,
    payload: {
      ruleName: 'Persone al cancello',
      delivery: 'immediate',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: 104,
        className: 'person',
        label: 'Mario',
        labelKind: 'identity',
        confidence: 0.87,
        zones: ['zone-1'],
        timestamp: 1_753_000_000_000,
      },
      group: {
        key: 'grp-1',
        revision: 2,
        anchorTrackId: 'trk-2',
        members: [
          { trackId: 'trk-1', className: 'person', at: 1_753_000_000_000 },
          {
            trackId: 'trk-2',
            className: 'person',
            label: 'Mario',
            labelKind: 'identity',
            at: 1_753_000_000_500,
          },
        ],
      },
    },
  }
}

/** An occupancy edge: over capacity, with a zone name frozen on the edge (the
 *  admin `zones` list stays empty — zone scoping lives on the edge, not the
 *  condition, per D-occupancy in outbox.ts). */
function occupancyEntry(): NcOutboxEntry {
  return {
    ...BASE_ID,
    id: 'rule-2:occ-1:tgt-1',
    ruleId: 'rule-2',
    deviceId: 591,
    recordKind: 'device-event',
    recordId: 'occ-1',
    createdAt: AT,
    updatedAt: AT,
    payload: {
      ruleName: 'Parking pieno',
      delivery: 'device-event',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: 591,
        className: 'person',
        zones: [],
        timestamp: 1_753_000_100_000,
        occupancy: { zone: 'Parking', count: 5, capacity: 3, occupied: true },
      },
    },
  }
}

/** A LEVEL-mode sound confirmation: `hitPercent` is level-only, `labels` and
 *  `peakDbfs` are shared with label mode — see `NcOutboxAudioSubject`. */
function levelSoundEntry(): NcOutboxEntry {
  return {
    ...BASE_ID,
    id: 'rule-3:aud-1:tgt-1',
    ruleId: 'rule-3',
    deviceId: 107,
    recordKind: 'audio-window',
    recordId: 'aud-1',
    createdAt: AT,
    updatedAt: AT,
    payload: {
      ruleName: 'Rumore in garden',
      delivery: 'immediate',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: 107,
        className: 'audio-dog_bark',
        zones: [],
        timestamp: 1_753_000_200_000,
        audio: { labels: ['dog_bark', 'car_horn'], hitPercent: 42.4, peakDbfs: -17.6 },
      },
    },
  }
}

/** A doorbell press — the device's own event token, for `{{eventType}}`. */
function doorbellPressEntry(): NcOutboxEntry {
  return {
    ...BASE_ID,
    id: 'rule-4:sns-1:tgt-1',
    ruleId: 'rule-4',
    deviceId: 593,
    recordKind: 'device-event',
    recordId: 'sns-1',
    createdAt: AT,
    updatedAt: AT,
    payload: {
      ruleName: 'Campanello',
      delivery: 'device-event',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: 593,
        className: 'doorbell',
        zones: [],
        timestamp: 1_753_000_300_000,
        eventType: 'press',
      },
    },
  }
}

/**
 * The directory the samples' devices resolve through — for the intake's
 * `lookup` (the frozen `deviceName` param) and for the dispatcher's
 * `getDeviceName` (`{{camera}}`), the same two reads production makes.
 */
const DIRECTORY: ReadonlyMap<number, string> = new Map([
  [104, 'Cancello'],
  [591, 'Parking'],
  [592, 'Garden'],
  [593, 'Front door'],
  [102, 'Vialetto'],
  [700, 'Centrale allarme'],
  [701, 'Finestra porch'],
])
const lookup: NcDeviceLookup = (deviceId) => {
  const name = DIRECTORY.get(deviceId)
  return name === undefined
    ? undefined
    : { deviceId, type: DeviceType.Camera, name, isCamera: true, parentDeviceId: null }
}
const getDeviceName = async (deviceId: number): Promise<string | null> =>
  DIRECTORY.get(deviceId) ?? null
const getZoneNames = async (): Promise<readonly { id: string; name: string }[]> => [
  { id: 'zone-1', name: 'Cancello' },
]

/**
 * `buildTemplateVars` for one row, fed exactly what the dispatcher feeds it:
 * the name `notificationDeviceName` derives (never a constant — a device-less
 * system row renders the filler, and the catalog must know that) and the
 * zone labels `resolveZoneLabels` would resolve for this row.
 */
async function producedVars(
  entry: NcOutboxEntry,
  zoneLabels: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const deviceName = await notificationDeviceName(entry, getDeviceName)
  return buildTemplateVars(texts, entry, deviceName, zoneLabels, 'UTC')
}

describe('rule producer ↔ catalog', () => {
  const cases: readonly {
    readonly ctx: NcTemplateVarContext
    readonly entry: () => NcOutboxEntry
  }[] = [
    {
      ctx: { family: 'rule', field: 'body', kind: 'detection' },
      entry: () => groupedPersonEntryInZone(),
    },
    { ctx: { family: 'rule', field: 'body', kind: 'occupancy' }, entry: () => occupancyEntry() },
    { ctx: { family: 'rule', field: 'body', kind: 'sound' }, entry: () => levelSoundEntry() },
    { ctx: { family: 'rule', field: 'body', kind: 'sensor' }, entry: () => doorbellPressEntry() },
  ]
  for (const { ctx, entry } of cases) {
    it(`${ctx.kind}: declared ⇔ supplied`, async () => {
      // Real admin zones only ever reach `buildTemplateVars` on a DETECTION
      // row: `subjectFromSensorEvent` / `subjectFromAudioWindow` /
      // `subjectFromOccupancyEvent` (rule-engine.ts) hard-code `zones: []`,
      // and `resolveZoneLabels` short-circuits an empty id list to `[]` — so
      // every OTHER kind's caller passes `[]` in production. A fixed
      // non-empty list for every kind would manufacture a `zones`/`inZones`
      // ghost that no real row can produce.
      const zoneLabels = ctx.kind === 'detection' ? ['Gate'] : []
      const vars = await producedVars(entry(), zoneLabels)
      // The rule producer emits every key on every row (empty where it has
      // nothing), so only the NON-EMPTY keys must be declared for this kind.
      const nonEmpty = Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== ''))
      expectAllDeclared(nonEmpty, ctx)
      expectAllSupplied(vars, ctx)
    })
  }
})

// ── System rows, built by the REAL intake ─────────────────────────────────

const SYS_AT = 1_753_000_400_000

/** A bus event, as `incomingFromSystemEvent` receives it. */
function bus(category: string, data: Record<string, unknown>): SystemEvent {
  return {
    id: `evt-${category}-${String(Object.keys(data).length)}`,
    timestamp: new Date(SYS_AT),
    source: { type: 'core', id: 'hub' },
    category,
    data,
  }
}

function fromBus(category: string, data: Record<string, unknown>): NcIncomingEvent | null {
  return incomingFromSystemEvent(bus(category, data), lookup)
}

const FACTS: NcSystemEventFacts = {
  eventId: 'band-1',
  timestamp: SYS_AT,
  category: 'device.state-changed',
  data: {},
}

const PANEL = 700
const COVERAGE: NcAlarmModeCoverage = {
  mode: 'away',
  ruleCount: 2,
  allDevices: false,
  allDevicesExcept: [],
  deviceIds: [104, 102],
  skippedDevices: [{ deviceId: 102, reason: 'offline' }],
}
const nameOf = (deviceId: number): string => DIRECTORY.get(deviceId) ?? String(deviceId)

function alarm(
  transition: NcAlarmTransition,
  body?: NcArmAnnouncementText,
): NcIncomingEvent | null {
  return incomingFromAlarmTransition({
    transition,
    panelDeviceId: PANEL,
    lookup,
    ...(body !== undefined ? { body } : {}),
  })
}

/** One system-row sample: a label for the test name and the intake call. */
interface SystemSample {
  readonly name: string
  readonly build: () => NcIncomingEvent | null
}

/**
 * One sample per intake BRANCH that changes which params are frozen — every
 * builder event-intake.ts exports or dispatches to, fed the shape its own
 * producer emits. The kind each one covers is read off the result, never
 * typed here, so a builder that starts producing a different kind moves its
 * sample with it.
 */
const SYSTEM_SAMPLES: readonly SystemSample[] = [
  { name: 'device.offline', build: () => fromBus('device.offline', { deviceId: 102 }) },
  { name: 'device.online', build: () => fromBus('device.online', { deviceId: 102 }) },
  {
    name: 'device.state-changed (offline)',
    build: () =>
      fromBus('device.state-changed', {
        deviceId: 102,
        capName: 'device-status',
        slice: { online: false },
      }),
  },
  { name: 'device.disabled', build: () => fromBus('device.disabled', { deviceId: 102 }) },
  { name: 'device.enabled', build: () => fromBus('device.enabled', { deviceId: 102 }) },
  {
    name: 'battery low (measured)',
    build: () =>
      incomingFromBatteryBand({
        facts: FACTS,
        deviceId: 102,
        band: 'low',
        reading: { percentage: 14.6, lastUpdated: SYS_AT },
        identity: lookup(102),
      }),
  },
  {
    name: 'battery normal (binary)',
    build: () =>
      incomingFromBatteryBand({
        facts: FACTS,
        deviceId: 102,
        band: 'normal',
        reading: { percentage: 100, lastUpdated: SYS_AT, binary: true },
        identity: lookup(102),
      }),
  },
  {
    name: 'battery normal (measured)',
    build: () =>
      incomingFromBatteryBand({
        facts: FACTS,
        deviceId: 102,
        band: 'normal',
        reading: { percentage: 64, lastUpdated: SYS_AT },
        identity: lookup(102),
      }),
  },
  {
    name: 'consumable low (measured)',
    build: () =>
      incomingFromConsumableBand({
        facts: FACTS,
        deviceId: 102,
        band: 'low',
        item: { key: 'filter', label: 'Filtro', level: 8, status: 'replace' },
        thresholdPercent: 15,
        identity: lookup(102),
      }),
  },
  {
    name: 'consumable normal (unmeasured)',
    build: () =>
      incomingFromConsumableBand({
        facts: FACTS,
        deviceId: 102,
        band: 'normal',
        item: { key: 'brush', label: 'Spazzola', level: null, status: 'ok' },
        thresholdPercent: 15,
        identity: lookup(102),
      }),
  },
  {
    name: 'consumable normal (measured)',
    build: () =>
      incomingFromConsumableBand({
        facts: FACTS,
        deviceId: 102,
        band: 'normal',
        item: { key: 'filter', label: 'Filtro', level: 100, status: 'ok' },
        thresholdPercent: 15,
        identity: lookup(102),
      }),
  },
  {
    name: 'consumable tank low (clean water)',
    build: () =>
      incomingFromProviderConsumableBand({
        facts: FACTS,
        deviceId: 102,
        band: 'low',
        item: { key: 'cleanWater', label: 'Clean water', form: 'tank' },
        attention: 'low',
        identity: lookup(102),
      }),
  },
  {
    name: 'consumable bin full (dust bin)',
    build: () =>
      incomingFromProviderConsumableBand({
        facts: FACTS,
        deviceId: 102,
        band: 'low',
        item: { key: 'dustBin', label: 'Dust bin', form: 'bin' },
        attention: 'full',
        identity: lookup(102),
      }),
  },
  {
    name: 'consumable tank recovered (dirty water)',
    build: () =>
      incomingFromProviderConsumableBand({
        facts: FACTS,
        deviceId: 102,
        band: 'normal',
        item: { key: 'dirtyWater', label: 'Dirty water', form: 'tank' },
        attention: 'low',
        identity: lookup(102),
      }),
  },
  {
    name: 'stream.offline (profiled)',
    build: () =>
      fromBus('stream.offline', {
        deviceId: 102,
        camStreamId: 'cam-102-main',
        profile: 'high',
        reason: 'stale-timeout',
      }),
  },
  {
    name: 'stream.online',
    build: () =>
      fromBus('stream.online', { deviceId: 102, camStreamId: 'cam-102-main', reason: 'recovered' }),
  },
  {
    name: 'stream.online (profiled)',
    build: () =>
      fromBus('stream.online', {
        deviceId: 102,
        camStreamId: 'cam-102-main',
        profile: 'high',
        reason: 'recovered',
      }),
  },
  { name: 'agent.offline', build: () => fromBus('agent.offline', { agentId: 'agent-a' }) },
  { name: 'agent.online', build: () => fromBus('agent.online', { agentId: 'mac-mini' }) },
  {
    // What the node hold-off hands the rule engine on a recovery whose outage
    // start it saw (D820): the display name and `{{offlineFor}}`.
    name: 'agent.online (recovery after the hold-off)',
    build: () => {
      const incoming = fromBus('agent.online', { agentId: 'mac-mini' })
      return incoming === null
        ? null
        : withNodeLivenessFacts(incoming, {
            timing: { since: 3_600_000, previousSince: 0 },
            nodeName: 'Mac mini',
          })
    },
  },
  {
    name: 'agent.offline (connection lost)',
    build: () => fromBus('agent.offline', { agentId: 'agent-a', reason: 'connection-lost' }),
  },
  {
    name: 'pipeline.node-inference-unavailable',
    build: () =>
      fromBus('pipeline.node-inference-unavailable', {
        nodeId: 'agent-a',
        unavailableDeviceKeys: ['Vialetto', 'Cancello'],
      }),
  },
  {
    name: 'addon.runner-failed',
    build: () =>
      fromBus('addon.runner-failed', {
        nodeId: 'hub',
        runnerId: 'recorder',
        crashesInWindow: 3,
        addonIds: ['recorder'],
      }),
  },
  {
    name: 'pipeline.detection-blind',
    build: () =>
      fromBus('pipeline.detection-blind', {
        deviceId: 102,
        blindForMs: 720_000,
        motionMs: 720_000,
        sessions: 4,
        belowFloor: 0,
      }),
  },
  {
    name: 'pipeline.motion-noisy',
    build: () =>
      fromBus('pipeline.motion-noisy', {
        deviceId: 102,
        windowMs: 3_600_000,
        dutyPct: 55,
        sessions: 96,
      }),
  },
  {
    name: 'pipeline.motion-calm',
    build: () =>
      fromBus('pipeline.motion-calm', {
        deviceId: 102,
        windowMs: 3_600_000,
        dutyPct: 8,
        sessions: 5,
      }),
  },
  {
    name: 'pipeline.package-llm-silent',
    build: () =>
      fromBus('pipeline.package-llm-silent', {
        deviceId: 102,
        reason: 'timeout',
        latencyMs: 8_000,
      }),
  },
  {
    name: 'pipeline.package-llm-answered',
    build: () => fromBus('pipeline.package-llm-answered', { deviceId: 102 }),
  },
  {
    name: 'recording.health.stalled',
    build: () =>
      fromBus('recording.health.stalled', {
        deviceId: 102,
        idleMs: 300_000,
        thresholdMs: 300_000,
      }),
  },
  {
    name: 'recording.health.ok',
    build: () => fromBus('recording.health.ok', { deviceId: 102 }),
  },
  {
    name: 'recording.health.degraded',
    build: () =>
      fromBus('recording.health.degraded', {
        deviceId: 102,
        message: 'writer restart budget exhausted',
      }),
  },
  {
    name: 'storage.location.low',
    build: () =>
      fromBus('storage.location.low', {
        locationId: 'recordings:default',
        nodeId: 'hub',
        locationName: 'Recordings',
        freePercent: 12,
        reason: 'low',
      }),
  },
  {
    name: 'storage.location.critical',
    build: () =>
      fromBus('storage.location.critical', {
        locationId: 'recordings:default',
        nodeId: 'hub',
        locationName: 'Recordings',
        freePercent: null,
        reason: 'capacity-unreadable',
      }),
  },
  {
    name: 'storage.location.ok',
    build: () =>
      fromBus('storage.location.ok', {
        locationId: 'recordings:default',
        nodeId: 'hub',
        locationName: 'Recordings',
      }),
  },
  {
    name: 'notification.rule-broken',
    build: () =>
      fromBus('notification.rule-broken', {
        ruleId: 'r-robot',
        ruleName: 'Robot',
        reason: 'device-deleted',
        reasons: [{ code: 'device-deleted', ids: ['4483'] }],
        offendingIds: ['4483'],
      }),
  },
  {
    name: 'notification.rule-repaired',
    build: () => fromBus('notification.rule-repaired', { ruleId: 'r-robot', ruleName: 'Robot' }),
  },
  {
    // TWO nodes: the intake names them through `{{nodes}}`, and leaves
    // `{{nodeId}}` / `{{node}}` unset — the one-node sample below fills those.
    name: 'update.available (addon, two nodes)',
    build: () =>
      fromBus('update.available', {
        target: 'addon',
        packages: [
          {
            packageName: '@camstack/addon-recorder',
            currentVersion: '1.2.377',
            latestVersion: '1.2.378',
            nodeId: 'hub',
          },
          {
            packageName: '@camstack/addon-notifier',
            currentVersion: '2.0.1',
            latestVersion: '2.0.2',
            nodeId: 'agent-a',
          },
        ],
      }),
  },
  {
    name: 'update.available (addon, one node)',
    build: () =>
      fromBus('update.available', {
        target: 'addon',
        packageName: '@camstack/addon-recorder',
        currentVersion: '1.2.377',
        latestVersion: '1.2.378',
        nodeId: 'hub',
      }),
  },
  {
    name: 'update.available (server, one node)',
    build: () =>
      fromBus('update.available', {
        target: 'server',
        packageName: '@camstack/server',
        currentVersion: '1.0.10',
        latestVersion: '1.0.11',
        nodeId: 'hub',
      }),
  },
  {
    name: 'update.available (server, two nodes)',
    build: () =>
      fromBus('update.available', {
        target: 'server',
        packages: [
          {
            packageName: '@camstack/server',
            currentVersion: '1.0.10',
            latestVersion: '1.0.11',
            nodeId: 'hub',
          },
          {
            packageName: '@camstack/server',
            currentVersion: '1.0.10',
            latestVersion: '1.0.11',
            nodeId: 'agent-a',
          },
        ],
      }),
  },
  {
    name: 'update.available (wrapper)',
    build: () =>
      fromBus('update.available', {
        target: 'wrapper',
        wrapperKind: 'docker',
        packageName: 'camstack/hub',
        currentVersion: '2026.09.01',
        latestVersion: '2026.09.20',
        nodeId: 'hub',
      }),
  },
  {
    name: 'addon.updated',
    build: () =>
      fromBus('addon.updated', {
        packageName: '@camstack/addon-recorder',
        fromVersion: '1.2.377',
        toVersion: '1.2.378',
        nodeId: 'hub',
      }),
  },
  {
    name: 'system.restart-completed (framework update)',
    build: () =>
      fromBus('system.restart-completed', {
        kind: 'framework-update',
        fromVersion: '1.0.10',
        toVersion: '1.0.11',
        nodeId: 'hub',
      }),
  },
  {
    name: 'system.restarting (plain restart)',
    build: () =>
      fromBus('system.restarting', { kind: 'manual', requestedAt: 1, nodeId: 'agent-a' }),
  },
  {
    name: 'system.restarting (framework update)',
    build: () =>
      fromBus('system.restarting', {
        kind: 'framework-update',
        requestedAt: 1,
        packageName: '@camstack/server',
        fromVersion: '1.0.10',
        toVersion: '1.0.11',
        nodeId: 'agent-a',
      }),
  },
  {
    name: 'recording.export.completed (camera, titled)',
    build: () =>
      fromBus('recording.export.completed', {
        exportId: 'exp-1',
        deviceId: 102,
        title: 'Vialetto 08:00',
        fileBytes: 10_485_760,
      }),
  },
  {
    name: 'recording.export.completed (no camera)',
    build: () => fromBus('recording.export.completed', { exportId: 'exp-2' }),
  },
  {
    name: 'backup.run-completed (partial)',
    build: () =>
      fromBus('backup.run-completed', {
        destinationsOk: 2,
        destinationsTotal: 3,
        sizeMB: 412,
        backupId: 'bk-20260924',
      }),
  },
  {
    name: 'alert episode raised (critical, on a node, with an action link)',
    build: () =>
      fromBus('alert.episode', {
        phase: 'raised',
        episodeId: 'runner:hub:recorder@1',
        alertId: 'runner:hub:recorder',
        severity: 'critical',
        category: 'addon.runner-failed',
        title: 'Addon crash loop',
        message: 'Runner "recorder" gave up after 5 crashes',
        sourceType: 'core',
        sourceId: 'recorder',
        nodeId: 'hub',
        actionUrl: '/system/addons',
        at: SYS_AT,
      }),
  },
  {
    name: 'alert episode raised (error, on a node)',
    build: () =>
      fromBus('alert.episode', {
        phase: 'raised',
        episodeId: 'x@1',
        alertId: 'x',
        severity: 'error',
        category: 'x',
        title: 'Something broke',
        message: 'It broke',
        sourceType: 'addon',
        sourceId: 'x',
        nodeId: 'hub',
        actionUrl: '/system/addons',
        at: SYS_AT,
      }),
  },
  {
    name: 'alert episode raised (critical, bare)',
    build: () =>
      fromBus('alert.episode', {
        phase: 'raised',
        episodeId: 'y@1',
        alertId: 'y',
        severity: 'critical',
        category: 'y',
        title: 'Something broke',
        message: 'It broke',
        at: SYS_AT,
      }),
  },
  {
    name: 'alert episode resolved (critical)',
    build: () =>
      fromBus('alert.episode', {
        phase: 'resolved',
        episodeId: 'runner:hub:recorder@1',
        alertId: 'runner:hub:recorder',
        severity: 'critical',
        category: 'addon.runner-failed',
        title: 'Addon crash loop',
        message: 'Runner "recorder" gave up after 5 crashes',
        sourceType: 'core',
        sourceId: 'recorder',
        nodeId: 'hub',
        actionUrl: '/system/addons',
        at: SYS_AT,
      }),
  },
  {
    name: 'device attention raised (critical alert about a device)',
    build: () =>
      fromBus('alert.episode', {
        phase: 'raised',
        episodeId: 'dreame.pin-required:101@1',
        alertId: 'dreame.pin-required:101',
        severity: 'critical',
        category: 'device.credentials-required',
        title: 'Camera PIN required',
        message: 'The device needs its camera PIN before its video can open.',
        sourceType: 'device',
        sourceId: '101',
        actionUrl: '/devices/101',
        at: SYS_AT,
      }),
  },
  {
    name: 'device attention resolved',
    build: () =>
      fromBus('alert.episode', {
        phase: 'resolved',
        episodeId: 'dreame.pin-required:101@1',
        alertId: 'dreame.pin-required:101',
        severity: 'critical',
        category: 'device.credentials-required',
        title: 'Camera PIN required',
        message: 'The device needs its camera PIN before its video can open.',
        sourceType: 'device',
        sourceId: '101',
        actionUrl: '/devices/101',
        at: SYS_AT,
      }),
  },
  {
    name: 'alarm armed (devices, one skipped)',
    build: () =>
      alarm(
        { kind: 'alarm-armed', state: 'armed_away', previous: 'arming', mode: 'away', at: SYS_AT },
        buildArmAnnouncement(COVERAGE, nameOf),
      ),
  },
  {
    name: 'alarm armed (bypass)',
    build: () =>
      alarm(
        { kind: 'alarm-armed', state: 'armed_away', previous: 'arming', mode: 'away', at: SYS_AT },
        buildArmAnnouncement(COVERAGE, nameOf, [701]),
      ),
  },
  {
    name: 'alarm arming (devices, one skipped)',
    build: () =>
      alarm(
        {
          kind: 'alarm-arming',
          state: 'arming',
          previous: 'disarmed',
          mode: 'away',
          at: SYS_AT,
          seconds: 30,
        },
        buildArmingAnnouncement(COVERAGE, 30, nameOf),
      ),
  },
  {
    name: 'alarm arming (all skipped)',
    build: () =>
      alarm(
        {
          kind: 'alarm-arming',
          state: 'arming',
          previous: 'disarmed',
          mode: 'away',
          at: SYS_AT,
          seconds: 30,
        },
        buildArmingAnnouncement(
          { ...COVERAGE, deviceIds: [102], skippedDevices: [{ deviceId: 102, reason: 'offline' }] },
          30,
          nameOf,
        ),
      ),
  },
  {
    name: 'alarm arming (bypass)',
    build: () =>
      alarm(
        {
          kind: 'alarm-arming',
          state: 'arming',
          previous: 'disarmed',
          mode: 'away',
          at: SYS_AT,
          seconds: 30,
        },
        buildArmingAnnouncement(COVERAGE, 30, nameOf, [701]),
      ),
  },
  {
    name: 'alarm arm refused',
    build: () =>
      alarm(
        {
          kind: 'alarm-arm-refused',
          state: 'disarmed',
          previous: 'disarmed',
          mode: 'away',
          at: SYS_AT,
        },
        buildArmRefusedAnnouncement('away', ['Finestra porch'], true),
      ),
  },
  {
    name: 'alarm disarmed',
    build: () =>
      alarm({ kind: 'alarm-disarmed', state: 'disarmed', previous: 'armed_away', at: SYS_AT }),
  },
  {
    name: 'alarm disarmed (defused a siren)',
    build: () =>
      alarm({ kind: 'alarm-disarmed', state: 'disarmed', previous: 'triggered', at: SYS_AT }),
  },
  {
    name: 'alarm pending (manual)',
    build: () =>
      alarm({
        kind: 'alarm-pending',
        state: 'pending',
        previous: 'armed_away',
        mode: 'away',
        seconds: 20,
        at: SYS_AT,
      }),
  },
  {
    name: 'alarm pending (started by a rule)',
    build: () =>
      alarm({
        kind: 'alarm-pending',
        state: 'pending',
        previous: 'armed_away',
        mode: 'away',
        seconds: 20,
        at: SYS_AT,
        source: {
          ruleId: 'rule-9',
          ruleName: 'Contatti',
          deviceId: 104,
          sourceDeviceId: 701,
          recordId: 'sr-9',
          timestamp: SYS_AT,
        },
      }),
  },
  {
    name: 'alarm re-armed after a bounded siren',
    build: () =>
      alarm({
        kind: 'alarm-rearmed',
        state: 'armed_away',
        previous: 'triggered',
        mode: 'away',
        at: SYS_AT,
      }),
  },
  {
    name: 'alarm sensor bypass (trigger ignored)',
    build: () =>
      alarm({
        kind: 'alarm-sensor-bypass',
        state: 'armed_away',
        previous: 'armed_away',
        at: SYS_AT,
        sensor: { deviceId: 701, event: 'ignored' },
      }),
  },
  {
    name: 'alarm sensor bypass (exclusion lifted)',
    build: () =>
      alarm({
        kind: 'alarm-sensor-bypass',
        state: 'armed_away',
        previous: 'armed_away',
        at: SYS_AT,
        sensor: { deviceId: 701, event: 'lifted' },
      }),
  },
  {
    name: 'alarm check failed (armed without reading the openings)',
    build: () =>
      alarm({
        kind: 'alarm-check-failed',
        state: 'disarmed',
        previous: 'disarmed',
        mode: 'away',
        at: SYS_AT,
      }),
  },
  {
    name: 'alarm triggered (manual)',
    build: () =>
      alarm({ kind: 'alarm-triggered', state: 'triggered', previous: 'armed_away', at: SYS_AT }),
  },
  {
    // The COMBINED row: the triggering rule's detection vocabulary.
    name: 'alarm triggered (by a detection rule)',
    build: () =>
      alarm({
        kind: 'alarm-triggered',
        state: 'triggered',
        previous: 'armed_away',
        at: SYS_AT,
        source: {
          ruleId: 'rule-9',
          ruleName: 'Cancello di notte',
          deviceId: 104,
          recordId: 'ev-9',
          timestamp: SYS_AT,
          className: 'person',
          label: 'Mario',
          zones: ['zone-1'],
          confidence: 0.91,
        },
      }),
  },
]

/** Freeze an intake subject as `NotificationCenter.buildEntries` (index.ts)
 *  does for a system event: no class (the `'event'` filler), no admin zones. */
function entryFromIncoming(incoming: NcIncomingEvent): NcOutboxEntry {
  const subject = incoming.subject
  return {
    ...BASE_ID,
    id: `rule-sys:${subject.recordId}:tgt-1`,
    ruleId: 'rule-sys',
    deviceId: subject.deviceId,
    recordKind: 'system-event',
    recordId: subject.recordId,
    createdAt: AT,
    updatedAt: AT,
    payload: {
      ruleName: 'Avvisi di sistema',
      delivery: 'system-event',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: subject.deviceId,
        className: subject.classNames[0] ?? subject.sensorKind ?? 'event',
        zones: [],
        timestamp: subject.timestamp,
        ...(subject.systemEvent !== undefined ? { systemEvent: subject.systemEvent } : {}),
      },
    },
  }
}

/** The zone labels the dispatcher resolves for a system row (dispatcher.ts
 *  `buildNotification`): only a combined alarm row has any. */
async function systemZoneLabels(entry: NcOutboxEntry): Promise<readonly string[]> {
  const source = entry.payload.subject.systemEvent?.alarmSource
  return source?.zones !== undefined && source.zones.length > 0
    ? resolveZoneLabels(getZoneNames, source.deviceId, source.zones)
    : []
}

/**
 * Keys the rule producer fills on a system row that the catalog must NEVER
 * offer there — named, never a silent skip.
 *
 *  - `deviceName` on `export-completed`: the intake freezes no name for an
 *    export (only `deviceId`), so the value is the dispatcher's IN-FLIGHT ROW
 *    RESCUE — the id as a string, meant for rows enqueued before the catalog
 *    named devices. `{{camera}}` is the export's name.
 *
 *  - `subject`: on a system row it is the event's DEDUP SLOT key
 *    (`battery:102`, `node:hub`, `alarm:700`), never a composed sentence — see
 *    the comment above the `subject` descriptor (template-vars.ts). The one
 *    exception, the combined alarm row, composes a real sentence, but a rule
 *    watching `alarm-triggered` cannot tell which it will get.
 *  - `camera` ONLY when it carries the device-less filler
 *    ({@link NC_DEVICELESS_CAMERA_NAME}) — the catalog narrows `{{camera}}` to
 *    the device-carrying kinds for exactly this reason.
 */
function offeredOnSystemRow(kind: NcSystemEventKind, name: string, value: string): boolean {
  if (name === 'subject') return false
  if (name === 'deviceName' && kind === 'export-completed') return false
  if (name === 'camera' && value === NC_DEVICELESS_CAMERA_NAME) return false
  return true
}

/**
 * Authorable kinds that exist in the schema but have NO producer yet, so no
 * real-intake sample can be built for them. Every entry is a debt with an
 * owner, never a skip — the guard below fails the moment a listed kind gains a
 * sample, so an entry cannot outlive its producer. EMPTY since alarm revamp
 * Task 8 (D630) produced the last four alarm kinds.
 */
const KINDS_AWAITING_PRODUCER: readonly NcSystemEventKind[] = []

/** The authorable kinds this file can hold to parity today. */
const PRODUCED_SYSTEM_EVENT_KINDS: readonly NcSystemEventKind[] =
  NC_AUTHORABLE_SYSTEM_EVENT_KINDS.filter((k) => !KINDS_AWAITING_PRODUCER.includes(k))

describe('system rows built by the real intake ↔ catalog', () => {
  const built = SYSTEM_SAMPLES.map(({ name, build }) => {
    const incoming = build()
    const kind = incoming?.subject.systemEvent?.kind
    return { name, incoming, kind }
  })

  it('every sample is accepted by its intake builder', () => {
    expect(built.filter((b) => b.kind === undefined).map((b) => b.name)).toEqual([])
  })

  it('every authorable system kind has at least one sample', () => {
    const covered = new Set(built.map((b) => b.kind))
    expect(PRODUCED_SYSTEM_EVENT_KINDS.filter((k) => !covered.has(k))).toEqual([])
  })

  it('KINDS_AWAITING_PRODUCER holds only authorable kinds that still have no sample', () => {
    const covered = new Set(built.map((b) => b.kind))
    for (const kind of KINDS_AWAITING_PRODUCER) {
      expect(NC_AUTHORABLE_SYSTEM_EVENT_KINDS).toContain(kind)
      expect(covered.has(kind)).toBe(false)
    }
  })

  for (const { name, incoming, kind } of built) {
    it(`${name}: every non-empty variable is declared for its kind`, async () => {
      if (incoming === null || kind === undefined) throw new Error(`${name}: no subject`)
      const entry = entryFromIncoming(incoming)
      const vars = await producedVars(entry, await systemZoneLabels(entry))
      const offered = Object.fromEntries(
        Object.entries(vars).filter(([n, v]) => v !== '' && offeredOnSystemRow(kind, n, v)),
      )
      expectAllDeclared(offered, {
        family: 'rule',
        field: 'body',
        kind: 'system',
        systemEventKinds: [kind],
      })
    })
  }

  // No GHOST, judged per KIND over all of its samples: an intake that picks
  // between two branches (one node vs several, measured vs binary) fills a
  // declared variable on one of them, and that is what "supplied" means.
  for (const kind of PRODUCED_SYSTEM_EVENT_KINDS) {
    it(`${kind}: every declared variable is filled by some sample`, async () => {
      const filled = new Set<string>()
      for (const b of built.filter((s) => s.kind === kind)) {
        if (b.incoming === null) continue
        const entry = entryFromIncoming(b.incoming)
        const vars = await producedVars(entry, await systemZoneLabels(entry))
        for (const [n, v] of Object.entries(vars)) {
          if (v !== '' && offeredOnSystemRow(kind, n, v)) filled.add(n)
        }
      }
      const ghosts = templateVarsFor({
        family: 'rule',
        field: 'body',
        kind: 'system',
        systemEventKinds: [kind],
      })
        .filter((d) => d.dynamic === undefined && d.name !== 'ai')
        .map((d) => d.name)
        .filter((n) => !filled.has(n))
      expect(ghosts).toEqual([])
    })
  }
})

const NIGHT_TRACKS = [
  { firstSeen: 1, lastSeen: 2, className: 'person' },
  { firstSeen: 1, lastSeen: 2, className: 'person' },
  { firstSeen: 1, lastSeen: 2, className: 'car' },
] as const

function timelapseInputWithPersonAndCar(catalog: NcTextCatalog): TimelapseDeliveryInput {
  const window = { startMs: Date.UTC(2026, 8, 24, 20), endMs: Date.UTC(2026, 8, 25, 6) }
  return {
    texts: catalog,
    ruleId: 'tl-1',
    ruleName: 'Notte in garden',
    deviceId: 1441,
    deviceName: 'Garden',
    window,
    targets: [],
    priority: 3,
    coverage: footageCoverage(
      [{ startMs: window.startMs, endMs: window.endMs }],
      window.startMs,
      window.endMs,
    ),
    exportId: 'exp-1',
    denseRanges: 2,
    generatedAt: window.endMs + 300_000,
    detections: countDetections({ tracks: [...NIGHT_TRACKS] }),
  }
}

function summaryInputWithPersonAndCar(catalog: NcTextCatalog): SummaryDeliveryInput {
  const window = { startMs: Date.UTC(2026, 8, 24, 20), endMs: Date.UTC(2026, 8, 24, 22) }
  return {
    texts: catalog,
    ruleId: 'sm-1',
    ruleName: 'Digest serale',
    window,
    deviceIds: [104, 591],
    primaryDeviceId: 104,
    targets: [],
    priority: 3,
    tileCount: 5,
    cameraCount: 2,
    matchedCount: 8,
    generatedAt: window.endMs + 60_000,
    detections: countDetections({ tracks: [...NIGHT_TRACKS] }),
  }
}

describe('timelapse and digest producers ↔ catalog', () => {
  it('timelapse body', () => {
    const vars = timelapseTemplateVars(timelapseInputWithPersonAndCar(texts))
    expectAllDeclared(vars, { family: 'timelapse', field: 'body' })
    expectAllSupplied(vars, { family: 'timelapse', field: 'body' })
  })
  it('summary body', () => {
    const vars = summaryTemplateVars(summaryInputWithPersonAndCar(texts))
    expectAllDeclared(vars, { family: 'summary', field: 'body' })
    expectAllSupplied(vars, { family: 'summary', field: 'body' })
  })
})

/**
 * ONE `{{time}}` is declared for all three families ("in the notification
 * language"), so all three producers must render it through `ncClockText` —
 * the timelapse and digest producers used to print a host-24h `HH:MM` of
 * their own. The AM/PM marker is time-zone independent, which is what makes
 * the English half discriminating on any host.
 */
describe('{{time}} is in the notification language in every family', () => {
  const en = new NcTextCatalog({ language: 'en' })
  const it_ = new NcTextCatalog({ language: 'it' })
  const ENGLISH_CLOCK = /^\d{2}:\d{2}\s?(AM|PM)$/
  const ITALIAN_CLOCK = /^\d{2}:\d{2}$/

  it('rule', () => {
    const entry = groupedPersonEntryInZone()
    const at = entry.payload.subject.timestamp
    expect(buildTemplateVars(en, entry, 'Cancello', [], 'UTC')['time']).toMatch(ENGLISH_CLOCK)
    expect(buildTemplateVars(it_, entry, 'Cancello', [], 'UTC')['time']).toBe(
      ncClockText('it', at, 'UTC'),
    )
  })

  it('timelapse', () => {
    const enInput = timelapseInputWithPersonAndCar(en)
    expect(timelapseTemplateVars(enInput)['time']).toMatch(ENGLISH_CLOCK)
    expect(timelapseTemplateVars(enInput)['time']).toBe(ncClockText('en', enInput.generatedAt))
    expect(timelapseTemplateVars(timelapseInputWithPersonAndCar(it_))['time']).toMatch(
      ITALIAN_CLOCK,
    )
  })

  it('summary', () => {
    const enInput = summaryInputWithPersonAndCar(en)
    expect(summaryTemplateVars(enInput)['time']).toMatch(ENGLISH_CLOCK)
    expect(summaryTemplateVars(enInput)['time']).toBe(ncClockText('en', enInput.generatedAt))
    expect(summaryTemplateVars(summaryInputWithPersonAndCar(it_))['time']).toMatch(ITALIAN_CLOCK)
  })
})

/**
 * D647 — the STATE SUMMARY row. Built by the real producer
 * (`stateSummaryText` → `stateSummarySubject`) with one open item in EVERY
 * section, and rendered by the real `buildTemplateVars`: every non-empty
 * variable is declared for a summary rule, and every declared summary
 * variable is filled.
 */
describe('state-summary rows ↔ catalog (D647)', () => {
  const sections: NcStateSummary['sections'] = NC_STATE_SUMMARY_SECTION_IDS.map((id) => ({
    id,
    status: 'read' as const,
    items: [
      {
        section: id,
        subject: { kind: 'device-offline' as const, subject: `s:${id}`, data: {} },
        lineKey: 'summary.line.device-offline',
        params: { deviceName: `item of ${id}` },
        since: AT - 60_000,
      },
    ],
  }))
  const summary: NcStateSummary = {
    sections,
    itemCount: sections.length,
    unavailableCount: 0,
    dropped: {},
    excludedGroups: [],
  }
  const rule = NcRuleSchema.parse({
    id: 'rule-state',
    name: 'Stato',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: ['device-battery-low'] } },
    targets: [{ targetId: 'tgt-1' }],
    createdBy: 'admin',
    createdAt: AT,
    updatedAt: AT,
  })
  const window = { startMs: AT - 60_000, endMs: AT }
  const text = stateSummaryText({ texts, summary, nowMs: AT, timeZone: 'UTC' })
  const subject = stateSummarySubject({ rule, summary, text, window })
  const ctx: NcTemplateVarContext = {
    family: 'rule',
    field: 'body',
    kind: 'device-events',
    systemEventKinds: [
      'device-battery-low',
      'stream-offline',
      'node-offline',
      'addon-crash-loop',
      'addon-update-available',
      'server-update-available',
      'device-offline',
      'device-consumable-low',
      'detection-blind',
    ],
    systemEventDelivery: 'summary',
  }

  it('every non-empty variable is declared for a summary rule, and every declared one is filled', async () => {
    if (subject === null) throw new Error('no subject')
    const entry = entryFromIncoming({
      subject,
      kind: 'system-event',
      origin: 'system',
      log: () => ({ tags: {}, meta: {} }),
    })
    const vars = await producedVars(entry, [])
    const offered = Object.fromEntries(
      Object.entries(vars).filter(
        ([n, v]) => v !== '' && offeredOnSystemRow('device-battery-low', n, v),
      ),
    )
    expect(offered['eventKind']).toBeUndefined()
    expectAllDeclared(offered, ctx)
    const ghosts = templateVarsFor(ctx)
      .filter((d) => d.dynamic === undefined && d.name !== 'ai')
      .map((d) => d.name)
      .filter((n) => offered[n] === undefined)
    expect(ghosts).toEqual([])
  })

  it('a per-SECTION row (D698) fills only declared variables, its section named', async () => {
    const rows = stateSummarySubjects({ rule, summary, text, window, split: 'section' })
    expect(rows).toHaveLength(NC_STATE_SUMMARY_SECTION_IDS.length)
    for (const row of rows) {
      const entry = entryFromIncoming({
        subject: row,
        kind: 'system-event',
        origin: 'system',
        log: () => ({ tags: {}, meta: {} }),
      })
      const vars = await producedVars(entry, [])
      const offered = Object.fromEntries(
        Object.entries(vars).filter(
          ([n, v]) => v !== '' && offeredOnSystemRow('device-battery-low', n, v),
        ),
      )
      expectAllDeclared(offered, ctx)
      expect(offered['summarySection']).toBeDefined()
      expect(offered['summaryText']).toBeDefined()
    }
  })
})
