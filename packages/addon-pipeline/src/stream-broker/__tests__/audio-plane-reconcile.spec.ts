/**
 * D83 — the audio-plane reconcile DECISION.
 *
 * Every assertion here is about a way the reconcile could damage a healthy
 * stream, because the only action it can take (a re-dial) tears one down. The
 * happy path is trivial; the guards are the product.
 */
import { describe, expect, it } from 'vitest'

import {
  AUDIO_PLANE_DISAGREEMENTS_TO_ACT,
  AUDIO_PLANE_MAX_REDIALS,
  AUDIO_PLANE_REDIAL_COOLDOWN_MS,
  type AudioPlaneObservation,
  type AudioPlaneState,
  decideAudioPlaneAction,
  EMPTY_AUDIO_PLANE_STATE,
} from '../stream-broker/audio-plane-reconcile.js'

const T0 = 1_000_000

/** Run a sequence of observations, returning the actions in order. */
function run(
  observations: readonly AudioPlaneObservation[],
  options?: { readonly startState?: AudioPlaneState; readonly stepMs?: number },
): { readonly actions: readonly string[]; readonly state: AudioPlaneState } {
  let state = options?.startState ?? EMPTY_AUDIO_PLANE_STATE
  const actions: string[] = []
  observations.forEach((observation, i) => {
    const decision = decideAudioPlaneAction(observation, state, T0 + i * (options?.stepMs ?? 1000))
    actions.push(decision.action.kind)
    state = decision.nextState
  })
  return { actions, state }
}

describe('decideAudioPlaneAction — agreement costs nothing', () => {
  it.each([
    ['broker-muted'],
    ['no-live-source'],
    ['audio-present'],
    ['declared-off'],
  ] as const)('%s clears the memory entirely', (kind) => {
    const dirty: AudioPlaneState = {
      disagreements: 1,
      redials: 2,
      lastRedialMs: T0 - 10,
      gaveUp: false,
    }
    const decision = decideAudioPlaneAction({ kind }, dirty, T0)
    expect(decision.action.kind).toBe('none')
    expect(decision.nextState).toEqual(EMPTY_AUDIO_PLANE_STATE)
  })

  it('an operator mute is not a disagreement, however long it lasts', () => {
    const { actions, state } = run(Array<AudioPlaneObservation>(10).fill({ kind: 'broker-muted' }))
    expect(new Set(actions)).toEqual(new Set(['none']))
    expect(state).toEqual(EMPTY_AUDIO_PLANE_STATE)
  })

  it('observing audio again restores the full re-dial budget', () => {
    const spent: AudioPlaneState = {
      disagreements: 2,
      redials: AUDIO_PLANE_MAX_REDIALS,
      lastRedialMs: T0,
      gaveUp: true,
    }
    const recovered = decideAudioPlaneAction({ kind: 'audio-present' }, spent, T0 + 1).nextState
    // And the next disagreement is treated as a brand-new one, not a relapse.
    const { actions } = run([{ kind: 'declared-on' }, { kind: 'declared-on' }], {
      startState: recovered,
    })
    expect(actions).toEqual(['await-second-pass', 'redial'])
  })
})

describe('decideAudioPlaneAction — a read we could not trust changes NOTHING (D49)', () => {
  it.each([
    ['read-failed'],
    ['audio-unknown'],
  ] as const)('%s leaves the state untouched', (kind) => {
    const mid: AudioPlaneState = {
      disagreements: 1,
      redials: 1,
      lastRedialMs: T0 - 5,
      gaveUp: false,
    }
    const decision = decideAudioPlaneAction({ kind }, mid, T0)
    expect(decision.action.kind).toBe('none')
    expect(decision.nextState).toEqual(mid)
  })

  it('a failed read never accumulates toward a re-dial, however many times it fails', () => {
    const { actions, state } = run(Array<AudioPlaneObservation>(20).fill({ kind: 'read-failed' }))
    expect(new Set(actions)).toEqual(new Set(['none']))
    expect(state.redials).toBe(0)
  })

  it('a flaky read between two genuine disagreements does not reset the count', () => {
    const { actions } = run([
      { kind: 'declared-on' },
      { kind: 'read-failed' },
      { kind: 'declared-on' },
    ])
    expect(actions).toEqual(['await-second-pass', 'none', 'redial'])
  })
})

