import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { batteryCapability, DeviceRuntimeState } from '@camstack/types'
import {
  attemptLedgerOverSlice,
  BatteryHourlyRefresh,
  carryRefreshBookkeeping,
  staggerOffsetMs,
  type RefreshBookkeeping,
} from '../battery-hourly-refresh.js'
import { createRecordingLogger } from './clip-test-logger.js'

/**
 * #666 — the scheduled refresh's bookkeeping must survive what a restart and
 * a later battery read do to the battery slice.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const DEVICE_ID = 640
const OFFSET = staggerOffsetMs(DEVICE_ID, HOUR)
const WINDOW_START = OFFSET + 1_000 * HOUR

function sourceOf(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')
}

interface PersistedSlice {
  fields: RefreshBookkeeping
}

describe('the attempt bookkeeping survives a restart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(WINDOW_START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** One "process": a fresh controller over the SAME persisted slice. */
  function boot(slice: PersistedSlice, counts: { wakes: number }, awake: { value: boolean }) {
    return new BatteryHourlyRefresh({
      deviceId: DEVICE_ID,
      logger: createRecordingLogger(),
      now: () => Date.now(),
      isAwake: () => awake.value,
      intervalMs: () => HOUR,
      lastFullRefreshAt: () => slice.fields.lastFullRefreshAt,
      wake: async () => {
        counts.wakes += 1
        return false // the camera never answers
      },
      // Found awake, the read fails hard: the window stays owed.
      refreshAll: async () => ({ failed: ['battery'] }),
      stamp: (at) => {
        slice.fields = { ...slice.fields, lastFullRefreshAt: at }
      },
      attemptLedger: attemptLedgerOverSlice(
        () => slice.fields,
        (fields) => {
          slice.fields = { ...slice.fields, ...fields }
        },
      ),
    })
  }

  it('two failed attempts in a window, then a restart: no third attempt (20:35 wake of 2026-11-23)', async () => {
    const slice: PersistedSlice = { fields: {} }
    const counts = { wakes: 0 }
    const awake = { value: true }

    const before = boot(slice, counts, awake)
    vi.setSystemTime(WINDOW_START + MIN)
    await before.tick() // attempt 1: found awake, refresh fails
    awake.value = false
    vi.setSystemTime(WINDOW_START + HOUR - 4 * MIN)
    await before.tick() // attempt 2: asleep at the deadline, the wake fails
    expect(counts.wakes).toBe(1)

    // The provider restarts: new controller, RAM gone, slice persisted.
    const after = boot(slice, counts, awake)
    vi.setSystemTime(WINDOW_START + HOUR - 2 * MIN)
    await after.tick()
    expect(counts.wakes).toBe(1)
  })
})

describe('a later battery read does not erase the stamp', () => {
  const stamp = 1_795_000_000_000

  it('a full-slice write that carries the bookkeeping keeps the stamp and the attempts', () => {
    const persisted = {
      level: 80,
      charging: 'none' as const,
      sleeping: true,
      lastUpdated: 1,
      lastFullRefreshAt: stamp,
      refreshAttemptWindow: 7,
      refreshAttempts: 2,
      refreshLastAttemptAt: stamp,
    }
    const state = DeviceRuntimeState.fromInitial({ battery: persisted }, async () => undefined)
    state.installCapSchema('battery', batteryCapability.runtimeState)

    // What a battery read composes: a fresh value, no bookkeeping of its own.
    const read: Record<string, unknown> = {
      level: 79,
      charging: 'none',
      sleeping: false,
      lastUpdated: 2,
    }
    const previous =
      state.getCapState<RefreshBookkeeping & Record<string, unknown>>('battery') ?? {}
    state.setCapState('battery', carryRefreshBookkeeping(previous, read))

    const next = state.getCapState('battery')
    expect(next?.['level']).toBe(79)
    expect(next?.['lastFullRefreshAt']).toBe(stamp)
    expect(next?.['refreshAttempts']).toBe(2)
  })

  it('WITHOUT carrying, the same write loses the stamp — the defect the helper exists for', () => {
    const state = DeviceRuntimeState.fromInitial(
      {
        battery: {
          level: 80,
          charging: 'none',
          sleeping: true,
          lastUpdated: 1,
          lastFullRefreshAt: stamp,
        },
      },
      async () => undefined,
    )
    state.installCapSchema('battery', batteryCapability.runtimeState)
    state.setCapState('battery', { level: 79, charging: 'none', sleeping: false, lastUpdated: 2 })
    expect(state.getCapState('battery')?.['lastFullRefreshAt']).toBeUndefined()
  })

  it('the camera composes its battery read through the helper', () => {
    const camera = sourceOf('reolink-camera.ts')
    const start = camera.indexOf('private updateBatteryCache(')
    const body = camera.slice(start, camera.indexOf('applyHubBatteryInfo(', start))
    expect(body).toContain('carryRefreshBookkeeping(this.state.battery')
  })

  it('the camera backs the controller with the persisted slice', () => {
    const camera = sourceOf('reolink-camera.ts')
    const start = camera.indexOf('private getBatteryRefresh()')
    const body = camera.slice(start, camera.indexOf('private async refreshEverythingNow', start))
    expect(body).toContain('attemptLedger: attemptLedgerOverSlice(')
  })
})
