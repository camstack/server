/**
 * THE ARM PATH, on the real device: refuse, Arm anyway, exclude, re-arm (D630).
 *
 * `alarm-panel.arm` used to be unconditional — every mode armable, always — and
 * the operator's report was "deve inviare un messaggio di errore quando non può
 * essere armato" [it must send an error message when it cannot be armed]. These tests pin what answers it, and the ways answering it
 * could make the alarm worse:
 *
 *  - an open covered device REFUSES a plain arm, every time — a second press
 *    is refused again, never a bypass;
 *  - the ONLY way past it is `armAnyway(refusalId)`, bound to that one refusal:
 *    one-shot, stale once the panel moves, expired after
 *    `ARM_ANYWAY_TTL_MS`, superseded by a later refusal, and gone after a
 *    restart;
 *  - an Arm anyway RE-READS the openings: a device that opened since is a new
 *    refusal, never silently excluded, and a blocker that closed is armed;
 *  - the excluded device does NOT set the alarm off, and rejoins once it has
 *    been closed and opened again — across a restart too.
 */

import type { AlarmArmMode } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NcRuleFireRef } from '../../rule-engine.js'
import { NcAlarmArmRefusedError, type NcAlarmOpenDevice } from '../alarm-arm-guard.js'
import {
  ARM_ANYWAY_TTL_MS,
  type NcAlarmArmGuardHook,
  type NcAlarmArmOutcome,
  NcAlarmPanelDevice,
  type NcAlarmPublishReport,
  type NcAlarmRefusal,
} from '../alarm-panel-device.js'
import { makePanelContext, type NcTestLogLine, type NcTestPanelCap } from './panel-test-context.js'

const PANEL_ID = 1023
const PORCH = 3243
const RETRO = 3272
const GARAGE = 4001

type CapProvider = NcTestPanelCap

interface NcRefusalAnnounced {
  readonly refusal: NcAlarmRefusal
  readonly blocking: readonly NcAlarmOpenDevice[]
  readonly state: string
}

type NcLogLine = NcTestLogLine

interface Harness {
  readonly device: NcAlarmPanelDevice
  readonly cap: CapProvider
  readonly config: Record<string, unknown>
  readonly reports: NcAlarmPublishReport[]
  readonly refusals: NcRefusalAnnounced[]
  readonly checkFailures: { mode: AlarmArmMode; state?: string; error: string }[]
  readonly logs: NcLogLine[]
  /** What the guard answers next: the covered devices reading OPEN… */
  open: NcAlarmOpenDevice[]
  /** …and the covered devices it could not read. */
  unknown: number[]
  /** Devices handed to secure-on-arm on a successful arm. */
  secured: NcAlarmOpenDevice[]
  /** Rebuild the device from the config blob it persisted — a deploy. */
  restart(): Harness
}

function device(
  deviceId: number,
  name: string,
  state = 'open',
  controllable = false,
  cap?: 'cover' | 'lock-control' | 'switch',
): NcAlarmOpenDevice {
  return {
    deviceId,
    name,
    state,
    controllable,
    ...(cap !== undefined ? { cap } : {}),
  }
}

const PORCH_OPEN = device(PORCH, 'Finestra porch')
const GARAGE_OPEN = device(GARAGE, 'Garage', 'stopped')
const LOCK_OPEN = device(RETRO, 'Serratura front door', 'unlocked', true, 'lock-control')

/** A panel on the shared fake `DeviceContext` (`panel-test-context.ts`). */
function buildPanel(persisted: Record<string, unknown> = {}): Harness {
  const config: Record<string, unknown> = { ...persisted }
  const reports: NcAlarmPublishReport[] = []
  const refusals: NcRefusalAnnounced[] = []
  const checkFailures: { mode: AlarmArmMode; state?: string; error: string }[] = []
  const logs: NcLogLine[] = []
  const open: NcAlarmOpenDevice[] = []
  const unknown: number[] = []
  const secured: NcAlarmOpenDevice[] = []
  const { ctx, cap } = makePanelContext(config, logs)

  const panel = new NcAlarmPanelDevice(ctx)
  const guard: NcAlarmArmGuardHook = {
    openings: async () => ({ open: [...open], unknown: [...unknown] }),
    secureOnArm: (devices) => {
      secured.push(...devices)
    },
    announceRefusal: (input) =>
      refusals.push({ refusal: input.refusal, blocking: input.blocking, state: input.state }),
    announceCheckFailed: (input) => checkFailures.push({ mode: input.mode, error: input.error }),
  }
  panel.setArmGuard(guard)
  panel.setPublishHook((report) => reports.push(report))
  const harness: Harness = {
    device: panel,
    cap: cap(),
    config,
    reports,
    refusals,
    checkFailures,
    logs,
    open,
    unknown,
    secured,
    restart: () => buildPanel(config),
  }
  return harness
}

