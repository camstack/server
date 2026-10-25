import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { describe, it, expect, afterEach } from 'vitest'
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { RecordingIndex } from '../../recording-index.js'
import { segmentRelPath } from '../../segment-path.js'
import {
  hydrateDeviceFromStorage,
  locationForHydratedProfile,
  recordingsLocationOfMode,
} from '../roots.js'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-roots-spec-'))
  tmpDirs.push(root)
  return root
}

describe('hydrateDeviceFromStorage — staging isolation', () => {
  it('assigns aliased-root profiles by profile class, independent of location order', () => {
    const aliases = [
      recordingsLocationOfMode(
        { id: 'recordingsLow:default', type: 'recordingsLow', root: '/shared' },
        'active',
      ),
      recordingsLocationOfMode(
        { id: 'recordings:default', type: 'recordings', root: '/shared' },
        'active',
      ),
    ]
    expect(locationForHydratedProfile(aliases, 'high').id).toBe('recordings:default')
    expect(locationForHydratedProfile(aliases, 'mid').id).toBe('recordings:default')
    expect(locationForHydratedProfile(aliases, 'low').id).toBe('recordingsLow:default')
  })

  it('indexes finalized segments but never the per-location .rec-tmp staging dir', async () => {
    const root = await makeRoot()
    // One real finalized segment in the UTC bucket tree.
    const rel = segmentRelPath(99, 'low', 1_781_512_557_000, 4_000, 100)
    const finalized = path.join(root, rel)
    await fs.mkdir(path.dirname(finalized), { recursive: true })
    await fs.writeFile(finalized, new Uint8Array(100))
    // In-flight flat ffmpeg staging files under `<root>/.rec-tmp/<dev>/<profile>`
    // (R1 per-location staging) — outside the `<root>/<deviceId>/` walk AND
    // rejected by parseSegmentPath even if they ever leaked into a listing.
    const staging = path.join(root, '.rec-tmp', '99', 'low')
    await fs.mkdir(staging, { recursive: true })
    await fs.writeFile(path.join(staging, '1781512557.m4s'), new Uint8Array(50))
    await fs.writeFile(path.join(staging, 'live.m3u8'), '#EXTM3U\n')

    const index = new RecordingIndex()
    await hydrateDeviceFromStorage(
      {} as unknown as AddonApi,
      index,
      99,
      [recordingsLocationOfMode({ id: 'recordings', type: 'recordings', root }, 'active')],
      noopLogger,
    )

    const rows = index.segments(99)
    expect(rows.map((r) => r.path)).toEqual([rel])
    expect(index.accounting(99).count).toBe(1)
  })

  /**
   * The walk ANNOUNCES itself, or the reconcile that follows it deletes
   * durable rows for footage still on the array.
   *
   * `reconcileFromIndex` prunes an hour the index does not report — and since
   * D524 the index gives hours back to stay inside its budget. The only thing
   * that tells those two apart is `RecordingIndex.beginWalk`, called here.
   * Without it `droppedDuringWalk` answers `false` for a camera whose archive
   * the index just trimmed, and the ledger believes the short view.
   */
  it('announces the walk, so a trimmed index cannot be read as a shrunken disk', async () => {
    const root = await makeRoot()
    for (let i = 0; i < 12; i += 1) {
      const rel = segmentRelPath(99, 'low', 1_781_512_557_000 - (i + 3) * 3_600_000, 4_000, 100)
      const abs = path.join(root, rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, new Uint8Array(100))
    }

    const index = new RecordingIndex()
    index.armResidency({
      logger: noopLogger,
      now: () => 1_781_512_557_000,
      budget: {
        residentRowBudget: 4,
        residentHourBudget: 4,
        evictToFraction: 0.5,
        pinnedTailHours: 2,
      },
    })
    expect(index.droppedDuringWalk(99)).toBe(false)

    await hydrateDeviceFromStorage(
      {} as unknown as AddonApi,
      index,
      99,
      [recordingsLocationOfMode({ id: 'recordings', type: 'recordings', root }, 'active')],
      noopLogger,
    )

    expect(index.residency().evictedRows).toBeGreaterThan(0)
    expect(index.droppedDuringWalk(99)).toBe(true)
  })
})

/**
 * The boot hydrate is the other multi-minute phase that said nothing (D160).
 *
 * `fs.readdir(deviceDir, { recursive: true })` is >1M entries after a few weeks
 * (and 123 000 more after the D148 staging recovery lands), and everything from
 * there to `hydrateDevice` used to run as ONE synchronous block — measured at
 * 963 ms for a single device's 544 320 entries — with the only log line emitted
 * after EVERY device had finished.
 */
