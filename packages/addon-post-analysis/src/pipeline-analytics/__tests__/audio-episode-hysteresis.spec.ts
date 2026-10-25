/**
 * Per-camera audio-episode hysteresis — one episode, one event, one
 * synthetic track. No class allowlist: every confident classification is
 * eligible; the knobs (open-hold, close-gap, cooldown) are what stop a
 * 5-second heartbeat from spamming the timeline.
 *
 * One discriminating test per gate. The 1–2 day live trial is how we learn
 * whether speech-all-day still produces too many long tracks.
 */
import { describe, expect, it } from 'vitest'
import {
  emptyAudioEpisodeState,
  observeAudioEpisode,
  type AudioEpisodeKnobs,
} from '../audio-episode-hysteresis.js'

const KNOBS: AudioEpisodeKnobs = {
  enabled: true,
  openHoldMs: 1_500,
  closeGapMs: 12_000,
  cooldownMs: 30_000,
}

function step(
  state: ReturnType<typeof emptyAudioEpisodeState>,
  atMs: number,
  className: string | null,
  knobs: AudioEpisodeKnobs = KNOBS,
) {
  return observeAudioEpisode(state, { timestampMs: atMs, className }, knobs)
}

describe('observeAudioEpisode', () => {
  it('a 200 ms blip never opens — open-hold has not elapsed', () => {
    let s = emptyAudioEpisodeState()
    const a = step(s, 1_000, 'crying')
    expect(a.action.kind).toBe('none')
    const b = step(a.nextState, 1_200, 'crying')
    expect(b.action.kind).toBe('none')
  })

  it('the same class held for openHoldMs opens exactly once', () => {
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'crying').nextState
    const opened = step(s, 1_500, 'crying')
    expect(opened.action).toEqual({
      kind: 'open',
      className: 'crying',
      episodeId: expect.any(String),
    })
    const held = step(opened.nextState, 2_000, 'crying')
    expect(held.action.kind).toBe('hold')
    if (held.action.kind !== 'hold' || opened.action.kind !== 'open') return
    expect(held.action.episodeId).toBe(opened.action.episodeId)
  })

  it('the same class continuing for tens of seconds never opens a second episode', () => {
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'speech').nextState
    const opened = step(s, 1_500, 'speech')
    expect(opened.action.kind).toBe('open')
    s = opened.nextState
    for (let t = 2_000; t <= 60_000; t += 5_000) {
      const r = step(s, t, 'speech')
      expect(r.action.kind).toBe('hold')
      s = r.nextState
    }
  })

  it('absence shorter than closeGap keeps the episode open (no close, no second open)', () => {
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'crying').nextState
    const opened = step(s, 1_500, 'crying')
    s = opened.nextState
    const gap = step(s, 6_000, null)
    expect(gap.action.kind).toBe('none')
    const back = step(gap.nextState, 8_000, 'crying')
    expect(back.action.kind).toBe('hold')
    if (back.action.kind !== 'hold' || opened.action.kind !== 'open') return
    expect(back.action.episodeId).toBe(opened.action.episodeId)
  })

  it('absence longer than closeGap closes the episode', () => {
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'crying').nextState
    s = step(s, 1_500, 'crying').nextState
    const closed = step(s, 1_500 + 12_000, null)
    expect(closed.action).toMatchObject({ kind: 'close', className: 'crying' })
  })

  it('the same class cannot reopen until cooldown elapses', () => {
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'crying').nextState
    s = step(s, 1_500, 'crying').nextState
    s = step(s, 13_500, null).nextState
    // closed at 13500; cooldown 30s → blocked until 43500
    s = step(s, 14_000, 'crying').nextState
    const blocked = step(s, 15_500, 'crying')
    expect(blocked.action.kind).toBe('none')
    const after = step(blocked.nextState, 43_500, 'crying')
    // still pending at first sample after cooldown
    expect(after.action.kind).toBe('none')
    const reopened = step(after.nextState, 43_500 + 1_500, 'crying')
    expect(reopened.action.kind).toBe('open')
  })

  it('a different class must hold openHoldMs before replacing the open episode', () => {
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'crying').nextState
    const crying = step(s, 1_500, 'crying')
    expect(crying.action.kind).toBe('open')
    const flicker = step(crying.nextState, 3_000, 'speech')
    expect(flicker.action.kind).toBe('none')
    const back = step(flicker.nextState, 3_400, 'crying')
    expect(back.action.kind).toBe('hold')
    if (back.action.kind !== 'hold' || crying.action.kind !== 'open') return
    expect(back.action.episodeId).toBe(crying.action.episodeId)
    s = back.nextState
    s = step(s, 4_000, 'speech').nextState
    const switched = step(s, 5_500, 'speech')
    expect(switched.action.kind).toBe('replace')
    if (switched.action.kind !== 'replace') return
    expect(switched.action.closed.className).toBe('crying')
    expect(switched.action.closed.episodeId).toBe(crying.action.episodeId)
    expect(switched.action.opened.className).toBe('speech')
    expect(switched.action.opened.episodeId).not.toBe(crying.action.episodeId)
  })

  it('a competing class still in cooldown does not replace the open episode', () => {
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'speech').nextState
    s = step(s, 1_500, 'speech').nextState
    s = step(s, 13_500, null).nextState
    s = step(s, 14_000, 'crying').nextState
    const crying = step(s, 15_500, 'crying')
    expect(crying.action.kind).toBe('open')
    s = crying.nextState
    s = step(s, 16_000, 'speech').nextState
    const blocked = step(s, 17_500, 'speech')
    expect(blocked.action.kind).toBe('none')
    const stillCrying = step(blocked.nextState, 18_000, 'crying')
    expect(stillCrying.action.kind).toBe('hold')
  })

  it('speech is eligible — there is no class allowlist', () => {
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'speech').nextState
    const opened = step(s, 1_500, 'speech')
    expect(opened.action).toMatchObject({ kind: 'open', className: 'speech' })
  })

  it('disabled never opens, even after open-hold', () => {
    const off: AudioEpisodeKnobs = { ...KNOBS, enabled: false }
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'crying', off).nextState
    const r = step(s, 5_000, 'crying', off)
    expect(r.action.kind).toBe('none')
  })

  it('a pending class that flickers to something else resets the open-hold clock', () => {
    let s = emptyAudioEpisodeState()
    s = step(s, 0, 'crying').nextState
    s = step(s, 1_000, 'speech').nextState
    const tooSoon = step(s, 1_400, 'speech')
    expect(tooSoon.action.kind).toBe('none')
    const opened = step(tooSoon.nextState, 1_000 + 1_500, 'speech')
    expect(opened.action).toMatchObject({ kind: 'open', className: 'speech' })
  })
})
