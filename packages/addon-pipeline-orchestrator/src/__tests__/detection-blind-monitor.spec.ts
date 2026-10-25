/**
 * DetectionBlindMonitor — a camera is blind only when it MOVED and the detector
 * produced nothing at all (D907). The traces below are the production ones.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DETECTION_BLIND_CONFIG,
  DetectionBlindMonitor,
  DETECTION_BLIND_MIN_MOTION_MS,
  DETECTION_BLIND_MIN_SESSIONS,
  type BlindFrameOutput,
} from '../detection-blind-monitor.js'

const DEV = 101
const SEC = 1000
const MIN = 60_000
const EMPTY: BlindFrameOutput = { detections: 0, discarded: 0 }
const FLOOR_FILTERED: BlindFrameOutput = { detections: 0, discarded: 2 }
const SEEN: BlindFrameOutput = { detections: 1, discarded: 0 }

/** One session of `lengthMs` starting at `at`, with an empty frame every 10 s inside it. */
function session(
  m: DetectionBlindMonitor,
  at: number,
  lengthMs: number,
  frame: BlindFrameOutput = EMPTY,
  device = DEV,
): void {
  m.noteSessionOpen(device, at)
  for (let t = at; t < at + lengthMs; t += 10 * SEC) m.noteFrame(device, frame, t)
  m.noteSessionClose(device, at + lengthMs)
}

describe('DetectionBlindMonitor — blind', () => {
  it('(a) 70 min idle then one 16 s session is a QUIET camera, not a blind one (109)', () => {
    const m = new DetectionBlindMonitor()
    m.noteFrame(DEV, SEEN, 0)
    session(m, 70 * MIN, 16 * SEC)
    expect(m.sweep(70 * MIN + 20 * SEC)).toHaveLength(0)
    expect(m.sweepMotion(70 * MIN + 20 * SEC)).toHaveLength(0)
  })

  it('(c) 10 min of motion over 3 sessions with empty, discard-free frames is blind', () => {
    const m = new DetectionBlindMonitor()
    m.noteFrame(DEV, SEEN, 0)
    session(m, 10 * MIN, 4 * MIN)
    session(m, 20 * MIN, 3 * MIN)
    session(m, 30 * MIN, 3 * MIN)
    const out = m.sweep(33 * MIN + 10 * SEC)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      deviceId: DEV,
      motionMs: 10 * MIN,
      sessions: 3,
      belowFloor: 0,
      thresholdMs: DETECTION_BLIND_MIN_MOTION_MS,
    })
  })

  it('(d) the same motion with below-floor candidates is floor-filtered, NOT blind', () => {
    const m = new DetectionBlindMonitor()
    m.noteFrame(DEV, SEEN, 0)
    session(m, 10 * MIN, 4 * MIN, FLOOR_FILTERED)
    session(m, 20 * MIN, 3 * MIN, FLOOR_FILTERED)
    session(m, 30 * MIN, 3 * MIN, FLOOR_FILTERED)
    expect(m.sweep(33 * MIN + 10 * SEC)).toHaveLength(0)
  })

  it('one discarded candidate resets the motion counted so far', () => {
    const m = new DetectionBlindMonitor()
    session(m, 0, 4 * MIN)
    session(m, 10 * MIN, 4 * MIN)
    m.noteFrame(DEV, FLOOR_FILTERED, 20 * MIN)
    session(m, 21 * MIN, 1 * MIN)
    session(m, 23 * MIN, 1 * MIN)
    session(m, 25 * MIN, 1 * MIN)
    expect(m.sweep(26 * MIN)).toHaveLength(0)
  })

  it('needs the sessions: one long session of 12 min is a subject standing there', () => {
    const m = new DetectionBlindMonitor()
    session(m, 0, 12 * MIN)
    expect(DETECTION_BLIND_MIN_SESSIONS).toBeGreaterThan(1)
    expect(m.sweep(12 * MIN + 10 * SEC)).toHaveLength(0)
  })

  it('needs an analysed frame: motion with no frames at all is not blind', () => {
    const m = new DetectionBlindMonitor()
    for (let i = 0; i < 4; i += 1) {
      m.noteSessionOpen(DEV, i * 10 * MIN)
      m.noteSessionClose(DEV, i * 10 * MIN + 4 * MIN)
    }
    expect(m.sweep(40 * MIN)).toHaveLength(0)
  })

  it('a camera whose motion source is unknown (no session ever) is never classified', () => {
    const m = new DetectionBlindMonitor()
    for (let t = 0; t < 3 * 60 * MIN; t += MIN) m.noteFrame(DEV, EMPTY, t)
    expect(m.sweep(3 * 60 * MIN)).toHaveLength(0)
    expect(m.sweepMotion(3 * 60 * MIN)).toHaveLength(0)
  })

  it('reports ONCE per blind episode; a detection re-arms it', () => {
    const m = new DetectionBlindMonitor()
    session(m, 0, 4 * MIN)
    session(m, 10 * MIN, 4 * MIN)
    session(m, 20 * MIN, 4 * MIN)
    expect(m.sweep(24 * MIN)).toHaveLength(1)
    expect(m.sweep(24 * MIN + 30 * SEC)).toHaveLength(0)
    m.noteFrame(DEV, SEEN, 30 * MIN)
    session(m, 40 * MIN, 4 * MIN)
    session(m, 50 * MIN, 4 * MIN)
    session(m, 60 * MIN, 4 * MIN)
    expect(m.sweep(64 * MIN)).toHaveLength(1)
  })

  it('a frame older than the freshness window is quiet, not blind', () => {
    const m = new DetectionBlindMonitor()
    session(m, 0, 4 * MIN)
    session(m, 10 * MIN, 4 * MIN)
    session(m, 20 * MIN, 4 * MIN)
    expect(m.sweep(24 * MIN + DEFAULT_DETECTION_BLIND_CONFIG.frameFreshnessMs + SEC)).toHaveLength(
      0,
    )
  })

  it('forget() resets a camera, so a re-attach starts a fresh clock', () => {
    const m = new DetectionBlindMonitor()
    session(m, 0, 4 * MIN)
    session(m, 10 * MIN, 4 * MIN)
    session(m, 20 * MIN, 4 * MIN)
    m.forget(DEV)
    expect(m.sweep(24 * MIN)).toHaveLength(0)
  })

  it('tracks cameras independently', () => {
    const m = new DetectionBlindMonitor()
    for (const at of [0, 10 * MIN, 20 * MIN]) {
      session(m, at, 4 * MIN, EMPTY, 101)
      session(m, at, 4 * MIN, SEEN, 102)
    }
    expect(m.sweep(24 * MIN).map((e) => e.deviceId)).toEqual([101])
  })
})

