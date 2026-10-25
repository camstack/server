/**
 * D735 end to end: a rule press carries its own source, so an EXCLUDED sensor can never set
 * the alarm off — however close together the presses land.
 *
 * The reference is the 2026-10-07 02:32Z false alarm. Night was armed with four contacts open
 * and excluded (4171 porta porch, 3243 finestra porch, 4138 finestra studio, 3293
 * cameretta Carol). Zigbee2MQTT restarted, the four came back `unavailable → on`, and the
 * rule "Allarme notte — sensori e serrature" matched all four within ~60 ms. Each match
 * pressed the panel through an awaited `ctx.api` actuation (3–27 ms), and the source of each
 * press waited in ONE slot on the panel: two matches 1 ms apart overwrote it, one press read
 * nothing, skipped the exclusion check (fail-open on a missing source) and TRIGGERED — the
 * alarm row had no source and no "Intrusion: <places>" body.
 *
 * The replay below feeds the same four matches back to back on one evaluation chain, with the
 * actuator DEFERRED like the real one, one of them camera-attributed (camera 3836, sensor
 * 4138). The alarm must stay armed, say "ignored" four times, and push nothing for them.
 * Revert-checked: on the slot design it triggers with no source.
 */

import { makeNcRecords } from './support/nc-test-deps.js'
import {
  type AlarmArmMode,
  DeviceType,
  type IScopedLogger,
  NcRuleInputSchema,
  type SensorEvent,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  makePanelContext,
  type NcTestLogLine,
  TEST_PANEL_ID,
} from '../alarm/__tests__/panel-test-context.js'
import type { NcAlarmOpenDevice } from '../alarm/alarm-arm-guard.js'
import { NcAlarmPanelDevice, type NcAlarmPublishReport } from '../alarm/alarm-panel-device.js'
import { ncAlarmPanelPort } from '../alarm/alarm-panel-port.js'
import type { NcSendInput, NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import { resolvePruneWindows } from '../prune-windows.js'
import { type LoggedLine, makeLogRecorder } from './grouped-harness.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const T0 = Date.UTC(2026, 9, 7, 2, 32, 0)
const PANEL_ID = TEST_PANEL_ID
const PORTA_PORCH = 4171
const FINESTRA_PORCH = 3243
const FINESTRA_STUDIO = 4138
const CAMERETTA = 3293
/** The camera that links the studio window: its match is the window's, attributed. */
const CAM_STUDIO = 3836
const EXCLUDED = [PORTA_PORCH, FINESTRA_PORCH, CAMERETTA, FINESTRA_STUDIO] as const

const NAMES: Readonly<Record<number, string>> = {
  [PORTA_PORCH]: 'Porta porch',
  [FINESTRA_PORCH]: 'Finestra porch',
  [FINESTRA_STUDIO]: 'Finestra studio',
  [CAMERETTA]: 'Cameretta Carol',
  [CAM_STUDIO]: 'Cam studio',
}

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-phone', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
]

const openContact = (deviceId: number): NcAlarmOpenDevice => ({
  deviceId,
  name: NAMES[deviceId] ?? String(deviceId),
  state: 'open',
  controllable: false,
  cap: 'contact',
})

