import { describe, it, expect } from 'vitest'
import { TrackResidentState, type TrackCloseMode } from '../track-resident-state.js'
import { TRACK_CLOSE_MODES } from '../../__tests__/fixtures/track-close-modes.js'

/** Deterministic per-trackId keyFrame media ROW id (D482) — not a real
 *  rowid, just a stable, non-zero number the fixture can assert back against
 *  for a given trackId within one test. */
function mediaIdFor(trackId: string): number {
  let hash = 0
  for (const ch of trackId) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000
  return hash + 1000
}

/** Populate EVERY per-track container for one track so a close-invariant test
 *  can prove the full litany ran. */
function populate(residents: TrackResidentState, deviceId: number, trackId: string): void {
  residents.open(deviceId, trackId)
  residents.observeBestFrame(deviceId, trackId, 0.9, 1_000, true, 0.5, 1, 0.5, 0, false, 0)
  residents.observeObjectEmbeddingBest(deviceId, {
    trackId,
    confidence: 0.8,
    atMs: 1_000,
    className: 'person',
    bbox: { x: 1, y: 2, w: 3, h: 4 },
    embedding: [0.1, 0.2],
    embeddingModelId: 'clip-test',
  })
  residents.setKeyFrameMediaId(deviceId, trackId, mediaIdFor(trackId))
  residents.setLastFrameAt(deviceId, trackId, 1_234)
  residents.markFirstFramePending(deviceId, trackId)
  residents.markThumbnailLanded(deviceId, trackId)
  residents.noteKeyFrameAttempt(deviceId, trackId, 1_500, true)
  residents.markKeyFrameLanded(deviceId, trackId)
  residents.setLifecycleUpdateMem(deviceId, trackId, {
    lastConfidence: 0.7,
    lastEmitAt: 1_000,
    lastBboxArea: 12,
  })
  residents.markConfirmed(deviceId, trackId)
  residents.retainRasterFallback(deviceId, trackId, {
    jpeg: Buffer.from('raster'),
    timestamp: 1_100,
  })
  residents.recordBestSeenBbox(deviceId, trackId, {
    x: 10,
    y: 20,
    w: 78,
    h: 60,
    frameWidth: 640,
    frameHeight: 360,
    timestamp: 1_000,
  })
}

/** Assert NO accessor reports any state for the track. `keyFrameMediaId` is
 *  asserted separately by the caller (deferred-drop semantics differ by mode). */
function expectNoResidentState(residents: TrackResidentState, trackId: string): void {
  expect(residents.bestFramePeak(trackId)).toBeUndefined()
  expect(residents.lastFrameAt(trackId)).toBeUndefined()
  expect(residents.isFirstFramePending(trackId)).toBe(false)
  expect(residents.isThumbnailLanded(trackId)).toBe(false)
  expect(residents.keyFrameCapture(trackId)).toEqual({
    landed: false,
    retries: 0,
    lastAttemptAt: undefined,
  })
  expect(residents.lifecycleUpdateMem(trackId)).toBeUndefined()
  expect(residents.closure(trackId)).toBeUndefined()
  expect(residents.bestSeenBbox(trackId)).toBeUndefined()
  // A fresh observation after close must read as a FIRST sighting again —
  // proves the best-frame tracker + object-embedding selector entries are gone.
  // A closed id is only lifted by a real birth (`open`), never by late work.
  residents.open(99, trackId)
  expect(residents.observeBestFrame(99, trackId, 0.01, 2_000, false, 0, 0, 0, 0, false, 0)).toBe(
    true,
  )
  expect(
    residents.observeObjectEmbeddingBest(99, {
      trackId,
      confidence: 0.01,
      atMs: 2_000,
      className: 'person',
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      // The SAME model `populate` used: selectors are per model (D649), and a
      // probe in another model's selector would be fresh whether or not close()
      // cleared this one.
      embeddingModelId: 'clip-test',
    }),
  ).toBe(true)
  // Undo the probe residents so callers can keep asserting on size().
  residents.close(trackId, 'prune')
}

