/**
 * The AUDIO rule schema — the sampling-window condition that carries a rule on
 * SOUND.
 *
 * Three properties this file exists to hold still:
 *
 *  - the operator's vocabulary is `hitPercent` over `samplingSeconds`, with
 *    BOTH filters (`labels`, `dbThreshold`) optional and independent;
 *  - the trigger enum is UNCHANGED — an audio rule is an `immediate` rule
 *    carrying `conditions.audio`, because a new `NcDelivery` member is one the
 *    viewer cannot render (`scripts/check-viewer-condition-mirror.ts`);
 *  - `.partial()` does NOT strip a `.default()`. `NcRulePatchSchema` must
 *    materialise NOTHING it was not given, or a two-field patch silently
 *    rewrites the audio condition of a rule that had one (the 2026-08-12
 * incident).
 */
import { describe, expect, it } from 'vitest'
import {
  NC_AUDIO_DBFS_FLOOR,
  NcAudioConditionSchema,
  NcConditionsSchema,
  NcDeliverySchema,
  NcRuleInputSchema,
  NcRulePatchSchema,
} from '../notification-rules.cap.js'

function rule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'cane in garden',
    delivery: 'immediate',
    targets: [{ targetId: 't1' }],
    ...over,
  }
}

describe('NcDeliverySchema — unchanged by the audio rules', () => {
  it('carries exactly the five triggers it carried before', () => {
    expect(NcDeliverySchema.options).toEqual([
      'immediate',
      'track-end',
      'device-event',
      'package-event',
      'system-event',
    ])
  })
})

describe('NcAudioConditionSchema', () => {
  it('defaults to 60% of a 10 s window, with NEITHER filter materialised', () => {
    const parsed = NcAudioConditionSchema.parse({})
    expect(parsed.hitPercent).toBe(60)
    expect(parsed.samplingSeconds).toBe(10)
    expect(parsed.labels).toBeUndefined()
    expect(parsed.dbThreshold).toBeUndefined()
  })

  it('accepts a labels-only rule (no threshold — a bark needs no dB)', () => {
    const parsed = NcAudioConditionSchema.parse({ labels: ['dog'], samplingSeconds: 5 })
    expect(parsed.labels).toEqual(['dog'])
    expect(parsed.dbThreshold).toBeUndefined()
    expect(parsed.samplingSeconds).toBe(5)
  })

  it('accepts a loudness-only rule (no labels — no model has to be right)', () => {
    const parsed = NcAudioConditionSchema.parse({ dbThreshold: -30, hitPercent: 80 })
    expect(parsed.dbThreshold).toBe(-30)
    expect(parsed.labels).toBeUndefined()
    expect(parsed.hitPercent).toBe(80)
  })

  it('refuses a POSITIVE dB threshold — the scale is dBFS and negative-going', () => {
    expect(NcAudioConditionSchema.safeParse({ dbThreshold: 60 }).success).toBe(false)
    expect(NcAudioConditionSchema.safeParse({ dbThreshold: 0 }).success).toBe(true)
    expect(NcAudioConditionSchema.safeParse({ dbThreshold: NC_AUDIO_DBFS_FLOOR }).success).toBe(
      true,
    )
    expect(NcAudioConditionSchema.safeParse({ dbThreshold: NC_AUDIO_DBFS_FLOOR - 1 }).success).toBe(
      false,
    )
  })

  it('refuses a hit percentage outside 1–100 and a zero-length window', () => {
    expect(NcAudioConditionSchema.safeParse({ hitPercent: 0 }).success).toBe(false)
    expect(NcAudioConditionSchema.safeParse({ hitPercent: 101 }).success).toBe(false)
    expect(NcAudioConditionSchema.safeParse({ hitPercent: 100 }).success).toBe(true)
    expect(NcAudioConditionSchema.safeParse({ samplingSeconds: 0 }).success).toBe(false)
    expect(NcAudioConditionSchema.safeParse({ samplingSeconds: 301 }).success).toBe(false)
  })
})

describe('NcConditions.audio', () => {
  it('is absent unless authored — every rule written before today is untouched', () => {
    expect(NcConditionsSchema.parse({}).audio).toBeUndefined()
    expect(NcRuleInputSchema.parse(rule()).conditions.audio).toBeUndefined()
  })

  it('fills its inner defaults when the operator sends the key', () => {
    const parsed = NcRuleInputSchema.parse(rule({ conditions: { audio: { dbThreshold: -25 } } }))
    expect(parsed.conditions.audio).toEqual({
      dbThreshold: -25,
      hitPercent: 60,
      samplingSeconds: 10,
    })
  })
})

describe('NcRulePatchSchema — materialise nothing that was not given', () => {
  it('leaves `conditions` (and its audio block) absent on a patch that omits it', () => {
    const patch = NcRulePatchSchema.parse({ enabled: false })
    expect('conditions' in patch).toBe(false)
    expect(patch.conditions).toBeUndefined()
  })

  it('does not invent an audio condition on a patch that only edits the throttle', () => {
    const patch = NcRulePatchSchema.parse({ throttle: { cooldownSec: 30 } })
    expect(patch.conditions).toBeUndefined()
  })

  it('still fills the audio inner defaults when the patch DOES send conditions', () => {
    const patch = NcRulePatchSchema.parse({ conditions: { audio: { labels: ['scream'] } } })
    expect(patch.conditions?.audio).toEqual({
      labels: ['scream'],
      hitPercent: 60,
      samplingSeconds: 10,
    })
  })
})
