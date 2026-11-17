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
})
