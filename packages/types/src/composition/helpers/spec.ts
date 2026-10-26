/**
 * A helper spec is what the editor stores and reads back (D944). The compiled
 * features are a projection; the editor never edits the expression.
 */
import { z } from 'zod'
import { CompositionSourceRefSchema } from '../source-ref.js'

/** A group may name more members than an expression call (the 16-arg cap). */
export const MAX_HELPER_MEMBERS: number = 64

export const GROUP_TEMPLATE_IDS = [
  'temperature',
  'humidity',
  'pressure',
  'illuminance',
  'power',
  'energy',
  'battery',
  'numeric',
  'motion',
  'contact',
  'leak',
  'smoke',
  'occupancy',
  'binary',
] as const
export type GroupTemplateId = (typeof GROUP_TEMPLATE_IDS)[number]

export const NUMERIC_AGGREGATES = ['mean', 'median', 'min', 'max', 'sum'] as const
export type NumericAggregate = (typeof NUMERIC_AGGREGATES)[number]

export const BINARY_AGGREGATES = ['any', 'all'] as const
export type BinaryAggregate = (typeof BINARY_AGGREGATES)[number]

export const AGGREGATE_REDUCERS = ['mean', 'median', 'min', 'max', 'sum', 'any', 'all'] as const
export type AggregateReducer = (typeof AGGREGATE_REDUCERS)[number]

export const GroupTemplateIdSchema: z.ZodType<GroupTemplateId> = z.enum(GROUP_TEMPLATE_IDS)
export const AggregateReducerSchema: z.ZodType<AggregateReducer> = z.enum(AGGREGATE_REDUCERS)

/** One member. The field is stored so occupancy can name motion or binary. */
export const HelperMemberSchema: z.ZodObject<{
  source: typeof CompositionSourceRefSchema
  cap: z.ZodString
  fieldPath: z.ZodString
}> = z.object({
  source: CompositionSourceRefSchema,
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
})
export type HelperMember = z.infer<typeof HelperMemberSchema>

/**
 * Phase 1a is groups only. Math, integral and statistics stay off this union
 * until the composer can run them — a control must not save a spec it cannot.
 */
export const GroupHelperSpecSchema: z.ZodObject<{
  kind: z.ZodLiteral<'group'>
  templateId: typeof GroupTemplateIdSchema
  aggregate: typeof AggregateReducerSchema
  members: z.ZodArray<typeof HelperMemberSchema>
}> = z.object({
  kind: z.literal('group'),
  templateId: GroupTemplateIdSchema,
  aggregate: AggregateReducerSchema,
  members: z.array(HelperMemberSchema).min(1).max(MAX_HELPER_MEMBERS),
})
export type GroupHelperSpec = z.infer<typeof GroupHelperSpecSchema>

export const HelperSpecSchema: z.ZodDiscriminatedUnion<[typeof GroupHelperSpecSchema], 'kind'> =
  z.discriminatedUnion('kind', [GroupHelperSpecSchema])
export type HelperSpec = z.infer<typeof HelperSpecSchema>
