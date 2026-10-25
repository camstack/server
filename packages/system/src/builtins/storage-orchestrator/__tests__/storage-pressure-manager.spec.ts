import type { IScopedLogger, IStorageEvictableProvider } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { type PressureManagerDeps, StoragePressureManager } from '../storage-pressure-manager.js'

function makeLogger(): IScopedLogger {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as IScopedLogger
  return Object.assign(l, { child: () => l, withTags: () => l })
}

interface FakeProvider extends IStorageEvictableProvider {
  readonly evictCalls: Array<{ locationId: string; targetBytes: number }>
}

/** A provider holding `bytes` that reclaims `reclaimPerEvict` per call until drained. */
function makeProvider(bytes: number, reclaimPerEvict = Infinity): FakeProvider {
  let remaining = bytes
  const evictCalls: Array<{ locationId: string; targetBytes: number }> = []
  return {
    evictCalls,
    async getEvictableUsage() {
      return { bytes: remaining }
    },
    async evict({ locationId, targetBytes }) {
      evictCalls.push({ locationId, targetBytes })
      const want = Math.min(targetBytes, reclaimPerEvict)
      const reclaimed = Math.min(remaining, want)
      remaining -= reclaimed
      return { reclaimedBytes: reclaimed, exhausted: remaining <= 0 }
    },
  }
}

function makeDeps(over: Partial<PressureManagerDeps>): PressureManagerDeps {
  return {
    logger: makeLogger(),
    getFreePercent: async () => 50,
    getVolumeTotalBytes: async () => 1_000_000,
    getEvictableProviders: () => [],
    getLocationThresholds: async () => new Map([['recordings:default', 10]]),
    ...over,
  }
}

