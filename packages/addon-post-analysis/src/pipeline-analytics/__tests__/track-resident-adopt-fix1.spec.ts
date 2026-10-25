/**
 * D683 Task 17 fix round 1 — the resident merge follows the WINNING best shot
 * (review H4), keeps the fallback that exists (M5), and late work under an
 * absorbed id never resurrects a ghost resident (M1).
 *
 * Disarms (each alone, restored):
 *  - make `keyFrameLanded` / `thumbnailLanded` / `keyFrameMediaId` / `keyFrameRetries`
 *    survivor-or-either again: "a landed LOSING shot does not close the winner's retry path" fails;
 *  - drop the alias redirect in `writable`: "late work under the absorbed id lands on the survivor" fails;
 *  - drop the holder check for best-shot writes: "a late landing of the LOSING shot is not applied" fails;
 *  - drop `bestShotHolder.delete` in `observeBestFrame`: "a newer survivor best supersedes" fails;
 *  - drop the retired-id refusal: "after the survivor closed, late work is refused and logged" fails;
 *  - make `rasterFallback` survivor-only: "the raster fallback that exists is kept" fails;
 *  - make `previewCaptureMiss` absorbed-only: "capture-miss counts add" fails.
 *  - drop `map.delete(survivorId)` from `BestDetectionTracker.adopt`'s `move` (review L2):
 *    "a field only the survivor carried does not ride on the absorbed peak" fails.
 * Compile-time (no test can show it): delete any rule from `RESIDENT_MERGE_RULES`,
 * or any key from `RESIDENT_MERGE_KEYS` — `tsc` fails.
 */
import { describe, expect, it } from 'vitest'
import { BestDetectionTracker } from '../pipeline/best-detection-tracker.js'
import { BEST_FRAME_POLICY } from '../pipeline/best-selection-policies.js'
import { TrackResidentState } from '../pipeline/track-resident-state.js'

/** B beats A on every axis `compareBestFrame` checks. */
function absorbedWinsRanking(r: TrackResidentState): void {
  r.observeBestFrame(1, 'A', 0.3, 100, false, 0.1, 0.1, 0.1, 0, false, 0.05)
  r.observeBestFrame(1, 'B', 0.95, 7000, true, 0.9, 0.95, 0.9, 1, true, 0.5)
}

/** A beats B on every axis. */
function survivorWinsRanking(r: TrackResidentState): void {
  r.observeBestFrame(1, 'A', 0.95, 100, true, 0.9, 0.95, 0.9, 1, true, 0.5)
  r.observeBestFrame(1, 'B', 0.3, 7000, false, 0.1, 0.1, 0.1, 0, false, 0.05)
}

describe('TrackResidentState.adopt — the best-shot fields follow the winner (H4)', () => {
  it('a landed LOSING shot does not close the winner’s retry path', () => {
    const r = new TrackResidentState()
    absorbedWinsRanking(r)
    r.noteKeyFrameAttempt(1, 'A', 200, true)
    r.noteKeyFrameAttempt(1, 'A', 300, true)
    r.markKeyFrameLanded(1, 'A')
    r.setKeyFrameMediaId(1, 'A', 11)
    r.markThumbnailLanded(1, 'A')
    expect(r.adopt('A', 'B').bestShotFrom).toBe('absorbed')
    expect(r.keyFrameCapture('A').landed).toBe(false)
    expect(r.keyFrameCapture('A').retries).toBe(0)
    expect(r.keyFrameMediaId('A')).toBeUndefined()
    expect(r.isThumbnailLanded('A')).toBe(false)
  })

  it('the survivor’s landed shot stays landed when it won', () => {
    const r = new TrackResidentState()
    survivorWinsRanking(r)
    r.markKeyFrameLanded(1, 'A')
    r.setKeyFrameMediaId(1, 'A', 11)
    r.markKeyFrameLanded(1, 'B')
    r.setKeyFrameMediaId(1, 'B', 22)
    expect(r.adopt('A', 'B').bestShotFrom).toBe('survivor')
    expect(r.keyFrameCapture('A').landed).toBe(true)
    expect(r.keyFrameMediaId('A')).toBe(11)
  })
})

describe('TrackResidentState.adopt — fallbacks and counters (M5)', () => {
  it('the raster fallback that exists is kept, the winner’s preferred', () => {
    const fa = { jpeg: Buffer.from('a'), timestamp: 1 }
    const fb = { jpeg: Buffer.from('b'), timestamp: 2 }
    const onlyB = new TrackResidentState()
    survivorWinsRanking(onlyB)
    onlyB.retainRasterFallback(1, 'B', fb)
    onlyB.adopt('A', 'B')
    expect(onlyB.closure('A')?.rasterFallback).toBe(fb)

    const both = new TrackResidentState()
    absorbedWinsRanking(both)
    both.retainRasterFallback(1, 'A', fa)
    both.retainRasterFallback(1, 'B', fb)
    both.adopt('A', 'B')
    expect(both.closure('A')?.rasterFallback).toBe(fb)
  })

  it('capture-miss counts add; the later reason is kept', () => {
    const r = new TrackResidentState()
    r.open(1, 'A')
    r.open(1, 'B')
    r.notePreviewCaptureMiss(1, 'A', 'keyframe:native-miss')
    r.notePreviewCaptureMiss(1, 'A', 'keyframe:native-miss')
    r.notePreviewCaptureMiss(1, 'B', 'thumbnail:overflow')
    r.adopt('A', 'B')
    expect(r.previewCaptureMiss('A')).toEqual({ reason: 'thumbnail:overflow', count: 3 })
  })
})

