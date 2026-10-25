/**
 * The `nc.*` ALARM bridge — status, arm, Arm anyway, disarm and config — end to
 * end through the real centre and the REAL panel device (D630).
 *
 * The bridge exists because the cap cannot say what the viewer needs: the
 * hub's generated router validates `alarm-panel.arm` against `z.void()`, so a
 * refusal there can only be a thrown string. Here the response schema lives in
 * the addon, so a refusal is a RESULT — its id and the names of what is open —
 * and the viewer can offer the Arm anyway bound to exactly that refusal.
 *
 * What these tests pin:
 *  - a refused arm is an answer, not an error, and names the device;
 *  - the Arm anyway is the panel's own one-shot path (a second press is `used`);
 *  - status and config are the admin's (status until the viewer scopes it);
 *  - `live` reads every covered device ONCE for all modes together, and an
 *    unreadable one is `unknown` — never open, never closed (D49).
 */

import { ncRecordKinds } from '../record-kinds.js'
import { DeviceType, type IScopedLogger, NcRuleInputSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcAlarmOpening } from '../alarm/alarm-openings.js'
import { ncPruneWindowsPort, makeNcRecords } from './support/nc-test-deps.js'
import { NcAlarmPanelDevice } from '../alarm/alarm-panel-device.js'
import { ncAlarmPanelPort } from '../alarm/alarm-panel-port.js'
import { makePanelContext, type NcTestLogLine } from '../alarm/__tests__/panel-test-context.js'
import { NotificationCenter } from '../index.js'
import { makeNcActionHandlers, type NcActionHandlers, ncActions } from '../nc-actions.js'
import { NcRuleAiStore } from '../rule-ai-store.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const PANEL_ID = 1023
const PORCH = 3243
const RETRO = 3272
const U1 = { userId: 'u1', isAdmin: false }
const ADMIN = { userId: 'admin1', isAdmin: true }

const OPEN: NcAlarmOpening = { kind: 'reading', reading: 'open', state: 'open', cap: 'contact' }
const SECURE: NcAlarmOpening = {
  kind: 'reading',
  reading: 'secure',
  state: 'closed',
  cap: 'contact',
}

interface Harness {
  readonly handlers: NcActionHandlers
  readonly panel: NcAlarmPanelDevice
  /** What `readDeviceOpenings` answers — mutable, so a test can close a window. */
  readonly openings: Map<number, NcAlarmOpening>
  /** Every `readDeviceOpenings` call, with the ids it was asked for. */
  readonly reads: (readonly number[])[]
  readonly logs: NcTestLogLine[]
  /** The centre's logger — spied on for the live view's WARN lines. */
  readonly ncLogger: IScopedLogger
}

/** How `readDeviceOpenings` behaves: the map, not wired at all, or throwing. */
type NcReaderMode = 'map' | 'absent' | 'throws'

const centers: NotificationCenter[] = []
const panels: NcAlarmPanelDevice[] = []

afterEach(async () => {
  for (const p of panels.splice(0)) p.stopCountdown()
  await Promise.all(centers.splice(0).map((c) => c.stop()))
})

