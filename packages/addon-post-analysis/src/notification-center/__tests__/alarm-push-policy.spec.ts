/**
 * D706 end to end: the operator's alarm notification policy (decided 2026-10-06), on the REAL
 * panel, the REAL centre, the real outbox, dispatcher and button minter.
 *
 * The reference is the 2026-10-05 14:10 incident: Away armed, entry delay 30 s, re-arm after
 * 10 s, ELEVEN pushes in 54 seconds. The replay below rebuilds its shape — a bypassed door that
 * closed and opened again (it rejoins the watch AND starts the entry delay), three people on
 * two cameras during the delay, one more after the alarm triggered, the re-arm, and a new
 * entry delay 54 s in — and pins the EXACT push list under each policy:
 *
 *   before D706 (11): watched-again · door rule · entry delay · 3× person rule · ALARM ·
 *                     person rule · re-armed · person rule · entry delay
 *   default (5):      entry delay · ALARM (all locations) · intrusion · re-armed · entry delay
 *
 * Every numbered behaviour of the policy has its own case, each one revert-checked (removing
 * the gate it pins makes it fail — see the ADR's Enforcement).
 */

import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import {
  type AlarmArmMode,
  DeviceType,
  type IScopedLogger,
  NcRuleInputSchema,
  type ObjectEvent,
  type SensorEvent,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  makePanelContext,
  type NcTestLogLine,
  TEST_PANEL_ID,
} from '../alarm/__tests__/panel-test-context.js'
import type { NcAlarmOpenDevice } from '../alarm/alarm-arm-guard.js'
import { NcAlarmPanelDevice } from '../alarm/alarm-panel-device.js'
import { ncAlarmPanelPort } from '../alarm/alarm-panel-port.js'
import { buildActionUrl } from '../action-token.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { readOutboxGroup } from '../grouped/grouped-payload.js'
import { NotificationCenter } from '../index.js'
import { type NcOutboxEntry, rowToEntry } from '../outbox.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { type LoggedLine, makeLogRecorder } from './grouped-harness.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const T0 = Date.UTC(2026, 9, 5, 12, 10, 0)
const PANEL_ID = TEST_PANEL_ID
/** The bypassed door: open when Away was armed, closed, then opened at 14:10:00. */
const DOOR = 3243
const HALL_CAM = 101
const LIVING_CAM = 102

const NAMES: Readonly<Record<number, string>> = {
  [DOOR]: 'Porta front door',
  [HALL_CAM]: 'Cam hallway',
  [LIVING_CAM]: 'Cam hall',
}

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-phone', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
]

const DOOR_OPEN: NcAlarmOpenDevice = {
  deviceId: DOOR,
  name: 'Porta front door',
  state: 'open',
  controllable: false,
  cap: 'contact',
}

/** One push as the phone saw it: when (seconds into the incident), title, body. */
interface Push {
  readonly at: number
  readonly title: string
  readonly body: string
  readonly actions: readonly string[]
}

interface Harness {
  readonly center: NotificationCenter
  readonly panel: NcAlarmPanelDevice
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  /** The PANEL's own lines (the lift, the follow, the trigger). */
  readonly panelLines: NcTestLogLine[]
  readonly pushes: Push[]
  /** Move the clock to `sec` seconds after T0, let the panel tick, drain the outbox. */
  at(sec: number): Promise<void>
  /** Drain what the last event produced, without moving the clock. */
  settle(): Promise<void>
  /** Every outbox row, oldest first. */
  rows(): NcOutboxEntry[]
}

const centers: NotificationCenter[] = []
const panels: NcAlarmPanelDevice[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: T0 - 60_000, toFake: ['Date', 'setInterval', 'clearInterval'] })
})

afterEach(async () => {
  for (const p of panels.splice(0)) p.stopCountdown()
  await Promise.all(centers.splice(0).map((c) => c.stop()))
  vi.useRealTimers()
})

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

