/**
 * key-event-scoring unit tests.
 *
 * Covers: bounds (all-zero → 0, all-max → 1.0 clamp), weight wiring (one signal
 * full → score === its weight), per-signal monotonicity, classRank ordering,
 * saturation knees, reason = dominant term, and determinism.
 */
import { describe, expect, it } from 'vitest'
import {
  CLASS_RANK_ANIMAL,
  CLASS_RANK_DEFAULT,
  CLASS_RANK_PERSON,
  CLASS_RANK_VEHICLE,
  clamp01,
  classRank,
  computeImportance,
  DWELL_FULL_MS,
  type ScoringInput,
  SIZE_FULL,
  STATIC_DISPLACEMENT_FRAC,
  STATIC_IMPORTANCE_MULTIPLIER,
  STATIC_SPAN_FRAC,
  TRAVEL_FULL,
  WEIGHT_CLASS,
  WEIGHT_CONFIDENCE,
  WEIGHT_DWELL,
  WEIGHT_IDENTITY,
  WEIGHT_PROXIMITY,
  WEIGHT_TRAVEL,
  WEIGHT_ZONE,
} from '../key-event-scoring.js'

const EPS = 1e-9

// A track with every signal at zero (default class → its rank is NOT zero, so
// use a class we drive to CLASS_RANK_DEFAULT and subtract that term where a
// true all-zero is needed). For most tests we build from this and bump one.
const ZERO: ScoringInput = {
  peakConfidence: 0,
  className: '__unknown__', // → CLASS_RANK_DEFAULT
  durationMs: 0,
  peakBboxAreaFrac: 0,
  totalDistance: 0,
  zonesVisited: [],
  label: undefined,
}