interface Harness {
  readonly center: NotificationCenter
  readonly panel: NcAlarmPanelDevice
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  readonly panelLines: NcTestLogLine[]
  readonly reports: NcAlarmPublishReport[]
  /** How many presses reached the (deferred) actuator. */
  readonly actuated: () => number
  settle(): Promise<void>
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

async function makeHarness(): Promise<Harness> {
  const world = makeNcRecords()
  const sends: NcSendInput[] = []
  const recording = makeLogRecorder()
  const panelLines: NcTestLogLine[] = []
  const reports: NcAlarmPublishReport[] = []
  let actuated = 0
  const { ctx, cap } = makePanelContext(
    // Night fires at once, as on the hub that night: the press that slipped through TRIGGERED.
    { exitDelaySec: 0, entryDelaySec: 0, triggeredDurationSec: 30 },
    panelLines,
  )
  const panel = new NcAlarmPanelDevice(ctx)
  panels.push(panel)
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
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async (deviceId: number) => NAMES[deviceId] ?? null,
      sleep: async () => undefined,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [
      { deviceId: PANEL_ID, type: DeviceType.AlarmPanel, name: 'Allarme', isCamera: false },
      ...EXCLUDED.map((deviceId) => ({
        deviceId,
        type: DeviceType.Sensor,
        name: NAMES[deviceId] ?? String(deviceId),
        isCamera: false,
      })),
      { deviceId: CAM_STUDIO, type: DeviceType.Camera, name: 'Cam studio', isCamera: true },
    ],
    isCapDeviceScoped: () => true,
    // DEFERRED like the real `ctx.api` call (3–27 ms on the hub): the press lands after
    // the evaluation that made it has moved on. A design that parks the source anywhere
    // between the match and this call is exposed by exactly this gap.
    actuate: async ({ cap: capName, method }) => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (capName !== 'alarm-panel') return
      actuated += 1
      if (method === 'trigger') await cap().trigger({ deviceId: PANEL_ID })
    },
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  center.setAlarmPanel(ncAlarmPanelPort(panel))
  panel.setPublishHook((report) => {
    reports.push(report)
    center.onAlarmPublish(report)
  })
  const announcer = center.alarmArmGuard()
  panel.setArmGuard({
    openings: async (mode: AlarmArmMode) => ({
      open: mode === 'night' ? EXCLUDED.map(openContact) : [],
      unknown: [],
    }),
    secureOnArm: (devices) => announcer.secureOnArm(devices),
    announceRefusal: (input) => announcer.announceRefusal(input),
    announceCheckFailed: (input) => announcer.announceCheckFailed(input),
  })

  const provider = center.buildProvider()
  const caller = { userId: 'admin', isAdmin: true }
  await provider.createRule({
    caller,
    rule: NcRuleInputSchema.parse({
      name: 'Allarme',
      delivery: 'system-event',
      conditions: {
        systemEvent: { kinds: ['alarm-pending', 'alarm-triggered', 'alarm-sensor-bypass'] },
      },
      targets: [{ targetId: 'tgt-phone' }],
      throttle: { cooldownSec: 0, scope: 'rule' },
    }),
  })
  await provider.createRule({
    caller,
    rule: NcRuleInputSchema.parse({
      name: 'Allarme notte — sensori e serrature',
      delivery: 'device-event',
      conditions: {
        devices: [...EXCLUDED, CAM_STUDIO],
        sensorKinds: ['contact'],
        deviceState: { deviceId: PANEL_ID, states: ['armed_night'] },
      },
      targets: [{ targetId: 'tgt-phone' }],
      throttle: { cooldownSec: 0, scope: 'rule-device' },
    }),
  })
  for (const deviceId of EXCLUDED) {
    await panel.applySettings({ nonBlockingEdit: { mode: 'night', deviceId, nonBlocking: true } })
  }
  const outcome = await panel.armWith('night')
  expect(outcome.outcome).toBe('armed')
  expect([...panel.excludedDevices()].toSorted()).toEqual([...EXCLUDED].toSorted())

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      await flush()
      await center.runDrainTickForTest()
    }
  }
  await settle()
  vi.advanceTimersByTime(60_000)
  await settle()
  sends.splice(0)
  reports.splice(0)
  return {
    center,
    panel,
    sends,
    lines: recording.lines,
    panelLines,
    reports,
    actuated: () => actuated,
    settle,
  }
}

let nextId = 1

/**
 * A contact that came back `unavailable → on`: the open it already was at the arm. Its
 * slice carries HA's fresh `last_changed` unless `changedAt` says otherwise — as it did
 * that night, before the provider kept the stamp of a value that did not change.
 */
function reopened(h: Harness, sensorId: number, cameraId?: number, changedAt?: number): void {
  nextId += 1
  const event: SensorEvent = {
    id: `contact-${nextId}`,
    deviceId: cameraId ?? sensorId,
    sourceDeviceId: sensorId,
    kind: 'contact',
    value: { entryOpen: true, lastChangedAt: changedAt ?? Date.now() },
    timestamp: Date.now(),
  }
  h.center.onSensorEventPersisted(event)
}

const IGNORED = 'alarm trigger ignored — the sensor was open when the alarm was armed'