interface Policy {
  readonly notifyDuringEntryDelay?: boolean
  readonly notifySensorRewatched?: boolean
  /** The person rule's grouping window (D692); absent = plain immediate. */
  readonly groupingSec?: number
  /** The system-event kinds the alarm rule delivers (default: every alarm row). */
  readonly alarmKinds?: readonly string[]
}

async function makeHarness(policy: Policy = {}): Promise<Harness> {
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const pushes: Push[] = []
  const recording = makeLogRecorder()
  const panelLines: NcTestLogLine[] = []
  const { ctx, cap } = makePanelContext(
    {
      exitDelaySec: 0,
      entryDelaySec: 30,
      triggeredDurationSec: 10,
      postTriggeredAction: 'rearmAfter',
    },
    panelLines,
  )
  const panel = new NcAlarmPanelDevice(ctx)
  panels.push(panel)
  let built: NotificationCenter | null = null
  const logger: IScopedLogger = recording.logger
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger,
    pruneWindows: async () => resolvePruneWindows({}),
    now: () => Date.now(),
    dispatcher: {
      listTargets: async () => TARGETS,
      send: async (input) => {
        sends.push(input)
        pushes.push({
          at: Math.round((Date.now() - T0) / 1000),
          title: input.notification.title ?? '',
          body: input.notification.body,
          actions: (input.notification.actions ?? []).map((a) => a.id),
        })
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async (deviceId: number) => NAMES[deviceId] ?? null,
      buildActions: (input) => built?.mintButtons(input) ?? Promise.resolve([]),
      sleep: async () => undefined,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [
      { deviceId: PANEL_ID, type: DeviceType.AlarmPanel, name: 'Allarme', isCamera: false },
      {
        deviceId: DOOR,
        type: DeviceType.Sensor,
        name: 'Porta front door',
        isCamera: false,
        location: 'Front door',
      },
      {
        deviceId: HALL_CAM,
        type: DeviceType.Camera,
        name: 'Cam hallway',
        isCamera: true,
        location: 'Hallway piano terra',
      },
      {
        deviceId: LIVING_CAM,
        type: DeviceType.Camera,
        name: 'Cam hall',
        isCamera: true,
        location: 'Hall',
      },
    ],
    isCapDeviceScoped: () => true,
    actuate: async ({ cap: capName, method }) => {
      if (capName !== 'alarm-panel') return
      if (method === 'trigger') await cap().trigger({ deviceId: PANEL_ID })
      if (method === 'disarm') await cap().disarm({ deviceId: PANEL_ID })
    },
    mintActionUrl: async ({ id, expMs }) =>
      buildActionUrl({
        baseUrl: 'https://camstack.example.top',
        routePrefix: '/addon/pipeline-analytics/nc-action',
        id,
        secret: 'secret',
        expMs,
      }),
    // A face that never settles keeps a grouped window open to its deadline.
    recognitionOutlook: () => ({ final: false, awaiting: 'face-unseen' }),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  built = center
  centers.push(center)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  center.setAlarmPanel(ncAlarmPanelPort(panel))
  panel.setPublishHook((report) => center.onAlarmPublish(report))
  const open = new Map<AlarmArmMode, NcAlarmOpenDevice[]>([['away', [DOOR_OPEN]]])
  const announcer = center.alarmArmGuard()
  panel.setArmGuard({
    openings: async (mode) => ({ open: [...(open.get(mode) ?? [])], unknown: [] }),
    secureOnArm: (devices) => announcer.secureOnArm(devices),
    announceRefusal: (input) => announcer.announceRefusal(input),
    announceCheckFailed: (input) => announcer.announceCheckFailed(input),
  })

  const provider = center.buildProvider()
  const caller = { userId: 'admin', isAdmin: true }
  const gate = { deviceId: PANEL_ID, states: ['armed_away'] }
  await provider.createRule({
    caller,
    rule: NcRuleInputSchema.parse({
      name: 'Allarme',
      delivery: 'system-event',
      conditions: {
        systemEvent: {
          kinds: [
            ...(policy.alarmKinds ?? [
              'alarm-pending',
              'alarm-triggered',
              'alarm-rearmed',
              'alarm-disarmed',
              'alarm-sensor-bypass',
            ]),
          ],
        },
      },
      targets: [{ targetId: 'tgt-phone' }],
      throttle: { cooldownSec: 0, scope: 'rule' },
    }),
  })
  await provider.createRule({
    caller,
    rule: NcRuleInputSchema.parse({
      name: 'Porta front door aperta',
      delivery: 'device-event',
      conditions: { devices: [DOOR], sensorKinds: ['contact'], deviceState: gate },
      targets: [{ targetId: 'tgt-phone' }],
      throttle: { cooldownSec: 0, scope: 'rule' },
    }),
  })
  await provider.createRule({
    caller,
    rule: NcRuleInputSchema.parse({
      name: 'Persone in casa',
      delivery: 'immediate',
      conditions: { classes: ['person'], devices: [HALL_CAM, LIVING_CAM], deviceState: gate },
      targets: [{ targetId: 'tgt-phone' }],
      media: { attach: 'none' },
      throttle: { cooldownSec: 0, scope: 'rule-device' },
      ...(policy.groupingSec !== undefined ? { groupingSec: policy.groupingSec } : {}),
    }),
  })
  await panel.applySettings({
    nonBlockingEdit: { mode: 'away', deviceId: DOOR, nonBlocking: true },
    ...(policy.notifyDuringEntryDelay !== undefined || policy.notifySensorRewatched !== undefined
      ? {
          modeDelays: [
            {
              mode: 'away',
              ...(policy.notifyDuringEntryDelay !== undefined
                ? { notifyDuringEntryDelay: policy.notifyDuringEntryDelay }
                : {}),
              ...(policy.notifySensorRewatched !== undefined
                ? { notifySensorRewatched: policy.notifySensorRewatched }
                : {}),
            },
          ],
        }
      : {}),
  })
  const outcome = await panel.armWith('away')
  expect(outcome.outcome).toBe('armed')
  expect(panel.excludedDevices()).toEqual([DOOR])

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      await flush()
      await center.runDrainTickForTest()
    }
  }
  const at = async (sec: number): Promise<void> => {
    const target = T0 + sec * 1000
    const delta = target - Date.now()
    if (delta > 0) vi.advanceTimersByTime(delta)
    await settle()
  }
  // Everything before the incident (the arm) is not part of the replay.
  await at(-30)
  pushes.splice(0)
  const rows = (): NcOutboxEntry[] =>
    [...(ncTable(world, 'outbox')?.entries() ?? [])]
      .map(([id, data]) => rowToEntry(id, data))
      .filter((entry): entry is NcOutboxEntry => entry !== null)
      .toSorted((a, b) => a.createdAt - b.createdAt)
  return { center, panel, sends, lines: recording.lines, panelLines, pushes, at, settle, rows }
}

