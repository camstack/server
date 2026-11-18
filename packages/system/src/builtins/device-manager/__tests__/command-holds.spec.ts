/**
 * The command hold (D1061): the spec's "Done when" list, end to end from a
 * command observation to the slice the mirror emits and the transition the
 * recorder is told of.
 */
import type {
  CommandHoldOptions,
  DeviceCommandObservation,
  IScopedLogger,
  LogExtras,
} from '@camstack/types'
import { ONE_SHOT_HOLD_MS } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCommandObserverRegistryForTests,
  getCommandObserverRegistry,
} from '../../../kernel/command-observation.js'
import { startCommandHolds } from '../command-holds-wiring.js'
import { harness, type Harness } from './mirror-harness.js'

const DEVICE = 7

interface Told {
  readonly capName: string
  readonly prior: Readonly<Record<string, unknown>> | undefined
  readonly slice: Readonly<Record<string, unknown>>
}

interface Rig {
  readonly h: Harness
  readonly told: Told[]
  readonly stop: () => void
}

function recordingLogger(h: Harness): IScopedLogger {
  const line =
    (level: string) =>
    (message: string, extras?: LogExtras): void =>
      void h.logs.push({ level, message, extras })
  const logger: IScopedLogger = {
    debug: line('debug'),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function rig(options?: Record<string, CommandHoldOptions>): Rig {
  const h = harness()
  const told: Told[] = []
  h.mirror.setTransitionTap(
    (_deviceId, capName, prior, slice) => void told.push({ capName, prior, slice }),
  )
  const stop = startCommandHolds({
    mirror: h.mirror,
    logger: recordingLogger(h),
    optionsFor: (_deviceId, capName) => options?.[capName],
  })
  return { h, told, stop }
}

function command(
  capName: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
  outcome?: Promise<void>,
): void {
  const obs: DeviceCommandObservation = {
    deviceId: DEVICE,
    capName,
    method,
    args: { deviceId: DEVICE, ...args },
    actor: { kind: 'user', userId: 'u', username: 'ada', credential: 'session' },
    at: Date.now(),
    ...(outcome !== undefined ? { outcome } : {}),
  }
  getCommandObserverRegistry().observe(obs)
}

/** The last `switch` slice the mirror emitted. */
function lastSlice(h: Harness, capName: string): Record<string, unknown> | undefined {
  return h.events.filter((e) => e.capName === capName).at(-1)?.slice
}

describe('DeviceStateMirror - command hold (D1061)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetCommandObserverRegistryForTests()
  })
  afterEach(() => {
    __resetCommandObserverRegistryForTests()
    vi.useRealTimers()
  })

  it('says the device is holding until the report confirms the command (D1062 burst gate)', () => {
    const { h, stop } = rig()
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    expect(h.mirror.isHoldingDevice(DEVICE)).toBe(false)
    command('switch', 'setState', { on: true })
    expect(h.mirror.isHoldingDevice(DEVICE)).toBe(true)
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    expect(h.mirror.isHoldingDevice(DEVICE)).toBe(true)
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: true })
    expect(h.mirror.isHoldingDevice(DEVICE)).toBe(false)
    stop()
  })

  it('tells the report tap of every report, unchanged ones included (D1062 push health)', () => {
    const { h, stop } = rig()
    const reports: string[] = []
    h.mirror.setReportTap((deviceId, capName) => void reports.push(`${deviceId}:${capName}`))
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    expect(reports).toEqual([`${DEVICE}:switch`, `${DEVICE}:switch`])
    stop()
  })

  it('shows the commanded value through 10 s of stale polls; history sees one transition, at confirmation', () => {
    const { h, told, stop } = rig()
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    told.length = 0

    command('switch', 'setState', { on: true })
    expect(lastSlice(h, 'switch')).toEqual({ on: true })
    for (let s = 0; s < 10; s += 1) {
      vi.advanceTimersByTime(1_000)
      h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
      expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: true })
      expect(h.mirror.capSlice(DEVICE, 'switch', 'confirmed')).toEqual({ on: false })
    }
    expect(lastSlice(h, 'switch')).toEqual({ on: true })
    expect(told).toEqual([])

    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: true })
    expect(told).toEqual([{ capName: 'switch', prior: { on: false }, slice: { on: true } }])
    expect(h.mirror.capSlice(DEVICE, 'switch', 'confirmed')).toEqual({ on: true })
    vi.advanceTimersByTime(60_000)
    expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: true })
    expect(h.logs.filter((l) => l.level === 'warn')).toEqual([])
    stop()
  })

  it('carries the confirmed slice on the event while a hold changes it, and nothing extra otherwise', () => {
    const { h, stop } = rig()
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    expect(h.events.at(-1)).toEqual({ capName: 'switch', slice: { on: false } })
    command('switch', 'setState', { on: true })
    expect(h.events.at(-1)).toEqual({
      capName: 'switch',
      slice: { on: true },
      confirmed: { on: false },
    })
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: true })
    expect(h.events.at(-1)).toEqual({ capName: 'switch', slice: { on: true } })
    stop()
  })

  it('rolls a refused command back at once', async () => {
    const { h, stop } = rig()
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    let refuse: (err: Error) => void = () => undefined
    const outcome = new Promise<void>((_resolve, reject) => {
      refuse = reject
    })
    command('switch', 'setState', { on: true }, outcome)
    expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: true })
    refuse(new Error('device offline'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: false })
    expect(lastSlice(h, 'switch')).toEqual({ on: false })
    stop()
  })

  it('reverts an unconfirmed command at 30 s, logged with the device tag', () => {
    const { h, stop } = rig()
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    command('switch', 'setState', { on: true })
    vi.advanceTimersByTime(29_999)
    expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: true })
    vi.advanceTimersByTime(1)
    expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: false })
    expect(lastSlice(h, 'switch')).toEqual({ on: false })
    const warns = h.logs.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.extras).toMatchObject({ tags: { deviceId: DEVICE } })
    stop()
  })

  it("emits nothing for a method the provider marked hold: 'never' until the device reports", () => {
    const { h, stop } = rig({ switch: { setState: { hold: 'never' } } })
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    const before = h.events.length
    command('switch', 'setState', { on: true })
    expect(h.events.length).toBe(before)
    expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: false })
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: true })
    expect(lastSlice(h, 'switch')).toEqual({ on: true })
    stop()
  })

  it('holds a purifier speed set in Auto as the speed AND the manual mode', () => {
    const { h, stop } = rig()
    h.mirror.applySingleCapUpdate(DEVICE, 'fan-control', { speed: 20, preset: 'auto' })
    command('fan-control', 'setPercentage', { speed: 40 })
    expect(h.mirror.capSlice(DEVICE, 'fan-control')).toEqual({ speed: 40, preset: '' })
    // The device confirms the speed first: the mode stays held until it confirms too.
    h.mirror.applySingleCapUpdate(DEVICE, 'fan-control', { speed: 40, preset: 'auto' })
    expect(h.mirror.capSlice(DEVICE, 'fan-control')).toEqual({ speed: 40, preset: '' })
    h.mirror.applySingleCapUpdate(DEVICE, 'fan-control', { speed: 40, preset: '' })
    expect(h.mirror.capSlice(DEVICE, 'fan-control')).toEqual({ speed: 40, preset: '' })
    vi.advanceTimersByTime(60_000)
    expect(h.mirror.capSlice(DEVICE, 'fan-control')).toEqual({ speed: 40, preset: '' })
    expect(h.logs.filter((l) => l.level === 'warn')).toEqual([])
    stop()
  })

  it('lets the newer command on a field win, and the older one cannot revert it', () => {
    const { h, stop } = rig()
    h.mirror.applySingleCapUpdate(DEVICE, 'fan-control', { speed: 20, preset: '' })
    command('fan-control', 'setPercentage', { speed: 40 })
    vi.advanceTimersByTime(20_000)
    command('fan-control', 'setPercentage', { speed: 60 })
    expect(h.mirror.capSlice(DEVICE, 'fan-control')).toEqual({ speed: 60, preset: '' })
    vi.advanceTimersByTime(10_000)
    expect(h.mirror.capSlice(DEVICE, 'fan-control')).toEqual({ speed: 60, preset: '' })
    vi.advanceTimersByTime(20_000)
    expect(h.mirror.capSlice(DEVICE, 'fan-control')).toEqual({ speed: 20, preset: '' })
    expect(h.logs.filter((l) => l.level === 'warn')).toHaveLength(1)
    stop()
  })

  it("honours a provider's limit and extra effects", () => {
    const { h, stop } = rig({
      switch: { setState: { holdMs: 5_000, extraEffects: [{ field: 'busy', value: true }] } },
    })
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false, busy: false })
    command('switch', 'setState', { on: true })
    expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: true, busy: true })
    vi.advanceTimersByTime(5_000)
    expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: false, busy: false })
    stop()
  })

  it('serves the device slice as confirmed and the held one as effective', () => {
    const { h, stop } = rig()
    h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
    command('switch', 'setState', { on: true })
    expect(h.mirror.snapshotForDevice(DEVICE, 'confirmed')).toMatchObject({ switch: { on: false } })
    expect(h.mirror.snapshotForDevice(DEVICE)).toMatchObject({ switch: { on: true } })
    stop()
  })

  describe('the release rule: stale keeps, confirmed or answered releases', () => {
    function answered(h: Harness): readonly unknown[] {
      return h.logs
        .filter((l) => l.level === 'debug' && l.message.includes('the device answered'))
        .map((l) => l.extras)
    }

    it('keeps holding while the device still reports the pre-command value', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'locked' })
      command('lock-control', 'unlock', {})
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'locked' })
      expect(h.mirror.capSlice(DEVICE, 'lock-control')).toEqual({ state: 'unlocking' })
      expect(answered(h)).toEqual([])
      stop()
    })

    it('holds a lock as locking; the lock saying locking confirms it, locked follows', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'unlocked' })
      command('lock-control', 'lock', {})
      expect(h.mirror.capSlice(DEVICE, 'lock-control')).toEqual({ state: 'locking' })
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'locking' })
      expect(answered(h)).toEqual([])
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'locked' })
      expect(h.mirror.capSlice(DEVICE, 'lock-control')).toEqual({ state: 'locked' })
      vi.advanceTimersByTime(60_000)
      expect(h.mirror.capSlice(DEVICE, 'lock-control')).toEqual({ state: 'locked' })
      expect(h.logs.filter((l) => l.level === 'warn')).toEqual([])
      stop()
    })

    it('a lock that goes straight to locked releases the hold, logged device-answered', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'unlocked' })
      command('lock-control', 'lock', {})
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'locked' })
      expect(h.mirror.capSlice(DEVICE, 'lock-control')).toEqual({ state: 'locked' })
      expect(answered(h)).toEqual([
        {
          tags: { deviceId: DEVICE },
          meta: { cap: 'lock-control', field: 'state', reason: 'device-answered' },
        },
      ])
      stop()
    })

    it('a bolt that bounces back is never shown or told as locked', () => {
      const { h, told, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'unlocked' })
      command('lock-control', 'lock', {})
      // The lock reports its pre-command value again: the bolt did not throw.
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'unlocked' })
      expect(h.mirror.capSlice(DEVICE, 'lock-control')).toEqual({ state: 'locking' })
      vi.advanceTimersByTime(60_000)
      expect(h.mirror.capSlice(DEVICE, 'lock-control')).toEqual({ state: 'unlocked' })
      const states = [
        ...h.events.filter((e) => e.capName === 'lock-control').map((e) => e.slice?.['state']),
        ...told.filter((t) => t.capName === 'lock-control').map((t) => t.slice['state']),
      ]
      expect(states).not.toContain('locked')
      stop()
    })

    it('holds a feed as feeding for the short one-shot limit only', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'pet-feeder', { feeding: false })
      command('pet-feeder', 'feed', { grams: 10 })
      expect(h.mirror.capSlice(DEVICE, 'pet-feeder')).toEqual({ feeding: true })
      vi.advanceTimersByTime(ONE_SHOT_HOLD_MS - 1)
      expect(h.mirror.capSlice(DEVICE, 'pet-feeder')).toEqual({ feeding: true })
      vi.advanceTimersByTime(1)
      expect(h.mirror.capSlice(DEVICE, 'pet-feeder')).toEqual({ feeding: false })
      stop()
    })

    it('holds nothing when the lock is already locked', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'locked' })
      command('lock-control', 'lock', {})
      expect(h.mirror.capSlice(DEVICE, 'lock-control')).toEqual({ state: 'locked' })
      stop()
    })

    it('shows jammed when the lock jams', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'unlocked' })
      command('lock-control', 'lock', {})
      h.mirror.applySingleCapUpdate(DEVICE, 'lock-control', { state: 'jammed' })
      expect(h.mirror.capSlice(DEVICE, 'lock-control')).toEqual({ state: 'jammed' })
      stop()
    })

    it('holds an alarm panel as arming until the panel says armed', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'alarm-panel', { state: 'disarmed' })
      command('alarm-panel', 'arm', { mode: 'away' })
      expect(h.mirror.capSlice(DEVICE, 'alarm-panel')).toEqual({ state: 'arming' })
      h.mirror.applySingleCapUpdate(DEVICE, 'alarm-panel', { state: 'arming' })
      expect(h.mirror.capSlice(DEVICE, 'alarm-panel')).toEqual({ state: 'arming' })
      h.mirror.applySingleCapUpdate(DEVICE, 'alarm-panel', { state: 'armed_away' })
      expect(h.mirror.capSlice(DEVICE, 'alarm-panel')).toEqual({ state: 'armed_away' })
      stop()
    })

    it('takes a brightness within the step of the command as its confirmation (37 -> 36)', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'brightness', { level: 20 })
      command('brightness', 'setBrightness', { level: 37 })
      expect(h.mirror.capSlice(DEVICE, 'brightness')).toEqual({ level: 37 })
      h.mirror.applySingleCapUpdate(DEVICE, 'brightness', { level: 36 })
      expect(h.mirror.capSlice(DEVICE, 'brightness')).toEqual({ level: 36 })
      expect(answered(h)).toEqual([])
      vi.advanceTimersByTime(60_000)
      expect(h.logs.filter((l) => l.level === 'warn')).toEqual([])
      stop()
    })

    it('a value a newer command replaced is the device catching up, not an answer', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'fan-control', { speed: 20, preset: '' })
      command('fan-control', 'setPercentage', { speed: 40 })
      command('fan-control', 'setPercentage', { speed: 60 })
      h.mirror.applySingleCapUpdate(DEVICE, 'fan-control', { speed: 40, preset: '' })
      expect(h.mirror.capSlice(DEVICE, 'fan-control')).toEqual({ speed: 60, preset: '' })
      h.mirror.applySingleCapUpdate(DEVICE, 'fan-control', { speed: 60, preset: '' })
      expect(h.mirror.capSlice(DEVICE, 'fan-control', 'confirmed')).toEqual({
        speed: 60,
        preset: '',
      })
      vi.advanceTimersByTime(60_000)
      expect(h.logs.filter((l) => l.level === 'warn')).toEqual([])
      stop()
    })
  })

  describe('a hold ends with its device and with the process', () => {
    it('forgetting the device drops its holds and their timers', async () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
      command('switch', 'setState', { on: true })
      await h.mirror.forgetDevice(DEVICE)
      h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
      expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: false })
      vi.advanceTimersByTime(60_000)
      expect(h.logs.filter((l) => l.level === 'warn')).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      stop()
    })

    it('stopping the wiring drops every hold and timer', () => {
      const { h, stop } = rig()
      h.mirror.applySingleCapUpdate(DEVICE, 'switch', { on: false })
      command('switch', 'setState', { on: true })
      expect(vi.getTimerCount()).toBe(1)
      stop()
      expect(vi.getTimerCount()).toBe(0)
      expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: false })
      // A command after the stop is no longer observed.
      command('switch', 'setState', { on: true })
      expect(h.mirror.capSlice(DEVICE, 'switch')).toEqual({ on: false })
    })
  })
})