async function makeHarness(
  persisted: Record<string, unknown> = { exitDelaySec: 30 },
  withPanel = true,
  reader: NcReaderMode = 'map',
): Promise<Harness> {
  const ncLogger = makeSilentLogger()
  const world = makeNcRecords()
  const logs: NcTestLogLine[] = []
  const openings = new Map<number, NcAlarmOpening>([[PORCH, OPEN]])
  const reads: (readonly number[])[] = []
  const { ctx } = makePanelContext({ ...persisted }, logs)
  const panel = new NcAlarmPanelDevice(ctx)
  panels.push(panel)
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: ncLogger,
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => [],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [
      { deviceId: PANEL_ID, type: DeviceType.AlarmPanel, name: 'Allarme', isCamera: false },
      { deviceId: PORCH, type: DeviceType.Sensor, name: 'Porch', isCamera: false },
      { deviceId: RETRO, type: DeviceType.Sensor, name: 'Retro', isCamera: false },
    ],
    ...(reader === 'absent'
      ? {}
      : {
          readDeviceOpenings: async (ids: readonly number[]) => {
            reads.push([...ids])
            if (reader === 'throws') throw new Error('runtime store unreachable')
            return new Map([...openings].filter(([id]) => ids.includes(id)))
          },
        }),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  await center.start({ evaluation: true })
  await center.whenHydrated()
  if (withPanel) {
    center.setAlarmPanel(ncAlarmPanelPort(panel))
    panel.setPublishHook((report) => center.onAlarmPublish(report))
    panel.setArmGuard(center.alarmArmGuard())
  }
  // Away covers the porch AND the back door; home covers only the back door.
  for (const [mode, devices] of [
    ['away', [PORCH, RETRO]],
    ['home', [RETRO]],
  ] as const) {
    await center.buildProvider().createRule({
      caller: { userId: 'admin1', isAdmin: true },
      rule: NcRuleInputSchema.parse({
        name: `intrusion ${mode}`,
        enabled: true,
        delivery: 'immediate',
        conditions: {
          deviceState: { deviceId: PANEL_ID, states: [`armed_${mode}`] },
          devices: [...devices],
        },
        targets: [{ targetId: 'tgt-phone' }],
      }),
    })
  }
  const ruleAiStore = new NcRuleAiStore({
    kind: world.records.kind(ncRecordKinds['rule-ai']),
    logger: makeSilentLogger(),
  })
  const handlers = makeNcActionHandlers({
    ruleStore: center.ruleStore,
    ruleAiStore,
    logger: makeSilentLogger(),
    listCallerTargetIds: async () => [],
    snooze: {
      list: () => [],
      create: async () => Promise.reject(new Error('unused')),
      cancel: async () => {},
    },
    alarm: center.alarmActions(),
  })
  reads.length = 0
  return { handlers, panel, openings, reads, logs, ncLogger }
}

describe('nc.armAlarm — a refusal is a RESULT', () => {
  it('names the open device and does not throw', async () => {
    const h = await makeHarness()
    const outcome = await h.handlers['nc.armAlarm']({ mode: 'away' }, ADMIN)
    expect(outcome.outcome).toBe('refused')
    if (outcome.outcome !== 'refused') return
    expect(outcome.refusalId.length).toBeGreaterThan(0)
    expect(outcome.blocking).toEqual([
      { deviceId: PORCH, name: 'Porch', state: 'open', controllable: false, cap: 'contact' },
    ])
    expect(h.panel.currentState()).toBe('disarmed')
  })

  it('rejects an absent caller — fail closed', async () => {
    const h = await makeHarness()
    await expect(h.handlers['nc.armAlarm']({ mode: 'away' }, undefined)).rejects.toThrow(
      /forbidden/,
    )
  })
})

describe('an unknown covered device is logged ONCE, by the guard', () => {
  it('one line per unknown device, tagged with its id and why — none from the panel', async () => {
    const h = await makeHarness()
    h.openings.set(PORCH, SECURE)
    const info = vi.spyOn(h.ncLogger, 'info')
    await h.handlers['nc.armAlarm']({ mode: 'away' }, ADMIN)
    const lines = info.mock.calls.filter(([msg]) => String(msg).includes('cannot block this arm'))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[1]).toMatchObject({ tags: { deviceId: RETRO }, meta: { why: 'read-failed' } })
    expect(h.logs.filter((l) => l.message.includes('cannot block this arm'))).toEqual([])
  })
})

describe('nc.armAlarmAnyway — the panel’s own one-shot path', () => {
  it('arms with that refusal’s id, and a second press is `used`', async () => {
    const h = await makeHarness()
    const refused = await h.handlers['nc.armAlarm']({ mode: 'away' }, ADMIN)
    if (refused.outcome !== 'refused') throw new Error(`expected refused, got ${refused.outcome}`)
    const first = await h.handlers['nc.armAlarmAnyway']({ refusalId: refused.refusalId }, ADMIN)
    expect(first.outcome).toBe('arming')
    const again = await h.handlers['nc.armAlarmAnyway']({ refusalId: refused.refusalId }, ADMIN)
    expect(again).toEqual({ outcome: 'rejected', reason: 'used' })
  })
})