let nextId = 1

function door(h: Harness, entryOpen: boolean): void {
  nextId += 1
  const event: SensorEvent = {
    id: `door-${nextId}`,
    deviceId: DOOR,
    sourceDeviceId: DOOR,
    kind: 'contact',
    value: { entryOpen, lastChangedAt: Date.now() },
    timestamp: Date.now(),
  }
  h.center.onSensorEventPersisted(event)
}

function person(h: Harness, deviceId: number, trackId: string): void {
  nextId += 1
  const event: ObjectEvent = {
    id: nextId,
    kind: 'object',
    deviceId,
    timestamp: Date.now(),
    trackId,
    className: 'person',
    confidence: 0.9,
    zones: [],
    bbox: { x: 100, y: 50, w: 60, h: 140 },
    frameWidth: 640,
    frameHeight: 360,
  }
  h.center.onObjectEventPersisted(event)
}

/**
 * The 14:10 incident, second by second. The door was bypassed at arm (open, on the mode's
 * non-blocking list); it closed, and its next OPEN both lifts the bypass and starts the entry
 * delay. Returns the pushes, in the order the phone received them.
 */
async function replayIncident(h: Harness): Promise<readonly Push[]> {
  const happenings = new Map<number, () => void>([
    [-5, () => door(h, false)],
    [0, () => door(h, true)],
    [6, () => person(h, HALL_CAM, 'trk-a')],
    [12, () => person(h, HALL_CAM, 'trk-b')],
    [19, () => person(h, LIVING_CAM, 'trk-c')],
    [33, () => person(h, LIVING_CAM, 'trk-d')],
    [54, () => person(h, HALL_CAM, 'trk-e')],
  ])
  for (let sec = -5; sec <= 72; sec += 1) {
    await h.at(sec)
    const happening = happenings.get(sec)
    if (happening !== undefined) {
      happening()
      await h.settle()
    }
  }
  return h.pushes
}

