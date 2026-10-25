/**
 * A cooldown on the kinds that never stop.
 *
 * ## Why
 *
 * Measured on 592 once the merge grain became the padding (D583): **1 819 rows
 * in a day**, of which **1 090 audio** and **1 180 carrying a single event**.
 * Two thirds of the list was one audio blip at a time. The operator:
 *
 * > *"teniamo gli audio come eventi, con un cooldown di 5 minuti tra uno e
 * > l'altro per evitare affollamento, gli audio sono costanti, esattamente
 * > come motion isolato (ma a 2 minuti)"*
 * > [We keep audio as events, with a 5-minute cooldown between one and the
 * > next to avoid crowding; audio is constant, exactly like isolated motion
 * > (but at 2 minutes).]
 *
 * So audio and motion are KEPT — they are real, and dropping them would hide a
 * camera that only ever hears something — but a run of them yields one row per
 * cooldown instead of one row per blip.
 *
 * ## What is never held back
 *
 * A visit holding an OBJECT event. That is the one the operator is looking
 * for, and a cooldown that could swallow it would be the defect this is meant
 * to avoid wearing the opposite sign. `dominantKind` already ranks object >
 * motion > audio, so an audio blip that coincides with a detection is already
 * part of that visit and is not a row of its own — the cooldown only ever sees
 * the ISOLATED ones.
 *
 * ## Measured from the last EMITTED row
 *
 * Not from the last seen. Measuring from the last seen means a constant stream
 * never emits anything after the first, which is silence dressed as a filter.
 */
import { describe, expect, it } from 'vitest'

import { applyQuietKinds, AUDIO_QUIET_MS, MOTION_QUIET_MS } from '../clip-quiet-kinds.js'
import type { Clip } from '@camstack/types'

const MIN = 60_000

function clip(kind: Clip['kind'], startMs: number): Clip {
  return {
    id: `analytics:${String(startMs)}:${String(startMs + 15_000)}:visit`,
    source: 'analytics',
    kind,
    timeRange: { startMs, endMs: startMs + 15_000 },
  } as Clip
}

const starts = (clips: readonly Clip[]): number[] => clips.map((c) => c.timeRange.startMs)

describe('applyQuietKinds', () => {
  it('keeps one AUDIO row per five minutes', () => {
    const kept = applyQuietKinds([
      clip('audio', 0),
      clip('audio', 1 * MIN),
      clip('audio', 4 * MIN),
      clip('audio', 5 * MIN),
      clip('audio', 6 * MIN),
      clip('audio', 11 * MIN),
    ])
    expect(starts(kept)).toEqual([0, 5 * MIN, 11 * MIN])
  })

  it('keeps one MOTION row per two minutes', () => {
    const kept = applyQuietKinds([
      clip('motion', 0),
      clip('motion', 1 * MIN),
      clip('motion', 2 * MIN),
      clip('motion', 3 * MIN),
    ])
    expect(starts(kept)).toEqual([0, 2 * MIN])
  })

  it('never holds back a row with an OBJECT in it', () => {
    const kept = applyQuietKinds([clip('object', 0), clip('object', 1_000), clip('object', 2_000)])
    expect(kept).toHaveLength(3)
  })

  it('counts from the last EMITTED row, not the last seen', () => {
    // Suppressed rows must not push the window forward, or a constant stream
    // emits exactly once and the list goes quiet for ever.
    const kept = applyQuietKinds([clip('audio', 0), clip('audio', 3 * MIN), clip('audio', 6 * MIN)])
    expect(starts(kept)).toEqual([0, 6 * MIN])
  })

  it('keeps the two clocks apart', () => {
    // An audio row does not silence a motion row, and the other way round.
    const kept = applyQuietKinds([clip('audio', 0), clip('motion', 1_000), clip('object', 2_000)])
    expect(kept).toHaveLength(3)
  })

  it('decides oldest-first but KEEPS the order it was handed', () => {
    // This provider lists newest-first. Reversing the list here would turn a
    // density filter into a reordering — which is exactly what the first
    // version did, and what `clips[0].kind` in the provider spec caught.
    const kept = applyQuietKinds([clip('audio', 6 * MIN), clip('audio', 1 * MIN), clip('audio', 0)])
    expect(starts(kept)).toEqual([6 * MIN, 0])
  })

  it('emits at the boundary — a row exactly one cooldown later is kept', () => {
    expect(starts(applyQuietKinds([clip('audio', 0), clip('audio', AUDIO_QUIET_MS)]))).toEqual([
      0,
      AUDIO_QUIET_MS,
    ])
    expect(starts(applyQuietKinds([clip('motion', 0), clip('motion', MOTION_QUIET_MS)]))).toEqual([
      0,
      MOTION_QUIET_MS,
    ])
  })

  it('is the identity on an empty list', () => {
    expect(applyQuietKinds([])).toEqual([])
  })

  it('has the cooldowns the operator asked for', () => {
    expect(AUDIO_QUIET_MS).toBe(5 * MIN)
    expect(MOTION_QUIET_MS).toBe(2 * MIN)
  })
})
