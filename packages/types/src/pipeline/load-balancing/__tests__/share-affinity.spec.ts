import { describe, expect, it } from 'vitest'
import { electByShareWithAffinity } from '../share-election.js'
import type { ShareCandidate } from '../share-election.js'

function cand(
  key: string,
  share: number,
  running = 0,
  extra: Partial<ShareCandidate> = {},
): ShareCandidate {
  return { key, share, running, capped: false, saturated: false, ...extra }
}

describe('electByShareWithAffinity', () => {
  it('without a previous placement it is the plain share election', () => {
    const out = electByShareWithAffinity([cand('a', 1), cand('b', 1, 0, { recent: 1 })], null)
    expect(out.election).toMatchObject({ kind: 'elected', key: 'a' })
    expect(out).toMatchObject({ sticky: false, affinityReason: 'no-previous', turnKey: 'a' })
  })

  it('keeps the previous candidate when it is within one session of the turn holder', () => {
    // a is owed the turn by 0.5 sessions; b (previous) stays.
    const out = electByShareWithAffinity(
      [cand('a', 1, 0, { recent: 1 }), cand('b', 1, 0, { recent: 1.5 })],
      'b',
    )
    expect(out.election).toMatchObject({ kind: 'elected', key: 'b' })
    expect(out).toMatchObject({ sticky: true, affinityReason: 'within-one-session', turnKey: 'a' })
  })

  it('moves when the previous candidate is more than one session over', () => {
    const out = electByShareWithAffinity(
      [cand('a', 1, 0, { recent: 1 }), cand('b', 1, 0, { recent: 2.6 })],
      'b',
    )
    expect(out.election).toMatchObject({ kind: 'elected', key: 'a' })
    expect(out).toMatchObject({ sticky: false, affinityReason: 'share-off', turnKey: 'a' })
  })

  it('says the previous candidate is the turn holder when it is', () => {
    const out = electByShareWithAffinity([cand('a', 1), cand('b', 1, 0, { recent: 3 })], 'a')
    expect(out.election).toMatchObject({ kind: 'elected', key: 'a' })
    expect(out).toMatchObject({ sticky: true, affinityReason: 'previous-is-turn' })
  })

  it('never keeps a previous candidate that is not offered, capped or drowning', () => {
    const gone = electByShareWithAffinity([cand('a', 1), cand('b', 1, 0, { recent: 0.2 })], 'c')
    expect(gone).toMatchObject({ sticky: false, affinityReason: 'previous-ineligible' })
    const capped = electByShareWithAffinity(
      [cand('a', 1, 0, { recent: 0.5 }), cand('b', 1, 0, { capped: true })],
      'b',
    )
    expect(capped.election).toMatchObject({ key: 'a' })
    expect(capped).toMatchObject({ sticky: false, affinityReason: 'previous-no-room' })
    const drowning = electByShareWithAffinity(
      [cand('a', 1, 0, { recent: 0.5 }), cand('b', 1, 0, { saturated: true })],
      'b',
    )
    expect(drowning.election).toMatchObject({ key: 'a' })
    expect(drowning).toMatchObject({ sticky: false, affinityReason: 'previous-no-room' })
  })

  it('reports the candidates it scored so the election can be logged', () => {
    const out = electByShareWithAffinity([cand('a', 1, 2, { recent: 0.5 }), cand('b', 3)], 'a')
    expect(out.scored.map((s) => s.key).toSorted()).toEqual(['a', 'b'])
    const a = out.scored.find((s) => s.key === 'a')
    expect(a).toMatchObject({ running: 2, recent: 0.5 })
  })
})