/** The refusal id of a `refused` outcome — fails the test on anything else. */
function refusalIdOf(outcome: NcAlarmArmOutcome): string {
  if (outcome.outcome !== 'refused') {
    throw new Error(`expected a refusal, got ${outcome.outcome}`)
  }
  return outcome.refusalId
}

/** The provenance the action runner hands over immediately before a trigger. */
function fireRef(sourceDeviceId: number): NcRuleFireRef {
  return {
    ruleId: 'rule-contacts',
    ruleName: '[TEST] Intrusione Home — contatti',
    deviceId: 102,
    sourceDeviceId,
    recordId: 'sensor-row-1',
    timestamp: Date.now(),
  }
}

describe('a plain arm with a device open', () => {
  let h: Harness
  beforeEach(() => {
    h = buildPanel({ exitDelaySec: 0, entryDelaySec: 0 })
  })

  it('arms when nothing is open', async () => {
    await h.cap.arm({ deviceId: PANEL_ID, mode: 'home' })
    expect(h.device.currentState()).toBe('armed_home')
    expect(h.refusals).toEqual([])
    expect(h.device.excludedDevices()).toEqual([])
  })

  it('REFUSES, leaves the panel disarmed, and announces THAT refusal once', async () => {
    h.open.push(PORCH_OPEN)
    const outcome = await h.device.armWith('away')
    const refusalId = refusalIdOf(outcome)
    expect(outcome).toEqual({ outcome: 'refused', refusalId, blocking: [PORCH_OPEN] })
    // The panel did not move. A refusal that armed anyway would be a lie in
    // both directions at once.
    expect(h.device.currentState()).toBe('disarmed')
    // A refused arm must not slam shutters / locks.
    expect(h.secured).toEqual([])
    // …and the operator was TOLD, on the channel that reaches a phone — with
    // the id the notification's Arm anyway will carry, and the EXACT ids.
    expect(h.refusals).toHaveLength(1)
    expect(h.refusals[0]?.refusal.id).toBe(refusalId)
    expect(h.refusals[0]?.refusal.blockingIds).toEqual([PORCH])
    expect(h.refusals[0]?.refusal.mode).toBe('away')
    expect(h.refusals[0]?.blocking).toEqual([PORCH_OPEN])
    expect(h.refusals[0]?.state).toBe('disarmed')
    // Per device, tagged with ITS id.
    const line = h.logs.find((l) => l.message.includes('REFUSED'))
    expect(line?.deviceId).toBe(PORCH)
  })

  it('secure-on-arm actuates an open lock only when the arm proceeds', async () => {
    h.open.push(LOCK_OPEN)
    const outcome = await h.device.armWith('away')
    expect(outcome).toEqual({ outcome: 'armed', excluded: [LOCK_OPEN] })
    expect(h.secured).toEqual([LOCK_OPEN])
  })

  it('a second plain press is refused AGAIN, with a new id — it never bypasses', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(1_000_000))
      h.open.push(PORCH_OPEN)
      const first = refusalIdOf(await h.device.armWith('away'))
      vi.setSystemTime(new Date(1_000_500))
      const second = refusalIdOf(await h.device.armWith('away'))
      expect(second).not.toBe(first)
      expect(h.device.currentState()).toBe('disarmed')
      expect(h.device.excludedDevices()).toEqual([])
      expect(h.refusals).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the cap throws the refusal, naming every open device and the Arm anyway', async () => {
    h.open.push(PORCH_OPEN, device(RETRO, 'Porta retro'))
    const attempt = h.cap.arm({ deviceId: PANEL_ID, mode: 'home' })
    await expect(attempt).rejects.toBeInstanceOf(NcAlarmArmRefusedError)
    await expect(h.cap.arm({ deviceId: PANEL_ID, mode: 'home' })).rejects.toThrow(
      /open: Finestra porch, Porta retro\. Use "Arm anyway"/,
    )
  })

  it("arms around a device on the mode's NON-BLOCKING list, and says why", async () => {
    await h.device.applySettings({ nonBlocking: [{ mode: 'away', deviceIds: [PORCH] }] })
    h.open.push(PORCH_OPEN)
    const outcome = await h.device.armWith('away')
    expect(outcome).toEqual({ outcome: 'armed', excluded: [PORCH_OPEN] })
    expect(h.device.currentState()).toBe('armed_away')
    expect(h.device.excludedDevices()).toEqual([PORCH])
    expect(h.refusals).toEqual([])
    const line = h.logs.find((l) => l.message.includes('open device excluded'))
    expect(line?.deviceId).toBe(PORCH)
    expect(line?.meta?.['why']).toBe('non-blocking')
  })

  it('a non-blocking list is PER MODE — home still refuses', async () => {
    await h.device.applySettings({ nonBlocking: [{ mode: 'away', deviceIds: [PORCH] }] })
    h.open.push(PORCH_OPEN)
    expect((await h.device.armWith('home')).outcome).toBe('refused')
  })

  it('arms — and hands the check failure to the announcer — when the guard cannot read', async () => {
    h.device.setArmGuard({
      openings: async () => {
        throw new Error('device-manager unreachable')
      },
      secureOnArm: () => {},
      announceRefusal: () => {},
      announceCheckFailed: (input) =>
        h.checkFailures.push({ mode: input.mode, state: input.state, error: input.error }),
    })
    const outcome = await h.device.armWith('home')
    expect(outcome.outcome).toBe('armed')
    expect(h.device.currentState()).toBe('armed_home')
    expect(h.checkFailures).toEqual([
      { mode: 'home', state: 'armed_home', error: 'Error: device-manager unreachable' },
    ])
    expect(
      h.logs.some((l) => l.level === 'warn' && l.message.includes('arming without the check')),
    ).toBe(true)
  })

  it('an UNKNOWN device never blocks — and the panel leaves its line to the guard', async () => {
    h.unknown.push(RETRO, GARAGE)
    const outcome = await h.device.armWith('home')
    expect(outcome.outcome).toBe('armed')
    // ONE place logs an unknown device: the guard that read it
    // (nc-actions-alarm.spec pins that line). A second copy here said less.
    expect(h.logs.filter((l) => l.message.includes('cannot block this arm'))).toEqual([])
    // …and a PLAIN arm does not exclude it either: nobody was shown it.
    expect(h.device.excludedDevices()).toEqual([])
  })

  it('arms with no guard wired at all', async () => {
    const bare = buildPanel({ exitDelaySec: 0 })
    bare.device.setArmGuard(null)
    await bare.cap.arm({ deviceId: PANEL_ID, mode: 'home' })
    expect(bare.device.currentState()).toBe('armed_home')
  })
})