describe('hydrateDeviceFromStorage — phase reporting and yielding', () => {
  async function seed(root: string, deviceId: number, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const rel = segmentRelPath(deviceId, 'low', 1_781_512_557_000 + i * 10_000, 10_000, 100)
      const abs = path.join(root, rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, new Uint8Array(1))
    }
  }

  it('reports each device+root it walked, with counts and the deviceId tag', async () => {
    const root = await makeRoot()
    await seed(root, 99, 3)
    const lines: { message: string; extras: unknown }[] = []
    const logger = {
      debug: () => {},
      info: (message: string, extras: unknown) => lines.push({ message, extras }),
      warn: () => {},
      error: () => {},
    } as unknown as IScopedLogger

    await hydrateDeviceFromStorage(
      {} as unknown as AddonApi,
      new RecordingIndex(),
      99,
      [recordingsLocationOfMode({ id: 'recordings', type: 'recordings', root }, 'active')],
      logger,
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]!.message).toBe('recorder: hydrated a device from one recordings root')
    expect(lines[0]!.extras).toMatchObject({
      tags: { deviceId: 99 },
      meta: { root, indexed: 3, locationIds: ['recordings'] },
    })
  })

  it('hands the event loop back every chunk of entries', async () => {
    const root = await makeRoot()
    await seed(root, 99, 6)
    const index = new RecordingIndex()
    let yields = 0

    await hydrateDeviceFromStorage(
      {} as unknown as AddonApi,
      index,
      99,
      [recordingsLocationOfMode({ id: 'recordings', type: 'recordings', root }, 'active')],
      noopLogger,
      {
        chunkSize: 2,
        yieldBetween: async () => {
          yields += 1
        },
      },
    )

    // Six segments at two per chunk. Drop the chunking and the whole classify
    // loop is one uninterrupted stretch again — 963 ms for a real device.
    expect(index.accounting(99).count).toBe(6)
    expect(yields).toBe(3)
  })
})

/**
 * The boot walk is LATENCY-bound, not CPU-bound, and a device is done when its
 * own walk is done (D167).
 *
 * Measured on the live hub 2026-08-15: seven cameras, 357 s of `readdir` and a
 * wall clock of 362 s — the loop was `for … await`, so the sum WAS the wall
 * clock. The archive lives on a FUSE share where one cold hour directory costs
 * ~1.3 s; 24 of them cost 31 s sequentially and 16.7 s eight at a time. Nothing
 * here competes for CPU, so overlapping the devices is free.
 *
 * The second defect is worse than slow: `markHydratedAll` ran in a SEPARATE
 * loop after every device, so a camera whose walk finished at minute 1 still
 * answered `hydrationOf → 'unknown'` until minute 6 — and every read in that
 * window paid for a redundant on-demand walk that contended with the walk still
 * running for the other cameras.
 */
describe('hydrateDeviceFromStorage — empty disk wins', () => {
  it('replaces ghost segments when the device directory is missing', async () => {
    const root = await makeRoot()
    const index = new RecordingIndex()
    const ghost = segmentRelPath(99, 'high', 1_781_512_557_000, 4_000, 100)
    index.hydrateDevice(99, 'recordings', [ghost])
    expect(index.accounting(99).count).toBe(1)

    await hydrateDeviceFromStorage(
      {} as unknown as AddonApi,
      index,
      99,
      [recordingsLocationOfMode({ id: 'recordings', type: 'recordings', root }, 'active')],
      noopLogger,
    )

    expect(index.accounting(99).count).toBe(0)
  })

  it('clears a profile class the walk did not see on a shared root', async () => {
    const root = await makeRoot()
    const high = segmentRelPath(99, 'high', 1_781_512_557_000, 4_000, 100)
    const abs = path.join(root, high)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, new Uint8Array(1))

    const index = new RecordingIndex()
    const ghostLow = segmentRelPath(99, 'low', 1_781_512_557_000, 4_000, 50)
    index.hydrateDevice(99, 'recordingsLow:default', [ghostLow])

    await hydrateDeviceFromStorage(
      {} as unknown as AddonApi,
      index,
      99,
      [
        recordingsLocationOfMode({ id: 'recordings:default', type: 'recordings', root }, 'active'),
        recordingsLocationOfMode(
          { id: 'recordingsLow:default', type: 'recordingsLow', root },
          'active',
        ),
      ],
      noopLogger,
    )

    expect(
      index
        .segments(99)
        .map((r) => r.locationId)
        .toSorted(),
    ).toEqual(['recordings:default'])
  })
})
