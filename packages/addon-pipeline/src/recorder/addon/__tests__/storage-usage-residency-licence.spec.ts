/**
 * The RESIDENCY LICENCE of `recording.getStorageUsage` (D295, D418).
 *
 * ## The defect this pins
 *
 * `getStorageUsage` answered with two quantities of different KINDS under
 * names that suggested they matched. `locations[].usedBytes` came from the
 * durable hour ledger — the ARCHIVE — and reported 1.9 TB on the live hub.
 * `devices[].usedBytes` and `devices[].oldestMs` came from
 * `RecordingIndex.accounting(deviceId)` — RESIDENCY, "the live tail plus the
 * hours somebody hydrated" — and reported 60.5 GB with an oldest of three
 * hours ago, on an archive holding 3.3 days.
 *
 * On 2026-09-09 that reading cost an operator and an assistant most of a day:
 * both concluded the recorder was holding three hours of history and evicting
 * recent footage under pressure. Nothing was wrong with the storage.
 *
 * ## Why the fixture is deliberately LOPSIDED
 *
 * Every assertion below runs against an index that holds a FRACTION of what
 * the ledger holds — never a fixture where the two agree, which is exactly
 * what let the original substitution ship and survive its tests. If an
 * implementation quietly reverts `devices[]` to `deps.index`, the numbers here
 * change and these tests go red.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import type { SegmentStore } from '../../segment-store.js'
import type { ArchiveDeviceUsage, SegmentRow } from '../../types.js'
import type { RecordingConfigsState } from '../config-store.js'
import { buildRecordingProvider, type RecordingProviderDeps } from '../recording-provider.js'
import { recordingsLocationOfMode } from '../roots.js'

const noopLogger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

const GB = 1_000_000_000
const HOUR_MS = 3_600_000
const NOW = 1_757_000_000_000

/** One resident row — what the RAM index happens to hold for a camera. */
function residentRow(deviceId: number, startMs: number, bytes: number): SegmentRow {
  return {
    deviceId,
    profile: 'high',
    startMs,
    durMs: 4_000,
    bytes,
    path: `${String(deviceId)}/high/2026/09/09/12/${String(startMs)}-4000-${String(bytes)}.m4s`,
    locationId: 'recordings:default',
  }
}

interface UsageHarness {
  readonly deps: RecordingProviderDeps
  /** Every `locationIds` set the ARCHIVE per-device read was asked about. */
  readonly asked: string[][]
  readonly warnings: string[]
}

/**
 * A provider whose index holds THREE resident hours for camera 101 and nothing
 * at all for 102, over a ledger that holds days of both.
 */
function usageHarness(
  archive: ((locationIds: ReadonlySet<string>) => ReadonlyMap<number, ArchiveDeviceUsage>) | null,
): UsageHarness {
  const index = new RecordingIndex()
  for (let i = 0; i < 3; i += 1) {
    index.addSegment(residentRow(101, NOW - (i + 1) * HOUR_MS, 20 * GB))
  }
  const asked: string[][] = []
  const warnings: string[] = []
  const logger: IScopedLogger = {
    ...noopLogger,
    warn: (message: string) => {
      warnings.push(message)
    },
  } as unknown as IScopedLogger

  const deps: RecordingProviderDeps = {
    index,
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'node-1',
    logger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => [
      recordingsLocationOfMode(
        { id: 'recordings:default', type: 'recordings', root: '/mnt/mixed' },
        'active',
      ),
    ],
    refreshLocations: async () => [],
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/data',
    playbackBaseUrl: () => null,
    archiveAccounting: async () => ({
      bytes: 1_900 * GB,
      count: 98_445,
      oldestMs: NOW - 80 * HOUR_MS,
      newestMs: NOW,
    }),
    ...(archive === null
      ? {}
      : {
          archiveDeviceUsage: (locationIds): ReadonlyMap<number, ArchiveDeviceUsage> => {
            asked.push([...locationIds].toSorted())
            return archive(locationIds)
          },
        }),
  }
  return { deps, asked, warnings }
}

/** The ledger's answer: days of footage for two cameras, on the one volume. */
function ledgerUsage(): ReadonlyMap<number, ArchiveDeviceUsage> {
  return new Map<number, ArchiveDeviceUsage>([
    [101, { bytes: 1_200 * GB, segments: 61_000, oldestMs: NOW - 80 * HOUR_MS, newestMs: NOW }],
    [102, { bytes: 700 * GB, segments: 37_445, oldestMs: NOW - 79 * HOUR_MS, newestMs: NOW }],
  ])
}

