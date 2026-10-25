import { describe, expect, it } from 'vitest'
import {
  assertSummaryBudget,
  NcSummaryRuleInputSchema,
  NcSummaryRulePatchSchema,
  NcSummaryRuleSchema,
} from '../summary-rule.js'

const TARGET = { targetId: 'zentik-1', notifierId: 'zentik' }

function minimalInput(): Record<string, unknown> {
  return {
    name: 'night digest',
    deviceIds: [636, 637],
    window: {
      kind: 'schedule',
      schedule: { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1260, endMinute: 420 }] },
    },
    targets: [TARGET],
  }
}

describe('NcSummaryRuleInputSchema', () => {
  it('defaults the budgets, the rank and the barrier', () => {
    const parsed = NcSummaryRuleInputSchema.parse(minimalInput())
    expect(parsed.enabled).toBe(true)
    expect(parsed.maxTiles).toBe(12)
    expect(parsed.maxAiImages).toBe(6)
    expect(parsed.rank).toBe('importance')
    expect(parsed.barrierSeconds).toBe(120)
    expect(parsed.deliverEmpty).toBe(false)
    expect(parsed.priority).toBe(3)
  })

  it('defaults the mosaic to NO TEXT — a new rule delivers pictures', () => {
    expect(NcSummaryRuleInputSchema.parse(minimalInput()).captions).toBe('none')
  })

  it('reads an EXISTING rule that predates the field as none — the soft migration', () => {
    // Exactly what `summary-store.ts` hands `NcSummaryRuleSchema.safeParse` for
    // a rule stored before this option existed: no `captions` key at all. It
    // must come back `none`, not `all`, and nothing must be rewritten on disk.
    const stored = {
      ...minimalInput(),
      id: 'sum_1',
      createdBy: 'admin',
      createdAt: 1,
      updatedAt: 2,
      captionText: 'Notte {{from}}→{{to}}',
    }
    expect(stored).not.toHaveProperty('captions')
    const parsed = NcSummaryRuleSchema.parse(stored)
    expect(parsed.captions).toBe('none')
    // The caption TEXT survives untouched — turning the words back on must not
    // cost the operator the words he wrote.
    expect(parsed.captionText).toBe('Notte {{from}}→{{to}}')
  })

  it('keeps every captions value the operator can choose', () => {
    for (const captions of ['none', 'tiles', 'all'] as const) {
      expect(NcSummaryRuleInputSchema.parse({ ...minimalInput(), captions }).captions).toBe(
        captions,
      )
    }
    expect(() =>
      NcSummaryRuleInputSchema.parse({ ...minimalInput(), captions: 'labels' }),
    ).toThrow()
  })

  it('refuses a window that is neither kind', () => {
    expect(() =>
      NcSummaryRuleInputSchema.parse({ ...minimalInput(), window: { kind: 'rolling' } }),
    ).toThrow()
  })

  it('accepts a motion window and keeps both bounds', () => {
    const parsed = NcSummaryRuleInputSchema.parse({
      ...minimalInput(),
      window: { kind: 'motion', quietSeconds: 300, maxWindowSeconds: 1800 },
    })
    expect(parsed.window).toEqual({ kind: 'motion', quietSeconds: 300, maxWindowSeconds: 1800 })
  })

  it('strips ownership and provenance that rode in on the blob', () => {
    const parsed = NcSummaryRuleInputSchema.parse({
      ...minimalInput(),
      ownerUserId: 'someone-else',
      createdBy: 'someone-else',
      id: 'forged',
    })
    expect(parsed).not.toHaveProperty('ownerUserId')
    expect(parsed).not.toHaveProperty('createdBy')
    expect(parsed).not.toHaveProperty('id')
  })

  it('carries the ai section verbatim when present, and omits it when not', () => {
    const withAi = NcSummaryRuleInputSchema.parse({
      ...minimalInput(),
      ai: { enabled: true, prompt: 'what happened?' },
    })
    expect(withAi.ai).toEqual({ enabled: true, prompt: 'what happened?' })
    expect(NcSummaryRuleInputSchema.parse(minimalInput())).not.toHaveProperty('ai')
  })
})

describe('NcSummaryRulePatchSchema — the `.partial()` trap', () => {
  it('materialises NOTHING for keys the caller did not send', () => {
    const patch = NcSummaryRulePatchSchema.parse({ name: 'renamed' })
    expect(Object.keys(patch)).toEqual(['name'])
  })

  it('carries exactly the same field names as the input', () => {
    const inputKeys = Object.keys(NcSummaryRuleInputSchema.shape).toSorted()
    const patchKeys = Object.keys(NcSummaryRulePatchSchema.shape).toSorted()
    expect(patchKeys).toEqual(inputKeys)
  })

  it('lets template, filters and ai be cleared with an explicit null', () => {
    const patch = NcSummaryRulePatchSchema.parse({ template: null, filters: null, ai: null })
    expect(patch.template).toBeNull()
    expect(patch.filters).toBeNull()
    expect(patch.ai).toBeNull()
  })

  it('never accepts ownership fields', () => {
    const patch = NcSummaryRulePatchSchema.parse({ ownerUserId: 'x', createdBy: 'y', id: 'z' })
    expect(Object.keys(patch)).toEqual([])
  })
})

describe('NcSummaryRuleSchema', () => {
  it('requires the server-stamped provenance', () => {
    expect(() =>
      NcSummaryRuleSchema.parse(NcSummaryRuleInputSchema.parse(minimalInput())),
    ).toThrow()
    const rule = NcSummaryRuleSchema.parse({
      ...NcSummaryRuleInputSchema.parse(minimalInput()),
      id: 'r1',
      createdBy: 'admin',
      createdAt: 1,
      updatedAt: 1,
    })
    expect(rule.id).toBe('r1')
    expect(rule.generatedAt).toBeUndefined()
  })
})

describe('assertSummaryBudget', () => {
  it('refuses an AI budget larger than the mosaic', () => {
    expect(() => assertSummaryBudget({ maxTiles: 4, maxAiImages: 6 })).toThrow(/cannot exceed/)
  })
  it('accepts equal budgets', () => {
    expect(() => assertSummaryBudget({ maxTiles: 6, maxAiImages: 6 })).not.toThrow()
  })
})
