/**
 * What a grid says about ITSELF, derived from what its sources said.
 *
 * A grid is a camera, so the viewer already knows how to light it: it keys the
 * motion ring off `motion.on-motion-changed` for a `deviceId` and the audio one
 * off `pipeline.audio-inference-result`. Nothing in the app changes — the grid
 * just has to answer those questions about its own device id.
 *
 * The operator set both rules: motion is on if AT LEAST ONE source has it, and
 * the audio level is the LOUDEST of them.
 *
 * The part that needs care is the falling edge. Bus events are telemetry and
 * may be dropped (D8/D11), and a lost `detected: false` would leave a grid lit
 * for ever. So a source's motion is remembered WITH ITS TIME and expires on its
 * own; the mirror is state refreshed off the event path, never a gate that
 * re-reads something fallible to decide (D49).
 */
import { describe, expect, it } from 'vitest'
import { GridActivityMirror } from '../grid-activity-mirror.js'

const T0 = 1_700_000_000_000

describe('motion — at least one source', () => {
  it('is detected while ANY source is', () => {
    const m = new GridActivityMirror()
    m.noteMotion(592, true, T0)
    expect(m.motionAt(T0).detected).toBe(true)
    m.noteMotion(618, true, T0 + 100)
    m.noteMotion(592, false, T0 + 200)
    expect(m.motionAt(T0 + 200).detected).toBe(true)
  })

  it('clears only when the LAST source clears', () => {
    const m = new GridActivityMirror()
    m.noteMotion(592, true, T0)
    m.noteMotion(618, true, T0)
    m.noteMotion(592, false, T0 + 100)
    m.noteMotion(618, false, T0 + 200)
    expect(m.motionAt(T0 + 200).detected).toBe(false)
  })

  it('carries the most recent rising edge as lastDetectedAt', () => {
    const m = new GridActivityMirror()
    m.noteMotion(592, true, T0)
    m.noteMotion(618, true, T0 + 5_000)
    expect(m.motionAt(T0 + 5_000).lastDetectedAt).toBe(T0 + 5_000)
  })

  it('a heartbeat is not a rise: a source that keeps sending `true` does not move lastDetectedAt', () => {
    const m = new GridActivityMirror()
    m.noteMotion(592, true, T0)
    m.noteMotion(592, true, T0 + 1_000)
    m.noteMotion(592, true, T0 + 2_000)
    expect(m.motionAt(T0 + 2_000).lastDetectedAt).toBe(T0)
    // A clear, then a new `true`: that IS a rise.
    m.noteMotion(592, false, T0 + 3_000)
    m.noteMotion(592, true, T0 + 4_000)
    expect(m.motionAt(T0 + 4_000).lastDetectedAt).toBe(T0 + 4_000)
  })

  it('a `true` after the previous one expired (a lost clear) is a rise', () => {
    const m = new GridActivityMirror()
    m.noteMotion(592, true, T0)
    m.noteMotion(592, true, T0 + 60_000)
    expect(m.motionAt(T0 + 60_000).lastDetectedAt).toBe(T0 + 60_000)
  })

  it('has never been detected before anything happened — null, not zero', () => {
    expect(new GridActivityMirror().motionAt(T0).lastDetectedAt).toBeNull()
  })

  it('EXPIRES a source whose clear was lost — a dropped event must not light a grid for ever', () => {
    const m = new GridActivityMirror()
    m.noteMotion(592, true, T0)
    expect(m.motionAt(T0 + 14_000).detected).toBe(true)
    expect(m.motionAt(T0 + 16_000).detected).toBe(false)
  })

  it('a fresh rising edge renews the expiry — a subject that stays is still there', () => {
    const m = new GridActivityMirror()
    m.noteMotion(592, true, T0)
    m.noteMotion(592, true, T0 + 10_000)
    expect(m.motionAt(T0 + 16_000).detected).toBe(true)
  })
})

describe('audio — the loudest source', () => {
  it('reports the LOUDEST recent reading, not the latest one', () => {
    const m = new GridActivityMirror()
    m.noteAudio(592, -20, T0)
    m.noteAudio(618, -45, T0 + 100)
    expect(m.loudestAt(T0 + 100)).toBe(-20)
  })

  it('forgets a reading that has gone stale — a shout is not loud for ever', () => {
    const m = new GridActivityMirror()
    m.noteAudio(592, -20, T0)
    m.noteAudio(618, -45, T0 + 3_000)
    // At +6 s the loud one is 6 s old and gone; the quiet one is 3 s old and
    // still current, so the grid reports the quiet one rather than holding the
    // shout.
    expect(m.loudestAt(T0 + 6_000)).toBe(-45)
  })

  it('is null when nothing fresh has been heard — silence is not -inf', () => {
    const m = new GridActivityMirror()
    expect(m.loudestAt(T0)).toBeNull()
    m.noteAudio(592, -20, T0)
    expect(m.loudestAt(T0 + 60_000)).toBeNull()
  })
})

describe('sources that leave', () => {
  it('forgets a source the grid no longer composes', () => {
    const m = new GridActivityMirror()
    m.noteMotion(592, true, T0)
    m.noteAudio(592, -10, T0)
    m.keepOnly([618])
    expect(m.motionAt(T0).detected).toBe(false)
    expect(m.loudestAt(T0)).toBeNull()
  })
})
