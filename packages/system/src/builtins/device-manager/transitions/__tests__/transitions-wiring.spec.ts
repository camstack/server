import { afterEach, describe, expect, it } from 'vitest'
import type {
  DeviceCommandObservation,
  DeviceCommandSettledEvent,
  DeviceTransition,
  IScopedLogger,
} from '@dominevo/types'
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
    ticker: t.ticker,
  })
  return { h, t, recorded, errors, handle, settled }
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

describe('device command audit wiring (D1022, D1084)', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
  }

  it('a command writes exactly ONE row, on the next tick, and nothing waits for the device', async () => {
    const w = setup()
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    getCommandObserverRegistry().observe(command())
    w.t.tick()
    await flush()
    expect(w.recorded.flat()).toHaveLength(1)
    expect(w.recorded[0]?.[0]).toMatchObject({
      outcome: 'ok',
      field: 'on',
      from: false,
      to: true,
      actor: { kind: 'user' },
    })
    // the device reporting the change later adds no row: the change is read from history
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    w.t.tick()
    await flush()
    expect(w.recorded.flat()).toHaveLength(1)
    await w.handle.stop()
  })

  it('a call still in flight writes nothing until it settles', async () => {
    const w = setup()
    let finish: () => void = () => undefined
    const inflight = new Promise<void>((resolve) => {
      finish = resolve
    })
    getCommandObserverRegistry().observe(command({ outcome: inflight }))
    w.t.tick()
    await flush()
    expect(w.recorded.flat()).toEqual([])
    finish()
    await flush()
    w.t.tick()
    await flush()
    expect(w.recorded.flat()).toEqual([expect.objectContaining({ outcome: 'ok' })])
    await w.handle.stop()
  })

  it('a call that is not a vocabulary command is not recorded', async () => {
    const w = setup()
    getCommandObserverRegistry().observe(command({ method: 'notACommand' }))
    w.t.tick()
    await flush()
    expect(w.recorded.flat()).toEqual([])
    await w.handle.stop()
  })

  it('a device change nobody asked for writes no row at all (it is derived from history on read)', async () => {
    const w = setup()
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: false })
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    w.t.tick()
    await flush()
    await w.handle.stop()
    expect(w.recorded.flat()).toEqual([])
    expect(w.settled).toEqual([])
  })

  it('a completed command is announced ONCE by its vocabulary action id, with actor and outcome ok, no args', async () => {
    const w = setup()
    getCommandObserverRegistry().observe(command())
    expect(w.settled).toEqual([
      {
        deviceId: 7,
        action: 'switch.on',
        outcome: 'ok',
        actor: { kind: 'user', userId: 'u', username: 'ada', credential: 'session' },
        at: 1000,
      },
    ])
    await w.handle.stop()
  })

  it('a call that threw writes failed, with its message scrubbed, and announces failed', async () => {
    const w = setup()
    const failure = Promise.reject(new Error('device unreachable'))
    getCommandObserverRegistry().observe(command({ outcome: failure }))
    await failure.catch(() => undefined)
    await flush()
    expect(w.settled).toEqual([expect.objectContaining({ action: 'switch.on', outcome: 'failed' })])
    w.t.tick()
    await flush()
    expect(w.recorded.flat()).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        command: expect.objectContaining({ error: 'device unreachable' }),
      }),
    ])
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
    getCommandObserverRegistry().observe(command())
    await w.handle.stop()
    expect(
      w.errors.some((e) => e.includes('abandoned at shutdown') && e.includes('1 transition')),
    ).toBe(true)
  })
})