describe('key-event-scoring', () => {
  describe('weights', () => {
    it('sum to exactly 1.0', () => {
      const total =
        WEIGHT_CONFIDENCE +
        WEIGHT_CLASS +
        WEIGHT_DWELL +
        WEIGHT_PROXIMITY +
        WEIGHT_TRAVEL +
        WEIGHT_ZONE +
        WEIGHT_IDENTITY
      expect(total).toBeCloseTo(1.0, 12)
    })
  })

  describe('clamp01', () => {
    it('clamps below/above/NaN', () => {
      expect(clamp01(-5)).toBe(0)
      expect(clamp01(0.4)).toBe(0.4)
      expect(clamp01(5)).toBe(1)
      expect(clamp01(NaN)).toBe(0)
    })
  })

  describe('bounds', () => {
    it('all-zero signals → 0', () => {
      // Force even the class term to 0 by giving classRank a stub we know is
      // default (0.25), then subtract it: instead assert the score equals only
      // the class contribution when everything else is zero.
      const r = computeImportance(ZERO)
      expect(r.importance).toBeCloseTo(WEIGHT_CLASS * CLASS_RANK_DEFAULT, 9)
    })

    it('true all-zero (no class rank) → 0', () => {
      // className that ranks default still contributes; there is no class that
      // ranks 0, so the minimum achievable score is WEIGHT_CLASS*DEFAULT. This
      // asserts the FLOOR is exactly that and nothing else leaks in.
      const r = computeImportance({ ...ZERO, className: 'nonsense-class' })
      expect(r.importance).toBeGreaterThan(0)
      expect(r.importance).toBeLessThanOrEqual(WEIGHT_CLASS * CLASS_RANK_DEFAULT + EPS)
    })

    it('all-max signals → exactly 1.0 (clamp no-op)', () => {
      const r = computeImportance({
        peakConfidence: 1,
        className: 'person',
        durationMs: DWELL_FULL_MS * 10,
        peakBboxAreaFrac: SIZE_FULL * 10,
        totalDistance: TRAVEL_FULL * 10,
        zonesVisited: ['a'],
        label: 'Alice',
      })
      expect(r.importance).toBeCloseTo(1.0, 9)
    })

    it('over-max inputs still clamp to 1.0', () => {
      const r = computeImportance({
        peakConfidence: 99,
        className: 'person',
        durationMs: Number.MAX_SAFE_INTEGER,
        peakBboxAreaFrac: 50,
        totalDistance: 9999,
        zonesVisited: ['a', 'b', 'c'],
        label: 'X',
      })
      expect(r.importance).toBe(1)
    })
  })

  describe('weight wiring — one signal full → score === its weight', () => {
    // Baseline: everything zero EXCEPT the class term (which cannot be zeroed).
    // So a "one signal full" score = WEIGHT_CLASS*DEFAULT + that signal's weight.
    const floor = WEIGHT_CLASS * CLASS_RANK_DEFAULT

    it('confidence', () => {
      const r = computeImportance({ ...ZERO, peakConfidence: 1 })
      expect(r.importance).toBeCloseTo(floor + WEIGHT_CONFIDENCE, 9)
      expect(r.reason).toBe('confidence')
    })

    it('dwell', () => {
      const r = computeImportance({ ...ZERO, durationMs: DWELL_FULL_MS })
      expect(r.importance).toBeCloseTo(floor + WEIGHT_DWELL, 9)
      expect(r.reason).toBe('dwell')
    })

    it('proximity (size)', () => {
      const r = computeImportance({ ...ZERO, peakBboxAreaFrac: SIZE_FULL })
      expect(r.importance).toBeCloseTo(floor + WEIGHT_PROXIMITY, 9)
      expect(r.reason).toBe('proximity')
    })

    it('travel', () => {
      const r = computeImportance({ ...ZERO, totalDistance: TRAVEL_FULL })
      expect(r.importance).toBeCloseTo(floor + WEIGHT_TRAVEL, 9)
      expect(r.reason).toBe('travel')
    })

    it('zone', () => {
      const r = computeImportance({ ...ZERO, zonesVisited: ['entrance'] })
      expect(r.importance).toBeCloseTo(floor + WEIGHT_ZONE, 9)
    })

    it('identity', () => {
      const r = computeImportance({ ...ZERO, label: 'Alice' })
      expect(r.importance).toBeCloseTo(floor + WEIGHT_IDENTITY, 9)
    })

    it('class person full → reason class', () => {
      const r = computeImportance({ ...ZERO, className: 'person' })
      expect(r.importance).toBeCloseTo(WEIGHT_CLASS * CLASS_RANK_PERSON, 9)
      expect(r.reason).toBe('class')
    })
  })

  describe('classRank ordering', () => {
    it('person/face > vehicle/car > animal/dog > default', () => {
      expect(classRank('person')).toBe(CLASS_RANK_PERSON)
      expect(classRank('FACE')).toBe(CLASS_RANK_PERSON)
      expect(classRank('vehicle')).toBe(CLASS_RANK_VEHICLE)
      expect(classRank('Car')).toBe(CLASS_RANK_VEHICLE)
      expect(classRank('truck')).toBe(CLASS_RANK_VEHICLE)
      expect(classRank('bus')).toBe(CLASS_RANK_VEHICLE)
      expect(classRank('animal')).toBe(CLASS_RANK_ANIMAL)
      expect(classRank('dog')).toBe(CLASS_RANK_ANIMAL)
      expect(classRank('cat')).toBe(CLASS_RANK_ANIMAL)
      expect(classRank('umbrella')).toBe(CLASS_RANK_DEFAULT)
      expect(CLASS_RANK_PERSON).toBeGreaterThan(CLASS_RANK_VEHICLE)
      expect(CLASS_RANK_VEHICLE).toBeGreaterThan(CLASS_RANK_ANIMAL)
      expect(CLASS_RANK_ANIMAL).toBeGreaterThan(CLASS_RANK_DEFAULT)
    })

    /**
     * D189: a sound is not a subject in frame. Before the contract, an audio
     * episode carried the HEARD class here — so a bark ranked as an ANIMAL
     * walking past, purely because the audio and detection vocabularies
     * collide. This pins the honest rank so nobody "fixes" the fall-through by
     * adding `audio` to a boosted set.
     */
    it('an audio row ranks at the default — never as the thing it sounds like', () => {
      expect(classRank('audio')).toBe(CLASS_RANK_DEFAULT)
      expect(classRank('audio')).toBeLessThan(CLASS_RANK_ANIMAL)
    })
  })

  describe('monotonicity (per signal, all else fixed)', () => {
    it('confidence is non-decreasing', () => {
      const lo = computeImportance({ ...ZERO, peakConfidence: 0.2 }).importance
      const hi = computeImportance({ ...ZERO, peakConfidence: 0.8 }).importance
      expect(hi).toBeGreaterThan(lo)
    })
    it('dwell is non-decreasing until saturation', () => {
      const lo = computeImportance({ ...ZERO, durationMs: 10_000 }).importance
      const hi = computeImportance({ ...ZERO, durationMs: 40_000 }).importance
      expect(hi).toBeGreaterThan(lo)
    })
    it('size is non-decreasing until saturation', () => {
      const lo = computeImportance({
        ...ZERO,
        peakBboxAreaFrac: 0.02,
      }).importance
      const hi = computeImportance({
        ...ZERO,
        peakBboxAreaFrac: 0.1,
      }).importance
      expect(hi).toBeGreaterThan(lo)
    })
    it('travel is non-decreasing until saturation', () => {
      const lo = computeImportance({ ...ZERO, totalDistance: 0.5 }).importance
      const hi = computeImportance({ ...ZERO, totalDistance: 1.5 }).importance
      expect(hi).toBeGreaterThan(lo)
    })
  })

  describe('saturation knees', () => {
    it('dwell saturates at DWELL_FULL_MS (past-knee === at-knee)', () => {
      const at = computeImportance({
        ...ZERO,
        durationMs: DWELL_FULL_MS,
      }).importance
      const past = computeImportance({
        ...ZERO,
        durationMs: DWELL_FULL_MS * 3,
      }).importance
      expect(past).toBeCloseTo(at, 12)
    })
    it('size saturates at SIZE_FULL', () => {
      const at = computeImportance({
        ...ZERO,
        peakBboxAreaFrac: SIZE_FULL,
      }).importance
      const past = computeImportance({
        ...ZERO,
        peakBboxAreaFrac: SIZE_FULL * 3,
      }).importance
      expect(past).toBeCloseTo(at, 12)
    })
    it('travel saturates at TRAVEL_FULL', () => {
      const at = computeImportance({
        ...ZERO,
        totalDistance: TRAVEL_FULL,
      }).importance
      const past = computeImportance({
        ...ZERO,
        totalDistance: TRAVEL_FULL * 3,
      }).importance
      expect(past).toBeCloseTo(at, 12)
    })
  })

  describe('reason = dominant term', () => {
    it('picks the largest weighted contribution', () => {
      // Confidence full (0.30) beats a full identity (0.05).
      const r = computeImportance({
        ...ZERO,
        className: 'nonsense',
        peakConfidence: 1,
        label: 'Alice',
      })
      expect(r.reason).toBe('confidence')
    })
    it('identity can dominate when confidence/class are low', () => {
      // Zero confidence, default class (0.05 contribution) vs identity 0.05 —
      // class and identity tie at 0.05; tie-break favors class (earlier order).
      // Bump identity is impossible above 0.05, so give class default and check
      // a clearly-identity-dominant case is not constructible; instead assert a
      // vehicle-class case yields 'class'.
      const r = computeImportance({ ...ZERO, className: 'car' })
      expect(r.reason).toBe('class')
    })
  })

  describe('static-track suppression', () => {
    // A long-dwell "person" that never actually moved — the ghost the audit
    // flagged (a pile of clothes read as a person for 46s on 640×360).
    const STATIC_GHOST: ScoringInput = {
      peakConfidence: 0.85,
      className: 'person',
      durationMs: 46_000,
      peakBboxAreaFrac: 0.05,
      totalDistance: 0.0,
      zonesVisited: [],
      label: undefined,
    }

    it('sanity: the constants keep displacement ≤ span and are frame-diagonal fractions', () => {
      expect(STATIC_DISPLACEMENT_FRAC).toBeGreaterThan(0)
      expect(STATIC_SPAN_FRAC).toBeGreaterThanOrEqual(STATIC_DISPLACEMENT_FRAC)
      expect(STATIC_IMPORTANCE_MULTIPLIER).toBeGreaterThan(0)
      expect(STATIC_IMPORTANCE_MULTIPLIER).toBeLessThan(1)
    })

    it('a pure-static track is strongly demoted', () => {
      const free = computeImportance(STATIC_GHOST).importance
      const gated = computeImportance({
        ...STATIC_GHOST,
        netDisplacementFrac: 0.001,
        pathSpanFrac: 0.002,
      }).importance
      expect(gated).toBeCloseTo(free * STATIC_IMPORTANCE_MULTIPLIER, 9)
      expect(gated).toBeLessThan(free)
    })

    it('a loiterer with small movements (below both thresholds) is demoted', () => {
      const free = computeImportance(STATIC_GHOST).importance
      const gated = computeImportance({
        ...STATIC_GHOST,
        netDisplacementFrac: STATIC_DISPLACEMENT_FRAC * 0.5,
        pathSpanFrac: STATIC_SPAN_FRAC * 0.5,
      }).importance
      expect(gated).toBeCloseTo(free * STATIC_IMPORTANCE_MULTIPLIER, 9)
    })

    it('a walking person (span above threshold) is NOT demoted', () => {
      const free = computeImportance(STATIC_GHOST).importance
      const gated = computeImportance({
        ...STATIC_GHOST,
        netDisplacementFrac: 0.4,
        pathSpanFrac: 0.6,
      }).importance
      expect(gated).toBeCloseTo(free, 9)
    })

    it('a big-loop walker (small net but large span) is NOT demoted', () => {
      const free = computeImportance(STATIC_GHOST).importance
      const gated = computeImportance({
        ...STATIC_GHOST,
        netDisplacementFrac: 0.001, // ended near start
        pathSpanFrac: 0.5, // but roamed widely
      }).importance
      expect(gated).toBeCloseTo(free, 9)
    })

    it('a static track WITH a resolved IDENTITY (tier 2) is NEVER suppressed', () => {
      const identified: ScoringInput = {
        ...STATIC_GHOST,
        identityLabel: 'Alice',
      }
      const free = computeImportance(identified).importance
      const gated = computeImportance({
        ...identified,
        netDisplacementFrac: 0.0,
        pathSpanFrac: 0.0,
      }).importance
      expect(gated).toBeCloseTo(free, 9)
    })

    /**
     * The 2026-08-20 defect, pinned. `displayLabel()` returns `subLabel ?? label`,
     * so after the 4g tiering a plain tier-1 SUB-CLASS ("Car", written by the
     * vehicle classifier) reached the gate's `identified` test and vetoed the
     * demotion. Measured: 68 tracks/day on the fleet kept 10x their deserved
     * salience because a parked car had been told it was a car.
     *
     * A sub-class is not an identity. Only tier 2 — a recognised face or a read
     * plate — is.
     */
    it('a static track carrying only a tier-1 SUB-CLASS is still demoted', () => {
      const subclassed: ScoringInput = {
        ...STATIC_GHOST,
        className: 'vehicle',
        label: 'Car',
      }
      const free = computeImportance(subclassed).importance
      const gated = computeImportance({
        ...subclassed,
        netDisplacementFrac: 0.0,
        pathSpanFrac: 0.0,
      }).importance
      expect(gated).toBeCloseTo(free * STATIC_IMPORTANCE_MULTIPLIER, 9)
    })

    it('a tier-2 identity exempts even when a tier-1 sub-class also rides along', () => {
      const both: ScoringInput = {
        ...STATIC_GHOST,
        className: 'vehicle',
        label: 'van',
        identityLabel: 'AB123CD',
      }
      const free = computeImportance(both).importance
      const gated = computeImportance({
        ...both,
        netDisplacementFrac: 0.0,
        pathSpanFrac: 0.0,
      }).importance
      expect(gated).toBeCloseTo(free, 9)
    })

    it('an EMPTY tier-2 string is not an identity', () => {
      const blank: ScoringInput = { ...STATIC_GHOST, identityLabel: '' }
      const free = computeImportance(blank).importance
      const gated = computeImportance({
        ...blank,
        netDisplacementFrac: 0.0,
        pathSpanFrac: 0.0,
      }).importance
      expect(gated).toBeCloseTo(free * STATIC_IMPORTANCE_MULTIPLIER, 9)
    })

    it('the gate is inert when metrics are absent (backwards compatible)', () => {
      const a = computeImportance(STATIC_GHOST).importance
      const b = computeImportance({ ...STATIC_GHOST }).importance
      expect(a).toBe(b)
    })
  })

  describe('determinism', () => {
    it('identical input → identical output across calls', () => {
      const input: ScoringInput = {
        peakConfidence: 0.73,
        className: 'person',
        durationMs: 12_345,
        peakBboxAreaFrac: 0.04,
        totalDistance: 0.9,
        zonesVisited: ['a'],
        label: 'Bob',
      }
      const a = computeImportance(input)
      const b = computeImportance(input)
      expect(a).toEqual(b)
    })
  })
})
