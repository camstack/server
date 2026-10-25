import { describe, expect, it } from 'vitest'
import {
  decideMotionSignal,
  motionEpisodeDurationMs,
  type MotionEpisodeOpenState,
  type MotionSignalState,
} from '../motion-episode.js'

describe('decideMotionSignal', () => {
  it('a false observation with no prior state is a noop', () => {
    expect(decideMotionSignal(undefined, false, 1_000)).toEqual({ kind: 'noop' })
  })

  it('a true observation with no prior state opens an episode', () => {
    expect(decideMotionSignal(undefined, true, 1_000)).toEqual({ kind: 'open-episode' })
  })

  it('a false observation while an episode is open leaves the episode alone', () => {
    const episode: MotionEpisodeOpenState = {
      eventId: 42,
      startedAt: 1_000,
      lastOnAt: 1_000,
      edgeOffsetsMs: [0],
    }
    const prior: MotionSignalState = { lastDetected: true, episode }
    const decision = decideMotionSignal(prior, false, 5_000)
    expect(decision).toEqual({ kind: 'observed-off' })
  })

  it('a continuation tick (still true, no intervening false) extends without a new edge', () => {
    const episode: MotionEpisodeOpenState = {
      eventId: 42,
      startedAt: 1_000,
      lastOnAt: 1_000,
      edgeOffsetsMs: [0],
    }
    const prior: MotionSignalState = { lastDetected: true, episode }
    const decision = decideMotionSignal(prior, true, 1_250)
    expect(decision).toEqual({
      kind: 'extend-episode',
      isNewEdge: false,
      next: { eventId: 42, startedAt: 1_000, lastOnAt: 1_250, edgeOffsetsMs: [0] },
    })
  })

  it('a true tick after an observed-off, still within the open episode, is a NEW edge', () => {
    const episode: MotionEpisodeOpenState = {
      eventId: 42,
      startedAt: 1_000,
      lastOnAt: 4_000,
      edgeOffsetsMs: [0],
    }
    // The camera stopped pushing for a while — `observed-off` set lastDetected
    // false but left the episode itself open (it closes only on its own timer).
    const prior: MotionSignalState = { lastDetected: false, episode }
    const decision = decideMotionSignal(prior, true, 9_000)
    expect(decision).toEqual({
      kind: 'extend-episode',
      isNewEdge: true,
      next: { eventId: 42, startedAt: 1_000, lastOnAt: 9_000, edgeOffsetsMs: [0, 8_000] },
    })
  })

  it('a true tick with no open episode opens a NEW one even if lastDetected was stale-true', () => {
    // Shape: the previous episode already closed (its timer fired and the
    // caller cleared `episode` to null) but never got a `false` push in
    // between (Reolink-style keepalive that just stops). The next `true`
    // must still open a fresh episode, not be mistaken for a continuation.
    const prior: MotionSignalState = { lastDetected: true, episode: null }
    expect(decideMotionSignal(prior, true, 20_000)).toEqual({ kind: 'open-episode' })
  })

  it('repeated true observations from a firmware keepalive produce exactly ONE edge', () => {
    // Reolink/Hikvision-style: true, true, true... at ~1 Hz, never a false,
    // for the whole burst. `edges` must stay at [0], not grow per tick.
    let state: MotionSignalState = { lastDetected: false, episode: null }
    const opened: MotionEpisodeOpenState = {
      eventId: 7,
      startedAt: 0,
      lastOnAt: 0,
      edgeOffsetsMs: [0],
    }
    state = { lastDetected: true, episode: opened }
    for (const t of [1_000, 2_000, 3_000, 4_000, 5_000]) {
      const decision = decideMotionSignal(state, true, t)
      if (decision.kind !== 'extend-episode') throw new Error('expected extend-episode')
      expect(decision.isNewEdge).toBe(false)
      state = { lastDetected: true, episode: decision.next }
    }
    expect(state.episode?.edgeOffsetsMs).toEqual([0])
    expect(state.episode?.lastOnAt).toBe(5_000)
  })
})

describe('motionEpisodeDurationMs', () => {
  it('is lastOnAt - startedAt, NOT closedAt - startedAt', () => {
    // An instantaneous trigger (one rising edge, immediately followed by 15 s
    // of quiet) must report ~0 ms of motion, not 15 s.
    const state: MotionEpisodeOpenState = {
      eventId: 1,
      startedAt: 10_000,
      lastOnAt: 10_010,
      edgeOffsetsMs: [0],
    }
    expect(motionEpisodeDurationMs(state)).toBe(10)
  })
})
