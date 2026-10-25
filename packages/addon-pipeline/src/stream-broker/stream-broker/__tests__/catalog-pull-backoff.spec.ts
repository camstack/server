/**
 * The catalog-pull ladder itself: it is the repo's ONE retry schedule, it
 * escalates, and — unlike boot recovery — it CLAMPS instead of ending, so a
 * camera that silently starts working again is always eventually re-asked.
 */
import { describe, it, expect } from 'vitest'
import { BOOT_RECOVERY_BACKOFF_MS } from '@camstack/types'
import {
  catalogPullRetryDelayMs,
  mayAttemptPolledCatalogPull,
  nextCatalogPullFailureState,
} from '../catalog-pull-backoff.js'

const LAST_RUNG = BOOT_RECOVERY_BACKOFF_MS[BOOT_RECOVERY_BACKOFF_MS.length - 1]

describe('catalogPullRetryDelayMs', () => {
  it('walks the shared boot-recovery ladder, failure by failure', () => {
    const walked = BOOT_RECOVERY_BACKOFF_MS.map((_rung, i) => catalogPullRetryDelayMs(i + 1))
    expect(walked).toEqual([...BOOT_RECOVERY_BACKOFF_MS])
  })

  it('CLAMPS at the last rung instead of running out', () => {
    // A chain that ends turns a transient session expiry into a permanent
    // outage: nothing else ever asks a camera nobody is watching.
    expect(catalogPullRetryDelayMs(BOOT_RECOVERY_BACKOFF_MS.length + 1)).toBe(LAST_RUNG)
    expect(catalogPullRetryDelayMs(10_000)).toBe(LAST_RUNG)
  })

  it('never returns a delay short enough to hot-loop', () => {
    for (let n = 1; n <= 50; n++) {
      expect(catalogPullRetryDelayMs(n)).toBeGreaterThanOrEqual(15_000)
    }
  })
})

describe('nextCatalogPullFailureState', () => {
  it('starts at one failure and schedules the first rung', () => {
    const state = nextCatalogPullFailureState(undefined, 1_000)
    expect(state.consecutiveFailures).toBe(1)
    expect(state.nextAttemptAtMs).toBe(1_000 + BOOT_RECOVERY_BACKOFF_MS[0]!)
  })

  it('escalates on every further failure', () => {
    const first = nextCatalogPullFailureState(undefined, 0)
    const second = nextCatalogPullFailureState(first, 0)
    expect(second.consecutiveFailures).toBe(2)
    expect(second.nextAttemptAtMs).toBeGreaterThan(first.nextAttemptAtMs)
  })
})

describe('mayAttemptPolledCatalogPull', () => {
  it('always allows a device with no failure memory', () => {
    expect(mayAttemptPolledCatalogPull(undefined, 0)).toBe(true)
  })

  it('blocks before the rung elapses and allows on it', () => {
    const state = nextCatalogPullFailureState(undefined, 0)
    expect(mayAttemptPolledCatalogPull(state, state.nextAttemptAtMs - 1)).toBe(false)
    expect(mayAttemptPolledCatalogPull(state, state.nextAttemptAtMs)).toBe(true)
  })
})