describe('nc.disarmAlarm', () => {
  it('disarms, and status says so', async () => {
    const h = await makeHarness()
    h.openings.set(PORCH, SECURE)
    await h.handlers['nc.armAlarm']({ mode: 'away' }, ADMIN)
    expect(h.panel.currentState()).toBe('arming')
    expect(await h.handlers['nc.disarmAlarm']({}, ADMIN)).toEqual({ success: true })
    const status = await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(status.live?.state).toBe('disarmed')
    expect(status.live?.targetMode).toBeNull()
  })
})

describe('nc.getAlarmStatus — admin, live', () => {
  it('answers live.state, with openings per mode', async () => {
    const h = await makeHarness()
    const status = await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(status.deviceId).toBe(PANEL_ID)
    expect(status.live?.state).toBe('disarmed')
    expect(status.live?.availableModes).toEqual(['home', 'away', 'night'])
    const away = status.live?.openings.find((o) => o.mode === 'away')
    expect(away?.devices).toEqual([
      { deviceId: PORCH, name: 'Porch', state: 'open', blocking: true },
    ])
    // The back door is covered but the read did not answer for it: unknown,
    // not closed (D49).
    expect(away?.unknown).toEqual([RETRO])
    const home = status.live?.openings.find((o) => o.mode === 'home')
    expect(home?.devices).toEqual([])
  })

  it('reads each covered device ONCE for all modes together', async () => {
    const h = await makeHarness()
    await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(h.reads).toHaveLength(1)
    expect([...(h.reads[0] ?? [])].toSorted((a, b) => a - b)).toEqual([PORCH, RETRO])
  })

  it('a device on the mode’s non-blocking list is open but NOT blocking', async () => {
    const h = await makeHarness({
      exitDelaySec: 30,
      nonBlocking: [{ mode: 'away', deviceIds: [PORCH] }],
    })
    const status = await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    const away = status.live?.openings.find((o) => o.mode === 'away')
    expect(away?.devices[0]?.blocking).toBe(false)
  })

  it('a failed read makes every covered device unknown — and still answers', async () => {
    const h = await makeHarness()
    h.openings.clear()
    const status = await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    const away = status.live?.openings.find((o) => o.mode === 'away')
    expect(away?.devices).toEqual([])
    expect(away?.unknown).toEqual([PORCH, RETRO])
  })

  it('lists the exclusions with names after an Arm anyway', async () => {
    const h = await makeHarness()
    const refused = await h.handlers['nc.armAlarm']({ mode: 'away' }, ADMIN)
    if (refused.outcome !== 'refused') throw new Error('expected refused')
    await h.handlers['nc.armAlarmAnyway']({ refusalId: refused.refusalId }, ADMIN)
    const status = await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(status.live?.state).toBe('arming')
    expect(status.live?.targetMode).toBe('away')
    expect(status.live?.exclusions).toEqual([{ deviceId: PORCH, name: 'Porch', phase: 'open' }])
  })

  it('a hub with no panel answers deviceId null and live null', async () => {
    const h = await makeHarness({ exitDelaySec: 30 }, false)
    expect(await h.handlers['nc.getAlarmStatus']({}, ADMIN)).toEqual({ deviceId: null, live: null })
    await expect(h.handlers['nc.armAlarm']({ mode: 'away' }, ADMIN)).rejects.toThrow(
      /no alarm panel/,
    )
  })
})