describe('armAnyway(refusalId) — bound to ONE refusal', () => {
  let h: Harness
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000))
    h = buildPanel({ exitDelaySec: 30, entryDelaySec: 0 })
    h.open.push(PORCH_OPEN)
  })
  afterEach(() => {
    h.device.stopCountdown()
    vi.useRealTimers()
  })

  it('arms around exactly the refused device', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    vi.setSystemTime(new Date(1_010_000))
    const outcome = await h.device.armAnyway(id)
    expect(outcome).toEqual({ outcome: 'arming', excluded: [PORCH_OPEN] })
    expect(h.device.currentState()).toBe('arming')
    expect(h.device.excludedDevices()).toEqual([PORCH])
    const line = h.logs.find((l) => l.message.includes('open device excluded'))
    expect(line?.meta?.['why']).toBe('arm-anyway')
  })

  it('is ONE-SHOT — a second press of the same refusal is rejected', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    await h.device.armAnyway(id)
    const changedBefore = h.device.currentState()
    const again = await h.device.armAnyway(id)
    expect(again).toEqual({ outcome: 'rejected', reason: 'used' })
    expect(h.device.currentState()).toBe(changedBefore)
    expect(h.refusals).toHaveLength(1)
  })

  it('is STALE once the panel changed state — a disarm in between', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    vi.setSystemTime(new Date(1_001_000))
    await h.cap.disarm({ deviceId: PANEL_ID })
    const outcome = await h.device.armAnyway(id)
    expect(outcome).toEqual({ outcome: 'rejected', reason: 'stale' })
    expect(h.device.currentState()).toBe('disarmed')
    expect(h.device.excludedDevices()).toEqual([])
    const line = h.logs.find((l) => l.message.includes('Arm anyway rejected'))
    expect(line?.deviceId).toBe(PANEL_ID)
    expect(line?.meta).toMatchObject({ refusalId: id, reason: 'stale' })
  })

  it('is STALE once the panel changed state — a successful arm of another mode', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    h.open.length = 0
    vi.setSystemTime(new Date(1_001_000))
    expect((await h.device.armWith('home')).outcome).toBe('arming')
    h.open.push(PORCH_OPEN)
    expect(await h.device.armAnyway(id)).toEqual({ outcome: 'rejected', reason: 'stale' })
    // Still arming HOME — never away, and nothing excluded.
    expect(h.device.currentState()).toBe('arming')
    expect(h.reports.at(-1)?.transition?.mode).toBe('home')
    expect(h.device.excludedDevices()).toEqual([])
  })

  it('EXPIRES after ARM_ANYWAY_TTL_MS', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    vi.setSystemTime(new Date(1_000_000 + ARM_ANYWAY_TTL_MS + 1))
    expect(await h.device.armAnyway(id)).toEqual({ outcome: 'rejected', reason: 'expired' })
    expect(h.device.currentState()).toBe('disarmed')
  })

  it('is SUPERSEDED by a later refusal — only the latest one arms', async () => {
    const a = refusalIdOf(await h.device.armWith('away'))
    vi.setSystemTime(new Date(1_000_100))
    const b = refusalIdOf(await h.device.armWith('away'))
    expect(await h.device.armAnyway(a)).toEqual({ outcome: 'rejected', reason: 'unknown-refusal' })
    expect(h.device.currentState()).toBe('disarmed')
    expect((await h.device.armAnyway(b)).outcome).toBe('arming')
  })

  it('refuses AGAIN when a NEW device opened since — never excludes it silently', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    h.open.push(GARAGE_OPEN)
    vi.setSystemTime(new Date(1_002_000))
    const outcome = await h.device.armAnyway(id)
    const next = refusalIdOf(outcome)
    expect(next).not.toBe(id)
    // The new refusal names EVERY device that blocks now — the porch that
    // is still open and the garage that opened since — so ITS Arm anyway can
    // arm around both (controller ruling, fix round 1).
    expect(outcome).toEqual({
      outcome: 'refused',
      refusalId: next,
      blocking: [PORCH_OPEN, GARAGE_OPEN],
    })
    expect(h.refusals).toHaveLength(2)
    expect(h.refusals[1]?.refusal.id).toBe(next)
    expect(h.refusals[1]?.blocking).toEqual([PORCH_OPEN, GARAGE_OPEN])
    expect(h.refusals[1]?.refusal.blockingIds).toEqual([PORCH, GARAGE])
    expect(h.device.currentState()).toBe('disarmed')
    expect(h.device.excludedDevices()).toEqual([])
    // The OLD refusal is spent; the new one is what the new notification carries.
    expect(await h.device.armAnyway(id)).toEqual({ outcome: 'rejected', reason: 'used' })
  })

  it("the second refusal's Arm anyway arms with BOTH excluded", async () => {
    const first = refusalIdOf(await h.device.armWith('away'))
    h.open.push(GARAGE_OPEN)
    vi.setSystemTime(new Date(1_002_000))
    const second = refusalIdOf(await h.device.armAnyway(first))
    vi.setSystemTime(new Date(1_003_000))
    expect(await h.device.armAnyway(second)).toEqual({
      outcome: 'arming',
      excluded: [PORCH_OPEN, GARAGE_OPEN],
    })
    expect(h.device.excludedDevices()).toEqual([PORCH, GARAGE])
  })

  it('a FAILED re-read excludes exactly what the refusal showed, unverified', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    h.device.setArmGuard({
      openings: async () => {
        throw new Error('device-manager unreachable')
      },
      secureOnArm: () => {},
      announceRefusal: () => {},
      announceCheckFailed: (input) =>
        h.checkFailures.push({ mode: input.mode, state: input.state, error: input.error }),
    })
    const outcome = await h.device.armAnyway(id)
    expect(outcome).toEqual({ outcome: 'arming', excluded: [PORCH_OPEN] })
    expect(h.device.excludedDevices()).toEqual([PORCH])
    expect(h.checkFailures).toHaveLength(1)
    const line = h.logs.find((l) => l.message.includes('open device excluded'))
    expect(line?.deviceId).toBe(PORCH)
    expect(line?.meta?.['why']).toBe('arm-anyway-unverified')
  })

  it('announces the unchecked arm with the state the panel REALLY landed in', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    h.device.setArmGuard({
      openings: async () => {
        throw new Error('device-manager unreachable')
      },
      secureOnArm: () => {},
      announceRefusal: () => {},
      announceCheckFailed: (input) =>
        h.checkFailures.push({
          mode: input.mode,
          // Read the panel AT announcement time: the arm must already be there.
          state: `${input.state}/${h.device.currentState()}`,
          error: input.error,
        }),
    })
    await h.device.armAnyway(id)
    expect(h.checkFailures).toEqual([
      { mode: 'away', state: 'arming/arming', error: 'Error: device-manager unreachable' },
    ])
  })

  // I2 (alarm Phase 2 review): the announcement used to be made INSIDE the
  // failed read, before the stale check — so an Arm anyway overtaken by a
  // disarm pushed "Armed away without checking openings" for an arm that never
  // happened.
  it('a STALE Arm anyway whose re-read failed arms nothing and announces nothing', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    vi.setSystemTime(new Date(1_005_000))
    h.device.setArmGuard({
      openings: async () => {
        // A disarm lands while the read is in flight, then the read fails.
        await h.device.disarm()
        throw new Error('device-manager unreachable')
      },
      secureOnArm: () => {},
      announceRefusal: () => {},
      announceCheckFailed: (input) =>
        h.checkFailures.push({ mode: input.mode, state: input.state, error: input.error }),
    })
    expect(await h.device.armAnyway(id)).toEqual({ outcome: 'rejected', reason: 'stale' })
    expect(h.device.currentState()).toBe('disarmed')
    expect(h.checkFailures).toEqual([])
  })

  // I3 (alarm Phase 2 review, D49): a new blocker re-refuses — and the
  // confirmed device that now reads UNKNOWN must ride along, or the next Arm
  // anyway arms it live on a guess.
  it('a re-refusal carries the confirmed devices that now read UNKNOWN', async () => {
    const first = refusalIdOf(await h.device.armWith('away'))
    h.open.length = 0
    h.open.push(GARAGE_OPEN)
    h.unknown.push(PORCH)
    vi.setSystemTime(new Date(1_002_000))
    const second = refusalIdOf(await h.device.armAnyway(first))
    expect(h.refusals.at(-1)?.blocking).toEqual([GARAGE_OPEN, PORCH_OPEN])
    expect(h.refusals.at(-1)?.refusal.blockingIds).toEqual([GARAGE, PORCH])
    vi.setSystemTime(new Date(1_003_000))
    expect(await h.device.armAnyway(second)).toEqual({
      outcome: 'arming',
      excluded: [GARAGE_OPEN, PORCH_OPEN],
    })
    expect(h.device.excludedDevices()).toEqual([GARAGE, PORCH])
  })

  it('an acknowledged device that reads UNKNOWN at press time is still excluded (D49)', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    h.open.length = 0
    h.unknown.push(PORCH)
    const outcome = await h.device.armAnyway(id)
    expect(outcome).toEqual({ outcome: 'arming', excluded: [PORCH_OPEN] })
    expect(h.device.excludedDevices()).toEqual([PORCH])
    const line = h.logs.find((l) => l.message.includes('open device excluded'))
    expect(line?.meta?.['why']).toBe('arm-anyway-unknown')
  })

  it('refusal ids never collide, even inside one millisecond', async () => {
    const a = refusalIdOf(await h.device.armWith('away'))
    const b = refusalIdOf(await h.device.armWith('away'))
    expect(b).not.toBe(a)
    expect(await h.device.armAnyway(a)).toEqual({ outcome: 'rejected', reason: 'unknown-refusal' })
  })

  it('arms the refused device NORMALLY when it closed in between', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    h.open.length = 0
    const outcome = await h.device.armAnyway(id)
    expect(outcome).toEqual({ outcome: 'arming', excluded: [] })
    expect(h.device.excludedDevices()).toEqual([])
  })

  it('does not survive a RESTART — the refusal is never persisted', async () => {
    const id = refusalIdOf(await h.device.armWith('away'))
    h.device.stopCountdown()
    const after = h.restart()
    after.open.push(PORCH_OPEN)
    expect(await after.device.armAnyway(id)).toEqual({
      outcome: 'rejected',
      reason: 'unknown-refusal',
    })
    expect(after.device.currentState()).toBe('disarmed')
    after.device.stopCountdown()
  })

  it('an unknown id arms nothing', async () => {
    expect(await h.device.armAnyway('refusal:1023:away:1')).toEqual({
      outcome: 'rejected',
      reason: 'unknown-refusal',
    })
    expect(h.device.currentState()).toBe('disarmed')
  })
})

