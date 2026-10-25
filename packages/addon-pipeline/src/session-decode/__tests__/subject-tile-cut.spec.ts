/**
 * The window between "this frame is alive" and "its pixels have been read".
 *
 * `handleCutTiles` used to hold a JS reference to the retained frame across the
 * `await` of every subject's JPEG encode. That await is real async work, so the
 * worker services more IPC while it runs — and one of those messages is a `pull`
 * whose delivered frame calls `leaseStore.put`, which EVICTS the oldest held
 * frame. On dev:111 (hub runner, busy camera) that was the frame being cut:
 * the next subject read a freed node-av frame and reported
 * `unsupported pixel format -1 (planes=0, hw=false)` — AV_PIX_FMT_NONE, nothing
 * behind it.
 *
 * The fix is structural rather than defensive: EVERY pixel read happens in ONE
 * synchronous turn, before any encode is awaited. Nothing can free a frame
 * mid-turn, because the free would have to run on this same thread.
 *
 * What is pinned here is exactly that ordering — and it is pinned by a frame
 * that DIES the moment control returns to the event loop, which is what the live
 * failure did. Interleave extraction with encoding again (the pre-fix shape) and
 * these go red.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedRegion } from '../crop-geometry.js'
import type { NativeTile } from '../native-tile-store.js'
import {
  cutSubjectTiles,
  extractSubjectTiles,
  type RawSubjectTile,
  type SubjectTileCutPorts,
} from '../subject-tile-cut.js'
import type { NormalizedBbox } from '../worker-protocol.js'

/** A retained frame stand-in whose liveness the test controls. */
interface FakeFrame {
  live: boolean
}

const BBOXES: readonly NormalizedBbox[] = [
  { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
  { x: 0.3, y: 0.3, w: 0.1, h: 0.1 },
  { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
]

function region(index: number): ResolvedRegion {
  return { left: index * 10, top: index * 10, width: 8, height: 8 }
}

interface Harness {
  readonly frame: FakeFrame
  readonly ports: SubjectTileCutPorts<FakeFrame>
  readonly events: string[]
  readonly failures: string[]
}

function makeHarness(overrides: Partial<SubjectTileCutPorts<FakeFrame>> = {}): Harness {
  const frame: FakeFrame = { live: true }
  const events: string[] = []
  const failures: string[] = []
  let cut = 0
  const ports: SubjectTileCutPorts<FakeFrame> = {
    isLive: (f: FakeFrame): boolean => f.live,
    cutRaw: (f: FakeFrame): RawSubjectTile => {
      // The whole point: a read of a dead frame must be impossible, not merely
      // detected. If the ordering breaks, this throws where a real worker would
      // read recycled memory.
      if (!f.live) throw new Error('read a DEAD frame')
      const index = cut
      cut += 1
      events.push(`cut:${index}`)
      return { region: region(index), raw: new Uint8Array([index]) }
    },
    encode: async (tile: RawSubjectTile): Promise<NativeTile> => {
      events.push(`encode:${tile.raw[0]}`)
      // A real encode hands control back to the event loop; that is when the
      // eviction happened live, so the fake kills the frame at the same moment.
      await Promise.resolve()
      frame.live = false
      return { region: tile.region, bytes: new Uint8Array([255]) }
    },
    onFrameLost: (): void => {
      events.push('frameLost')
    },
    onCutFailed: (reason: string): void => {
      failures.push(reason)
    },
    ...overrides,
  }
  return { frame, ports, events, failures }
}

describe('cutSubjectTiles — a frame that dies during encoding', () => {
  it('reads every subject BEFORE the first encode, so the eviction cannot reach the pixels', async () => {
    const h = makeHarness()
    const tiles = await cutSubjectTiles(h.frame, BBOXES, h.ports)
    expect(tiles).toHaveLength(3)
    expect(h.failures).toEqual([])
    // Every read, then the hold ends, then the encodes. Not interleaved.
    expect(h.events).toEqual(['cut:0', 'cut:1', 'cut:2', 'encode:0', 'encode:1', 'encode:2'])
  })
})

describe('cutSubjectTiles — a frame that is already dead when the cut arrives', () => {
  it('never touches it: no cut is attempted, and the loss is reported ONCE', async () => {
    const h = makeHarness()
    h.frame.live = false
    const cutRaw = vi.spyOn(h.ports, 'cutRaw')
    const tiles = await cutSubjectTiles(h.frame, BBOXES, h.ports)
    expect(tiles).toEqual([])
    expect(cutRaw).not.toHaveBeenCalled()
    expect(h.events.filter((e) => e === 'frameLost')).toHaveLength(1)
    // The loss is not ALSO reported as three failed cuts — one event, one line.
    expect(h.failures).toEqual([])
  })
})

describe('extractSubjectTiles — an operational failure stays per subject', () => {
  it('a cut that throws costs its own subject and no other', () => {
    const h = makeHarness({
      cutRaw: (_f: FakeFrame, bbox: NormalizedBbox): RawSubjectTile => {
        if (bbox.x === 0.3) throw new Error('sws_scale failed: -22')
        return { region: region(0), raw: new Uint8Array([1]) }
      },
    })
    const raws = extractSubjectTiles(h.frame, BBOXES, h.ports)
    expect(raws).toHaveLength(2)
    expect(h.failures).toEqual(['sws_scale failed: -22'])
  })

  it('re-checks liveness before EACH read, so a frame lost mid-loop stops the loop', () => {
    const h = makeHarness({
      cutRaw: (f: FakeFrame): RawSubjectTile => {
        f.live = false // whatever killed it, the next read must not happen
        return { region: region(0), raw: new Uint8Array([1]) }
      },
    })
    const raws = extractSubjectTiles(h.frame, BBOXES, h.ports)
    expect(raws).toHaveLength(1)
    expect(h.events.filter((e) => e === 'frameLost')).toHaveLength(1)
  })
})

describe('cutSubjectTiles — an encode failure is not a pixel problem', () => {
  it('counts the subject and keeps the tiles that did encode', async () => {
    const h = makeHarness({
      encode: async (tile: RawSubjectTile): Promise<NativeTile> => {
        await Promise.resolve()
        if (tile.raw[0] === 1) throw new Error('jpeg encode failed')
        return { region: tile.region, bytes: new Uint8Array([255]) }
      },
    })
    const tiles = await cutSubjectTiles(h.frame, BBOXES, h.ports)
    expect(tiles).toHaveLength(2)
    expect(h.failures).toEqual(['jpeg encode failed'])
  })
})
