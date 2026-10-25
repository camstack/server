/**
 * D276 — the late-keyFrame preview upgrade.
 *
 * Live 2026-08-28, track 413c69ff… (dev 618): the keyFrame row landed 8 s
 * AFTER the close (queued exec finished late) while the tile stayed the 5 KB
 * face-crop stand-in forever. What is pinned here:
 *
 *  - the registry is claim-once (`take` removes) and bounded (TTL + cap);
 *  - a `native`-ranked held tile is NEVER overwritten by the upgrade;
 *  - a redeemed upgrade writes BOTH variants at `native` provenance and
 *    clears the persisted miss reason;
 *  - every non-upgraded outcome with a pending entry logs itself.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { MediaProvenance } from '../../store/media-store.js'
import {
  PENDING_PREVIEW_TTL_MS,
  type PendingPreviewUpgrade,
  PendingPreviewUpgrades,
  type PreviewUpgradeDeps,
  type PreviewUpgradePut,
  runPreviewUpgrade,
} from '../preview-upgrade.js'

const DEVICE_ID = 108
const TRACK_ID = '413c69ff'

function makeLogger(): { logger: IScopedLogger; infos: string[] } {
  const infos: string[] = []
  const logger = {
    debug: () => {},
    info: (message: string) => {
      infos.push(message)
    },
    warn: () => {},
    error: () => {},
    child: (): IScopedLogger => logger,
    withTags: (): IScopedLogger => logger,
  }
  return { logger, infos }
}

function entry(overrides: Partial<PendingPreviewUpgrade> = {}): PendingPreviewUpgrade {
  return {
    deviceId: DEVICE_ID,
    trackId: TRACK_ID,
    bestSeen: {
      x: 10,
      y: 20,
      w: 100,
      h: 200,
      frameWidth: 640,
      frameHeight: 360,
      timestamp: 19_400,
    },
    recordedAtMs: 1_000,
    ...overrides,
  }
}

interface DepsHarness {
  readonly deps: PreviewUpgradeDeps
  readonly puts: PreviewUpgradePut[]
  readonly cleared: Array<{ deviceId: number; trackId: string }>
  readonly infos: string[]
}

function makeDeps(options: {
  readonly pending?: PendingPreviewUpgrade
  readonly held?: MediaProvenance | null
  readonly derive?: 'ok' | 'null'
}): DepsHarness {
  const registry = new PendingPreviewUpgrades({ now: () => 1_000 })
  if (options.pending) registry.record(options.pending)
  const puts: PreviewUpgradePut[] = []
  const cleared: Array<{ deviceId: number; trackId: string }> = []
  const { logger, infos } = makeLogger()
  const deps: PreviewUpgradeDeps = {
    takePending: (trackId) => registry.take(trackId),
    heldThumbnailProvenance: async () => options.held ?? null,
    derive: async () =>
      options.derive === 'null'
        ? null
        : {
            thumbnail: Buffer.from('upgraded-thumb'),
            thumbnailSmall: Buffer.from('upgraded-small'),
            skewMs: 3,
          },
    put: async (input) => {
      puts.push(input)
    },
    clearPreviewMiss: async (deviceId, trackId) => {
      cleared.push({ deviceId, trackId })
    },
    logger,
  }
  return { deps, puts, cleared, infos }
}

/** The just-landed keyFrame's media ROW id (D482) — an arbitrary non-zero
 *  rowid, not a composite key. */
const KEY_FRAME_MEDIA_ID = 4242

const INPUT = {
  deviceId: DEVICE_ID,
  trackId: TRACK_ID,
  keyFrameMediaId: KEY_FRAME_MEDIA_ID,
  timestamp: 20_000,
}

describe('PendingPreviewUpgrades — bounded claim-once registry', () => {
  it('take claims the entry exactly once', () => {
    const registry = new PendingPreviewUpgrades({ now: () => 1_000 })
    registry.record(entry())
    expect(registry.take(TRACK_ID)).toBeDefined()
    expect(registry.take(TRACK_ID)).toBeUndefined()
  })

  it('expires entries past the TTL', () => {
    let now = 1_000
    const registry = new PendingPreviewUpgrades({ now: () => now })
    registry.record(entry({ recordedAtMs: 1_000 }))
    now = 1_000 + PENDING_PREVIEW_TTL_MS + 1
    expect(registry.take(TRACK_ID)).toBeUndefined()
  })

  it('evicts the OLDEST entry over the cap', () => {
    const registry = new PendingPreviewUpgrades({ now: () => 1_000, maxEntries: 2 })
    registry.record(entry({ trackId: 'a' }))
    registry.record(entry({ trackId: 'b' }))
    registry.record(entry({ trackId: 'c' }))
    expect(registry.size).toBe(2)
    expect(registry.take('a')).toBeUndefined()
    expect(registry.take('b')).toBeDefined()
    expect(registry.take('c')).toBeDefined()
  })
})

