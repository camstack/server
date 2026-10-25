/**
 * ONE authority for "is this subject still" — per OCCASION.
 *
 * There were two, deriving the same physical fact by different means and at
 * different speeds:
 *
 *   - `StateAnalyzer` — per TRACK, kinematic: centroid velocity and net travel,
 *     answering after the per-device `stationaryThresholdSec`.
 *   - this ledger — per ANCHOR, statistical: an observation counted as evidence
 *     of stillness purely because its box overlapped the anchor
 *     (`agrees = overlap >= agreeIou`), so stillness was INFERRED from a long
 *     run of overlaps.
 *
 * Nothing made them agree, and they could not: one is about a track that dies,
 * the other about an object that outlives every track that ever saw it.
 *
 * The split is on the right seam. The IoU keeps the job its own docblock gives
 * it — IDENTITY, "the same object in the same place" — and STILLNESS has one
 * authority per occasion (D508):
 *
 *   - on a `'session'` frame the tracker's verdict, and only `idle`;
 *   - on a `'burst'` frame the occasion itself — the runner admits a recheck
 *     only while its motion gate says the scene is still, and a four-frame
 *     burst cannot carry a tracker verdict (every track in it is `entered`).
 *
 * There is no third path. A session observation with no verdict at all is a
 * producer that forgot the field, and it does not agree.
 */
import { describe, expect, it } from 'vitest'
import {
  observationAgrees,
  stillnessVerdictFor,
  trackOffersEvidence,
} from '../stationary-evidence.js'

const AGREE_IOU = 0.5

describe('observationAgrees — a session frame is vouched for by the tracker', () => {
  it('agrees when the box matches AND the tracker says stationary', () => {
    expect(observationAgrees(0.9, AGREE_IOU, 'session', 'idle')).toBe(true)
  })

  it('refuses a subject the tracker says has left', () => {
    expect(observationAgrees(0.9, AGREE_IOU, 'session', 'left')).toBe(false)
  })

  it('REFUSES a perfectly overlapping box the tracker calls moving', () => {
    expect(observationAgrees(1, AGREE_IOU, 'session', 'moving')).toBe(false)
  })

  it('refuses a still subject that is not the same object', () => {
    expect(observationAgrees(0.2, AGREE_IOU, 'session', 'idle')).toBe(false)
  })

  // `entered` is the five-frame warm-up every track begins with. Measured on
  // 102 (12 h, 2026-09-15): a passer-by is gone in eight frames and five of
  // them are `entered`, which cleared the 0.6 ratio on its own and minted a
  // parked object out of a passage.
  it('refuses the undecided window — a warm-up is not a verdict', () => {
    expect(observationAgrees(0.9, AGREE_IOU, 'session', 'entered')).toBe(false)
    expect(observationAgrees(0.9, AGREE_IOU, 'session', 'new')).toBe(false)
  })

  // The way D494 said this could rot: a producer that omits the verdict used
  // to fall back to overlap alone, silently. It now reads as a miss.
  it('refuses a session observation that carries no verdict at all', () => {
    expect(observationAgrees(0.9, AGREE_IOU, 'session', undefined)).toBe(false)
  })
})

describe('observationAgrees — a burst frame is vouched for by its occasion', () => {
  it('agrees on overlap alone — the recheck only ever looks at a still scene', () => {
    expect(observationAgrees(0.9, AGREE_IOU, 'burst', undefined)).toBe(true)
  })

  // A four-frame burst's tracks never leave `entered`; if that verdict were
  // consulted, no burst could ever vote — which is exactly what happened,
  // invisibly, while the runner filed live frames as bursts.
  it('is not refused by the tracker verdict a burst track cannot help carrying', () => {
    expect(observationAgrees(0.9, AGREE_IOU, 'burst', 'entered')).toBe(true)
    expect(observationAgrees(0.9, AGREE_IOU, 'burst', 'new')).toBe(true)
  })

  it('identity still comes first — a burst box somewhere else is not the object', () => {
    expect(observationAgrees(0.2, AGREE_IOU, 'burst', undefined)).toBe(false)
  })
})

/**
 * The two helpers the producer (`pipeline-analytics/index.ts`) builds every
 * observation with. Pinned here because the ledger specs build observations
 * by hand and would stay green if either helper silently changed.
 */
describe('stillnessVerdictFor — the verdict an observation carries, by occasion', () => {
  it("a session observation carries the tracker's state, whatever it is", () => {
    expect(stillnessVerdictFor('session', 'idle')).toBe('idle')
    expect(stillnessVerdictFor('session', 'moving')).toBe('moving')
    expect(stillnessVerdictFor('session', 'entered')).toBe('entered')
  })

  it('a burst observation carries NONE — the occasion is the authority', () => {
    expect(stillnessVerdictFor('burst', 'entered')).toBeUndefined()
    expect(stillnessVerdictFor('burst', 'idle')).toBeUndefined()
    expect(stillnessVerdictFor('burst', 'moving')).toBeUndefined()
  })
})

describe('trackOffersEvidence — a coasted frame is not a sighting', () => {
  it('refuses a track the detector did not see this frame', () => {
    expect(trackOffersEvidence({ matchedThisFrame: false })).toBe(false)
  })

  it('accepts a matched track, and an older producer that never says', () => {
    expect(trackOffersEvidence({ matchedThisFrame: true })).toBe(true)
    expect(trackOffersEvidence({})).toBe(true)
  })
})
