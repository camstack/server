import { describe, expect, it, vi } from 'vitest'
import {
  buildFaceRescoreReport,
  decideRescorePersistence,
  persistRescoreResult,
  type FaceRescoreParams,
  type FaceRescoreReport,
} from '../face-rescore.js'
import { deriveSuggestionMinCosine, SUGGESTION_BAND_FACTOR } from '../face-settings.js'
import { type GallerySample, matchEmbedding, rankIdentities } from '../pipeline/face-matcher.js'

const MODEL = 'auraface-r100'

function sample(identityId: string, embedding: number[], modelId = MODEL): GallerySample {
  return { identityId, embedding, modelId }
}

const NAMES: ReadonlyMap<string, string> = new Map([
  ['alice', 'Alice'],
  ['bob', 'Bob'],
  ['carol', 'Carol'],
])

/** The live hub's values, with the suggestion floor DERIVED (D222) rather than
 *  set beside the threshold — 0.45 against a hand-set 0.50 floor was the
 *  inverted, unproducible band that motivated the change. */
const PARAMS: FaceRescoreParams = {
  threshold: 0.45,
  margin: 0.12,
  minIdentitySamples: 2,
  suggestionMinCosine: deriveSuggestionMinCosine(0.45),
  suggestionBandFactor: SUGGESTION_BAND_FACTOR,
}

describe('rankIdentities', () => {
  it('scores EVERY identity with a comparable sample, not just the winner', () => {
    const gallery = [
      sample('alice', [1, 0, 0, 0]),
      sample('alice', [0.9, 0.1, 0, 0]),
      sample('bob', [0, 1, 0, 0]),
      sample('bob', [0.1, 0.9, 0, 0]),
    ]
    const rows = rankIdentities({ embedding: [1, 0, 0, 0], modelId: MODEL }, gallery, 2)
    expect(rows.map((r) => r.identityId)).toEqual(['alice', 'bob'])
    expect(rows[0]!.score).toBeCloseTo(1, 6)
    expect(rows[0]!.sampleCount).toBe(2)
    expect(rows[0]!.eligible).toBe(true)
  })

  it('keeps an INELIGIBLE identity in the ranking, flagged, instead of hiding it', () => {
    // Carol has one sample and minIdentitySamples is 2: the matcher must not
    // consider her, but the operator must still see why she is not offered.
    const gallery = [
      sample('alice', [1, 0, 0, 0]),
      sample('alice', [0.9, 0.1, 0, 0]),
      sample('carol', [1, 0, 0, 0]),
    ]
    const rows = rankIdentities({ embedding: [1, 0, 0, 0], modelId: MODEL }, gallery, 2)
    const carol = rows.find((r) => r.identityId === 'carol')
    expect(carol).toBeDefined()
    expect(carol!.eligible).toBe(false)
    expect(carol!.sampleCount).toBe(1)
  })

  it('excludes samples from another model space entirely', () => {
    const gallery = [sample('alice', [1, 0, 0, 0], 'arcface-r100'), sample('bob', [0, 1, 0, 0])]
    const rows = rankIdentities({ embedding: [1, 0, 0, 0], modelId: MODEL }, gallery, 1)
    expect(rows.map((r) => r.identityId)).toEqual(['bob'])
  })

  it('excludes samples of a different dimension', () => {
    const gallery = [sample('alice', [1, 0, 0]), sample('bob', [0, 1, 0, 0])]
    const rows = rankIdentities({ embedding: [1, 0, 0, 0], modelId: MODEL }, gallery, 1)
    expect(rows.map((r) => r.identityId)).toEqual(['bob'])
  })

  it('is sorted by score descending', () => {
    const gallery = [
      sample('alice', [0.5, 0.86, 0, 0]),
      sample('bob', [1, 0, 0, 0]),
      sample('carol', [0.86, 0.5, 0, 0]),
    ]
    const rows = rankIdentities({ embedding: [1, 0, 0, 0], modelId: MODEL }, gallery, 1)
    expect(rows.map((r) => r.identityId)).toEqual(['bob', 'carol', 'alice'])
  })
})