describe('the non-blocking list, persisted', () => {
  it('is served by settings() and survives a restart', async () => {
    const h = buildPanel({ exitDelaySec: 0 })
    const saved = await h.device.applySettings({
      nonBlocking: [{ mode: 'home', deviceIds: [PORCH, RETRO] }],
    })
    expect(saved.nonBlocking).toEqual([{ mode: 'home', deviceIds: [PORCH, RETRO] }])
    // A patch that does not name it leaves it alone.
    await h.device.applySettings({ exitDelaySec: 5 })
    expect(h.restart().device.settings().nonBlocking).toEqual([
      { mode: 'home', deviceIds: [PORCH, RETRO] },
    ])
  })

  it('drops a persisted entry for a mode the panel does not know, without a cast', () => {
    const h = buildPanel({
      nonBlocking: [
        { mode: 'home', deviceIds: [PORCH] },
        { mode: 'garden', deviceIds: [RETRO] },
        { mode: 'home', deviceIds: [RETRO] },
      ],
    })
    expect(h.device.settings().nonBlocking).toEqual([{ mode: 'home', deviceIds: [PORCH] }])
  })

  it('says once that the announceArm switch is gone, when it was off with targets', () => {
    const h = buildPanel({ announceArm: false, announceTargets: ['t1'] })
    const lines = h.logs.filter((l) => l.message.includes('announceArm switch is gone'))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.deviceId).toBe(PANEL_ID)
    const quiet = buildPanel({ announceArm: true, announceTargets: ['t1'] })
    expect(quiet.logs.some((l) => l.message.includes('announceArm switch is gone'))).toBe(false)
  })
})

