/**
 * The mirror behind the `scene` gate, and the semantics it feeds.
 *
 * Every test here is about a failure that would be SILENT in production: a rule
 * that keeps firing because a scene went stale, one that stops firing because a
 * single read threw, or — the one this whole design exists to prevent (D49) — a
 * failed read that looks exactly like the scene having gone back to normal and
 * un-gates the alarm at the moment the operator most needs it gated.
 *
 * The three neutralization checks are named in the test titles: each is written
 * so that removing the guard in `scene-state-cache.ts` makes it fail.
 */
import type { SceneMonitor } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  type NcSceneObservation,
  NcSceneStateCache,
  SCENE_MAX_AGE_MS,
  sceneConditionSatisfied,
  sceneGateReason,
} from '../scene-state-cache.js'

const T0 = 1_800_000_000_000
const SCENE = 'scene-uuid-1'

function observation(over: Partial<NcSceneObservation> = {}): NcSceneObservation {
  return {
    sceneId: SCENE,
    deviceId: 102,
    label: 'Bin out front',
    verdict: 'matched',
    latched: false,
    emit: 'latched',
    ...over,
  }
}

function makeCache(
  readScenes: () => readonly NcSceneObservation[],
  clock: { now: number },
): NcSceneStateCache {
  return new NcSceneStateCache({
    logger: makeSilentLogger(),
    readScenes,
    now: () => clock.now,
  })
}

describe('NcSceneStateCache', () => {
  it('a COLD mirror knows nothing — a gated rule does not fire before the first read', () => {
    const clock = { now: T0 }
    const cache = makeCache(() => [observation()], clock)
    cache.setWatched([SCENE])
    expect(cache.get(SCENE)).toBeUndefined()
  })

  it('serves the observation after a refresh', () => {
    const clock = { now: T0 }
    const cache = makeCache(() => [observation({ verdict: 'diverged', latched: true })], clock)
    cache.setWatched([SCENE])
    cache.refresh()
    expect(cache.get(SCENE)?.verdict).toBe('diverged')
    expect(cache.get(SCENE)?.latched).toBe(true)
  })

  it('reads NOTHING it was not asked to watch — a rule set with no scene gate does no work', () => {
    const clock = { now: T0 }
    let calls = 0
    const cache = makeCache(() => {
      calls += 1
      return [observation()]
    }, clock)
    cache.refresh()
    expect(calls).toBe(0)
    expect(cache.get(SCENE)).toBeUndefined()
  })

  it('drops a watched scene the refresh no longer answers for — deleted must stop arming', () => {
    const clock = { now: T0 }
    let present = true
    const cache = makeCache(() => (present ? [observation()] : []), clock)
    cache.setWatched([SCENE])
    cache.refresh()
    expect(cache.get(SCENE)).toBeDefined()
    present = false
    cache.refresh()
    expect(cache.get(SCENE)).toBeUndefined()
  })

  /**
   * NEUTRALIZATION: delete the `try`/`catch` around `readScenes()` in
   * `refresh()` and this test throws instead of passing. Replace the `return`
   * inside the catch with a fall-through that assigns an empty list and it
   * fails on the second assertion — which is precisely the D49 bug: one bad
   * read looks exactly like the scene going back to `matched`.
   */
  it('a FAILED refresh keeps what it already had — a bad read is not an un-gate (D49)', () => {
    const clock = { now: T0 }
    let broken = false
    const cache = makeCache(() => {
      if (broken) throw new Error('store unreachable')
      return [observation({ verdict: 'diverged', latched: true })]
    }, clock)
    cache.setWatched([SCENE])
    cache.refresh()
    broken = true
    cache.refresh()
    expect(cache.get(SCENE)?.verdict).toBe('diverged')
    expect(cache.get(SCENE)?.latched).toBe(true)
  })

  /**
   * NEUTRALIZATION: remove the `now - entry.at > SCENE_MAX_AGE_MS` check in
   * `get()` and this fails — a sustained outage would then pin a week-old
   * verdict forever, which is the other half of the same mistake.
   */
  it('…but it does NOT keep it forever: a stale entry ages out', () => {
    const clock = { now: T0 }
    let broken = false
    const cache = makeCache(() => {
      if (broken) throw new Error('store unreachable')
      return [observation({ verdict: 'diverged' })]
    }, clock)
    cache.setWatched([SCENE])
    cache.refresh()
    broken = true
    clock.now = T0 + SCENE_MAX_AGE_MS + 1
    cache.refresh()
    expect(cache.get(SCENE)).toBeUndefined()
  })

  /**
   * NEUTRALIZATION: drop the `noted` branch from `get()` and this fails — the
   * gate would then answer with the reconciled value for up to a reload tick
   * after the scene flipped, which is exactly the lag `onAlarmPublish` was
   * added to close for `deviceState`.
   */
  it('an in-process edge OUTRANKS the last refresh — the next event already sees the flip', () => {
    const clock = { now: T0 }
    const cache = makeCache(() => [observation({ verdict: 'matched', latched: false })], clock)
    cache.setWatched([SCENE])
    cache.refresh()
    cache.note(observation({ verdict: 'diverged', latched: true }))
    expect(cache.get(SCENE)?.verdict).toBe('diverged')
    expect(cache.get(SCENE)?.latched).toBe(true)
  })

  it('a noted edge ages out too, so a scene that stopped reporting falls back to the tick', () => {
    const clock = { now: T0 }
    const cache = makeCache(() => [observation({ verdict: 'matched' })], clock)
    cache.setWatched([SCENE])
    cache.note(observation({ verdict: 'diverged' }))
    clock.now = T0 + SCENE_MAX_AGE_MS + 1
    cache.refresh()
    expect(cache.get(SCENE)?.verdict).toBe('matched')
  })
})