describe('rankIdentities is the SAME authority matchEmbedding uses', () => {
  // The point of the refactor: one scoring implementation. If these ever
  // disagree the rescore button is lying about what the pipeline would do.
  const gallery = [
    sample('alice', [1, 0, 0, 0]),
    sample('alice', [0.99, 0.14, 0, 0]),
    sample('bob', [0.9, 0.44, 0, 0]),
    sample('bob', [0.88, 0.47, 0, 0]),
    sample('carol', [0, 0, 1, 0]),
    sample('carol', [0, 0, 0.99, 0.14]),
  ]
  const probes: readonly number[][] = [
    [1, 0, 0, 0],
    [0.9, 0.44, 0, 0],
    [0.7, 0.7, 0, 0],
    [0, 0, 1, 0],
    [0, 1, 0, 0],
  ]

  for (const probe of probes) {
    it(`agrees with matchEmbedding for probe ${JSON.stringify(probe)}`, () => {
      const opts = {
        threshold: PARAMS.threshold,
        margin: PARAMS.margin,
        minIdentitySamples: PARAMS.minIdentitySamples,
      }
      const match = matchEmbedding({ embedding: probe, modelId: MODEL }, gallery, opts)
      const report = buildFaceRescoreReport({
        probe: { embedding: probe, modelId: MODEL },
        gallery,
        identityNames: NAMES,
        clusterModelId: MODEL,
        params: PARAMS,
      })
      if (match === null) {
        expect(report.verdict).not.toBe('auto-assignable')
      } else {
        expect(report.verdict).toBe('auto-assignable')
        expect(report.identities[0]!.identityId).toBe(match.identityId)
        expect(report.identities[0]!.score).toBeCloseTo(match.score, 9)
      }
    })
  }
})

describe('buildFaceRescoreReport', () => {
  const twoEach = [
    sample('alice', [1, 0, 0, 0]),
    sample('alice', [0.99, 0.14, 0, 0]),
    sample('bob', [0, 1, 0, 0]),
    sample('bob', [0.14, 0.99, 0, 0]),
  ]

  it('reports auto-assignable when the best clears threshold AND margin', () => {
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: MODEL },
      gallery: twoEach,
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.verdict).toBe('auto-assignable')
    expect(r.comparable).toBe(true)
    expect(r.identities[0]!.name).toBe('Alice')
    expect(r.identities[0]!.meetsThreshold).toBe(true)
    expect(r.identities[0]!.wouldAutoAssign).toBe(true)
    // Bob is scored too — the whole point of the button.
    expect(r.identities).toHaveLength(2)
    expect(r.identities[1]!.wouldAutoAssign).toBe(false)
  })

  it('reports AMBIGUOUS when two identities clear threshold within the margin', () => {
    const gallery = [
      sample('alice', [1, 0, 0, 0]),
      sample('alice', [0.99, 0.14, 0, 0]),
      sample('bob', [0.999, 0.045, 0, 0]),
      sample('bob', [0.998, 0.06, 0, 0]),
    ]
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: MODEL },
      gallery,
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.verdict).toBe('ambiguous')
    expect(r.identities[0]!.wouldAutoAssign).toBe(false)
    expect(r.runnerUpGap).toBeLessThan(PARAMS.margin)
  })

  it('reports SUGGESTION when the best sits in the suggestion band', () => {
    // threshold 0.60 ⇒ derived suggestion floor 0.48; cos ≈ 0.53 lands between.
    // Both samples are near the +x axis so the BEST of them is still ≈ 0.53 —
    // an off-axis second sample would score HIGHER against this probe and the
    // fixture would silently test auto-assignment instead.
    const gallery = [sample('alice', [1, 0, 0, 0]), sample('alice', [0.999, 0, 0.0447, 0])]
    const r = buildFaceRescoreReport({
      probe: { embedding: [0.53, 0.848, 0, 0], modelId: MODEL },
      gallery,
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: { ...PARAMS, threshold: 0.6, suggestionMinCosine: deriveSuggestionMinCosine(0.6) },
    })
    expect(r.verdict).toBe('suggestion')
  })

  it('reports below-threshold when nothing reaches the suggestion floor', () => {
    const r = buildFaceRescoreReport({
      probe: { embedding: [0, 0, 1, 0], modelId: MODEL },
      gallery: twoEach,
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.verdict).toBe('below-threshold')
    expect(r.identities).toHaveLength(2)
  })

  it('an INELIGIBLE identity can never be the auto-assign winner', () => {
    // Carol scores 1.0 but has a single sample: minIdentitySamples excludes her
    // from matching. She must be listed, and the verdict must ignore her.
    const gallery = [...twoEach, sample('carol', [1, 0, 0, 0])]
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: MODEL },
      gallery,
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    const carol = r.identities.find((i) => i.identityId === 'carol')!
    expect(carol.eligible).toBe(false)
    expect(carol.wouldAutoAssign).toBe(false)
    expect(r.verdict).toBe('auto-assignable')
    expect(r.identities.find((i) => i.wouldAutoAssign)!.identityId).toBe('alice')
  })

  it('names the all-single-sample case instead of calling it below-threshold', () => {
    // Every identity scores 1.0 but none has minIdentitySamples: the gallery
    // knows this face perfectly and can still assign nobody. "Below threshold"
    // would send the operator to the wrong knob.
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: MODEL },
      gallery: [sample('alice', [1, 0, 0, 0]), sample('bob', [1, 0, 0, 0])],
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.verdict).toBe('no-eligible-identity')
    expect(r.identities).toHaveLength(2)
    expect(r.identities.every((i) => !i.eligible)).toBe(true)
    expect(r.runnerUpGap).toBeUndefined()
  })

  it('refuses to score at all when the probe is in a DIFFERENT model space', () => {
    // D196: a vector from another feature space is not comparable. Percentages
    // computed across spaces are noise wearing a number's clothes.
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },
      gallery: twoEach,
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.verdict).toBe('model-mismatch')
    expect(r.comparable).toBe(false)
    expect(r.identities).toHaveLength(0)
    expect(r.probeModelId).toBe('arcface-r100')
    expect(r.clusterModelId).toBe(MODEL)
  })

  it('reports an empty gallery honestly rather than as below-threshold', () => {
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: MODEL },
      gallery: [],
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.verdict).toBe('empty-gallery')
    expect(r.identities).toHaveLength(0)
  })

  it('a gallery entirely in another space is empty-gallery for the probe, not a match', () => {
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: MODEL },
      gallery: [
        sample('alice', [1, 0, 0, 0], 'arcface-r100'),
        sample('alice', [0.99, 0.14, 0, 0], 'arcface-r100'),
      ],
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.verdict).toBe('empty-gallery')
  })

  it('falls back to the identity id when a name is unknown', () => {
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: MODEL },
      gallery: [sample('zed', [1, 0, 0, 0]), sample('zed', [0.99, 0.14, 0, 0])],
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.identities[0]!.name).toBe('zed')
  })

  it('carries the params in force so the UI never restates a default', () => {
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: MODEL },
      gallery: twoEach,
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.params).toEqual(PARAMS)
  })
})