describe('runPreviewUpgrade', () => {
  it('no pending entry → nothing happens (the common live-track landing)', async () => {
    const h = makeDeps({})
    const outcome = await runPreviewUpgrade(h.deps, INPUT)
    expect(outcome).toBe('no-pending')
    expect(h.puts).toEqual([])
    expect(h.cleared).toEqual([])
  })

  it('a held NATIVE tile is never overwritten — logged, no puts, no clear', async () => {
    const h = makeDeps({ pending: entry(), held: 'native' })
    const outcome = await runPreviewUpgrade(h.deps, INPUT)
    expect(outcome).toBe('held-native')
    expect(h.puts).toEqual([])
    expect(h.cleared).toEqual([])
    expect(h.infos).toContain('late keyFrame: preview already native — no upgrade')
  })

  it('a standin tile is replaced: both variants written native, miss cleared', async () => {
    const h = makeDeps({ pending: entry(), held: 'standin' })
    const outcome = await runPreviewUpgrade(h.deps, INPUT)
    expect(outcome).toBe('upgraded')
    expect(h.puts).toHaveLength(2)
    expect(h.puts[0]).toMatchObject({
      deviceId: DEVICE_ID,
      trackId: TRACK_ID,
      kind: 'thumbnail',
      timestamp: 20_000,
      provenance: 'native',
    })
    expect(h.puts[0]?.data.toString()).toBe('upgraded-thumb')
    expect(h.puts[1]).toMatchObject({ kind: 'thumbnailSmall', provenance: 'native' })
    expect(h.cleared).toEqual([{ deviceId: DEVICE_ID, trackId: TRACK_ID }])
    expect(h.infos).toContain('best-shot upgraded from late keyFrame (stand-in replaced)')
  })

  it('a missing tile (no thumbnail row at all) is redeemed the same way', async () => {
    const h = makeDeps({ pending: entry(), held: null })
    const outcome = await runPreviewUpgrade(h.deps, INPUT)
    expect(outcome).toBe('upgraded')
    expect(h.puts).toHaveLength(2)
  })

  it('no best-seen bbox → tile kept, logged, nothing written', async () => {
    const noBbox: PendingPreviewUpgrade = {
      deviceId: DEVICE_ID,
      trackId: TRACK_ID,
      recordedAtMs: 1_000,
    }
    const h = makeDeps({ pending: noBbox, held: 'standin' })
    const outcome = await runPreviewUpgrade(h.deps, INPUT)
    expect(outcome).toBe('no-bbox')
    expect(h.puts).toEqual([])
    expect(h.infos).toContain(
      'late keyFrame landed but no subject bbox was ever seen — tile kept as-is',
    )
  })

  it('a derive miss keeps the tile and says so', async () => {
    const h = makeDeps({ pending: entry(), held: 'standin', derive: 'null' })
    const outcome = await runPreviewUpgrade(h.deps, INPUT)
    expect(outcome).toBe('derive-miss')
    expect(h.puts).toEqual([])
    expect(h.cleared).toEqual([])
    expect(h.infos).toContain(
      'late keyFrame preview upgrade failed (derive miss) — tile kept as-is',
    )
  })

  it('the upgrade fires at most once — a second landing finds no pending entry', async () => {
    const h = makeDeps({ pending: entry(), held: 'standin' })
    expect(await runPreviewUpgrade(h.deps, INPUT)).toBe('upgraded')
    expect(await runPreviewUpgrade(h.deps, INPUT)).toBe('no-pending')
    expect(h.puts).toHaveLength(2)
  })

  it('derive receives the best-seen region of the JUST-landed keyFrame', async () => {
    const h = makeDeps({ pending: entry(), held: 'standin' })
    const deriveSpy = vi.fn(h.deps.derive)
    await runPreviewUpgrade({ ...h.deps, derive: deriveSpy }, INPUT)
    expect(deriveSpy).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      mediaId: KEY_FRAME_MEDIA_ID,
      bbox: { x: 10, y: 20, w: 100, h: 200 },
      frameWidth: 640,
      frameHeight: 360,
      // The BOX's instant, not the keyFrame's (`INPUT.timestamp` is 20_000).
      // Passing the keyFrame's own timestamp would hand the guard a pair of
      // identical instants and disarm it — the close-path regression of
      // 2026-08-24, which lived here too.
      timestamp: 19_400,
    })
  })

  it('a pre-guard pending entry (no box instant) is REFUSED, not cut blind', async () => {
    const stale = entry({
      bestSeen: { x: 10, y: 20, w: 100, h: 200, frameWidth: 640, frameHeight: 360 },
    })
    const h = makeDeps({ pending: stale, held: 'standin' })
    const deriveSpy = vi.fn(h.deps.derive)
    const outcome = await runPreviewUpgrade({ ...h.deps, derive: deriveSpy }, INPUT)
    expect(outcome).toBe('no-bbox')
    expect(deriveSpy).not.toHaveBeenCalled()
    expect(h.puts).toEqual([])
    expect(h.infos).toContain(
      'late keyFrame: pending entry predates the motion guard — tile kept as-is',
    )
  })
})