describe('TrackResidentState', () => {
  it('open is idempotent and indexes by device', () => {
    const r = new TrackResidentState()
    r.open(7, 't1')
    r.open(7, 't1')
    r.open(7, 't2')
    r.open(8, 't3')
    expect(r.size()).toBe(3)
    expect(r.trackIdsForDevice(7).sort()).toEqual(['t1', 't2'])
    expect(r.trackIdsForDevice(8)).toEqual(['t3'])
    expect(r.trackIdsForDevice(9)).toEqual([])
  })

  it('mutators auto-open the resident (deviceId travels with every write)', () => {
    const r = new TrackResidentState()
    r.setLastFrameAt(5, 't1', 100)
    r.markConfirmed(5, 't2')
    r.observeBestFrame(6, 't3', 0.5, 100, true, 0.5, 1, 0.5, 0, false, 0)
    expect(r.size()).toBe(3)
    expect(r.trackIdsForDevice(5).sort()).toEqual(['t1', 't2'])
    expect(r.trackIdsForDevice(6)).toEqual(['t3'])
  })

  describe('best-seen bbox (#27-A degenerate-retry gate reference)', () => {
    it('is undefined until recorded, then returns the latest record', () => {
      const r = new TrackResidentState()
      expect(r.bestSeenBbox('t1')).toBeUndefined()

      r.recordBestSeenBbox(4, 't1', {
        x: 10,
        y: 20,
        w: 78,
        h: 60,
        frameWidth: 640,
        frameHeight: 360,
        timestamp: 1_000,
      })
      expect(r.bestSeenBbox('t1')).toEqual({
        x: 10,
        y: 20,
        w: 78,
        h: 60,
        frameWidth: 640,
        frameHeight: 360,
        timestamp: 1_000,
      })

      // A later accepted new-best OVERWRITES the reference (the gate always
      // compares against the freshest best-seen subject).
      r.recordBestSeenBbox(4, 't1', {
        x: 30,
        y: 25,
        w: 120,
        h: 90,
        frameWidth: 640,
        frameHeight: 360,
        timestamp: 2_000,
      })
      expect(r.bestSeenBbox('t1')?.w).toBe(120)
      expect(r.bestSeenBbox('t1')?.timestamp).toBe(2_000)
    })

    it('auto-opens the resident (deviceId indexed) and clears on close', () => {
      const r = new TrackResidentState()
      r.recordBestSeenBbox(9, 't2', {
        x: 0,
        y: 0,
        w: 50,
        h: 40,
        frameWidth: 640,
        frameHeight: 360,
        timestamp: 500,
      })
      expect(r.trackIdsForDevice(9)).toEqual(['t2'])

      r.close('t2', 'end')
      expect(r.bestSeenBbox('t2')).toBeUndefined()
    })
  })

  describe('INVARIANT: after close via EVERY mode, no container holds the trackId', () => {
    for (const mode of TRACK_CLOSE_MODES) {
      it(`mode '${mode}' clears every container and size() drops`, () => {
        const r = new TrackResidentState()
        populate(r, 4, 'gone')
        populate(r, 4, 'stays')
        expect(r.size()).toBe(2)

        r.close('gone', mode)
        expect(r.size()).toBe(1)

        if (mode === 'prune') {
          // Prune has no recognizer end to wait for — the key drops immediately.
          expect(r.keyFrameMediaId('gone')).toBeUndefined()
        } else {
          // end/suppress/stationary: key stays readable (recognizer onTrackEnd
          // links it, Design B) until the deferred drop settles.
          expect(r.keyFrameMediaId('gone')).toBe(mediaIdFor('gone'))
          r.dropKeyFrameMediaId('gone')
          expect(r.keyFrameMediaId('gone')).toBeUndefined()
        }
        expectNoResidentState(r, 'gone')

        // The OTHER track's state is untouched.
        expect(r.keyFrameMediaId('stays')).toBe(mediaIdFor('stays'))
        expect(r.isThumbnailLanded('stays')).toBe(true)
        expect(r.closure('stays')?.confirmed).toBe(true)
      })
    }

    it('double-close is safe (second close of any mode is a no-op)', () => {
      const r = new TrackResidentState()
      populate(r, 4, 't1')
      r.close('t1', 'end')
      r.dropKeyFrameMediaId('t1')
      const modes: readonly TrackCloseMode[] = ['end', 'suppress', 'stationary', 'prune']
      for (const mode of modes) r.close('t1', mode)
      expect(r.size()).toBe(0)
      expectNoResidentState(r, 't1')
    })

    it('dropKeyFrameMediaId before close (faceEnd settled early) still drops the live key', () => {
      const r = new TrackResidentState()
      populate(r, 4, 't1')
      r.dropKeyFrameMediaId('t1')
      expect(r.keyFrameMediaId('t1')).toBeUndefined()
      r.close('t1', 'end')
      expect(r.keyFrameMediaId('t1')).toBeUndefined()
      expectNoResidentState(r, 't1')
    })
  })

  describe('INVARIANT: closeDevice closes every resident of the device (and only those)', () => {
    it('returns the closed trackIds, clears all their state incl. deferred keys', () => {
      const r = new TrackResidentState()
      populate(r, 4, 'a')
      populate(r, 4, 'b')
      populate(r, 5, 'other')
      // 'c' already closed via 'end' with its keyFrame key parked for the
      // deferred drop — device teardown must purge that too.
      populate(r, 4, 'c')
      r.close('c', 'end')
      expect(r.keyFrameMediaId('c')).toBe(mediaIdFor('c'))

      const closed = r.closeDevice(4)
      expect(closed.sort()).toEqual(['a', 'b'])
      expect(r.size()).toBe(1)
      expect(r.trackIdsForDevice(4)).toEqual([])
      for (const id of ['a', 'b', 'c']) expect(r.keyFrameMediaId(id)).toBeUndefined()
      expectNoResidentState(r, 'a')
      expectNoResidentState(r, 'b')
      // The other device is untouched.
      expect(r.keyFrameMediaId('other')).toBe(mediaIdFor('other'))
      expect(r.closure('other')?.confirmed).toBe(true)
    })

    it('closeDevice on an unknown device is a no-op', () => {
      const r = new TrackResidentState()
      populate(r, 4, 'a')
      expect(r.closeDevice(99)).toEqual([])
      expect(r.size()).toBe(1)
    })
  })

  describe('S3: onClose hook (capture-scheduler cancel choke point)', () => {
    it(`fires for EVERY close mode with the trackId`, () => {
      for (const mode of TRACK_CLOSE_MODES) {
        const closed: string[] = []
        const r = new TrackResidentState({ onClose: (trackId) => closed.push(trackId) })
        populate(r, 4, 't1')
        r.close('t1', mode)
        expect(closed).toEqual(['t1'])
      }
    })

    it('closeDevice fans every resident of the device through the hook', () => {
      const closed: string[] = []
      const r = new TrackResidentState({ onClose: (trackId) => closed.push(trackId) })
      populate(r, 4, 'a')
      populate(r, 4, 'b')
      populate(r, 5, 'other')
      r.closeDevice(4)
      expect(closed.sort()).toEqual(['a', 'b'])
    })

    it('fires even for an unknown trackId (queued captures can outlive the record)', () => {
      const closed: string[] = []
      const r = new TrackResidentState({ onClose: (trackId) => closed.push(trackId) })
      r.close('never-opened', 'prune')
      expect(closed).toEqual(['never-opened'])
    })

    it('no hook injected (tests/legacy) → close still works', () => {
      const r = new TrackResidentState()
      populate(r, 4, 't1')
      r.close('t1', 'prune')
      expect(r.size()).toBe(0)
    })
  })

  describe('keyFrame capture bookkeeping (bounded retry, 2026-08-06)', () => {
    it('an untouched track reads as never-attempted, never-landed', () => {
      const r = new TrackResidentState()
      expect(r.keyFrameCapture('t1')).toEqual({
        landed: false,
        retries: 0,
        lastAttemptAt: undefined,
      })
    })

    it('a NEW-BEST attempt advances the clock but spends no retry budget', () => {
      const r = new TrackResidentState()
      r.noteKeyFrameAttempt(7, 't1', 1_000, false)
      r.noteKeyFrameAttempt(7, 't1', 5_000, false)
      expect(r.keyFrameCapture('t1')).toEqual({
        landed: false,
        retries: 0,
        lastAttemptAt: 5_000,
      })
    })

    it('a RETRY attempt spends budget AND advances the clock', () => {
      const r = new TrackResidentState()
      r.noteKeyFrameAttempt(7, 't1', 1_000, true)
      r.noteKeyFrameAttempt(7, 't1', 3_000, true)
      expect(r.keyFrameCapture('t1')).toEqual({ landed: false, retries: 2, lastAttemptAt: 3_000 })
    })

    it('markKeyFrameLanded is sticky — a landed key frame ends the retries', () => {
      const r = new TrackResidentState()
      r.noteKeyFrameAttempt(7, 't1', 1_000, true)
      r.markKeyFrameLanded(7, 't1')
      expect(r.keyFrameCapture('t1').landed).toBe(true)
      r.noteKeyFrameAttempt(7, 't1', 4_000, true)
      expect(r.keyFrameCapture('t1').landed).toBe(true)
    })

    it('auto-opens the resident (deviceId indexed) and clears on close', () => {
      const r = new TrackResidentState()
      r.noteKeyFrameAttempt(7, 't1', 1_000, true)
      expect(r.trackIdsForDevice(7)).toEqual(['t1'])
      r.close('t1', 'end')
      expect(r.keyFrameCapture('t1')).toEqual({
        landed: false,
        retries: 0,
        lastAttemptAt: undefined,
      })
    })
  })

  describe('firstFrame landed flag (suppressed-birth resume recovery, 2026-07-23)', () => {
    it('is false until marked, then sticky — distinguishes never-captured from landed', () => {
      const state = new TrackResidentState()
      expect(state.isFirstFrameLanded('t1')).toBe(false)
      // Suppressed-birth life: pending never set, nothing landed → the resume
      // path may re-arm pending.
      state.markFirstFramePending(1, 't1')
      expect(state.isFirstFramePending('t1')).toBe(true)
      state.clearFirstFramePending('t1')
      state.markFirstFrameLanded(1, 't1')
      expect(state.isFirstFrameLanded('t1')).toBe(true)
      expect(state.isFirstFramePending('t1')).toBe(false)
    })

    it('auto-opens the resident and clears on close', () => {
      const state = new TrackResidentState()
      state.markFirstFrameLanded(9, 'tX')
      expect(state.isFirstFrameLanded('tX')).toBe(true)
      state.close('tX', 'end')
      expect(state.isFirstFrameLanded('tX')).toBe(false)
    })
  })

  it('clearAll drops every resident, tracker entry and deferred key', () => {
    const r = new TrackResidentState()
    populate(r, 4, 'a')
    populate(r, 5, 'b')
    r.close('b', 'end') // parks b's key in the deferred map
    r.clearAll()
    expect(r.size()).toBe(0)
    expect(r.keyFrameMediaId('a')).toBeUndefined()
    expect(r.keyFrameMediaId('b')).toBeUndefined()
    expectNoResidentState(r, 'a')
  })

  describe('per-concern behaviour preserved from the legacy containers', () => {
    it('retainRasterFallback is first-wins (a later frame never overwrites)', () => {
      const r = new TrackResidentState()
      const first = { jpeg: Buffer.from('first'), timestamp: 1 }
      const second = { jpeg: Buffer.from('second'), timestamp: 2 }
      r.retainRasterFallback(4, 't', first)
      r.retainRasterFallback(4, 't', second)
      expect(r.closure('t')?.rasterFallback).toEqual(first)
    })

    it('markConfirmed is sticky and closure() reflects it', () => {
      const r = new TrackResidentState()
      expect(r.closure('t')).toBeUndefined()
      r.markConfirmed(4, 't')
      expect(r.closure('t')?.confirmed).toBe(true)
      expect(r.closure('t')?.rasterFallback).toBeUndefined()
    })

    it('anyFirstFramePending reflects pending flags across residents', () => {
      const r = new TrackResidentState()
      expect(r.anyFirstFramePending()).toBe(false)
      r.markFirstFramePending(4, 't1')
      expect(r.anyFirstFramePending()).toBe(true)
      r.clearFirstFramePending('t1')
      expect(r.anyFirstFramePending()).toBe(false)
      // Clearing pending does NOT tear down the resident itself.
      expect(r.size()).toBe(1)
    })

    it('best-frame observe keeps the §5 policy (hysteresis + edge-aware) and peak reads back', () => {
      const r = new TrackResidentState()
      expect(r.observeBestFrame(4, 't', 0.5, 1_000, true, 0.5, 1, 0.5, 0.6, false, 0)).toBe(true)
      // Within hysteresis (0.05) at the same tier → NOT a new best.
      expect(r.observeBestFrame(4, 't', 0.52, 10_000, true, 0.5, 1, 0.5, 0.6, false, 0)).toBe(false)
      // Decisively higher confidence past the min-gap → new best.
      expect(r.observeBestFrame(4, 't', 0.9, 20_000, true, 0.5, 1, 0.5, 0.6, false, 0)).toBe(true)
      expect(r.bestFramePeak('t')).toEqual({ confidence: 0.9, atMs: 20_000 })
    })

    it('object-embedding observe keeps the confidence-only policy', () => {
      const r = new TrackResidentState()
      const obs = (confidence: number, atMs: number) => ({
        trackId: 't',
        confidence,
        atMs,
        className: 'car',
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      })
      expect(r.observeObjectEmbeddingBest(4, obs(0.5, 100))).toBe(true)
      expect(r.observeObjectEmbeddingBest(4, obs(0.4, 200))).toBe(false)
      expect(r.observeObjectEmbeddingBest(4, obs(0.6, 300))).toBe(true)
    })

    it('ranks the best embedding PER MODEL: a flip gets its first vector on the first eligible observation (D649)', () => {
      const r = new TrackResidentState()
      const seen = (model: string, confidence: number, atMs: number) =>
        r.observeObjectEmbeddingBest(4, {
          trackId: 't-flip',
          confidence,
          atMs,
          className: 'person',
          bbox: { x: 0, y: 0, w: 1, h: 1 },
          embedding: [1, 0],
          embeddingModelId: model,
        })
      expect(seen('mobileclip-s1', 0.9, 100)).toBe(true)
      // After the flip: a WEAKER detection is still SigLIP2's first — its index
      // holds nothing for this track, so it must be written.
      expect(seen('siglip2-b16-224', 0.5, 200)).toBe(true)
      expect(seen('siglip2-b16-224', 0.4, 300)).toBe(false)
      // And each model's ranking is its own.
      expect(seen('mobileclip-s1', 0.5, 400)).toBe(false)
    })

    it('lifecycle update memory reads back what was set', () => {
      const r = new TrackResidentState()
      const mem = {
        lastConfidence: 0.5,
        lastEmitAt: 100,
        lastBboxArea: 3,
        lastLabel: 'x',
      }
      r.setLifecycleUpdateMem(4, 't', mem)
      expect(r.lifecycleUpdateMem('t')).toEqual(mem)
    })

    it('setKeyFrameMediaId overwrites (putReplacing semantics) and reads back', () => {
      const r = new TrackResidentState()
      r.setKeyFrameMediaId(4, 't', 1)
      r.setKeyFrameMediaId(4, 't', 2)
      expect(r.keyFrameMediaId('t')).toBe(2)
    })
  })
})
