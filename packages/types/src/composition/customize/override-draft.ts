/**
 * A saved Customize assignment (D936). The schema is the type: callers use
 * `z.infer`, they do not restate the shape.
 */
import { z } from 'zod'

export const OverrideSourceSchema = z.object({
  addonId: z.string().min(1),
  stableId: z.string().min(1),
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
})
export type OverrideSource = z.infer<typeof OverrideSourceSchema>

export const IdentityTransformDraftSchema = z.object({ kind: z.literal('identity') })
export const InvertTransformDraftSchema = z.object({ kind: z.literal('invert') })
export const ThresholdTransformDraftSchema = z.object({
  kind: z.literal('threshold'),
  comparison: z.enum(['gte', 'lte']),
  threshold: z.number(),
  startDwellMs: z.number().nonnegative(),
  stopDwellMs: z.number().nonnegative(),
})
export const LinearTransformDraftSchema = z.object({
  kind: z.literal('linear'),
  scale: z.number(),
  offset: z.number(),
  clampMin: z.number().optional(),
  clampMax: z.number().optional(),
})
export const EnumMapTransformDraftSchema = z.object({
  kind: z.literal('enum-map'),
  mapping: z.record(z.string(), z.string().nullable()),
})
export const NumberBridgeTransformDraftSchema = z.object({ kind: z.literal('number') })

export const CustomizeTransformDraftSchema = z.discriminatedUnion('kind', [
  IdentityTransformDraftSchema,
  InvertTransformDraftSchema,
  ThresholdTransformDraftSchema,
  LinearTransformDraftSchema,
  EnumMapTransformDraftSchema,
  NumberBridgeTransformDraftSchema,
])
export type CustomizeTransformDraft = z.infer<typeof CustomizeTransformDraftSchema>

export const ScalarOverrideDraftSchema = z.object({
  kind: z.literal('scalar'),
  cap: z.string().min(1),
  targetId: z.string().min(1),
  source: OverrideSourceSchema,
  transform: CustomizeTransformDraftSchema,
})
export type ScalarOverrideDraft = z.infer<typeof ScalarOverrideDraftSchema>

export const KeyedArrayOverrideDraftSchema = z.object({
  kind: z.literal('keyedArray'),
  cap: z.string().min(1),
  targetId: z.string().min(1),
  key: z.string().min(1),
  label: z.string().min(1),
  fieldPath: z.string().min(1),
  source: OverrideSourceSchema,
  transform: CustomizeTransformDraftSchema,
})
export type KeyedArrayOverrideDraft = z.infer<typeof KeyedArrayOverrideDraftSchema>

export const PulseOverrideDraftSchema = z.object({
  kind: z.literal('pulse'),
  cap: z.string().min(1),
  targetId: z.string().min(1),
  enabled: z.boolean(),
  debounceMs: z.number().nonnegative(),
  sources: z.array(OverrideSourceSchema).min(1),
})
export type PulseOverrideDraft = z.infer<typeof PulseOverrideDraftSchema>

export const SpanSourceDraftSchema = OverrideSourceSchema.extend({
  mode: z.enum(['in-addition', 'confirm', 'replace']).optional(),
})
export type SpanSourceDraft = z.infer<typeof SpanSourceDraftSchema>

export const SpanOverrideDraftSchema = z.object({
  kind: z.literal('span'),
  cap: z.string().min(1),
  targetId: z.string().min(1),
  timeoutMs: z.number().nonnegative(),
  cooldownMs: z.number().nonnegative().optional(),
  sources: z.array(SpanSourceDraftSchema),
})
export type SpanOverrideDraft = z.infer<typeof SpanOverrideDraftSchema>

export const OverrideDraftSchema = z.discriminatedUnion('kind', [
  ScalarOverrideDraftSchema,
  KeyedArrayOverrideDraftSchema,
  PulseOverrideDraftSchema,
  SpanOverrideDraftSchema,
])
export type OverrideDraft = z.infer<typeof OverrideDraftSchema>

/** Effective authority for one declared target. Not a second stored switch. */
export const CustomizeAssignmentStatusSchema = z.object({
  targetId: z.string().min(1),
  configured: z.boolean(),
  source: z.enum(['native', 'assigned']),
  state: z.enum(['active', 'stale', 'released', 'unavailable']),
  reason: z.string().nullable(),
})
export type CustomizeAssignmentStatus = z.infer<typeof CustomizeAssignmentStatusSchema>