describe('getStorageUsage — devices[] is an ARCHIVE answer, never a residency one', () => {
  it('reports the ledger bytes and the ledger oldest, not the resident tail', async () => {
    const h = usageHarness(ledgerUsage)
    const provider = buildRecordingProvider(h.deps)
    const usage = await provider.getStorageUsage({})

    const row101 = usage.devices.find((d) => d.deviceId === 101)
    expect(row101?.usedBytes).toBe(1_200 * GB)
    expect(row101?.oldestMs).toBe(NOW - 80 * HOUR_MS)
    // The resident numbers, which the index CAN answer, are what the field used
    // to carry: 60 GB and three hours ago.
    expect(row101?.residentBytes).toBe(60 * GB)
    expect(row101?.residentOldestMs).toBe(NOW - 3 * HOUR_MS)
  })

  it('lists a camera whose footage is entirely COLD — the index has never seen it', async () => {
    const h = usageHarness(ledgerUsage)
    const provider = buildRecordingProvider(h.deps)
    const usage = await provider.getStorageUsage({})

    const row102 = usage.devices.find((d) => d.deviceId === 102)
    expect(row102?.usedBytes).toBe(700 * GB)
    expect(row102?.residentBytes).toBe(0)
    expect(usage.totalUsedBytes).toBe(1_900 * GB)
  })

  it('asks the archive ONCE for every camera, with the resolvable locations in one ask', async () => {
    const h = usageHarness(ledgerUsage)
    const provider = buildRecordingProvider(h.deps)
    await provider.getStorageUsage({})
    expect(h.asked).toEqual([['recordings:default']])
  })

  it('REFUSES rather than falling back to the index when this node has no archive', async () => {
    const h = usageHarness(null)
    const provider = buildRecordingProvider(h.deps)
    const usage = await provider.getStorageUsage({})

    expect(usage.devicesRead).toBe('unavailable')
    expect(usage.devices).toEqual([])
    expect(usage.totalUsedBytes).toBe(0)
    expect(h.warnings.join('\n')).toMatch(/per-camera/i)
  })

  it('says which quantity it answered with, so an operator is never left guessing', async () => {
    const h = usageHarness(ledgerUsage)
    const provider = buildRecordingProvider(h.deps)
    const usage = await provider.getStorageUsage({})
    expect(usage.devicesRead).toBe('archive')
  })

  it('SHOUTS when the per-camera sum and the per-volume total disagree', async () => {
    const h = usageHarness(
      () =>
        new Map<number, ArchiveDeviceUsage>([
          [101, { bytes: 10 * GB, segments: 5, oldestMs: NOW, newestMs: NOW }],
        ]),
    )
    const provider = buildRecordingProvider(h.deps)
    await provider.getStorageUsage({})
    // 10 GB of cameras against a 1 900 GB volume total: a gap that large is the
    // shape of the defect, and silence about it is what made it survive.
    expect(h.warnings.join('\n')).toMatch(/per-camera/i)
  })
})

describe('getStorageUsage — the licence cannot silently revert', () => {
  /**
   * The regression guard proper. `RecordingIndex.accounting` may still be read
   * for the RESIDENT columns; what it may never do again is decide `usedBytes`
   * or `oldestMs`. Poisoning the index's answer makes any such revert loud.
   */
  it('does not read usedBytes / oldestMs from the index even when the archive is thinner', async () => {
    const h = usageHarness(
      () =>
        new Map<number, ArchiveDeviceUsage>([
          [101, { bytes: 1 * GB, segments: 1, oldestMs: NOW - HOUR_MS, newestMs: NOW }],
        ]),
    )
    const spy = vi.spyOn(h.deps.index, 'accounting')
    const provider = buildRecordingProvider(h.deps)
    const usage = await provider.getStorageUsage({})

    expect(usage.devices).toHaveLength(1)
    expect(usage.devices[0]?.usedBytes).toBe(1 * GB)
    expect(usage.devices[0]?.oldestMs).toBe(NOW - HOUR_MS)
    // The index is consulted for the resident columns only — never per camera
    // more than once, and never for the census.
    expect(spy.mock.calls).toEqual([[101]])
    spy.mockRestore()
  })
})