describe('DetectionBlindMonitor — motion-noisy', () => {
  it('(b) 100 sessions an hour at 55% duty with zero detections is noisy, never blind (637)', () => {
    const m = new DetectionBlindMonitor()
    // 100 sessions of 20 s each = 33 min... use 100 x 20 s every 36 s => 55% duty.
    let blind = 0
    const noisy: string[] = []
    for (let t = 0; t < 2 * 60 * MIN; t += 36 * SEC) {
      session(m, t, 20 * SEC, FLOOR_FILTERED)
      if (t % MIN === 0) {
        blind += m.sweep(t).length
        for (const e of m.sweepMotion(t)) noisy.push(e.phase)
      }
    }
    expect(blind).toBe(0)
    expect(noisy).toEqual(['noisy'])
  })

  it('noise with EMPTY frames is noisy and the blind gate does not also fire on it before the window', () => {
    const m = new DetectionBlindMonitor()
    for (let t = 0; t < 61 * MIN; t += 36 * SEC) session(m, t, 20 * SEC)
    const events = m.sweepMotion(61 * MIN)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ deviceId: DEV, phase: 'noisy' })
    expect(events[0]?.duty).toBeGreaterThanOrEqual(0.25)
  })

  it('does not call a camera noisy before it has been watched for the whole window', () => {
    const m = new DetectionBlindMonitor()
    for (let t = 0; t < 30 * MIN; t += 36 * SEC) session(m, t, 20 * SEC)
    expect(m.sweepMotion(30 * MIN)).toHaveLength(0)
  })

  it('a detection in the window means the motion found a subject: not noisy', () => {
    const m = new DetectionBlindMonitor()
    for (let t = 0; t < 61 * MIN; t += 36 * SEC) session(m, t, 20 * SEC)
    m.noteFrame(DEV, SEEN, 60 * MIN)
    expect(m.sweepMotion(61 * MIN)).toHaveLength(0)
  })

  it('count alone is enough: 45 short sessions an hour at low duty', () => {
    const m = new DetectionBlindMonitor()
    for (let t = 0; t < 61 * MIN; t += 80 * SEC) session(m, t, 5 * SEC)
    const events = m.sweepMotion(61 * MIN)
    expect(events[0]).toMatchObject({ phase: 'noisy' })
    expect(events[0]?.duty).toBeLessThan(0.25)
  })

  it('goes calm when the motion falls back, once, and can go noisy again', () => {
    const m = new DetectionBlindMonitor()
    for (let t = 0; t < 61 * MIN; t += 36 * SEC) session(m, t, 20 * SEC)
    expect(m.sweepMotion(61 * MIN).map((e) => e.phase)).toEqual(['noisy'])
    expect(m.sweepMotion(62 * MIN)).toHaveLength(0)
    // An hour of near silence.
    expect(m.sweepMotion(125 * MIN).map((e) => e.phase)).toEqual(['calm'])
    expect(m.sweepMotion(126 * MIN)).toHaveLength(0)
    for (let t = 130 * MIN; t < 192 * MIN; t += 36 * SEC) session(m, t, 20 * SEC)
    expect(m.sweepMotion(192 * MIN).map((e) => e.phase)).toEqual(['noisy'])
  })

  it('a detection ends the episode with a calm', () => {
    const m = new DetectionBlindMonitor()
    for (let t = 0; t < 61 * MIN; t += 36 * SEC) session(m, t, 20 * SEC)
    expect(m.sweepMotion(61 * MIN)).toHaveLength(1)
    m.noteFrame(DEV, SEEN, 62 * MIN)
    session(m, 62 * MIN, 20 * SEC)
    expect(m.sweepMotion(63 * MIN).map((e) => e.phase)).toEqual(['calm'])
  })
})
