/**
 * The growth-matched drain ratchet (D386) — the five properties that make the
 * pace safe, each one named.
 */
import { describe, expect, it } from 'vitest'
import type { DrainState } from '../drain-ratchet.js'
import { drainProgressOf, stepDrain } from '../drain-ratchet.js'

const GB = 1024 ** 3

describe('the first sweep only ARMS the ratchet', () => {
  it('deletes nothing and records where the drain started', () => {
    const step = stepDrain(null, {
      locationId: 'recordings:old',
      usedBytes: 100 * GB,
      peerUsedBytes: 40 * GB,
      atMs: 1_000,
    })
    expect(step.capBytes).toBeNull()
    expect(step.growthBytes).toBeNull()
    expect(step.state.startBytes).toBe(100 * GB)
    expect(step.state.startedAtMs).toBe(1_000)
    expect(step.state.capBytes).toBe(100 * GB)
  })
})

describe('the pace is what the ACTIVE locations of the class gained', () => {
  it('cedes exactly the destination growth', () => {
    const armed = stepDrain(null, {
      locationId: 'recordings:old',
      usedBytes: 100 * GB,
      peerUsedBytes: 40 * GB,
      atMs: 0,
    }).state
    const step = stepDrain(armed, {
      locationId: 'recordings:old',
      usedBytes: 100 * GB,
      peerUsedBytes: 43 * GB,
      atMs: 60_000,
    })
    expect(step.growthBytes).toBe(3 * GB)
    expect(step.capBytes).toBe(97 * GB)
  })

  it('no growth in the destination ⇒ nothing is deleted this sweep', () => {
    const armed = stepDrain(null, {
      locationId: 'recordings:old',
      usedBytes: 100 * GB,
      peerUsedBytes: 40 * GB,
      atMs: 0,
    }).state
    const step = stepDrain(armed, {
      locationId: 'recordings:old',
      usedBytes: 100 * GB,
      peerUsedBytes: 40 * GB,
      atMs: 60_000,
    })
    expect(step.growthBytes).toBe(0)
    // The cap equals current usage, so `relieveToUsageCap` finds no excess.
    expect(step.capBytes).toBe(100 * GB)
  })
})

describe('the cap never rises again', () => {
  const shrunk: DrainState = {
    locationId: 'recordings:old',
    startedAtMs: 0,
    startBytes: 100 * GB,
    capBytes: 90 * GB,
    lastPeerBytes: 50 * GB,
    lastSweepMs: 60_000,
    observedGrowthBytes: 10 * GB,
    observedElapsedMs: 60_000,
  }

  it('survives a sweep where the destination SHRANK', () => {
    const step = stepDrain(shrunk, {
      locationId: 'recordings:old',
      usedBytes: 90 * GB,
      peerUsedBytes: 44 * GB,
      atMs: 120_000,
    })
    expect(step.growthBytes).toBe(-6 * GB)
    expect(step.capBytes).toBe(90 * GB)
    expect(step.state.observedGrowthBytes).toBe(10 * GB)
  })

  it('survives a sweep where growth was UNMEASURABLE', () => {
    const step = stepDrain(shrunk, {
      locationId: 'recordings:old',
      usedBytes: 90 * GB,
      peerUsedBytes: null,
      atMs: 120_000,
    })
    expect(step.growthBytes).toBeNull()
    expect(step.capBytes).toBe(90 * GB)
    // An unmeasurable sweep contributes no elapsed time either — otherwise a
    // stalled reader would slow the ETA it was never able to observe.
    expect(step.state.observedElapsedMs).toBe(60_000)
    expect(step.state.lastPeerBytes).toBe(50 * GB)
  })

  it('a location that grew back does not widen the cap', () => {
    const step = stepDrain(shrunk, {
      locationId: 'recordings:old',
      usedBytes: 95 * GB,
      peerUsedBytes: 50 * GB,
      atMs: 120_000,
    })
    expect(step.capBytes).toBe(90 * GB)
  })
})

describe('the state survives a process restart', () => {
  it('a reloaded state keeps ratcheting from the persisted cap, not from usage', () => {
    // What the store hands back after a restart. If this were recomputed from
    // scratch the cap would reset to 90 GB of *current* usage and every byte of
    // progress would be silently undone.
    const reloaded: DrainState = {
      locationId: 'recordings:old',
      startedAtMs: 0,
      startBytes: 100 * GB,
      capBytes: 80 * GB,
      lastPeerBytes: 60 * GB,
      lastSweepMs: 600_000,
      observedGrowthBytes: 20 * GB,
      observedElapsedMs: 600_000,
    }
    const step = stepDrain(reloaded, {
      locationId: 'recordings:old',
      usedBytes: 85 * GB,
      peerUsedBytes: 62 * GB,
      atMs: 660_000,
    })
    expect(step.capBytes).toBe(78 * GB)
    expect(step.state.startedAtMs).toBe(0)
    expect(step.state.startBytes).toBe(100 * GB)
  })
})

describe('reaching zero stops the ratchet', () => {
  it('reports drained and enforces no further cap', () => {
    const almost: DrainState = {
      locationId: 'recordings:old',
      startedAtMs: 0,
      startBytes: 100 * GB,
      capBytes: 0,
      lastPeerBytes: 90 * GB,
      lastSweepMs: 600_000,
      observedGrowthBytes: 50 * GB,
      observedElapsedMs: 600_000,
    }
    const step = stepDrain(almost, {
      locationId: 'recordings:old',
      usedBytes: 0,
      peerUsedBytes: 95 * GB,
      atMs: 660_000,
    })
    expect(step.drained).toBe(true)
    expect(step.capBytes).toBeNull()
  })
})

describe('progress a UI can render', () => {
  const state: DrainState = {
    locationId: 'recordings:old',
    startedAtMs: 0,
    startBytes: 100 * GB,
    capBytes: 90 * GB,
    lastPeerBytes: 50 * GB,
    lastSweepMs: 60_000,
    observedGrowthBytes: 10 * GB,
    observedElapsedMs: 60_000,
  }

  it('derives an empty time from the OBSERVED growth', () => {
    // 10 GB per 60 s observed → 90 GB remaining takes 540 s.
    const progress = drainProgressOf(state, 90 * GB, 60_000)
    expect(progress.bytesRemaining).toBe(90 * GB)
    expect(progress.estimatedEmptyAtMs).toBe(60_000 + 540_000)
  })

  it('reports NO date when growth has never been observed', () => {
    const unobserved: DrainState = { ...state, observedGrowthBytes: 0, observedElapsedMs: 0 }
    expect(drainProgressOf(unobserved, 90 * GB, 60_000).estimatedEmptyAtMs).toBeNull()
  })

  it('an empty location is drained, with no date', () => {
    const progress = drainProgressOf(state, 0, 60_000)
    expect(progress.drained).toBe(true)
    expect(progress.estimatedEmptyAtMs).toBeNull()
  })
})