describe('sceneConditionSatisfied', () => {
  const LIVE = { sceneId: SCENE, requiredState: 'diverged' as const, latched: false }
  const LATCH = { sceneId: SCENE, requiredState: 'diverged' as const, latched: true }

  it('LIVE reads the verdict', () => {
    expect(sceneConditionSatisfied(LIVE, observation({ verdict: 'diverged' }))).toBe(true)
    expect(sceneConditionSatisfied(LIVE, observation({ verdict: 'matched' }))).toBe(false)
  })

  it('LIVE: `unknown` satisfies NEITHER required state — it is not evidence in either direction', () => {
    const unknown: SceneMonitor['verdict'] = 'unknown'
    expect(sceneConditionSatisfied(LIVE, observation({ verdict: unknown }))).toBe(false)
    expect(
      sceneConditionSatisfied(
        { ...LIVE, requiredState: 'matched' },
        observation({ verdict: unknown }),
      ),
    ).toBe(false)
  })

  it('LATCHED reads the latch, and a scene that cannot judge does NOT clear it', () => {
    expect(sceneConditionSatisfied(LATCH, observation({ verdict: 'unknown', latched: true }))).toBe(
      true,
    )
    expect(
      sceneConditionSatisfied(LATCH, observation({ verdict: 'unknown', latched: false })),
    ).toBe(false)
  })

  it('LATCHED + requiredState `matched` means "not latched"', () => {
    expect(
      sceneConditionSatisfied(
        { ...LATCH, requiredState: 'matched' },
        observation({ latched: false }),
      ),
    ).toBe(true)
    expect(
      sceneConditionSatisfied(
        { ...LATCH, requiredState: 'matched' },
        observation({ latched: true }),
      ),
    ).toBe(false)
  })

  /**
   * NEUTRALIZATION: replace `condition.latched ?? observation.emit === 'latched'`
   * with a bare `condition.latched === true` and this fails. The scene's own
   * `emit` is the authority for which boolean drives rules (D62); a condition
   * that silently defaulted to `live` would disagree with the scene card the
   * operator is looking at.
   */
  it('`latched` ABSENT follows the scene’s own `emit`, in both directions', () => {
    const bare = { sceneId: SCENE, requiredState: 'diverged' as const }
    // emit: 'latched' → the latch decides, even though the live verdict is back.
    expect(
      sceneConditionSatisfied(
        bare,
        observation({ emit: 'latched', verdict: 'matched', latched: true }),
      ),
    ).toBe(true)
    // emit: 'live' → the verdict decides, even though the latch still holds.
    expect(
      sceneConditionSatisfied(
        bare,
        observation({ emit: 'live', verdict: 'matched', latched: true }),
      ),
    ).toBe(false)
  })
})

describe('sceneGateReason', () => {
  it('names the ABSENCE distinctly from a state that simply did not match', () => {
    const condition = { sceneId: SCENE, requiredState: 'diverged' as const }
    expect(sceneGateReason(condition, undefined)).toBe('no mirrored state for this scene')
    expect(sceneGateReason(condition, observation({ emit: 'live', verdict: 'matched' }))).toContain(
      'verdict=matched',
    )
    expect(sceneGateReason(condition, observation({ emit: 'latched', latched: false }))).toContain(
      'latched=false',
    )
  })
})
