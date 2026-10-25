/**
 * A deleted device's footage goes with it (D865): selected from the ARCHIVE,
 * evicted through the segment store, audited as `orphaned-device`, and a camera
 * that still has footage is NOT reported clean.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { SegmentRow } from '../../types.js'
import { createRecorderRemovalHook } from '../device-removal.js'
import type { RecordingProviderDeps } from '../recording-provider.js'

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

function row(deviceId: number, startMs: number): SegmentRow {
  return {
    deviceId,
    profile: 'high',
    locationId: 'loc-a',
    path: `${deviceId}/${startMs}.mp4`,
    startMs,
    durMs: 4000,
    bytes: 1000,
  }
}

interface World {
  readonly deps: RecordingProviderDeps
  readonly archive: SegmentRow[]
  readonly opsLog: ReturnType<typeof vi.fn>
  readonly evict: ReturnType<typeof vi.fn>
}

function world(opts: { evictFreesNothing?: boolean; noLedger?: boolean } = {}): World {
  const archive: SegmentRow[] = [row(4483, 1), row(4483, 2), row(4483, 3), row(7, 1)]
  const opsLog = vi.fn(async () => {})
  const evict = vi.fn(async (_loc: string, victims: readonly SegmentRow[]) => {
    if (opts.evictFreesNothing === true) return 0
    for (const v of victims) {
      const at = archive.findIndex((r) => r.deviceId === v.deviceId && r.startMs === v.startMs)
      if (at >= 0) archive.splice(at, 1)
    }
    return victims.reduce((sum, v) => sum + v.bytes, 0)
  })
  // Fake → interface: the provider deps are a wide surface; the removal path
  // reads these five members only.
  const deps = {
    logger: logger(),
    opsLog: { append: opsLog },
    segmentStore: { evict },
    locations: () => [{ id: 'loc-a', root: '/r' }],
    archiveDeviceUsage: () =>
      new Map([
        [
          4483,
          {
            bytes: 3000,
            segments: archive.filter((r) => r.deviceId === 4483).length,
            oldestMs: 1,
            newestMs: 3,
          },
        ],
        [7, { bytes: 1000, segments: 1, oldestMs: 1, newestMs: 1 }],
      ]),
    archive:
      opts.noLedger === true
        ? () => null
        : () => ({
            census: async ({ deviceId }: { deviceId?: number }) => {
              const rows = archive.filter((r) => r.deviceId === deviceId)
              return { segments: rows.length, bytes: rows.length * 1000, oldestMs: 1, newestMs: 3 }
            },
            streamSegments: async function* ({ deviceId }: { deviceId?: number }) {
              yield archive.filter((r) => r.deviceId === deviceId)
            },
          }),
  } as unknown as RecordingProviderDeps
  return { deps, archive, opsLog, evict }
}

describe('recorder device-removal-hook', () => {
  it('evicts every segment of the device, keeps the others, audits orphaned-device', async () => {
    const w = world()
    const hook = createRecorderRemovalHook(w.deps)

    const out = await hook.onDeviceRemoved({ deviceId: 4483, deletedAt: 1, providerAddonId: 'x' })

    expect(out.counts).toEqual({ footage: 3 })
    expect(w.archive.map((r) => r.deviceId)).toEqual([7])
    expect(w.opsLog).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'prune', reason: 'orphaned-device', deviceId: 4483 }),
    )
  })

  it('is idempotent: a second call finds nothing and audits nothing', async () => {
    const w = world()
    const hook = createRecorderRemovalHook(w.deps)
    await hook.onDeviceRemoved({ deviceId: 4483, deletedAt: 1, providerAddonId: 'x' })
    w.opsLog.mockClear()

    const again = await hook.onDeviceRemoved({ deviceId: 4483, deletedAt: 1, providerAddonId: 'x' })

    expect(again.counts).toEqual({ footage: 0 })
    expect(w.opsLog).not.toHaveBeenCalled()
  })

  it('a camera whose footage could not be evicted is NOT reported clean — the caller retries', async () => {
    const w = world({ evictFreesNothing: true })
    const hook = createRecorderRemovalHook(w.deps)

    await expect(
      hook.onDeviceRemoved({ deviceId: 4483, deletedAt: 1, providerAddonId: 'x' }),
    ).rejects.toThrow(/not fully removed/)
  })

  it('a node with no durable ledger refuses rather than falling back to the resident index', async () => {
    const w = world({ noLedger: true })
    const hook = createRecorderRemovalHook(w.deps)

    await expect(
      hook.onDeviceRemoved({ deviceId: 4483, deletedAt: 1, providerAddonId: 'x' }),
    ).rejects.toThrow(/hour ledger/)
    expect(w.evict).not.toHaveBeenCalled()
  })

  it('lists the footage it holds per device for the admin clean-up', async () => {
    const hook = createRecorderRemovalHook(world().deps)

    expect(await hook.listDeviceData()).toEqual([
      { store: 'footage', deviceId: 4483, count: 3 },
      { store: 'footage', deviceId: 7, count: 1 },
    ])
  })
})
