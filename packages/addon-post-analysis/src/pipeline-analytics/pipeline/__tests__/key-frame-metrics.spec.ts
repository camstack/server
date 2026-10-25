import { describe, expect, it } from 'vitest'
import { KeyFrameCaptureLog } from '../key-frame-metrics.js'

/**
 * Fix 3 (2026-08-06). There was NO metric on this path at all:
 * `fetchNativeFullFrameTiered` never called `bumpCropMetric` (that counter is
 * bumped only from `getNativeCropJpeg` and `captureCrop`), and it is a
 * process-global counter with no `deviceId` anyway. So "did the key-frame
 * retry work?" could only be answered by counting Loki lines by hand — which
 * is how the previous session spent its afternoon.
 *
 * This is the answer per camera, per minute, in one line.
 */
describe('KeyFrameCaptureLog', () => {
  it('holds the window open until the interval elapses', () => {
    const log = new KeyFrameCaptureLog(60_000)
    expect(log.note(101, { kind: 'attempt', retry: false, outcome: 'landed' }, 1_000)).toBeNull()
    expect(log.note(101, { kind: 'attempt', retry: false, outcome: 'landed' }, 30_000)).toBeNull()
    expect(
      log.note(101, { kind: 'attempt', retry: false, outcome: 'landed' }, 61_001),
    ).not.toBeNull()
  })

  it('separates the RETRY path from the new-best path — the whole point', () => {
    const log = new KeyFrameCaptureLog(1_000)
    log.note(101, { kind: 'attempt', retry: false, outcome: 'parcel-missing' }, 0)
    log.note(101, { kind: 'attempt', retry: true, outcome: 'parcel-missing' }, 10)
    log.note(101, { kind: 'attempt', retry: true, outcome: 'landed' }, 20)
    const window = log.flush(101, 30)
    expect(window).toMatchObject({
      attempts: 3,
      landed: 1,
      retryAttempts: 2,
      retryLanded: 1,
      parcelMissing: 2,
    })
  })

  it('counts every drop cause on its own axis', () => {
    const log = new KeyFrameCaptureLog(1_000)
    log.note(101, { kind: 'attempt', retry: false, outcome: 'parcel-missing' }, 0)
    log.note(101, { kind: 'attempt', retry: false, outcome: 'error' }, 2)
    log.note(101, { kind: 'skipped', reason: 'node-offline' }, 3)
    log.note(101, { kind: 'skipped', reason: 'node-offline' }, 4)
    expect(log.flush(101, 5)).toMatchObject({
      attempts: 2,
      landed: 0,
      parcelMissing: 1,
      error: 1,
      skippedNodeOffline: 2,
    })
  })

  it('keeps devices apart — a per-camera question needs a per-camera window', () => {
    const log = new KeyFrameCaptureLog(1_000)
    log.note(101, { kind: 'attempt', retry: false, outcome: 'landed' }, 0)
    log.note(102, { kind: 'attempt', retry: false, outcome: 'parcel-missing' }, 0)
    expect(log.flush(101, 1)).toMatchObject({ attempts: 1, landed: 1, parcelMissing: 0 })
    expect(log.flush(102, 1)).toMatchObject({ attempts: 1, landed: 0, parcelMissing: 1 })
  })

  it('flush on an idle device returns null rather than an empty line', () => {
    expect(new KeyFrameCaptureLog(1_000).flush(101, 1)).toBeNull()
  })

  it('reports the elapsed window, so a rate can be computed from one line', () => {
    const log = new KeyFrameCaptureLog(1_000)
    log.note(101, { kind: 'attempt', retry: false, outcome: 'landed' }, 1_000)
    expect(log.flush(101, 4_000)?.windowMs).toBe(3_000)
  })

  it('a skip alone opens a window — a camera capturing NOTHING must still report', () => {
    const log = new KeyFrameCaptureLog(1_000)
    log.note(101, { kind: 'skipped', reason: 'node-offline' }, 0)
    expect(log.flush(101, 1)).toMatchObject({ attempts: 0, skippedNodeOffline: 1 })
  })
})
