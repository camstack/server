/**
 * TimelapseRule schema tests (task A6) — defaults, bounds, ownership
 * boundary (`ownerUserId` is NOT a client input field) and patch shape.
 *
 * Spec: `docs/superpowers/specs/2026-07-24-nc-occupancy-timelapse-design.md`
 * §3.3. Timelapse is a STANDALONE subsystem: no delivery-enum member, no cap
 * method — this schema is a plain typed schema, never a `*.cap.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  assertTimelapseCadences,
  TIMELAPSE_DENSE_FLOOR_SEC,
  TimelapseRuleInputSchema,
  TimelapseRulePatchSchema,
  TimelapseRuleSchema,
} from '../timelapse-rule.js'

const SCHEDULE = { windows: [{ days: [1, 2, 3], startMinute: 480, endMinute: 1080 }] }

function minimalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'driveway daylight',
    deviceIds: [601],
    schedule: SCHEDULE,
    targets: [{ targetId: 'tgt-1' }],
    ...overrides,
  }
}

describe('TimelapseRuleInputSchema', () => {
  it('applies the parity defaults (cadenceSec 15, framerate 10, priority 3, enabled)', () => {
    const parsed = TimelapseRuleInputSchema.parse(minimalInput())
    expect(parsed.cadenceSec).toBe(15)
    expect(parsed.framerate).toBe(10)
    expect(parsed.priority).toBe(3)
    expect(parsed.enabled).toBe(true)
    expect(parsed.template).toBeUndefined()
  })

  it('requires at least one device and at least one target', () => {
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ deviceIds: [] })).success).toBe(false)
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ targets: [] })).success).toBe(false)
  })

  it('requires a schedule (a timelapse fires on a window boundary)', () => {
    const withoutSchedule = minimalInput()
    delete withoutSchedule['schedule']
    expect(TimelapseRuleInputSchema.safeParse(withoutSchedule).success).toBe(false)
  })

  it('bounds cadenceSec to 2..3600 and framerate to 1..60 (integers)', () => {
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ cadenceSec: 1 })).success).toBe(false)
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ cadenceSec: 3601 })).success).toBe(
      false,
    )
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ cadenceSec: 2.5 })).success).toBe(
      false,
    )
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ cadenceSec: 3600 })).success).toBe(
      true,
    )
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ framerate: 0 })).success).toBe(false)
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ framerate: 61 })).success).toBe(false)
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ framerate: 60 })).success).toBe(true)
  })

  it('bounds priority to the 1..5 canonical ordinal', () => {
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ priority: 0 })).success).toBe(false)
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ priority: 6 })).success).toBe(false)
  })

  it('accepts an optional template with title/body', () => {
    const parsed = TimelapseRuleInputSchema.parse(
      minimalInput({ template: { title: 'Daily {{camera}}', body: 'timelapse ready' } }),
    )
    expect(parsed.template?.title).toBe('Daily {{camera}}')
    expect(parsed.template?.body).toBe('timelapse ready')
  })

  it('defaults previewMode to the STILL — a GIF is opt-in, never a surprise cost', () => {
    // A dozen ffmpeg seeks and a palette pass per window per camera is not
    // something a rule that never asked for it should start paying on deploy.
    expect(TimelapseRuleInputSchema.parse(minimalInput()).previewMode).toBe('image')
    expect(TimelapseRuleInputSchema.parse(minimalInput({ previewMode: 'gif' })).previewMode).toBe(
      'gif',
    )
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ previewMode: 'webm' })).success).toBe(
      false,
    )
  })

  it('leaves reportClasses ABSENT by default — absent means "every class seen"', () => {
    expect(TimelapseRuleInputSchema.parse(minimalInput()).reportClasses).toBeUndefined()
    expect(
      TimelapseRuleInputSchema.parse(minimalInput({ reportClasses: ['person', 'vehicle'] }))
        .reportClasses,
    ).toEqual(['person', 'vehicle'])
    // An empty list is reachable and means the same as absent; it is not an error.
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ reportClasses: [] })).success).toBe(
      true,
    )
    expect(TimelapseRuleInputSchema.safeParse(minimalInput({ reportClasses: [''] })).success).toBe(
      false,
    )
  })

  it('STRIPS ownership/provenance fields — they are server-derived, never client-trusted', () => {
    const parsed = TimelapseRuleInputSchema.parse(
      minimalInput({
        ownerUserId: 'attacker',
        createdBy: 'attacker',
        id: 'forged',
        lastGeneratedAt: 42,
      }),
    )
    expect('ownerUserId' in parsed).toBe(false)
    expect('createdBy' in parsed).toBe(false)
    expect('id' in parsed).toBe(false)
    expect('lastGeneratedAt' in parsed).toBe(false)
  })
})

describe('TimelapseRuleSchema (persisted)', () => {
  it('carries the server-stamped provenance fields', () => {
    const rule = TimelapseRuleSchema.parse({
      ...minimalInput(),
      id: 'tl-1',
      createdBy: 'admin-1',
      createdAt: 1_000,
      updatedAt: 2_000,
      ownerUserId: 'u1',
      lastGeneratedAt: 3_000,
    })
    expect(rule.id).toBe('tl-1')
    expect(rule.createdBy).toBe('admin-1')
    expect(rule.createdAt).toBe(1_000)
    expect(rule.updatedAt).toBe(2_000)
    expect(rule.ownerUserId).toBe('u1')
    expect(rule.lastGeneratedAt).toBe(3_000)
  })

  it('leaves ownerUserId/lastGeneratedAt absent on a global, never-generated rule', () => {
    const rule = TimelapseRuleSchema.parse({
      ...minimalInput(),
      id: 'tl-2',
      createdBy: 'admin-1',
      createdAt: 1,
      updatedAt: 1,
    })
    expect(rule.ownerUserId).toBeUndefined()
    expect(rule.lastGeneratedAt).toBeUndefined()
  })

  it('rejects a persisted rule missing provenance', () => {
    expect(TimelapseRuleSchema.safeParse(minimalInput()).success).toBe(false)
  })
})

describe('TimelapseRulePatchSchema', () => {
  it('accepts any subset of the input fields', () => {
    const patch = TimelapseRulePatchSchema.parse({ cadenceSec: 30 })
    expect(patch.cadenceSec).toBe(30)
    expect(patch.name).toBeUndefined()
    expect(TimelapseRulePatchSchema.parse({}).enabled).toBeUndefined()
  })

  it('still enforces the field bounds it does carry', () => {
    expect(TimelapseRulePatchSchema.safeParse({ framerate: 99 }).success).toBe(false)
    expect(TimelapseRulePatchSchema.safeParse({ deviceIds: [] }).success).toBe(false)
  })

  it('never materialises defaults — an absent key means "leave unchanged"', () => {
    const patch = TimelapseRulePatchSchema.parse({ name: 'renamed' })
    expect(patch).toEqual({ name: 'renamed' })
  })

  it('accepts an explicit null template as the CLEAR signal (survives JSON)', () => {
    const patch = TimelapseRulePatchSchema.parse({ template: null })
    expect(patch.template).toBeNull()
    expect(
      TimelapseRulePatchSchema.parse(JSON.parse(JSON.stringify({ template: null }))).template,
    ).toBeNull()
    // An absent key still means "leave unchanged", never "clear".
    expect('template' in TimelapseRulePatchSchema.parse({ name: 'x' })).toBe(false)
  })

  it('covers exactly the input field set (no drift between the two schemas)', () => {
    expect(Object.keys(TimelapseRulePatchSchema.shape).sort()).toEqual(
      Object.keys(TimelapseRuleInputSchema.shape).sort(),
    )
  })

  it('leaves the density fields ABSENT when a rule never set them', () => {
    // The whole migration: an existing rule stores no dense cadence, so the
    // renderer's derivation is what answers for it — and changing the
    // derivation changes those rules without touching a single stored row.
    const rule = TimelapseRuleInputSchema.parse({
      name: 'Front door',
      deviceIds: [101],
      schedule: SCHEDULE,
      targets: [{ targetId: 't' }],
      cadenceSec: 30,
      framerate: 12,
    })
    expect(rule.denseCadenceSec).toBeUndefined()
    expect(rule.minDwellSec).toBeUndefined()
    expect('denseCadenceSec' in rule).toBe(false)
  })

  it('bounds denseCadenceSec at the recording frame interval', () => {
    expect(TIMELAPSE_DENSE_FLOOR_SEC).toBe(0.1)
    const ok = TimelapseRulePatchSchema.parse({ denseCadenceSec: TIMELAPSE_DENSE_FLOOR_SEC })
    expect(ok.denseCadenceSec).toBe(0.1)
    expect(() => TimelapseRulePatchSchema.parse({ denseCadenceSec: 0.05 })).toThrow()
    expect(() => TimelapseRulePatchSchema.parse({ minDwellSec: -1 })).toThrow()
  })

  describe('assertTimelapseCadences', () => {
    it('passes a rule that states no dense cadence at all', () => {
      expect(() => assertTimelapseCadences({ cadenceSec: 30 })).not.toThrow()
    })

    it('passes a dense cadence strictly denser than the base', () => {
      expect(() => assertTimelapseCadences({ cadenceSec: 30, denseCadenceSec: 1 })).not.toThrow()
    })

    it('refuses equal and refuses sparser, naming BOTH numbers', () => {
      expect(() => assertTimelapseCadences({ cadenceSec: 30, denseCadenceSec: 30 })).toThrow(
        /strictly smaller/i,
      )
      // Actionable in a toast: the operator must see what he set and what it
      // has to beat.
      expect(() => assertTimelapseCadences({ cadenceSec: 30, denseCadenceSec: 45 })).toThrow(/45/)
      expect(() => assertTimelapseCadences({ cadenceSec: 30, denseCadenceSec: 45 })).toThrow(/30/)
    })
  })

  it('STRIPS ownership/provenance fields (a patch can never re-own a rule)', () => {
    const patch = TimelapseRulePatchSchema.parse({
      name: 'renamed',
      ownerUserId: 'attacker',
      createdBy: 'attacker',
      lastGeneratedAt: 1,
    })
    expect('ownerUserId' in patch).toBe(false)
    expect('createdBy' in patch).toBe(false)
    expect('lastGeneratedAt' in patch).toBe(false)
  })
})