/**
 * The report is what the operator reads to find out WHY a face scored the way
 * it did. Since the suggestion floor is no longer a setting they can look up
 * (D222), the report has to carry both the floor and the rule that produced it
 * — a number that moves whenever another number moves reads as a bug otherwise.
 */
describe('the report states that the suggestion floor is DERIVED', () => {
  it('echoes the floor together with the factor it came from', () => {
    const r = buildFaceRescoreReport({
      probe: { embedding: [1, 0, 0, 0], modelId: MODEL },
      gallery: [sample('alice', [1, 0, 0, 0]), sample('alice', [0.99, 0.1, 0, 0])],
      identityNames: NAMES,
      clusterModelId: MODEL,
      params: PARAMS,
    })
    expect(r.params.suggestionMinCosine).toBe(0.36)
    expect(r.params.suggestionBandFactor).toBe(0.8)
    // The rule holds in the report itself: floor = factor × threshold.
    expect(r.params.suggestionMinCosine).toBe(deriveSuggestionMinCosine(r.params.threshold))
    expect(r.params.suggestionMinCosine).toBeLessThan(r.params.threshold)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Persistence — decideRescorePersistence / persistRescoreResult
// ─────────────────────────────────────────────────────────────────────────

describe('decideRescorePersistence', () => {
  const BASE: FaceRescoreReport = {
    verdict: 'suggestion',
    comparable: true,
    probeModelId: MODEL,
    clusterModelId: MODEL,
    params: PARAMS,
    identities: [],
  }

  it('auto-assignable ⇒ the first ELIGIBLE identity, never identities[0] blindly', () => {
    const candidate = decideRescorePersistence({
      ...BASE,
      verdict: 'auto-assignable',
      identities: [
        {
          identityId: 'blocked',
          name: 'Blocked',
          score: 0.99,
          sampleCount: 1,
          eligible: false,
          meetsThreshold: true,
          wouldAutoAssign: false,
        },
        {
          identityId: 'alice',
          name: 'Alice',
          score: 0.8,
          sampleCount: 4,
          eligible: true,
          meetsThreshold: true,
          wouldAutoAssign: true,
        },
      ],
    })
    expect(candidate).toEqual({ identityId: 'alice', score: 0.8 })
  })

  it('suggestion ⇒ the first eligible identity', () => {
    const candidate = decideRescorePersistence({
      ...BASE,
      verdict: 'suggestion',
      identities: [
        {
          identityId: 'bob',
          name: 'Bob',
          score: 0.5,
          sampleCount: 3,
          eligible: true,
          meetsThreshold: false,
          wouldAutoAssign: false,
        },
      ],
    })
    expect(candidate).toEqual({ identityId: 'bob', score: 0.5 })
  })

  it('a suggestion/auto-assignable verdict whose best row is INELIGIBLE ⇒ null', () => {
    const candidate = decideRescorePersistence({
      ...BASE,
      verdict: 'suggestion',
      identities: [
        {
          identityId: 'blocked',
          name: 'Blocked',
          score: 0.9,
          sampleCount: 1,
          eligible: false,
          meetsThreshold: true,
          wouldAutoAssign: false,
        },
      ],
    })
    expect(candidate).toBeNull()
  })

  it.each([
    'ambiguous',
    'below-threshold',
    'no-eligible-identity',
    'empty-gallery',
  ] as const)('%s ⇒ null — never picks a winner the matcher itself refused to pick', (verdict) => {
    const candidate = decideRescorePersistence({
      ...BASE,
      verdict,
      identities: [
        {
          identityId: 'alice',
          name: 'Alice',
          score: 0.7,
          sampleCount: 4,
          eligible: true,
          meetsThreshold: true,
          wouldAutoAssign: false,
        },
      ],
    })
    expect(candidate).toBeNull()
  })
})

describe('persistRescoreResult — the PORTANTE guarantee: model-mismatch never writes', () => {
  const BASE: FaceRescoreReport = {
    verdict: 'suggestion',
    comparable: true,
    probeModelId: MODEL,
    clusterModelId: MODEL,
    params: PARAMS,
    identities: [
      {
        identityId: 'alice',
        name: 'Alice',
        score: 0.8,
        sampleCount: 4,
        eligible: true,
        meetsThreshold: true,
        wouldAutoAssign: true,
      },
    ],
  }

  it('model-mismatch (comparable: false): setSuggestion is NEVER called', async () => {
    const setSuggestion = vi.fn(async () => undefined)
    const outcome = await persistRescoreResult(
      'face-t1',
      { ...BASE, verdict: 'model-mismatch', comparable: false, identities: [] },
      { setSuggestion },
    )
    expect(outcome).toBe('not-comparable')
    expect(setSuggestion).not.toHaveBeenCalled()
  })

  it('a comparable verdict WITH a candidate writes it', async () => {
    const setSuggestion = vi.fn(async () => undefined)
    const outcome = await persistRescoreResult(
      'face-t1',
      { ...BASE, verdict: 'auto-assignable' },
      { setSuggestion },
    )
    expect(outcome).toBe('written')
    expect(setSuggestion).toHaveBeenCalledTimes(1)
    expect(setSuggestion).toHaveBeenCalledWith('face-t1', { identityId: 'alice', score: 0.8 })
  })

  it('a comparable verdict with NO candidate clears — a write, not a no-op', async () => {
    const setSuggestion = vi.fn(async () => undefined)
    const outcome = await persistRescoreResult(
      'face-t1',
      { ...BASE, verdict: 'below-threshold' },
      { setSuggestion },
    )
    expect(outcome).toBe('cleared')
    expect(setSuggestion).toHaveBeenCalledTimes(1)
    expect(setSuggestion).toHaveBeenCalledWith('face-t1', null)
  })

  it('DISARM CHECK: without the comparable gate, model-mismatch WOULD write — proving the gate is load-bearing', async () => {
    // This mirrors what `persistRescoreResult` guards against: if a caller
    // skipped the `report.comparable` check and called
    // `decideRescorePersistence` directly on a model-mismatch report that
    // happened to carry stale `identities` (e.g. a caller that forgot to
    // clear them), noise would look like data. `decideRescorePersistence`
    // itself has no comparable gate — `persistRescoreResult` is the ONLY
    // place that gate is enforced, which is exactly what the tests above
    // prove and this one demonstrates the absence of.
    const candidateIfUngated = decideRescorePersistence({
      ...BASE,
      verdict: 'auto-assignable',
      comparable: false,
    })
    expect(candidateIfUngated).not.toBeNull()
  })
})
