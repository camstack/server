import { describe, expect, it } from 'vitest'
import {
  deriveSuggestedBufferCap,
  deriveSuggestionMinCosine,
  FACE_DEFAULTS,
  planStoredSuggestionPurge,
  planStoredMinFaceConfidencePurge,
  STORED_MIN_FACE_CONFIDENCE_KEY,
  resolveFaceSettings,
  STORED_SUGGESTION_MIN_COSINE_KEY,
  SUGGESTED_BUFFER_CAP_FACTOR,
  SUGGESTION_BAND_FACTOR,
} from '../face-settings.js'
import PipelineAnalyticsAddon, { stripGlobalOnlyFields } from '../index.js'

// Subclass to expose the protected globalSettingsSchema for schema-section tests.
class TestableAddon extends PipelineAnalyticsAddon {
  getSchema(cap?: string) {
    return this.globalSettingsSchema(cap)
  }
}

/**
 * Subclass that answers the settings read with a chosen blob, so the buffer
 * cap's SOURCE can be asserted. The seam stubbed is `resolveGlobalStore` — the
 * exact thing the sweep used to not call at all.
 */
class StoreBackedAddon extends PipelineAnalyticsAddon {
  constructor(private readonly blob: Record<string, unknown>) {
    super()
  }

  protected override async resolveGlobalStore(): Promise<Record<string, unknown>> {
    return this.blob
  }

  readBufferCap(): Promise<number> {
    return this.resolveBufferCap()
  }
}

describe('resolveFaceSettings', () => {
  it('returns all defaults for an empty blob', () => {
    expect(resolveFaceSettings({})).toEqual(FACE_DEFAULTS)
  })

  it('defaults are the spec values', () => {
    expect(FACE_DEFAULTS).toEqual({
      enabled: true,
      // D651: follows the default model. AuraFace's measured operating point
      // (2026-08-21, inter-identity max 0.361), not ArcFace's 0.55.
      similarityThreshold: 0.45,
      margin: 0.12,
      // `minFaceConfidence` is gone (D662): the detector's own model floor, on
      // the runner, is the one face-confidence bar.
      minFacePx: 30,
      // 2026-07-23: recognition (auto-assignment) floor, separate from minFacePx.
      recognitionMinFacePx: 48,
      minIdentitySamples: 2,
      // 2026-08-19: ships DISABLED — the bound must come from live data.
      maxEmbeddingMagnitude: 0,
      confirmFrames: 3,
      bufferMaxPerDevice: 50,
      // 2026-09-26 (D644): source frames ship OFF until measured live.
      keepSourceFrames: false,
    })
  })

  it('recognitionMinFacePx defaults to 48 and honours/validates overrides', () => {
    expect(FACE_DEFAULTS.recognitionMinFacePx).toBe(48)
    // Valid override honoured.
    expect(resolveFaceSettings({ recognitionMinFacePx: 64 }).recognitionMinFacePx).toBe(64)
    // Invalid (negative) falls back to the default.
    expect(resolveFaceSettings({ recognitionMinFacePx: -5 }).recognitionMinFacePx).toBe(48)
    // Absent → default (legacy blobs written before the field existed).
    expect(resolveFaceSettings({}).recognitionMinFacePx).toBe(48)
  })

  it('suggestionMinCosine is NOT a stored field — a persisted value is inert', () => {
    expect(Object.keys(FACE_DEFAULTS)).not.toContain('suggestionMinCosine')
    // The exact residue the live hub carried on 2026-08-21.
    const resolved = resolveFaceSettings({ similarityThreshold: 0.45, suggestionMinCosine: 0.33 })
    expect(Object.keys(resolved)).not.toContain('suggestionMinCosine')
    // ...and the band it governs is decided by the threshold alone.
    expect(deriveSuggestionMinCosine(resolved.similarityThreshold)).toBe(0.36)
  })

  it('validates and defaults the new auto-match tuning fields (#26)', () => {
    // Valid overrides are honoured.
    const ok = resolveFaceSettings({ minFacePx: 48, minIdentitySamples: 5 })
    expect(ok.minFacePx).toBe(48)
    expect(ok.minIdentitySamples).toBe(5)
    // Invalid values fall back per field.
    const bad = resolveFaceSettings({
      minFacePx: -10, // must be >= 0
      minIdentitySamples: 0, // must be >= 1 int
    })
    expect(bad.minFacePx).toBe(FACE_DEFAULTS.minFacePx)
    expect(bad.minIdentitySamples).toBe(FACE_DEFAULTS.minIdentitySamples)
  })

  it('honours valid overrides and keeps defaults for the rest', () => {
    const r = resolveFaceSettings({ enabled: true, similarityThreshold: 0.6 })
    expect(r.enabled).toBe(true)
    expect(r.similarityThreshold).toBe(0.6)
    expect(r.margin).toBe(FACE_DEFAULTS.margin)
    expect(r.confirmFrames).toBe(FACE_DEFAULTS.confirmFrames)
  })

  it('falls back per-field on invalid values', () => {
    const r = resolveFaceSettings({
      enabled: 'yes', // wrong type
      similarityThreshold: 5, // out of [0,1]
      margin: -1, // must be >= 0
      confirmFrames: 1.5, // must be int
      bufferMaxPerDevice: -3, // must be >= 0 int
    })
    expect(r.enabled).toBe(FACE_DEFAULTS.enabled)
    expect(r.similarityThreshold).toBe(FACE_DEFAULTS.similarityThreshold)
    expect(r.margin).toBe(FACE_DEFAULTS.margin)
    expect(r.confirmFrames).toBe(FACE_DEFAULTS.confirmFrames)
    expect(r.bufferMaxPerDevice).toBe(FACE_DEFAULTS.bufferMaxPerDevice)
  })
})

