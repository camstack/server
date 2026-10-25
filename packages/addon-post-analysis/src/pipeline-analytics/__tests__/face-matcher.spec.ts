import { describe, it, expect } from 'vitest'
import {
  matchEmbedding,
  assignUniquePerFrame,
  enrollmentPromiscuity,
  updateTrackAggregate,
  EMPTY_AGGREGATE,
  ENROLLMENT_MAX_FOREIGN_COSINE,
  type GallerySample,
  type FaceCandidate,
} from '../pipeline/face-matcher.js'

const OPTS = { threshold: 0.45, margin: 0.05 }

function sample(identityId: string, embedding: number[]): GallerySample {
  return { identityId, embedding, modelId: 'arcface-r100' }
}

describe('matchEmbedding', () => {
  it('returns the best identity when above threshold and unambiguous', () => {
    const gallery = [sample('alice', [1, 0, 0, 0]), sample('bob', [0, 1, 0, 0])]
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toEqual({ identityId: 'alice', score: 1 })
  })

  it('matches a single-identity gallery above threshold regardless of margin (no second identity)', () => {
    // Only one identity exists → the ambiguity/margin gate must be bypassed.
    const gallery = [sample('alice', [1, 0, 0, 0])]
    const m = matchEmbedding(
      { embedding: [0.99, 0.14, 0, 0], modelId: 'arcface-r100' },
      gallery,
      OPTS,
    )
    expect(m?.identityId).toBe('alice')
    expect(m!.score).toBeGreaterThanOrEqual(OPTS.threshold)
  })

  it('returns null when the best score is below threshold', () => {
    const gallery = [sample('alice', [1, 0, 0, 0])]
    // orthogonal-ish probe → cosine 0 < 0.45
    const m = matchEmbedding({ embedding: [0, 1, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toBeNull()
  })

  it('returns null when two identities are within the margin (ambiguous)', () => {
    // Two identities that score nearly equally for the probe.
    const gallery = [sample('alice', [1, 0.02, 0, 0]), sample('bob', [1, -0.02, 0, 0])]
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toBeNull()
  })

  it('skips samples from a different model id', () => {
    const gallery: GallerySample[] = [
      { identityId: 'alice', embedding: [1, 0, 0, 0], modelId: 'old-model' },
    ]
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toBeNull()
  })

  it('skips samples whose dimension differs from the probe', () => {
    const gallery = [sample('alice', [1, 0, 0])] // dim 3
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS) // dim 4
    expect(m).toBeNull()
  })

  it('takes the max score across multiple samples of the same identity', () => {
    const gallery = [sample('alice', [0, 1, 0, 0]), sample('alice', [1, 0, 0, 0])]
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toEqual({ identityId: 'alice', score: 1 })
  })
})

describe('assignUniquePerFrame', () => {
  it('discards an identity pair the margin calls ambiguous — the live-path bug of 2026-08-18', () => {
    // assignUniquePerFrame filtered on threshold alone: opts.margin was
    // received and never read, so the ambiguity guard that matchEmbedding has
    // always applied did not exist on the AUTO-ASSIGN path. Measured on the
    // live gallery: 241 of 258 auto-assignments in 24 h violated the margin,
    // and 79 would match a DIFFERENT identity re-scored today.
    const gallery = [sample('alice', [1, 0.02, 0, 0]), sample('bob', [1, -0.02, 0, 0])]
    const candidates: FaceCandidate[] = [
      { trackId: 't1', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },
    ]
    const out = assignUniquePerFrame(candidates, gallery, OPTS)
    expect(out.size).toBe(0)
  })

  it('a single-identity gallery still assigns — no second identity, no ambiguity', () => {
    const gallery = [sample('alice', [1, 0, 0, 0])]
    const candidates: FaceCandidate[] = [
      { trackId: 't1', embedding: [0.99, 0.14, 0, 0], modelId: 'arcface-r100' },
    ]
    const out = assignUniquePerFrame(candidates, gallery, OPTS)
    expect(out.get('t1')?.identityId).toBe('alice')
  })

  it('the margin gate is per candidate: an unambiguous sibling still assigns', () => {
    const gallery = [sample('alice', [1, 0.02, 0, 0]), sample('bob', [0, 1, 0, 0])]
    const candidates: FaceCandidate[] = [
      // ambiguous between alice and... actually clearly alice vs bob far apart
      { trackId: 'clear', embedding: [1, 0.02, 0, 0], modelId: 'arcface-r100' },
    ]
    const out = assignUniquePerFrame(candidates, gallery, OPTS)
    expect(out.get('clear')?.identityId).toBe('alice')
  })
  it('assigns each identity to at most one track (highest score wins)', () => {
    const gallery = [sample('alice', [1, 0, 0, 0])]
    const candidates: FaceCandidate[] = [
      { trackId: 't1', embedding: [0.9, 0.1, 0, 0], modelId: 'arcface-r100' }, // lower
      { trackId: 't2', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, // higher
    ]
    const assigned = assignUniquePerFrame(candidates, gallery, OPTS)
    expect(assigned.get('t2')).toEqual({ identityId: 'alice', score: 1 })
    expect(assigned.has('t1')).toBe(false) // alice already taken by t2
  })

  it('lets a loser take its next-best free identity', () => {
    const gallery = [sample('alice', [1, 0, 0, 0]), sample('bob', [0, 1, 0, 0])]
    const candidates: FaceCandidate[] = [
      { trackId: 't1', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, // alice 1.0
      { trackId: 't2', embedding: [0.85, 0.52, 0, 0], modelId: 'arcface-r100' }, // alice ~0.85 > bob; alice taken → bob
    ]
    const assigned = assignUniquePerFrame(candidates, gallery, OPTS)
    expect(assigned.get('t1')).toEqual({ identityId: 'alice', score: 1 })
    expect(assigned.get('t2')?.identityId).toBe('bob')
  })

  it('empty gallery returns empty map', () => {
    const candidates: FaceCandidate[] = [
      { trackId: 't1', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },
    ]
    const assigned = assignUniquePerFrame(candidates, [], OPTS)
    expect(assigned.size).toBe(0)
  })

  it('no candidates returns empty map', () => {
    const gallery = [sample('alice', [1, 0, 0, 0])]
    const assigned = assignUniquePerFrame([], gallery, OPTS)
    expect(assigned.size).toBe(0)
  })
})

describe('updateTrackAggregate', () => {
  const AGG = { confirmFrames: 2 }

  it('assigns after confirmFrames cumulative confirmations', () => {
    let s = EMPTY_AGGREGATE
    let r = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG)
    expect(r.changed).toBe(false)
    expect(r.state.assignedIdentityId).toBeNull()
    r = updateTrackAggregate(r.state, { identityId: 'alice', score: 0.9 }, AGG)
    expect(r.changed).toBe(true)
    expect(r.state.assignedIdentityId).toBe('alice')
  })

  it('a null match does not change state', () => {
    const r = updateTrackAggregate(EMPTY_AGGREGATE, null, AGG)
    expect(r.changed).toBe(false)
    expect(r.state).toEqual(EMPTY_AGGREGATE)
  })

  it('keeps the assignment when the same identity re-matches (no re-fire)', () => {
    let s = EMPTY_AGGREGATE
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state // assigned
    const r = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG)
    expect(r.changed).toBe(false)
    expect(r.state.assignedIdentityId).toBe('alice')
  })

  it('switches identity only after the challenger reaches confirmFrames', () => {
    let s = EMPTY_AGGREGATE
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state // assigned alice
    let r = updateTrackAggregate(s, { identityId: 'bob', score: 0.9 }, AGG)
    expect(r.state.assignedIdentityId).toBe('alice') // 1 bob confirmation — not yet
    expect(r.changed).toBe(false)
    r = updateTrackAggregate(r.state, { identityId: 'bob', score: 0.9 }, AGG)
    expect(r.state.assignedIdentityId).toBe('bob') // 2 → switch
    expect(r.changed).toBe(true)
  })

  it('switch-back requires full re-confirmation after reset', () => {
    // alice assigned, then bob assigned — alice must re-reach confirmFrames to switch back
    let s = EMPTY_AGGREGATE
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state // assigned alice
    s = updateTrackAggregate(s, { identityId: 'bob', score: 0.9 }, AGG).state
    s = updateTrackAggregate(s, { identityId: 'bob', score: 0.9 }, AGG).state // assigned bob

    // Single alice frame must NOT switch back (stale count was reset on bob assignment)
    const r1 = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG)
    expect(r1.state.assignedIdentityId).toBe('bob')
    expect(r1.changed).toBe(false)

    // Second alice frame reaches confirmFrames → switch back
    const r2 = updateTrackAggregate(r1.state, { identityId: 'alice', score: 0.9 }, AGG)
    expect(r2.state.assignedIdentityId).toBe('alice')
    expect(r2.changed).toBe(true)
  })
})

describe('minIdentitySamples — no single-sample sink (#26.3)', () => {
  it('excludes a 1-sample identity from auto-matching when minIdentitySamples=2', () => {
    // The "Bob" collapse: a lone 1-sample identity above threshold with no
    // competitor bypassed the ambiguity guard and attracted every probe.
    const gallery = [sample('bob', [1, 0, 0, 0])]
    const probe = { embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }
    // Legacy behaviour (no min-sample gate) still matches.
    expect(matchEmbedding(probe, gallery, OPTS)?.identityId).toBe('bob')
    // With the gate, a 1-sample identity is not an eligible target.
    expect(matchEmbedding(probe, gallery, { ...OPTS, minIdentitySamples: 2 })).toBeNull()
  })

  it('a 2-sample identity IS an eligible auto-match target', () => {
    const gallery = [sample('bob', [1, 0, 0, 0]), sample('bob', [0.99, 0.14, 0, 0])]
    const probe = { embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }
    expect(matchEmbedding(probe, gallery, { ...OPTS, minIdentitySamples: 2 })?.identityId).toBe(
      'bob',
    )
  })

  it('assignUniquePerFrame skips a 1-sample identity under the gate', () => {
    const gallery = [sample('bob', [1, 0, 0, 0])]
    const candidates: FaceCandidate[] = [
      { trackId: 'tk1', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },
    ]
    const withGate = assignUniquePerFrame(candidates, gallery, { ...OPTS, minIdentitySamples: 2 })
    expect(withGate.size).toBe(0)
    const withoutGate = assignUniquePerFrame(candidates, gallery, OPTS)
    expect(withoutGate.get('tk1')?.identityId).toBe('bob')
  })
})

describe('tightened defaults — borderline distance below the threshold is rejected', () => {
  it('rejects a probe whose best score is between the old (0.45) and new (0.55) threshold', () => {
    const gallery = [sample('alice', [1, 0, 0, 0]), sample('alice', [1, 0, 0, 0])]
    // Construct a probe with cosine ~0.5 to the enrolled vector.
    const probe = { embedding: [1, 1, 0, 0], modelId: 'arcface-r100' } // cos = 1/sqrt(2) ≈ 0.707
    // Pick a probe that lands ~0.5: [1, 1.73, 0, 0] → cos = 1/2 = 0.5.
    const borderline = { embedding: [1, Math.sqrt(3), 0, 0], modelId: 'arcface-r100' }
    expect(
      matchEmbedding(borderline, gallery, { threshold: 0.55, margin: 0.1, minIdentitySamples: 2 }),
    ).toBeNull()
    // A clearly-above probe still matches under the tightened threshold.
    expect(
      matchEmbedding(probe, gallery, { threshold: 0.55, margin: 0.1, minIdentitySamples: 2 })
        ?.identityId,
    ).toBe('alice')
  })
})

describe('enrollmentPromiscuity', () => {
  // The gallery poisoning of 2026-08-18: assignFace enrolled production
  // embeddings verbatim, and 22 of 50 live samples turned out to sit in the
  // low-information attractor — cosines up to 0.988 against samples of OTHER
  // identities, impossible for genuine faces. The gate condemns an embedding
  // whose best foreign cosine crosses the bound BEFORE it is enrolled.
  it('condemns an embedding near a FOREIGN identity sample', () => {
    const gallery = [sample('alice', [1, 0, 0, 0])]
    const verdict = enrollmentPromiscuity([0.999, 0.045, 0, 0], 'arcface-r100', 'bob', gallery)
    expect(verdict).not.toBeNull()
    expect(verdict!.identityId).toBe('alice')
    expect(verdict!.cosine).toBeGreaterThanOrEqual(ENROLLMENT_MAX_FOREIGN_COSINE)
  })

  it('accepts an embedding close only to its OWN identity', () => {
    const gallery = [sample('bob', [1, 0, 0, 0]), sample('alice', [0, 1, 0, 0])]
    expect(enrollmentPromiscuity([1, 0.02, 0, 0], 'arcface-r100', 'bob', gallery)).toBeNull()
  })

  it('ignores samples of a different model or dimension', () => {
    const gallery: GallerySample[] = [
      { identityId: 'alice', embedding: [1, 0, 0, 0], modelId: 'old-model' },
      { identityId: 'alice', embedding: [1, 0, 0], modelId: 'arcface-r100' },
    ]
    expect(enrollmentPromiscuity([1, 0, 0, 0], 'arcface-r100', 'bob', gallery)).toBeNull()
  })

  it('an empty gallery condemns nothing', () => {
    expect(enrollmentPromiscuity([1, 0, 0, 0], 'arcface-r100', 'bob', [])).toBeNull()
  })
})