const ENTRY = 'Entry delay — away, 30s to disarm'
const ALARM = { title: 'ALARM', body: 'Intrusion: Front door, Hallway piano terra, Hall' }
const REARMED = 'Re-armed — away'

const brief = (pushes: readonly Push[]) => pushes.map((p) => [p.at, p.title, p.body] as const)

describe('the 14:10 incident replayed under the D706 policy', () => {
  it('DEFAULT: five pushes — entry delay, ALARM with every location, one intrusion, re-armed, entry delay', async () => {
    const h = await makeHarness()
    const pushes = await replayIncident(h)
    expect(brief(pushes)).toEqual([
      [0, ENTRY, 'Started by Porta front door aperta on Porta front door'],
      [30, ALARM.title, ALARM.body],
      [33, 'Intrusion — Hall', 'Person on cam hall'],
      [40, REARMED, 'Armed again after the alarm had triggered'],
      [54, ENTRY, 'Started by Persone in casa on Cam hallway'],
    ])
  })

  it('notifyDuringEntryDelay, no grouping: every match during the delay is its own intrusion push', async () => {
    const h = await makeHarness({ notifyDuringEntryDelay: true })
    const pushes = await replayIncident(h)
    expect(brief(pushes)).toEqual([
      [0, ENTRY, 'Started by Porta front door aperta on Porta front door'],
      [6, 'Intrusion — Hallway piano terra', 'Person on cam hallway'],
      [12, 'Intrusion — Hallway piano terra', 'Person on cam hallway'],
      [19, 'Intrusion — Hall', 'Person on cam hall'],
      [30, ALARM.title, ALARM.body],
      [33, 'Intrusion — Hall', 'Person on cam hall'],
      [40, REARMED, 'Armed again after the alarm had triggered'],
      [54, ENTRY, 'Started by Persone in casa on Cam hallway'],
    ])
  })

  it('notifyDuringEntryDelay + grouping 15 s: ONE intrusion push per window, every camera its location in it', async () => {
    const h = await makeHarness({ notifyDuringEntryDelay: true, groupingSec: 15 })
    const pushes = await replayIncident(h)
    expect(brief(pushes)).toEqual([
      [0, ENTRY, 'Started by Porta front door aperta on Porta front door'],
      // trk-a + trk-b (hall) and trk-c (living room): during the entry delay the alarm
      // rule's window is the RULE's (D706), so the three share one push, both locations
      // in arrival order.
      [21, 'Intrusion — Hallway piano terra, Hall', '3 people on cam hallway'],
      [30, ALARM.title, ALARM.body],
      [40, REARMED, 'Armed again after the alarm had triggered'],
      // trk-d matched while TRIGGERED: its window outlives the re-arm and still speaks.
      [48, 'Intrusion — Hall', 'Person on cam hall'],
      [54, ENTRY, 'Started by Persone in casa on Cam hallway'],
    ])
    // trk-e STARTED the second entry delay: its window (armed ⇒ per camera, D692) closed
    // at 69 s and sent nothing — the entry-delay notification speaks for it.
    expect(
      h.lines.some(
        (l) =>
          l.msg === 'grouped member dropped — alarm-entry-delay-started' &&
          l.tags['deviceId'] === HALL_CAM,
      ),
    ).toBe(true)
    // The one window held three members of two cameras, and the mosaic tiles each on its own.
    const row = h.rows().find((r) => r.payload.alarmIntrusion?.locations.length === 2)
    const group = readOutboxGroup(row?.payload.group)
    expect(group?.members.map((m) => [m.trackId, m.eventDeviceId])).toEqual([
      ['trk-a', HALL_CAM],
      ['trk-b', HALL_CAM],
      ['trk-c', LIVING_CAM],
    ])
  })

  it("DEFAULT + grouping 15 s: the delay's window sends nothing, the triggered one speaks", async () => {
    const h = await makeHarness({ groupingSec: 15 })
    const pushes = await replayIncident(h)
    expect(brief(pushes)).toEqual([
      [0, ENTRY, 'Started by Porta front door aperta on Porta front door'],
      [30, ALARM.title, ALARM.body],
      [40, REARMED, 'Armed again after the alarm had triggered'],
      [48, 'Intrusion — Hall', 'Person on cam hall'],
      [54, ENTRY, 'Started by Persone in casa on Cam hallway'],
    ])
  })

  it('a starter and a follower of two cameras: each drop is said on its OWN camera', async () => {
    const h = await makeHarness({ groupingSec: 15 })
    // The first match starts the delay, the second arrives during it; whichever window
    // holds them, each member's drop is tagged with the camera that saw it.
    await h.at(0)
    person(h, HALL_CAM, 'trk-1')
    await h.settle()
    await h.at(2)
    person(h, LIVING_CAM, 'trk-2')
    await h.settle()
    for (let sec = 3; sec <= 20; sec += 1) await h.at(sec)
    // Starter (hall) and follower (living room) are both silent in the default mode.
    expect(h.pushes.map((p) => p.title)).toEqual([ENTRY])
    expect(
      h.lines
        .filter((l) => l.msg.startsWith('grouped member dropped — alarm-entry-delay'))
        .map((l) => [l.msg.split('— ')[1], l.tags['deviceId']]),
    ).toEqual([
      ['alarm-entry-delay-started', HALL_CAM],
      ['alarm-entry-delay', LIVING_CAM],
    ])
  })

  it('notifySensorRewatched: the door that rejoins the watch AND starts the delay is told once', async () => {
    const h = await makeHarness({ notifySensorRewatched: true })
    const pushes = await replayIncident(h)
    expect(pushes.map((p) => p.title)).toEqual([ENTRY, 'ALARM', 'Intrusion — Hall', REARMED, ENTRY])
    const dup = h.panelLines.find((l) => l.message.includes('"watched again" not notified'))
    expect(dup?.deviceId).toBe(DOOR)
    expect(dup?.meta?.['reason']).toBe('starts-entry-delay')
  })
})

