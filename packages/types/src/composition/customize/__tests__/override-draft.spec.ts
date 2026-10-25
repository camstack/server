/**
 * OverrideDraft and assignment status are Zod schemas (D936). The type is
 * `z.infer` of the schema. A pulse declares no duration; a span declares no
 * counter — that is the type, checked here so a later edit cannot add one
 * silently.
 */
import { describe, expect, it } from 'vitest'
import type {
  PulseEventCustomizeTarget,
  SpanEventCustomizeTarget,
} from '../../../capabilities/customize-spec.js'
import {
  CustomizeAssignmentStatusSchema,
  OverrideDraftSchema,
  type CustomizeAssignmentStatus,
  type OverrideDraft,
} from '../override-draft.js'

type Assert<T extends true> = T
type PulseHasNoDuration = Assert<'timeoutMs' extends keyof PulseEventCustomizeTarget ? false : true>
type SpanHasNoCounter = Assert<'counterPath' extends keyof SpanEventCustomizeTarget ? false : true>

const pulseDeclaresNoDuration: PulseHasNoDuration = true
const spanDeclaresNoCounter: SpanHasNoCounter = true

const scalarDraft: OverrideDraft = {
  kind: 'scalar',
  cap: 'battery',
  targetId: 'percentage',
  source: { addonId: 'ha', stableId: 'batt', cap: 'sensor', fieldPath: 'state' },
  transform: { kind: 'identity' },
}

describe('override draft', () => {
  it('parses a scalar assignment and an assignment status', () => {
    expect(OverrideDraftSchema.parse(scalarDraft)).toEqual(scalarDraft)
    const status: CustomizeAssignmentStatus = {
      targetId: 'percentage',
      configured: true,
      source: 'assigned',
      state: 'active',
      reason: null,
    }
    expect(CustomizeAssignmentStatusSchema.parse(status)).toEqual(status)
  })

  it('rejects a span whose timeout is negative', () => {
    const parsed = OverrideDraftSchema.safeParse({
      kind: 'span',
      cap: 'motion',
      targetId: 'detected',
      timeoutMs: -1,
      sources: [],
    })
    expect(parsed.success).toBe(false)
  })

  it('keeps duration off a pulse and a counter off a span', () => {
    expect(pulseDeclaresNoDuration).toBe(true)
    expect(spanDeclaresNoCounter).toBe(true)
  })
})