/**
 * The excluded window really MOVED (D735): an `open` whose own change time is after the
 * arm — it was shut and opened again and the close was never seen. `step` keeps each call
 * a NEW move (a re-delivery of the same reading is not one).
 */
function moved(h: Harness, step = 0): void {
  const at = Date.now() + 1_000 + step
  h.device.observeOpening(PORCH, 'open', at, { changedAt: at })
}

describe('what an Arm anyway excludes', () => {
  let h: Harness
  beforeEach(async () => {
    h = buildPanel({ exitDelaySec: 0, entryDelaySec: 0 })
    h.open.push(PORCH_OPEN)
    const id = refusalIdOf(await h.device.armWith('home'))
    expect((await h.device.armAnyway(id)).outcome).toBe('armed')
  })

  it('does NOT let the excluded sensor set the alarm off — and a re-sync is not announced (D735)', async () => {
    h.device.triggerFromRule(fireRef(PORCH))
    expect(h.device.currentState()).toBe('armed_home')
    const line = h.logs.find((l) => l.message.includes('was open when the alarm was armed'))
    expect(line?.deviceId).toBe(PORCH)
    expect(line?.meta?.['moved']).toBe(false)
    // The window was open all along: nothing moved, so nothing is told — said as a line.
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')).toEqual([])
    const quiet = h.logs.find((l) => l.message.includes('did not move since the arm'))
    expect(quiet).toMatchObject({ deviceId: PORCH, meta: { reason: 'not-moved' } })
  })

  it('a recovery from `unavailable` (an old or seeded change time) is never announced, switch on', async () => {
    await h.device.applySettings({ modeDelays: [{ mode: 'home', notifySensorIgnored: true }] })
    for (const changedAt of [1, Date.now() - 3_600_000]) {
      h.device.observeOpening(PORCH, 'open', Date.now(), { changedAt })
      h.device.triggerFromRule(fireRef(PORCH))
    }
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')).toEqual([])
  })

  it('a REAL move is announced only when the mode notifies ignored sensors (default off)', async () => {
    moved(h)
    h.device.triggerFromRule(fireRef(PORCH))
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')).toEqual([])
    const off = h.logs.find((l) => l.message.includes('"ignored" not notified'))
    expect(off).toMatchObject({ deviceId: PORCH, meta: { reason: 'ignored-notify-off' } })

    await h.device.applySettings({ modeDelays: [{ mode: 'home', notifySensorIgnored: true }] })
    moved(h, 1)
    h.device.triggerFromRule(fireRef(PORCH))
    expect(h.device.currentState()).toBe('armed_home')
    // …and it is TOLD, through the publish hook, with the state unchanged.
    expect(h.reports.at(-1)).toMatchObject({
      state: 'armed_home',
      transition: {
        kind: 'alarm-sensor-bypass',
        state: 'armed_home',
        previous: 'armed_home',
        sensor: { deviceId: PORCH, event: 'ignored' },
      },
    })
  })

  it('a move is consumed by its press — the same reading pressing again is a duplicate', async () => {
    await h.device.applySettings({ modeDelays: [{ mode: 'home', notifySensorIgnored: true }] })
    const at = Date.now() + 1_000
    h.device.observeOpening(PORCH, 'open', at, { changedAt: at })
    h.device.observeOpening(PORCH, 'open', at, { changedAt: at })
    h.device.triggerFromRule(fireRef(PORCH))
    h.device.triggerFromRule(fireRef(PORCH))
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')).toHaveLength(1)
  })

  it('tells an ignored trigger ONCE per sensor per arm — repeats are a debug line', async () => {
    await h.device.applySettings({ modeDelays: [{ mode: 'home', notifySensorIgnored: true }] })
    const bypasses = (): unknown[] =>
      h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')
    for (let i = 0; i < 3; i += 1) {
      moved(h, i)
      h.device.triggerFromRule(fireRef(PORCH))
    }
    expect(bypasses()).toHaveLength(1)
    const repeats = h.logs.filter(
      (l) => l.level === 'debug' && l.message.includes('already announced in this arm'),
    )
    expect(repeats.map((l) => l.deviceId)).toEqual([PORCH, PORCH])
    // The mark rides the persisted exclusion: a deploy does not re-announce.
    const after = h.restart()
    after.device.observeOpening(PORCH, 'open', Date.now(), { changedAt: Date.now() + 9_000 })
    after.device.triggerFromRule(fireRef(PORCH))
    expect(after.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')).toEqual([])
  })

  it('does not leave the refused trigger’s attribution behind for the next one', async () => {
    h.device.triggerFromRule(fireRef(PORCH))
    // A manual trigger now — it must be a PLAIN alarm, not one carrying the
    // excluded sensor's rule and pictures.
    await h.cap.trigger({ deviceId: PANEL_ID })
    expect(h.device.currentState()).toBe('triggered')
    const fired = h.reports.at(-1)?.transition
    expect(fired?.kind).toBe('alarm-triggered')
    expect(fired?.source).toBeUndefined()
  })

  it('lets EVERY OTHER sensor set it off — the exclusion is per sensor', async () => {
    h.device.triggerFromRule(fireRef(RETRO))
    expect(h.device.currentState()).toBe('triggered')
  })

  it('does not announce an ignored excluded sensor while the siren is already sounding', async () => {
    // Real sensor fires first → triggered. The excluded one chatters next —
    // logging only, no second push (2026-10-05 04:31: ALLARME + "Ignorato").
    h.device.triggerFromRule(fireRef(RETRO))
    expect(h.device.currentState()).toBe('triggered')
    const before = h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass').length
    h.device.triggerFromRule(fireRef(PORCH))
    expect(h.device.currentState()).toBe('triggered')
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')).toHaveLength(
      before,
    )
    expect(h.logs.some((l) => l.message.includes('siren is already sounding'))).toBe(true)
  })

  it('keeps excluding it while it is merely closed — the close is not the trigger', async () => {
    h.device.observeOpening(PORCH, 'secure')
    h.device.triggerFromRule(fireRef(PORCH))
    expect(h.device.currentState()).toBe('armed_home')
  })

  it('RE-ARMS the sensor on the open that follows the close — and says nothing by default (D706)', async () => {
    h.device.observeOpening(PORCH, 'secure')
    h.device.observeOpening(PORCH, 'open')
    expect(h.device.excludedDevices()).toEqual([])
    h.device.triggerFromRule(fireRef(PORCH))
    expect(h.device.currentState()).toBe('triggered')
    expect(h.logs.some((l) => l.message.includes('alarm exclusion lifted'))).toBe(true)
    expect(h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')).toEqual([])
    const quiet = h.logs.find((l) => l.message.includes('"watched again" not notified'))
    expect(quiet?.deviceId).toBe(PORCH)
    expect(quiet?.meta?.['reason']).toBe('rewatched-notify-off')
  })

  it('RE-ARMS the sensor and announces it when the mode notifies "watched again" (D706)', async () => {
    await h.device.applySettings({ modeDelays: [{ mode: 'home', notifySensorRewatched: true }] })
    h.device.observeOpening(PORCH, 'secure')
    h.device.observeOpening(PORCH, 'open')
    expect(h.device.excludedDevices()).toEqual([])
    h.device.triggerFromRule(fireRef(PORCH))
    expect(h.device.currentState()).toBe('triggered')
    const lifted = h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')
    expect(lifted.map((r) => r.transition?.sensor)).toEqual([{ deviceId: PORCH, event: 'lifted' }])
    // A bypass report is not a state change: the siren that followed is still
    // announced as one (`lastPublished` untouched).
    expect(h.reports.at(-1)?.transition?.kind).toBe('alarm-triggered')
  })

  it('keeps the exclusions across a restart, phase included', async () => {
    h.device.observeOpening(PORCH, 'secure')
    const after = h.restart()
    expect(after.device.currentState()).toBe('armed_home')
    expect(after.device.excludedDevices()).toEqual([PORCH])
    // Still mid-lift: one more open re-arms it, and until then it cannot fire.
    after.device.triggerFromRule(fireRef(PORCH))
    expect(after.device.currentState()).toBe('armed_home')
    after.device.observeOpening(PORCH, 'open')
    expect(after.device.excludedDevices()).toEqual([])
  })

  it('drops the exclusions on disarm — they belong to the arm that made them', async () => {
    await h.cap.disarm({ deviceId: PANEL_ID })
    expect(h.device.excludedDevices()).toEqual([])
    const after = h.restart()
    expect(after.device.excludedDevices()).toEqual([])
  })

  it('a later CLEAN arm drops the previous exclusions', async () => {
    h.open.length = 0
    await h.device.armWith('home')
    expect(h.device.excludedDevices()).toEqual([])
  })
})

describe('an ignored trigger during the EXIT delay', () => {
  it('is not announced — the panel is not armed yet — and is announced once armed', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(1_000_000))
      const h = buildPanel({ exitDelaySec: 30, entryDelaySec: 0 })
      h.open.push(PORCH_OPEN)
      const id = refusalIdOf(await h.device.armWith('home'))
      expect((await h.device.armAnyway(id)).outcome).toBe('arming')
      await h.device.applySettings({ modeDelays: [{ mode: 'home', notifySensorIgnored: true }] })
      const bypasses = (): unknown[] =>
        h.reports.filter((r) => r.transition?.kind === 'alarm-sensor-bypass')
      moved(h)
      h.device.triggerFromRule(fireRef(PORCH))
      expect(bypasses()).toEqual([])
      const line = h.logs.find((l) => l.message.includes('the panel is not armed yet'))
      expect(line).toMatchObject({ level: 'debug', deviceId: PORCH })
      vi.setSystemTime(new Date(1_000_000 + 31_000))
      moved(h)
      h.device.triggerFromRule(fireRef(PORCH))
      expect(bypasses()).toHaveLength(1)
      h.device.stopCountdown()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the two-phase lift, for every opening kind', () => {
  it('an excluded COVER is released once it reads secure, and re-arms on the next opening', async () => {
    const h = buildPanel({ exitDelaySec: 0 })
    await h.device.applySettings({ nonBlocking: [{ mode: 'home', deviceIds: [GARAGE] }] })
    h.open.push(GARAGE_OPEN)
    await h.device.armWith('home')
    expect(h.device.excludedDevices()).toEqual([GARAGE])
    h.device.observeOpening(GARAGE, 'open')
    expect(h.device.excludedDevices()).toEqual([GARAGE])
    h.device.observeOpening(GARAGE, 'secure')
    h.device.observeOpening(GARAGE, undefined)
    expect(h.device.excludedDevices()).toEqual([GARAGE])
    h.device.observeOpening(GARAGE, 'open')
    expect(h.device.excludedDevices()).toEqual([])
  })
})

// Task 8 review: the ignored-trigger line said "the panel is not armed" in
// every state `trigger` refuses — false during an entry delay or a siren.
describe('an ignored trigger says WHY, in the state it was ignored in', () => {
  const lineFor = (h: Harness): NcLogLine | undefined =>
    h.logs.filter((l) => l.message.startsWith('alarm trigger ignored')).at(-1)

  it('disarmed, arming, pending and triggered each have their own words', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(1_000_000))
      const h = buildPanel({ exitDelaySec: 30, entryDelaySec: 20 })
      await h.cap.trigger({ deviceId: PANEL_ID })
      expect(lineFor(h)).toMatchObject({
        message: 'alarm trigger ignored — the panel is disarmed',
        deviceId: PANEL_ID,
        meta: { state: 'disarmed' },
      })
      await h.device.armWith('away')
      await h.cap.trigger({ deviceId: PANEL_ID })
      expect(lineFor(h)?.message).toBe(
        'alarm trigger ignored — the panel is still arming (exit delay)',
      )
      vi.setSystemTime(new Date(1_000_000 + 31_000))
      await h.cap.trigger({ deviceId: PANEL_ID })
      expect(h.device.currentState()).toBe('pending')
      await h.cap.trigger({ deviceId: PANEL_ID })
      expect(lineFor(h)?.message).toBe('alarm trigger ignored — the entry delay is already running')
      vi.setSystemTime(new Date(1_000_000 + 52_000))
      expect(h.device.currentState()).toBe('triggered')
      await h.cap.trigger({ deviceId: PANEL_ID })
      expect(lineFor(h)?.message).toBe('alarm trigger ignored — the alarm is already going off')
      expect(h.logs.some((l) => l.message.includes('the panel is not armed'))).toBe(false)
      h.device.stopCountdown()
    } finally {
      vi.useRealTimers()
    }
  })
})