const suppressedLines = (h: Harness, reason: string): LoggedLine[] =>
  h.lines.filter(
    (l) =>
      l.msg === 'alarm rule push not sent — the alarm notification speaks for it' &&
      l.meta['reason'] === reason,
  )

describe('each behaviour of the policy (D706)', () => {
  it('1. ENTRY DELAY START: one push, with a background Disarm button and the first match as source', async () => {
    const h = await makeHarness()
    await h.at(-5)
    door(h, false)
    await h.settle()
    await h.at(0)
    door(h, true)
    await h.settle()
    expect(h.pushes.map((p) => p.title)).toEqual([ENTRY])
    const push = h.sends.at(-1)?.notification
    const disarm = push?.actions?.find((a) => a.id === 'alarm-disarm')
    expect(disarm?.mode).toBe('background')
    expect(disarm?.destructive).toBe(true)
    // The entry-delay row carries the rule match that started it — its picture owner.
    const pending = h.rows().find((r) => r.payload.subject.systemEvent?.kind === 'alarm-pending')
    expect(pending?.payload.subject.systemEvent?.alarmSource?.deviceId).toBe(DOOR)
    // …and the door rule's OWN row was never written, with a line saying why, on the door.
    expect(h.rows().filter((r) => r.payload.ruleName === 'Porta front door aperta')).toEqual([])
    const line = suppressedLines(h, 'alarm-entry-delay-started')[0]
    expect(line?.tags['deviceId']).toBe(DOOR)
  })

  it('2. DURING THE DELAY (default): no push, a line per match, and every match is a tile of the ALARM', async () => {
    const h = await makeHarness()
    await h.at(-5)
    door(h, false)
    await h.at(0)
    door(h, true)
    await h.settle()
    await h.at(6)
    person(h, HALL_CAM, 'trk-a')
    await h.settle()
    await h.at(12)
    person(h, LIVING_CAM, 'trk-b')
    await h.settle()
    expect(h.pushes.map((p) => p.title)).toEqual([ENTRY])
    const lines = suppressedLines(h, 'alarm-entry-delay')
    expect(lines.map((l) => l.tags['deviceId'])).toEqual([HALL_CAM, LIVING_CAM])
    for (let sec = 13; sec <= 31; sec += 1) await h.at(sec)
    const fired = h.rows().find((r) => r.payload.subject.systemEvent?.kind === 'alarm-triggered')
    expect(fired?.payload.group?.members.map((m) => m.trackId)).toEqual(['trk-a', 'trk-b'])
  })

  it('2. a mode that notifies during the delay sends INTRUSION pushes, never merged into an alarm row', async () => {
    const h = await makeHarness({ notifyDuringEntryDelay: true })
    await h.at(-5)
    door(h, false)
    await h.at(0)
    door(h, true)
    await h.settle()
    await h.at(6)
    person(h, HALL_CAM, 'trk-a')
    await h.settle()
    const intrusion = h.rows().find((r) => r.payload.ruleName === 'Persone in casa')
    expect(intrusion?.payload.alarmIntrusion).toEqual({ locations: ['Hallway piano terra'] })
    expect(intrusion?.payload.subject.systemEvent).toBeUndefined()
    expect(h.pushes.at(-1)?.title).toBe('Intrusion — Hallway piano terra')
  })

  it('3. WHILE TRIGGERED: the rule pushes, titled with the location', async () => {
    const h = await makeHarness()
    await h.at(-5)
    door(h, false)
    await h.at(0)
    door(h, true)
    for (let sec = 1; sec <= 31; sec += 1) await h.at(sec)
    expect(h.panel.currentState()).toBe('triggered')
    person(h, LIVING_CAM, 'trk-z')
    await h.settle()
    expect(h.pushes.at(-1)).toMatchObject({ title: 'Intrusion — Hall' })
  })

  it('a suppression nobody would hear instead is WAIVED and said (no rule delivers alarm-pending)', async () => {
    const h = await makeHarness({ alarmKinds: ['alarm-triggered'] })
    await h.at(-5)
    door(h, false)
    await h.at(0)
    door(h, true)
    await h.settle()
    // The door rule's own push goes out — the only one anybody would get.
    expect(h.pushes.map((p) => p.title)).toEqual(['Porta front door aperta'])
    const warn = h.lines.find(
      (l) => l.msg === 'alarm rule push kept — no enabled rule delivers the alarm notification',
    )
    expect(warn?.level).toBe('warn')
    expect(warn?.meta['missingKind']).toBe('alarm-pending')
  })
})
