/**
 * The bench needs byte-reproducible replays, and the tracker's ONE
 * non-deterministic input is the spawned id (`newTrackId`, random by design).
 * D681 makes the minter injectable and changes nothing else (spec §6.1).
 *
 * Pinned:
 *  - an injected minter names tracks in spawn order;
 *  - the default is still the production minter (10 chars of its alphabet);
 *  - the minter changes names only: two processors fed the same frames, one
 *    per minter, produce the same partition.
 *
 * Disarm: at the spawn site in `sort-tracker.ts`, call `newTrackId()` instead
 * of `this.mintTrackId()` — the first test must fail.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor, type FrameProcessorResult } from '../frame-processor.js'
import { sequentialTrackIdMinter, TRACK_ID_ALPHABET, TRACK_ID_LENGTH } from '../track-id.js'

function person(id: string, x: number): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 200, width: 60, height: 160 },
  }
}

function frame(t: number, dets: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${t}`,
    deviceId: 101,
    timestamp: t,
    width: 1280,
    height: 720,
    detections: dets,
  }
}

/** Two people far apart walking right, 12 frames at ~7 fps. */
function scene(): readonly FrameResult[] {
  return Array.from({ length: 12 }, (_, i) =>
    frame(1_000 + i * 140, [person(`a-${i}`, 100 + i * 4), person(`b-${i}`, 900 + i * 4)]),
  )
}

/** The slice of a processor result the partition reads. */
type PartitionInput = Pick<FrameProcessorResult, 'tracked'>

/** Detection id → track id, relabelled by first appearance so names drop out. */
function partition(results: readonly PartitionInput[]): readonly string[] {
  const names = new Map<string, string>()
  const out: string[] = []
  for (const r of results) {
    for (const t of r.tracked) {
      if (!names.has(t.trackId)) names.set(t.trackId, `#${String(names.size + 1)}`)
      out.push(`${t.sourceDetectionId ?? '-'}=${names.get(t.trackId) ?? ''}`)
    }
  }
  return out
}

describe('track id minter', () => {
  it('names tracks with the injected minter, in spawn order', () => {
    const p = new FrameProcessor(101, { minHits: 1 }, {}, {}, 'pipeline', {
      mintTrackId: sequentialTrackIdMinter(),
    })
    const r = p.process({ timestamp: 1_000, frame: scene()[0] ?? frame(0, []) })
    expect(r.tracked.map((t) => t.trackId).toSorted()).toEqual(['t1', 't2'])
  })

  it('defaults to the production minter', () => {
    const p = new FrameProcessor(101, { minHits: 1 })
    const r = p.process({ timestamp: 1_000, frame: scene()[0] ?? frame(0, []) })
    expect(r.tracked).toHaveLength(2)
    for (const t of r.tracked) {
      expect(t.trackId).toHaveLength(TRACK_ID_LENGTH)
      for (const ch of t.trackId) expect(TRACK_ID_ALPHABET).toContain(ch)
    }
  })

  it('changes names only — the partition is identical under either minter', () => {
    const a = new FrameProcessor(101, { minHits: 2 })
    const b = new FrameProcessor(101, { minHits: 2 }, {}, {}, 'pipeline', {
      mintTrackId: sequentialTrackIdMinter(),
    })
    const ra = scene().map((f) => a.process({ timestamp: f.timestamp, frame: f }))
    const rb = scene().map((f) => b.process({ timestamp: f.timestamp, frame: f }))
    expect(partition(rb)).toEqual(partition(ra))
    expect(partition(ra).length).toBeGreaterThan(0)
  })
})
