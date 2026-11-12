import { afterEach, describe, expect, it } from 'vitest'
import type {
  DeviceCommandObservation,
  DeviceCommandSettledEvent,
  DeviceTransition,
  IScopedLogger,
} from '@camstack/types'
import { COMMAND_MATCH_WINDOW_MS } from '../transition-correlator.js'
import {
  __resetCommandObserverRegistryForTests,
  getCommandObserverRegistry,
} from '../../../../kernel/command-observation.js'
import { harness } from '../../__tests__/mirror-harness.js'
import { startDeviceTransitions, type TransitionTicker } from '../transitions-wiring.js'

afterEach(() => __resetCommandObserverRegistryForTests())

function manualTicker() {
  const ticks: Array<() => void> = []
  const stopped: number[] = []
  const ticker: TransitionTicker = (fn) => {
    ticks.push(fn)
    const id = ticks.length
    return () => void stopped.push(id)
  }
  return { ticker, tick: () => ticks.forEach((t) => t()), stopped }
}

function setup(record?: (batch: readonly DeviceTransition[]) => Promise<void>) {
  const clock = { now: 1000 }
  const h = harness()
  const t = manualTicker()
  const recorded: DeviceTransition[][] = []
  const errors: string[] = []
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (m: string) => void errors.push(m),
    child: () => logger,
    withTags: () => logger,
  }
  const settled: DeviceCommandSettledEvent[] = []
  const handle = startDeviceTransitions({
    mirror: h.mirror,
    onCommandSettled: (e) => void settled.push(e),
    logger,
    record: record ?? (async (batch) => void recorded.push([...batch])),
    now: () => clock.now,
    ticker: t.ticker,
  })
  return { h, t, recorded, errors, handle, settled, clock }
}

const command = (over: Partial<DeviceCommandObservation> = {}): DeviceCommandObservation => ({
  deviceId: 7,
  capName: 'switch',
  method: 'setState',
  args: { deviceId: 7, on: true },
  actor: { kind: 'user', userId: 'u', username: 'ada', credential: 'session' },
  at: 1000,
  ...over,
})

describe('device transitions wiring (D1022)', () => {
  it('a command followed by the device reporting it reaches device-history on the next tick', async () => {
    const w = setup()
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    getCommandObserverRegistry().observe(command())
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    expect(w.recorded).toEqual([])
    w.t.tick()
    await Promise.resolve()
    await Promise.resolve()
    expect(w.recorded).toHaveLength(1)
    expect(w.recorded[0]?.[0]).toMatchObject({
      outcome: 'confirmed',
      field: 'on',
      from: false,
      to: true,
    })
    await w.handle.stop()
  })

  it('a call that is not a vocabulary command is not recorded', async () => {
    const w = setup()
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    getCommandObserverRegistry().observe(command({ method: 'notACommand' }))
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    w.t.tick()
    await Promise.resolve()
    await Promise.resolve()
    expect(w.recorded[0]?.[0]).toMatchObject({ outcome: 'device' })
    await w.handle.stop()
  })

  it('a command the device confirms is announced ONCE by its vocabulary action id, with actor and outcome, no args', async () => {
    const w = setup()
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    getCommandObserverRegistry().observe(command())
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    w.t.tick()
    expect(w.settled).toEqual([
      {
        deviceId: 7,
        action: 'switch.on',
        outcome: 'confirmed',
        actor: { kind: 'user', userId: 'u', username: 'ada', credential: 'session' },
        at: 1000,
      },
    ])
    await w.handle.stop()
  })

  it('announces a command whose target already held, with outcome already', async () => {
    const w = setup()
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    getCommandObserverRegistry().observe(command())
    w.t.tick()
    expect(w.settled).toEqual([
      expect.objectContaining({ action: 'switch.on', outcome: 'already' }),
    ])
    await w.handle.stop()
  })

  it('announces a command that caused nothing inside its window, with outcome unconfirmed', async () => {
    const w = setup()
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    getCommandObserverRegistry().observe(command())
    w.t.tick()
    expect(w.settled).toEqual([])
    w.clock.now += COMMAND_MATCH_WINDOW_MS
    w.t.tick()
    expect(w.settled).toEqual([
      expect.objectContaining({ action: 'switch.on', outcome: 'unconfirmed' }),
    ])
    await w.handle.stop()
  })

  it('announces a command whose call threw, with outcome failed', async () => {
    const w = setup()
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    const failure = Promise.reject(new Error('device unreachable'))
    getCommandObserverRegistry().observe(command({ outcome: failure }))
    await failure.catch(() => undefined)
    await Promise.resolve()
    expect(w.settled).toEqual([expect.objectContaining({ action: 'switch.on', outcome: 'failed' })])
    await w.handle.stop()
  })

  it("a change nobody asked for (the device's own) announces nothing", async () => {
    const w = setup()
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    w.t.tick()
    await Promise.resolve()
    await Promise.resolve()
    expect(w.recorded.flat()).toHaveLength(1)
    expect(w.settled).toEqual([])
    await w.handle.stop()
  })

  it('after stop nothing observes: no subscriber, the ticker is stopped', async () => {
    const w = setup()
    expect(getCommandObserverRegistry().observerCount()).toBe(1)
    await w.handle.stop()
    expect(getCommandObserverRegistry().observerCount()).toBe(0)
    expect(w.t.stopped).toHaveLength(1)
  })

  it('a stop that cannot send says how many rows it lost, for which device', async () => {
    const w = setup(async () => {
      throw new Error('hub gone')
    })
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    await w.handle.stop()
    expect(
      w.errors.some((e) => e.includes('abandoned at shutdown') && e.includes('1 transition')),
    ).toBe(true)
  })
})
