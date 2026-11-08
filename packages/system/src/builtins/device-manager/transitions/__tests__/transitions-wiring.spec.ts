import { afterEach, describe, expect, it } from 'vitest'
import type { DeviceCommandObservation, DeviceTransition, IScopedLogger } from '@camstack/types'
import { __resetCommandObserverRegistryForTests, getCommandObserverRegistry } from '../../../../kernel/command-observation.js'
import { harness } from '../../__tests__/mirror-harness.js'
import { startDeviceTransitions, type TransitionTimers } from '../transitions-wiring.js'

afterEach(() => __resetCommandObserverRegistryForTests())

function manualTimers() {
  const ticks: Array<() => void> = []
  const cleared: unknown[] = []
  const timers: TransitionTimers = {
    setInterval: (fn) => {
      ticks.push(fn)
      return ticks.length
    },
    clearInterval: (h) => void cleared.push(h),
  }
  return { timers, tick: () => ticks.forEach((t) => t()), cleared }
}


function setup() {
  const h = harness()
  const t = manualTimers()
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
    record: async (batch) => void recorded.push([...batch]),
    now: () => 1000,
    timers: t.timers,
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
    expect(w.recorded[0]?.[0]).toMatchObject({ outcome: 'confirmed', field: 'on', from: false, to: true })
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

  it('after stop nothing observes and the timer is cleared', async () => {
    const w = setup()
    await w.handle.stop()
    expect(w.t.cleared).toHaveLength(1)
    getCommandObserverRegistry().observe(command())
    w.h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    await w.handle.stop()
    expect(w.recorded).toEqual([])
  })
})