describe('the 2026-10-07 02:32Z false alarm, replayed (D735)', () => {
  it('four excluded contacts matching back to back never set the alarm off', async () => {
    const h = await makeHarness()
    expect(h.panel.currentState()).toBe('armed_night')
    // ~60 ms, on one evaluation chain; 4138 and 3293 1 ms apart, 4138 through its camera.
    reopened(h, PORTA_PORCH)
    reopened(h, FINESTRA_PORCH)
    reopened(h, FINESTRA_STUDIO, CAM_STUDIO)
    reopened(h, CAMERETTA)
    await h.settle()

    const fired = h.reports.find((r) => r.transition?.kind === 'alarm-triggered')
    // On the slot design: `triggered`, and the transition carries NO source.
    expect({ state: h.panel.currentState(), source: fired?.transition?.source }).toEqual({
      state: 'armed_night',
      source: undefined,
    })
    const ignored = h.panelLines.filter((l) => l.message === IGNORED)
    expect(ignored.map((l) => l.deviceId).toSorted()).toEqual([...EXCLUDED].toSorted())
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-triggered')).toEqual([])
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-pending')).toEqual([])
    // A rule press of THIS panel never goes through the actuator any more.
    expect(h.actuated()).toBe(0)
  })

  it('the rule pushes nothing for an excluded sensor — the bypass logic speaks for it', async () => {
    const h = await makeHarness()
    reopened(h, PORTA_PORCH)
    reopened(h, FINESTRA_STUDIO, CAM_STUDIO)
    await h.settle()
    const ruleSends = h.sends.filter((s) => s.notification.title?.includes('Allarme notte'))
    expect(ruleSends).toEqual([])
    const suppressed = h.lines.filter(
      (l) =>
        l.msg === 'alarm rule push not sent — the alarm notification speaks for it' &&
        l.meta['reason'] === 'alarm-sensor-excluded',
    )
    // Tagged with the device the subject is about: the sensor, or the camera it rode on.
    expect(suppressed.map((l) => l.tags['deviceId']).toSorted()).toEqual(
      [PORTA_PORCH, CAM_STUDIO].toSorted(),
    )
  })

  it('an ANONYMOUS rule-action press is refused while the arm excludes sensors (fail-closed)', async () => {
    const h = await makeHarness()
    // A rule's ACTIVATION binding presses the panel: no match, so no sensor to check.
    const provider = h.center.buildProvider()
    const caller = { userId: 'admin', isAdmin: true }
    const { rule } = await provider.createRule({
      caller,
      rule: NcRuleInputSchema.parse({
        name: 'Panico',
        enabled: false,
        delivery: 'immediate',
        conditions: { classes: ['person'] },
        targets: [{ targetId: 'tgt-phone' }],
        actions: {
          onActivation: [
            {
              kind: 'do',
              action: {
                kind: 'cap',
                deviceId: PANEL_ID,
                cap: 'alarm-panel',
                method: 'trigger',
                args: {},
              },
            },
          ],
        },
      }),
    })
    await provider.setRuleEnabled({ ruleId: rule.id, enabled: true })
    await h.settle()
    expect(h.panel.currentState()).toBe('armed_night')
    expect(h.actuated()).toBe(0)
    const refused = h.lines.find((l) => l.msg.startsWith('alarm trigger REFUSED'))
    expect(refused).toMatchObject({ level: 'error', tags: { deviceId: PANEL_ID } })
  })

  it('"ignored" is told only for a REAL move, and only when the mode notifies it (D735)', async () => {
    const h = await makeHarness()
    // Default OFF: even a real move (a change time after the arm) is a line, not a push.
    reopened(h, PORTA_PORCH)
    await h.settle()
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')).toEqual([])
    expect(h.panelLines.some((l) => l.meta?.['reason'] === 'ignored-notify-off')).toBe(true)

    await h.panel.applySettings({ modeDelays: [{ mode: 'night', notifySensorIgnored: true }] })
    // A re-sync whose change time predates the arm (the open it always was): nothing.
    reopened(h, FINESTRA_PORCH, undefined, T0 - 6 * 3_600_000)
    await h.settle()
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')).toEqual([])
    // A real move of another excluded sensor: told once, as "ignored", on that sensor.
    vi.advanceTimersByTime(1_000)
    reopened(h, CAMERETTA)
    await h.settle()
    const told = h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')
    expect(told.map((r) => r.transition?.sensor)).toEqual([
      { deviceId: CAMERETTA, event: 'ignored' },
    ])
    // The ONE push of the whole sequence: the rule's own pushes are suppressed (excluded).
    expect(h.sends).toHaveLength(1)
    expect(h.panel.currentState()).toBe('armed_night')
  })
})