describe('StoragePressureManager', () => {
  it('does nothing when free% is above the threshold', async () => {
    const provider = makeProvider(500_000)
    const mgr = new StoragePressureManager(
      makeDeps({
        getFreePercent: async () => 20, // > 10
        getEvictableProviders: () => [provider],
      }),
    )
    await mgr.sweep()
    expect(provider.evictCalls).toHaveLength(0)
  })

  it('skips locations whose threshold is 0 (guard off)', async () => {
    const provider = makeProvider(500_000)
    const mgr = new StoragePressureManager(
      makeDeps({
        getFreePercent: async () => 1, // breached if guarded
        getLocationThresholds: async () => new Map([['recordings:default', 0]]),
        getEvictableProviders: () => [provider],
      }),
    )
    await mgr.sweep()
    expect(provider.evictCalls).toHaveLength(0)
  })

  it('evicts on breach and stops once free% recovers', async () => {
    const provider = makeProvider(500_000)
    let calls = 0
    const mgr = new StoragePressureManager(
      makeDeps({
        // breached (5 < 10) on the first read, recovered (15) after one evict round
        getFreePercent: async () => (calls++ === 0 ? 5 : 15),
        getEvictableProviders: () => [provider],
        getVolumeTotalBytes: async () => 1_000_000,
      }),
    )
    await mgr.sweep()
    expect(provider.evictCalls).toHaveLength(1)
    // deficit = (10-5)+1 = 6% of 1_000_000 = 60_000
    expect(provider.evictCalls[0]!.targetBytes).toBe(60_000)
  })

  it('fans out proportionally to each provider footprint', async () => {
    const big = makeProvider(750_000)
    const small = makeProvider(250_000)
    let free = 5
    const mgr = new StoragePressureManager(
      makeDeps({
        getFreePercent: async () => free,
        getEvictableProviders: () => [big, small],
        getVolumeTotalBytes: async () => 1_000_000,
        maxRounds: 1,
      }),
    )
    await mgr.sweep()
    // target 60_000 split 75/25 → 45_000 / 15_000
    expect(big.evictCalls[0]!.targetBytes).toBe(45_000)
    expect(small.evictCalls[0]!.targetBytes).toBe(15_000)
  })

  it('stops (no infinite loop) when there is nothing evictable', async () => {
    const empty = makeProvider(0)
    const mgr = new StoragePressureManager(
      makeDeps({
        getFreePercent: async () => 1,
        getEvictableProviders: () => [empty],
      }),
    )
    await mgr.sweep()
    expect(empty.evictCalls).toHaveLength(0)
  })

  it('stops when a round makes no progress (providers exhausted)', async () => {
    // Reports bytes but reclaims nothing (e.g. all data pinned/locked).
    const stubborn: IStorageEvictableProvider = {
      async getEvictableUsage() {
        return { bytes: 500_000 }
      },
      async evict() {
        return { reclaimedBytes: 0, exhausted: true }
      },
    }
    const evictSpy = vi.spyOn(stubborn, 'evict')
    const mgr = new StoragePressureManager(
      makeDeps({
        getFreePercent: async () => 1, // never recovers
        getEvictableProviders: () => [stubborn],
        maxRounds: 8,
      }),
    )
    await mgr.sweep()
    // exactly one round: no progress → bail, NOT 8 rounds
    expect(evictSpy).toHaveBeenCalledTimes(1)
  })

  it('is bounded by maxRounds when eviction keeps making progress but never recovers', async () => {
    const bottomless = makeProvider(Number.MAX_SAFE_INTEGER, 10_000)
    const mgr = new StoragePressureManager(
      makeDeps({
        getFreePercent: async () => 1, // never recovers despite reclaiming
        getEvictableProviders: () => [bottomless],
        maxRounds: 3,
      }),
    )
    await mgr.sweep()
    expect(bottomless.evictCalls).toHaveLength(3)
  })

  // ── In-sweep physical-device dedup (M2 over-eviction guard) ──────────────
  describe('same-device relief dedup within one sweep', () => {
    it('relieves only the FIRST location on a shared physical device per sweep', async () => {
      // Two aliases (recordings / recordingsLow) on ONE disk: the first relief
      // frees the shared disk; re-relieving the second alias in the SAME sweep
      // could over-evict (lazy statfs still reads breached) → skip it this tick.
      const provider = makeProvider(500_000)
      const mgr = new StoragePressureManager(
        makeDeps({
          getFreePercent: async () => 5, // breached for both aliases
          getVolumeTotalBytes: async () => 1_000_000,
          getEvictableProviders: () => [provider],
          maxRounds: 1,
          getLocationThresholds: async () =>
            new Map([
              ['recordings:default', 10],
              ['recordingsLow:default', 10],
            ]),
          // Both aliases map to the same physical device key.
          getLocationDeviceKey: async () => '/recordings',
        }),
      )
      await mgr.sweep()
      // Exactly ONE relief round total — the second alias was skipped.
      expect(provider.evictCalls).toHaveLength(1)
    })

    it('relieves BOTH locations when they live on DISTINCT physical devices', async () => {
      const a = makeProvider(500_000)
      const b = makeProvider(500_000)
      const providers: Record<string, ReturnType<typeof makeProvider>> = {
        'a:default': a,
        'b:default': b,
      }
      const keys: Record<string, string> = { 'a:default': '/disk-a', 'b:default': '/disk-b' }
      let current = 'a:default'
      const mgr = new StoragePressureManager(
        makeDeps({
          getFreePercent: async () => 5,
          getVolumeTotalBytes: async () => 1_000_000,
          // relieveLocation is called per-location; route the provider + key by id.
          getEvictableProviders: () => [providers[current]!],
          maxRounds: 1,
          getLocationThresholds: async () =>
            new Map([
              ['a:default', 10],
              ['b:default', 10],
            ]),
          getLocationDeviceKey: async (id) => {
            current = id
            return keys[id] ?? null
          },
        }),
      )
      await mgr.sweep()
      expect(a.evictCalls).toHaveLength(1)
      expect(b.evictCalls).toHaveLength(1)
    })

    it('does NOT mark a device relieved when the first location was not breached', async () => {
      // A (threshold 5) is fine at 8% and does NOT relieve; B (threshold 20) on
      // the SAME disk IS breached at 8% → B must still get its relief this sweep.
      const provider = makeProvider(500_000)
      const mgr = new StoragePressureManager(
        makeDeps({
          getFreePercent: async () => 8,
          getVolumeTotalBytes: async () => 1_000_000,
          getEvictableProviders: () => [provider],
          maxRounds: 1,
          getLocationThresholds: async () =>
            new Map([
              ['loose:default', 5], // 8 >= 5 → not breached, no relief, no mark
              ['strict:default', 20], // 8 < 20 → breached, must relieve
            ]),
          getLocationDeviceKey: async () => '/shared-disk',
        }),
      )
      await mgr.sweep()
      // Only the strict location relieved (the loose one never breached).
      expect(provider.evictCalls).toHaveLength(1)
    })
  })
})