describe('nc.getAlarmConfig / nc.setAlarmConfig — admin only', () => {
  // I6 (alarm Phase 2 review): status names every covered device and whether
  // it is open, and `addons.custom` is system-scoped — any login could read
  // it. Admin-only until the viewer task scopes it to the caller's devices.
  it('status rejects a non-admin', async () => {
    const h = await makeHarness()
    await expect(h.handlers['nc.getAlarmStatus']({}, U1)).rejects.toThrow(/forbidden/)
  })

  it('rejects a non-admin', async () => {
    const h = await makeHarness()
    await expect(h.handlers['nc.getAlarmConfig']({}, U1)).rejects.toThrow(/forbidden/)
    await expect(
      h.handlers['nc.setAlarmConfig']({ patch: { exitDelaySec: 10 } }, U1),
    ).rejects.toThrow(/forbidden/)
  })

  it('serves the admin the config WITH live, and applies a patch', async () => {
    const h = await makeHarness()
    const config = await h.handlers['nc.getAlarmConfig']({}, ADMIN)
    expect(config.deviceId).toBe(PANEL_ID)
    expect(config.live?.state).toBe('disarmed')
    const next = await h.handlers['nc.setAlarmConfig']({ patch: { exitDelaySec: 10 } }, ADMIN)
    expect(next.settings.exitDelaySec).toBe(10)
    expect(next.live?.state).toBe('disarmed')
  })
})

describe('nc.getAlarmSensors — admin only', () => {
  it('rejects a non-admin', async () => {
    const h = await makeHarness()
    await expect(h.handlers['nc.getAlarmSensors']({ deviceIds: [PORCH] }, U1)).rejects.toThrow(
      /forbidden/,
    )
  })

  it('forwards an admin input to the reader and answers the classified state', async () => {
    const h = await makeHarness()
    const answer = await h.handlers['nc.getAlarmSensors']({ deviceIds: [RETRO, PORCH] }, ADMIN)
    expect(h.reads.at(-1)).toEqual([RETRO, PORCH].toSorted((a, b) => a - b))
    expect(answer.sensors.map((s) => [s.deviceId, s.reading])).toEqual([
      [PORCH, 'open'],
      [RETRO, 'unknown'],
    ])
  })
})

describe('the bridge WRITES are admin-only', () => {
  it('declares the three writes, the config pair and status `auth: admin` in the envelope', () => {
    for (const name of [
      'nc.getAlarmStatus',
      'nc.armAlarm',
      'nc.armAlarmAnyway',
      'nc.disarmAlarm',
      'nc.getAlarmConfig',
      'nc.getAlarmSensors',
      'nc.setAlarmConfig',
    ] as const) {
      expect(ncActions[name].auth).toBe('admin')
    }
  })

  // The cap's arm/disarm are DEVICE-scoped; `addons.custom` is system-scoped.
  // Opening these to any login would widen who can disarm the house.
  it('refuses a non-admin on arm, Arm anyway and disarm — and the panel does not move', async () => {
    const h = await makeHarness()
    h.openings.set(PORCH, SECURE)
    await expect(h.handlers['nc.armAlarm']({ mode: 'away' }, U1)).rejects.toThrow(/forbidden/)
    await expect(h.handlers['nc.armAlarmAnyway']({ refusalId: 'refusal:x' }, U1)).rejects.toThrow(
      /forbidden/,
    )
    expect(h.panel.currentState()).toBe('disarmed')
    await h.handlers['nc.armAlarm']({ mode: 'away' }, ADMIN)
    expect(h.panel.currentState()).toBe('arming')
    await expect(h.handlers['nc.disarmAlarm']({}, U1)).rejects.toThrow(/forbidden/)
    expect(h.panel.currentState()).toBe('arming')
  })

  it('logs WHO pressed it, tagged with the panel id', async () => {
    const h = await makeHarness()
    const info = vi.spyOn(h.ncLogger, 'info')
    await h.handlers['nc.disarmAlarm']({}, ADMIN)
    const line = info.mock.calls.find(
      ([msg]) => msg === 'alarm disarm requested through the bridge',
    )
    expect(line?.[1]).toMatchObject({ tags: { deviceId: PANEL_ID }, meta: { userId: 'admin1' } })
  })
})

