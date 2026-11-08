import { afterEach, describe, expect, it } from 'vitest'
import type { DeviceCommandObservation, DeviceTransition, IScopedLogger } from '@camstack/types'
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
  const handle = startDeviceTransitions({
    mirror: h.mirror,
    logger,
    record: record ?? (async (batch) => void recorded.push([...batch])),
    now: () => 1000,
    ticker: t.ticker,
  })
  return { h, t, recorded, errors, handle }
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