describe('globalSettingsSchema — face-recognition section', () => {
  it('includes a face-recognition section with an enabled field', () => {
    const addon = new TestableAddon()
    const schema = addon.getSchema()
    const section = schema?.sections.find((s) => s.id === 'face-recognition')
    expect(section).toBeDefined()
    const enabledField = section?.fields?.find((f: { key: string }) => f.key === 'enabled')
    expect(enabledField).toBeDefined()
    expect(enabledField).toMatchObject({ type: 'boolean', key: 'enabled', default: true })
  })

  it('face-recognition section fields cover all FACE_DEFAULTS keys', () => {
    const addon = new TestableAddon()
    const schema = addon.getSchema()
    const section = schema?.sections.find((s) => s.id === 'face-recognition')
    const keys = section?.fields?.map((f: { key: string }) => f.key) ?? []
    for (const k of Object.keys(FACE_DEFAULTS) as (keyof typeof FACE_DEFAULTS)[]) {
      expect(keys).toContain(k)
    }
  })

  it('cap face-gallery returns ONLY the face-recognition section — Pipeline Cluster Settings asks by cap', () => {
    const addon = new TestableAddon()
    const scoped = addon.getSchema('face-gallery')
    expect(scoped?.sections.map((s) => s.id)).toEqual(['face-recognition'])
    const unscoped = addon.getSchema()
    expect(unscoped?.sections.map((s) => s.id)).toContain('retention')
    expect(unscoped?.sections.map((s) => s.id)).toContain('face-recognition')
  })

  it('an unrelated cap returns no sections so this addon does not appear on the wrong page', () => {
    const addon = new TestableAddon()
    expect(addon.getSchema('network-access')?.sections).toEqual([])
  })
})

describe('stripGlobalOnlyFields — global-only `enabled` is removed from per-device sections', () => {
  it('drops the face-recognition `enabled` field but keeps the tuning knobs', () => {
    const addon = new TestableAddon()
    const sections = addon.getSchema()?.sections ?? []
    const stripped = stripGlobalOnlyFields(sections)
    const face = stripped.find((s) => s.id === 'face-recognition')
    const keys = face?.fields?.map((f: { key?: string }) => f.key) ?? []
    expect(keys).not.toContain('enabled')
    // Per-device tuning survives (hardware affects face capture).
    expect(keys).toContain('similarityThreshold')
    // D662: a face-confidence bar here re-applied SCRFD's 0.5 to YuNet scores.
    expect(keys).not.toContain('minFaceConfidence')
    expect(keys).toContain('bufferMaxPerDevice')
    // `bufferRetentionDays` is NOT here: D62 removed it, because D61 had already
    // removed the age half of the buffer prune that read it.
    expect(keys).not.toContain('bufferRetentionDays')
  })

  it('leaves sections without global-only fields untouched', () => {
    const addon = new TestableAddon()
    const sections = addon.getSchema()?.sections ?? []
    const stripped = stripGlobalOnlyFields(sections)
    const tracking = stripped.find((s) => s.id === 'tracking')
    const original = sections.find((s) => s.id === 'tracking')
    expect(tracking?.fields?.length).toBe(original?.fields?.length)
  })

  it('the cluster-post-processing section is global-only (present globally, dropped per-device)', () => {
    const addon = new TestableAddon()
    const sections = addon.getSchema()?.sections ?? []
    // Present on the global settings page, with the node field.
    const global = sections.find((s) => s.id === 'cluster-post-processing')
    expect(global).toBeDefined()
    expect(global?.fields?.some((f: { key?: string }) => f.key === 'postProcessingNodeId')).toBe(
      true,
    )
    // Dropped entirely from the per-device contribution (cluster-wide setting).
    const stripped = stripGlobalOnlyFields(sections)
    expect(stripped.find((s) => s.id === 'cluster-post-processing')).toBeUndefined()
  })
})