describe('decideAudioPlaneAction — a disagreement is believed only when it repeats', () => {
  it('one disagreeing pass never re-dials', () => {
    const decision = decideAudioPlaneAction({ kind: 'declared-on' }, EMPTY_AUDIO_PLANE_STATE, T0)
    expect(decision.action.kind).toBe('await-second-pass')
    expect(decision.nextState.disagreements).toBe(1)
    expect(decision.nextState.redials).toBe(0)
  })

  it('a single disagreement followed by agreement is forgotten', () => {
    const { actions, state } = run([
      { kind: 'declared-on' },
      { kind: 'audio-present' },
      { kind: 'declared-on' },
    ])
    expect(actions).toEqual(['await-second-pass', 'none', 'await-second-pass'])
    expect(state.redials).toBe(0)
  })

  it('the threshold is exactly AUDIO_PLANE_DISAGREEMENTS_TO_ACT passes', () => {
    const observations = Array<AudioPlaneObservation>(AUDIO_PLANE_DISAGREEMENTS_TO_ACT).fill({
      kind: 'declared-on',
    })
    const { actions } = run(observations)
    expect(actions.filter((a) => a === 'redial')).toHaveLength(1)
    expect(actions[actions.length - 1]).toBe('redial')
  })
})

describe('decideAudioPlaneAction — the re-dial is bounded in rate and in total', () => {
  it('holds off inside the cooldown instead of re-dialing every tick', () => {
    const afterRedial: AudioPlaneState = {
      disagreements: 0,
      redials: 1,
      lastRedialMs: T0,
      gaveUp: false,
    }
    // Two disagreeing passes a second apart, well inside the cooldown.
    const { actions, state } = run([{ kind: 'declared-on' }, { kind: 'declared-on' }], {
      startState: afterRedial,
    })
    expect(actions).toEqual(['await-second-pass', 'cooldown'])
    expect(state.redials).toBe(1)
    // The counter is pinned at the threshold rather than growing forever.
    expect(state.disagreements).toBe(AUDIO_PLANE_DISAGREEMENTS_TO_ACT)
  })

  it('re-dials again once the cooldown has elapsed', () => {
    const afterRedial: AudioPlaneState = {
      disagreements: AUDIO_PLANE_DISAGREEMENTS_TO_ACT,
      redials: 1,
      lastRedialMs: T0 - AUDIO_PLANE_REDIAL_COOLDOWN_MS - 1,
      gaveUp: false,
    }
    const decision = decideAudioPlaneAction({ kind: 'declared-on' }, afterRedial, T0)
    expect(decision.action.kind).toBe('redial')
    expect(decision.nextState.redials).toBe(2)
    expect(decision.nextState.lastRedialMs).toBe(T0)
  })

  it('gives up after the cap and then stays SILENT — never an infinite loop', () => {
    let state: AudioPlaneState = EMPTY_AUDIO_PLANE_STATE
    const actions: string[] = []
    // 60 passes, each a full cooldown apart, all disagreeing.
    for (let i = 0; i < 60; i++) {
      const decision = decideAudioPlaneAction(
        { kind: 'declared-on' },
        state,
        T0 + i * (AUDIO_PLANE_REDIAL_COOLDOWN_MS + 1),
      )
      actions.push(decision.action.kind)
      state = decision.nextState
    }
    expect(actions.filter((a) => a === 'redial')).toHaveLength(AUDIO_PLANE_MAX_REDIALS)
    // The give-up verdict is emitted exactly once, so it is one warn line and
    // not a warn per tick forever.
    expect(actions.filter((a) => a === 'give-up')).toHaveLength(1)
    expect(state.gaveUp).toBe(true)
    expect(actions.slice(-10)).toEqual(Array<string>(10).fill('none'))
  })

  it('a camera that recovers after the give-up is re-armed', () => {
    const gaveUp: AudioPlaneState = {
      disagreements: 2,
      redials: AUDIO_PLANE_MAX_REDIALS,
      lastRedialMs: T0,
      gaveUp: true,
    }
    const { actions } = run(
      [{ kind: 'audio-present' }, { kind: 'declared-on' }, { kind: 'declared-on' }],
      { startState: gaveUp, stepMs: AUDIO_PLANE_REDIAL_COOLDOWN_MS + 1 },
    )
    expect(actions).toEqual(['none', 'await-second-pass', 'redial'])
  })
})
