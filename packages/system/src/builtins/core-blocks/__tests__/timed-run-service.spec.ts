import { DeviceType, type TimedRunStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { TimedRunRowBody } from '../record-kinds.js'
import {
  TimedRunService,
  type TimedRunActuation,
  type TimedRunRows,
} from '../timed-run/timed-run-service.js'
import { recordingLogger } from './fixtures.js'

const HEATER = 5
const FOUNTAIN = 6
const T0 = 1_000_000

function fakeRows(seed: Record<number, TimedRunRowBody> = {}) {
  const rows = new Map<number, TimedRunRowBody>(
    Object.entries(seed).map(([id, body]) => [Number(id), body]),
  )
  const api: TimedRunRows = {
    get: async (deviceId) => rows.get(deviceId) ?? null,
    put: async (deviceId, body) => {
      rows.set(deviceId, body)
    },
    remove: async (deviceId) => {
      rows.delete(deviceId)
    },
    all: async () => [...rows.entries()].map(([deviceId, body]) => ({ deviceId, body })),
  }
  return { rows, api }
}

function harness(
  options: { seed?: Record<number, TimedRunRowBody>; failOff?: boolean; failOn?: boolean } = {},
) {
  const clock = { now: T0 }
  const store = fakeRows(options.seed)
  const commands: { deviceId: number; actuator: string; on: boolean }[] = []
  const timers: { delayMs: number; fire: () => void; cancelled: boolean }[] = []
  const published: { deviceId: number; status: TimedRunStatus }[] = []
  const { logger, lines } = recordingLogger()
  const types = new Map<number, DeviceType>([
    [HEATER, DeviceType.Heater],
    [FOUNTAIN, DeviceType.PetFountain],
    [9, DeviceType.Camera],
  ])
  const quickRuns = new Map<number, number>()
  const actuation: TimedRunActuation = {
    set: async (deviceId, actuator, on) => {
      commands.push({ deviceId, actuator, on })
      if (on ? options.failOn === true : options.failOff === true) throw new Error('unreachable')
    },
  }
  const service = new TimedRunService({
    rows: store.api,
    deviceTypeOf: async (deviceId) => types.get(deviceId) ?? null,
    actuation,
    quickRuns: {
      read: async (deviceId) => quickRuns.get(deviceId) ?? null,
      write: async (deviceId, duration) => {
        if (duration === null) quickRuns.delete(deviceId)
        else quickRuns.set(deviceId, duration)
      },
    },
    publish: async (deviceId, status) => {
      published.push({ deviceId, status })
    },
    scheduler: {
      schedule: (delayMs, fire) => {
        const entry = { delayMs, fire, cancelled: false }
        timers.push(entry)
        return {
          cancel: () => {
            entry.cancelled = true
          },
        }
      },
    },
    now: () => clock.now,
    settleMs: 0,
    logger,
  })
  const live = () => timers.filter((t) => !t.cancelled)
  return { service, clock, store, commands, timers, live, published, lines, quickRuns }
}

describe('TimedRunService', () => {
  it('runFor persists the deadline, switches on, arms one timer, and the deadline switches off', async () => {
    const h = harness()
    const result = await h.service.runFor({ deviceId: HEATER, duration: 30, unit: 'min' })
    expect(result).toEqual({ ok: true, activeUntil: T0 + 30 * 60_000 })
    expect(h.store.rows.get(HEATER)?.activeUntil).toBe(T0 + 30 * 60_000)
    expect(h.commands).toEqual([{ deviceId: HEATER, actuator: 'switch', on: true }])
    expect(h.live()).toHaveLength(1)
    expect(h.live()[0]?.delayMs).toBe(30 * 60_000)

    h.clock.now = T0 + 30 * 60_000
    h.live()[0]?.fire()
    await h.service.settled()
    expect(h.commands.at(-1)).toEqual({ deviceId: HEATER, actuator: 'switch', on: false })
    expect(h.store.rows.has(HEATER)).toBe(false)
    expect(h.published.at(-1)?.status.activeUntil).toBeNull()
  })

  it('a pet fountain run uses the pump actuator, in seconds', async () => {
    const h = harness()
    const result = await h.service.runFor({ deviceId: FOUNTAIN, duration: 120, unit: 's' })
    expect(result).toEqual({ ok: true, activeUntil: T0 + 120_000 })
    expect(h.commands).toEqual([{ deviceId: FOUNTAIN, actuator: 'pet-fountain', on: true }])
  })

  it('refuses above the type maximum with the typed reason and arms nothing', async () => {
    const h = harness()
    const heater = await h.service.runFor({ deviceId: HEATER, duration: 181, unit: 'min' })
    expect(heater).toEqual({ ok: false, reason: 'over-max', maxSeconds: 180 * 60 })
    const fountain = await h.service.runFor({ deviceId: FOUNTAIN, duration: 301, unit: 's' })
    expect(fountain).toEqual({ ok: false, reason: 'over-max', maxSeconds: 300 })
    expect(h.commands).toEqual([])
    expect(h.store.rows.size).toBe(0)
    expect(h.timers).toHaveLength(0)
  })

  it('refuses a device type that has no timed run', async () => {
    const h = harness()
    expect(await h.service.runFor({ deviceId: 9, duration: 1, unit: 'min' })).toEqual({
      ok: false,
      reason: 'unsupported-device',
      maxSeconds: null,
    })
    expect(h.commands).toEqual([])
  })

  it('a failed on command leaves no row and no timer', async () => {
    const h = harness({ failOn: true })
    const result = await h.service.runFor({ deviceId: HEATER, duration: 10, unit: 'min' })
    expect(result).toEqual({ ok: false, reason: 'command-failed', maxSeconds: 180 * 60 })
    expect(h.store.rows.size).toBe(0)
    expect(h.live()).toHaveLength(0)
  })

  it('a second runFor replaces the first deadline', async () => {
    const h = harness()
    await h.service.runFor({ deviceId: HEATER, duration: 10, unit: 'min' })
    await h.service.runFor({ deviceId: HEATER, duration: 20, unit: 'min' })
    expect(h.live()).toHaveLength(1)
    expect(h.store.rows.get(HEATER)?.activeUntil).toBe(T0 + 20 * 60_000)
  })

  it('cancel forgets the deadline and leaves the device alone', async () => {
    const h = harness()
    await h.service.runFor({ deviceId: HEATER, duration: 10, unit: 'min' })
    await h.service.cancel({ deviceId: HEATER })
    expect(h.live()).toHaveLength(0)
    expect(h.store.rows.size).toBe(0)
    expect(h.commands.filter((c) => !c.on)).toEqual([])
  })

  it('a manual off cancels the pending timer silently', async () => {
    const h = harness()
    await h.service.runFor({ deviceId: HEATER, duration: 10, unit: 'min' })
    h.clock.now = T0 + 5_000
    await h.service.onDeviceState({ deviceId: HEATER, capName: 'switch', slice: { on: false } })
    expect(h.live()).toHaveLength(0)
    expect(h.store.rows.size).toBe(0)
    expect(h.commands.filter((c) => !c.on)).toEqual([])
  })

  it('an on observation does not cancel; a fountain pump stop does', async () => {
    const h = harness()
    await h.service.runFor({ deviceId: HEATER, duration: 10, unit: 'min' })
    await h.service.onDeviceState({ deviceId: HEATER, capName: 'switch', slice: { on: true } })
    expect(h.live()).toHaveLength(1)
    await h.service.runFor({ deviceId: FOUNTAIN, duration: 60, unit: 's' })
    await h.service.onDeviceState({
      deviceId: FOUNTAIN,
      capName: 'pet-fountain',
      slice: { pumpRunning: false },
    })
    expect(h.store.rows.has(FOUNTAIN)).toBe(false)
  })

  it('restart: a passed deadline switches off exactly once, a future one is re-armed', async () => {
    const h = harness({
      seed: {
        [HEATER]: {
          activeUntil: T0 - 1,
          requestedBy: null,
          requestedAt: T0 - 60_000,
          actuator: 'switch',
        },
        [FOUNTAIN]: {
          activeUntil: T0 + 90_000,
          requestedBy: null,
          requestedAt: T0,
          actuator: 'pet-fountain',
        },
      },
    })
    await h.service.reconcile()
    await h.service.settled()
    expect(h.commands).toEqual([{ deviceId: HEATER, actuator: 'switch', on: false }])
    expect(h.store.rows.has(HEATER)).toBe(false)
    expect(h.live()).toHaveLength(1)
    expect(h.live()[0]?.delayMs).toBe(90_000)
    await h.service.reconcile()
    await h.service.settled()
    expect(h.commands.filter((c) => c.deviceId === HEATER)).toHaveLength(1)
  })

  it('D49: a failed off is logged with the device tag, the row is dropped, and it is not retried', async () => {
    const h = harness({
      failOff: true,
      seed: {
        [HEATER]: {
          activeUntil: T0 - 1,
          requestedBy: null,
          requestedAt: T0 - 1000,
          actuator: 'switch',
        },
      },
    })
    await h.service.reconcile()
    await h.service.settled()
    expect(h.commands).toHaveLength(1)
    const failure = h.lines.find((l) => l.level === 'warn' || l.level === 'error')
    expect(failure?.extras).toMatchObject({ tags: { deviceId: HEATER } })
    expect(h.store.rows.has(HEATER)).toBe(false)
    expect(h.live()).toHaveLength(0)
  })

  it('stop cancels every timer', async () => {
    const h = harness()
    await h.service.runFor({ deviceId: HEATER, duration: 10, unit: 'min' })
    h.service.stop()
    expect(h.live()).toHaveLength(0)
  })

  describe('the one-tap run of a device', () => {
    it('is the type default until the operator sets one, and the status carries it', async () => {
      const h = harness()
      expect((await h.service.getStatus({ deviceId: HEATER })).quickRun).toEqual({
        duration: 30,
        unit: 'min',
      })
      expect((await h.service.getStatus({ deviceId: FOUNTAIN })).quickRun).toEqual({
        duration: 30,
        unit: 's',
      })
      await h.service.runFor({ deviceId: HEATER, duration: 10, unit: 'min' })
      expect(h.published.at(-1)?.status.quickRun).toEqual({ duration: 30, unit: 'min' })
    })

    it('a stored duration is what the status says, and is published at once', async () => {
      const h = harness()
      await h.service.setSettings({ deviceId: HEATER, settings: { quickRunDuration: 45 } })
      expect(h.quickRuns.get(HEATER)).toBe(45)
      expect((await h.service.getStatus({ deviceId: HEATER })).quickRun).toEqual({
        duration: 45,
        unit: 'min',
      })
      expect(h.published.at(-1)).toMatchObject({
        deviceId: HEATER,
        status: { quickRun: { duration: 45, unit: 'min' } },
      })
    })

    it('REFUSES a duration above the type maximum and keeps what was stored', async () => {
      const h = harness()
      await h.service.setSettings({ deviceId: HEATER, settings: { quickRunDuration: 45 } })
      await expect(
        h.service.setSettings({ deviceId: HEATER, settings: { quickRunDuration: 181 } }),
      ).rejects.toThrow(/maximum/)
      expect(h.quickRuns.get(HEATER)).toBe(45)
    })

    it('null returns to the type default', async () => {
      const h = harness()
      await h.service.setSettings({ deviceId: HEATER, settings: { quickRunDuration: 45 } })
      await h.service.setSettings({ deviceId: HEATER, settings: { quickRunDuration: null } })
      expect(h.quickRuns.has(HEATER)).toBe(false)
      expect((await h.service.getStatus({ deviceId: HEATER })).quickRun.duration).toBe(30)
    })

    it('a type without a timed run has no settings to change', async () => {
      const h = harness()
      await expect(
        h.service.setSettings({ deviceId: 9, settings: { quickRunDuration: 5 } }),
      ).rejects.toThrow(/no timed run/)
    })

    it('getOptions names the unit, the maximum and the default', async () => {
      const h = harness()
      expect(await h.service.getOptions({ deviceId: HEATER })).toEqual({
        unit: 'min',
        maxDuration: 180,
        defaultDuration: 30,
      })
    })
  })
})