/**
 * The 2026-08-18 retune (0.62→0.55 / 0.15→0.12) was applied as a RUNTIME
 * override on the live hub and never reached the schema, so a fresh hub — or
 * anything that resets settings — booted on the values that same session had
 * measured as leaving almost nothing recognisable. A default nobody runs is a
 * decision nobody made.
 */
describe('defaults match the values actually running', () => {
  /**
   * D651: the threshold is a property of the MODEL's cosine space. AuraFace
   * became the default model, and at ArcFace's 0.55 it auto-matched 1 probe in
   * 496 (2026-08-21). 0.45 is the operating point measured on AuraFace's own
   * gallery (inter-identity max 0.361), above the impostor p99 0.33 the
   * 2026-09-26 gallery-shift measurement found in both alignments. It holds
   * until `scripts/face-threshold-calibration.ts` measures the live gallery.
   */
  it("similarityThreshold defaults to AuraFace's measured 0.45, not ArcFace's 0.55", () => {
    expect(FACE_DEFAULTS.similarityThreshold).toBe(0.45)
  })

  it('margin defaults to the retuned 0.12, not the dead 0.15', () => {
    expect(FACE_DEFAULTS.margin).toBe(0.12)
  })
})

/**
 * The suggestion floor is DERIVED from the assignment threshold, not stored
 * beside it (D222). Two independent knobs contradicted each other on the live
 * hub: the 2026-08-19 retune dropped `similarityThreshold` to 0.45 and left
 * `suggestionMinCosine` at 0.50, which INVERTED the band — the half-open
 * interval [0.50, 0.45) is empty, so no suggestion could be produced at all,
 * silently, for anybody.
 */
describe('deriveSuggestionMinCosine — the band cannot invert', () => {
  it('is 80% of the assignment threshold', () => {
    expect(SUGGESTION_BAND_FACTOR).toBe(0.8)
    // The live hub, 2026-09-26: threshold 0.40 ⇒ suggestions from 0.32.
    expect(deriveSuggestionMinCosine(0.4)).toBe(0.32)
    // ArcFace's former default.
    expect(deriveSuggestionMinCosine(0.55)).toBe(0.44)
    // The schema default (D651).
    expect(deriveSuggestionMinCosine(FACE_DEFAULTS.similarityThreshold)).toBe(0.36)
  })

  it('never returns float noise (0.8 × 0.45 is 0.36000000000000004 in IEEE754)', () => {
    expect(deriveSuggestionMinCosine(0.45)).not.toBe(0.45 * 0.8)
    expect(deriveSuggestionMinCosine(0.625)).toBe(0.5)
  })

  /**
   * THE invariant. This is the failure that shipped: a suggestion floor at or
   * above the assignment threshold makes the band empty and kills the feature
   * without an error anywhere. Derivation makes it unreachable BY CONSTRUCTION
   * — so it is pinned over the whole domain, not at a few sample points.
   */
  it('the suggestion floor is BELOW the assignment threshold for every threshold', () => {
    const thresholds: number[] = []
    for (let i = 0; i <= 1000; i++) thresholds.push(i / 1000)
    // Thresholds small enough that rounding to 4 decimals would REACH them
    // (0.8 × 0.0001 rounds back to 0.0001). Nobody will run a face matcher
    // here, but "for every threshold" has to mean every threshold, or the
    // invariant is a sample and the guard that keeps it total is untested.
    thresholds.push(1e-4, 5e-5, 1e-5, Number.MIN_VALUE)
    for (const threshold of thresholds) {
      const floor = deriveSuggestionMinCosine(threshold)
      expect(floor).toBeLessThanOrEqual(threshold)
      if (threshold > 0) expect(floor).toBeLessThan(threshold)
      expect(floor).toBeGreaterThanOrEqual(0)
    }
  })
})

/**
 * The value the operator had persisted (0.33, set by hand on 2026-08-21 to
 * re-open the band) must stop being an authority — and must not survive in the
 * store as one either, where a future reader could resurrect it.
 */
describe('planStoredSuggestionPurge — the stale value leaves the store', () => {
  it('plans an UNSET for a blob that carries the retired key', () => {
    const plan = planStoredSuggestionPurge({ similarityThreshold: 0.45, suggestionMinCosine: 0.33 })
    expect(plan).not.toBeNull()
    expect(plan?.was).toBe(0.33)
    // `undefined`, never `null`: the settings merge preserves an explicit null
    // as a stored value, which is exactly the residue this removes.
    expect(plan?.patch).toEqual({ [STORED_SUGGESTION_MIN_COSINE_KEY]: undefined })
    expect(Object.keys(plan?.patch ?? {})).toEqual(['suggestionMinCosine'])
  })

  it('is a no-op once the key is gone (absence IS the migration marker)', () => {
    expect(planStoredSuggestionPurge({})).toBeNull()
    expect(planStoredSuggestionPurge({ similarityThreshold: 0.45 })).toBeNull()
  })
})