describe('TrackResidentState.adopt — late work under the absorbed id (M1)', () => {
  it('late work under the absorbed id lands on the survivor, no ghost', () => {
    const r = new TrackResidentState()
    absorbedWinsRanking(r)
    r.adopt('A', 'B')
    r.noteKeyFrameAttempt(1, 'B', 7100, false)
    r.markKeyFrameLanded(1, 'B')
    r.setKeyFrameMediaId(1, 'B', 22)
    r.setLastFrameAt(1, 'B', 9000)
    expect(r.size()).toBe(1)
    expect(r.trackIdsForDevice(1)).toEqual(['A'])
    expect(r.keyFrameCapture('A').landed).toBe(true)
    expect(r.keyFrameMediaId('A')).toBe(22)
    expect(r.lastFrameAt('A')).toBe(9000)
  })

  it('a late landing of the LOSING shot is not applied', () => {
    const r = new TrackResidentState()
    survivorWinsRanking(r)
    r.adopt('A', 'B')
    r.markKeyFrameLanded(1, 'B')
    r.setKeyFrameMediaId(1, 'B', 22)
    r.markThumbnailLanded(1, 'B')
    expect(r.size()).toBe(1)
    expect(r.keyFrameCapture('A').landed).toBe(false)
    expect(r.keyFrameMediaId('A')).toBeUndefined()
    expect(r.isThumbnailLanded('A')).toBe(false)
  })

  it('a newer survivor best supersedes the absorbed shot', () => {
    const r = new TrackResidentState()
    absorbedWinsRanking(r)
    r.adopt('A', 'B')
    // A frame on the survivor that beats B's held peak (later, same tiers, decisively higher).
    expect(r.observeBestFrame(1, 'A', 0.99, 60_000, true, 0.95, 0.99, 0.95, 1, true, 0.6)).toBe(
      true,
    )
    r.markKeyFrameLanded(1, 'B')
    expect(r.keyFrameCapture('A').landed).toBe(false)
  })

  it('after the survivor closed, late work is refused and logged with the device tag', () => {
    const refused: { deviceId: number; trackId: string }[] = []
    const r = new TrackResidentState({
      onLateAbsorbedWork: (e) => refused.push({ deviceId: e.deviceId, trackId: e.trackId }),
    })
    absorbedWinsRanking(r)
    r.adopt('A', 'B')
    r.close('A', 'end')
    r.markKeyFrameLanded(1, 'B')
    r.setKeyFrameMediaId(1, 'B', 22)
    expect(r.size()).toBe(0)
    expect(refused[0]).toEqual({ deviceId: 1, trackId: 'B' })
    // Sampled: one line per device per window, not one per write.
    expect(refused).toHaveLength(1)
  })
})

describe('BestDetectionTracker.adopt — the winning record is whole (L2)', () => {
  it('a field only the survivor carried does not ride on the absorbed peak', () => {
    const t = new BestDetectionTracker(BEST_FRAME_POLICY)
    t.observe('A', 0.3, 100, false, 0.1, 0.1, 0.1, 0, false, 0.05)
    t.observe('B', 0.95, 7000, true, 0.9, 0.95, 0.9, 1, true, undefined)
    expect(t.adopt('A', 'B')).toBe('absorbed')
    expect(t.heldCandidate('A')?.canvasFill).toBeUndefined()
    expect(t.heldCandidate('A')?.confidence).toBe(0.95)
  })
})

/**
 * D683 Task 18: the fusion sweep-up ranks every single-instance media kind by
 * the shot that is current AT CLOSE. Disarm: return the survivor's own id
 * unconditionally — "names the absorbed piece while its shot is current"
 * fails.
 */
describe('TrackResidentState.currentBestShotHolder (D683 Task 18)', () => {
  it('names the absorbed piece while its shot is current, and the survivor once it takes a better one', () => {
    const r = new TrackResidentState()
    absorbedWinsRanking(r)
    r.adopt('A', 'B')
    expect(r.currentBestShotHolder('A')).toBe('B')
    // An absorbed id asks on behalf of its survivor.
    expect(r.currentBestShotHolder('B')).toBe('B')
    // The survivor's own new best supersedes the absorbed shot.
    expect(r.observeBestFrame(1, 'A', 0.99, 9000, true, 0.95, 0.99, 0.95, 1, true, 0.6)).toBe(true)
    expect(r.currentBestShotHolder('A')).toBe('A')
  })

  it('is the survivor itself when its own shot won', () => {
    const r = new TrackResidentState()
    survivorWinsRanking(r)
    r.adopt('A', 'B')
    expect(r.currentBestShotHolder('A')).toBe('A')
  })
})