describe('the live view when the openings cannot be read (D49)', () => {
  it('no reader wired: every covered device is unknown, one WARN on the panel', async () => {
    const h = await makeHarness({ exitDelaySec: 30 }, true, 'absent')
    const warn = vi.spyOn(h.ncLogger, 'warn')
    const status = await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    const away = status.live?.openings.find((o) => o.mode === 'away')
    expect(away).toEqual({ mode: 'away', devices: [], unknown: [PORCH, RETRO] })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ tags: { deviceId: PANEL_ID } })
  })

  it('the read throws: still answers, every covered device unknown, one WARN', async () => {
    const h = await makeHarness({ exitDelaySec: 30 }, true, 'throws')
    const warn = vi.spyOn(h.ncLogger, 'warn')
    const status = await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(status.live?.state).toBe('disarmed')
    const away = status.live?.openings.find((o) => o.mode === 'away')
    expect(away?.unknown).toEqual([PORCH, RETRO])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ tags: { deviceId: PANEL_ID } })
  })

  it('a partial read logs ONE aggregated WARN naming the unanswered ids', async () => {
    const h = await makeHarness()
    const warn = vi.spyOn(h.ncLogger, 'warn')
    await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      tags: { deviceId: PANEL_ID },
      meta: { unanswered: 1, unansweredIds: String(RETRO) },
    })
  })
})

/**
 * The admin polls `getAlarmConfig` every 2–15 s. A WARN on every poll buried
 * the one line that mattered under hundreds that said the same thing, so the
 * live view logs the TRANSITIONS of its read: the first failure WARNs, a
 * repeat of the same failure is silent, a recovery is ONE INFO — every line
 * tagged with the panel's id.
 */
describe('the live view logs its read failure on change only', () => {
  function linesAbout(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
    return spy.mock.calls.filter(([msg]) => String(msg).startsWith('alarm live view'))
  }

  it('a partial read repeated on every poll WARNs once', async () => {
    const h = await makeHarness()
    const warn = vi.spyOn(h.ncLogger, 'warn')
    for (let i = 0; i < 4; i += 1) await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(linesAbout(warn)).toHaveLength(1)
  })

  it('a read that throws on every poll WARNs once', async () => {
    const h = await makeHarness({ exitDelaySec: 30 }, true, 'throws')
    const warn = vi.spyOn(h.ncLogger, 'warn')
    for (let i = 0; i < 3; i += 1) await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(linesAbout(warn)).toHaveLength(1)
  })

  it('no reader wired, polled repeatedly: one WARN', async () => {
    const h = await makeHarness({ exitDelaySec: 30 }, true, 'absent')
    const warn = vi.spyOn(h.ncLogger, 'warn')
    for (let i = 0; i < 3; i += 1) await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(linesAbout(warn)).toHaveLength(1)
  })

  it('recovery is ONE INFO on the panel; a relapse WARNs again', async () => {
    const h = await makeHarness()
    const warn = vi.spyOn(h.ncLogger, 'warn')
    const info = vi.spyOn(h.ncLogger, 'info')
    await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    h.openings.set(RETRO, SECURE)
    await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    const recovered = linesAbout(info)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.[1]).toMatchObject({ tags: { deviceId: PANEL_ID } })
    h.openings.delete(RETRO)
    await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    expect(linesAbout(warn)).toHaveLength(2)
  })

  it('a DIFFERENT failure is a change and WARNs', async () => {
    const h = await makeHarness()
    const warn = vi.spyOn(h.ncLogger, 'warn')
    await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    h.openings.delete(PORCH)
    await h.handlers['nc.getAlarmStatus']({}, ADMIN)
    const lines = linesAbout(warn)
    expect(lines).toHaveLength(2)
    expect(lines[1]?.[1]).toMatchObject({
      tags: { deviceId: PANEL_ID },
      meta: { unanswered: 2 },
    })
  })
})