/**
 * The suggested tier's capacity is DERIVED from `bufferMaxPerDevice`, never a
 * second knob — two independent numbers over one buffer is how the suggestion
 * BAND broke (D222).
 */
describe('deriveSuggestedBufferCap — the suggested tier is bounded and derived', () => {
  it('is larger than the ordinary cap at the shipped default', () => {
    const cap = deriveSuggestedBufferCap(FACE_DEFAULTS.bufferMaxPerDevice)
    expect(cap).toBe(FACE_DEFAULTS.bufferMaxPerDevice * SUGGESTED_BUFFER_CAP_FACTOR)
    expect(cap).toBeGreaterThan(FACE_DEFAULTS.bufferMaxPerDevice)
  })

  it('TRACKS the operator knob rather than fighting it', () => {
    expect(deriveSuggestedBufferCap(10)).toBeGreaterThan(deriveSuggestedBufferCap(5))
    expect(deriveSuggestedBufferCap(200)).toBe(800)
  })

  it('BOUNDS: total over the domain, never Infinity and never below the ordinary cap', () => {
    const caps = [0, 1, 7, 50, 137, 1_000, 10_000]
    for (const max of caps) {
      const derived = deriveSuggestedBufferCap(max)
      expect(Number.isFinite(derived)).toBe(true)
      expect(Number.isInteger(derived)).toBe(true)
      expect(derived).toBeGreaterThanOrEqual(max)
    }
  })

  it('0 turns the buffer off entirely — one switch, not two', () => {
    expect(deriveSuggestedBufferCap(0)).toBe(0)
  })

  it('a non-finite or negative cap can never become an unbounded tier', () => {
    expect(deriveSuggestedBufferCap(Number.POSITIVE_INFINITY)).toBe(0)
    expect(deriveSuggestedBufferCap(Number.NaN)).toBe(0)
    expect(deriveSuggestedBufferCap(-5)).toBe(0)
  })
})

/**
 * `bufferMaxPerDevice` is offered on the settings form, and the capacity sweep
 * read `FACE_DEFAULTS` instead — an override was a knob that wrote a store
 * nobody read (the D62 shape). This pins that the sweep reads the STORE.
 */
describe('the buffer cap in force comes from the operator, not the constant', () => {
  it('honours a stored override', async () => {
    const addon = new StoreBackedAddon({ bufferMaxPerDevice: 120 })
    expect(await addon.readBufferCap()).toBe(120)
    expect(await addon.readBufferCap()).not.toBe(FACE_DEFAULTS.bufferMaxPerDevice)
  })

  it('falls back to the default for an empty or invalid blob', async () => {
    expect(await new StoreBackedAddon({}).readBufferCap()).toBe(FACE_DEFAULTS.bufferMaxPerDevice)
    expect(await new StoreBackedAddon({ bufferMaxPerDevice: -3 }).readBufferCap()).toBe(
      FACE_DEFAULTS.bufferMaxPerDevice,
    )
  })
})

/**
 * D662 — `minFaceConfidence` retired. The recognizer re-applied a number on the
 * DETECTOR's score scale without knowing which detector ran; after YuNet became
 * the default its 0.5 was SCRFD's bar applied to YuNet. The runner's per-model
 * floor is the one bar now, and a stored value must leave the store — the hub
 * carried an interim `0.85` written by hand on 2026-09-27.
 */
describe('planStoredMinFaceConfidencePurge — the retired bar leaves the store', () => {
  it('plans an UNSET for a blob that carries it, reporting what it was', () => {
    const plan = planStoredMinFaceConfidencePurge({
      similarityThreshold: 0.45,
      minFaceConfidence: 0.85,
    })
    expect(plan?.was).toBe(0.85)
    expect(plan?.patch).toEqual({ [STORED_MIN_FACE_CONFIDENCE_KEY]: undefined })
    expect(Object.keys(plan?.patch ?? {})).toEqual(['minFaceConfidence'])
  })

  it('is a no-op once the key is gone', () => {
    expect(planStoredMinFaceConfidencePurge({})).toBeNull()
    expect(planStoredMinFaceConfidencePurge({ similarityThreshold: 0.45 })).toBeNull()
  })

  it('a stored value no longer reaches the resolved settings', () => {
    expect(Object.keys(resolveFaceSettings({ minFaceConfidence: 0.85 }))).not.toContain(
      'minFaceConfidence',
    )
  })
})
