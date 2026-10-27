/**
 * A helper spec is what the editor stores and reads back (D944). The compiled
 * features are a projection; the editor never edits the expression.
 */
import { z } from 'zod'
import { APPLIANCE_KINDS, APPLIANCE_TEMPLATE_ID } from './appliance.js'
import { STATISTIC_STATS } from './history-math.js'
import {
  RESET_PERIODS,
  type ResetPeriod,
  type StatisticWindow,
  StatisticWindowSchema,
} from './history-window.js'
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
  'switch',
  'light',
] as const
export type GroupTemplateId = (typeof GROUP_TEMPLATE_IDS)[number]

export const NUMERIC_AGGREGATES = ['mean', 'median', 'min', 'max', 'sum'] as const
export type NumericAggregate = (typeof NUMERIC_AGGREGATES)[number]

export const BINARY_AGGREGATES = ['any', 'all'] as const
export type BinaryAggregate = (typeof BINARY_AGGREGATES)[number]

/** How an actuator group decides it is on. Unknown members never count as off. */
export const ACTIVE_CRITERIA = ['at-least-one', 'all'] as const
export type ActiveCriterion = (typeof ACTIVE_CRITERIA)[number]

export const AGGREGATE_REDUCERS = ['mean', 'median', 'min', 'max', 'sum', 'any', 'all'] as const
export type AggregateReducer = (typeof AGGREGATE_REDUCERS)[number]

export const GroupTemplateIdSchema: z.ZodType<GroupTemplateId> = z.enum(GROUP_TEMPLATE_IDS)
export const AggregateReducerSchema: z.ZodType<AggregateReducer> = z.enum(AGGREGATE_REDUCERS)
export const ActiveCriterionSchema: z.ZodType<ActiveCriterion> = z.enum(ACTIVE_CRITERIA)

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

/** A group, a statistic, or an integral (D944). The composer runs all three. */
export const GroupHelperSpecSchema: z.ZodObject<{
  kind: z.ZodLiteral<'group'>
  templateId: typeof GroupTemplateIdSchema
  aggregate: typeof AggregateReducerSchema
  members: z.ZodArray<typeof HelperMemberSchema>
  active: z.ZodOptional<typeof ActiveCriterionSchema>
}> = z.object({
  kind: z.literal('group'),
  templateId: GroupTemplateIdSchema,
  aggregate: AggregateReducerSchema,
  members: z.array(HelperMemberSchema).min(1).max(MAX_HELPER_MEMBERS),
  /** Actuator groups only. Readings leave this unset. */
  active: ActiveCriterionSchema.optional(),
})
export type GroupHelperSpec = z.infer<typeof GroupHelperSpecSchema>

export const ApplianceHelperSpecSchema: z.ZodObject<{
  kind: z.ZodLiteral<'appliance'>
  templateId: z.ZodLiteral<typeof APPLIANCE_TEMPLATE_ID>
  appliance: z.ZodEnum<{ washer: 'washer'; dryer: 'dryer'; dishwasher: 'dishwasher' }>
  thresholdWatts: z.ZodNumber
  startDwellMs: z.ZodNumber
  stopDwellMs: z.ZodNumber
  member: typeof HelperMemberSchema
}> = z.object({
  kind: z.literal('appliance'),
  templateId: z.literal(APPLIANCE_TEMPLATE_ID),
  appliance: z.enum(APPLIANCE_KINDS),
  thresholdWatts: z.number().positive(),
  startDwellMs: z.number().int().nonnegative(),
  stopDwellMs: z.number().int().nonnegative(),
  member: HelperMemberSchema,
})
export type ApplianceHelperSpec = z.infer<typeof ApplianceHelperSpecSchema>

export type StatisticStat = (typeof STATISTIC_STATS)[number]

export type StatisticHelperSpec = {
  readonly kind: 'statistic'
  readonly stat: StatisticStat
  readonly window: StatisticWindow
  readonly source: HelperMember
}

const statisticHelperObject = z.object({
  kind: z.literal('statistic'),
  stat: z.enum(STATISTIC_STATS),
  window: StatisticWindowSchema,
  source: HelperMemberSchema,
})

export const StatisticHelperSpecSchema: z.ZodType<StatisticHelperSpec> = statisticHelperObject

export const INTEGRAL_OUTPUTS = ['energy', 'meter'] as const
export type IntegralOutput = (typeof INTEGRAL_OUTPUTS)[number]

export type IntegralHelperSpec = {
  readonly kind: 'integral'
  readonly reset: ResetPeriod
  readonly output: IntegralOutput
  readonly source: HelperMember
}

const integralHelperObject = z.object({
  kind: z.literal('integral'),
  reset: z.enum(RESET_PERIODS),
  output: z.enum(INTEGRAL_OUTPUTS),
  source: HelperMemberSchema,
})

export const IntegralHelperSpecSchema: z.ZodType<IntegralHelperSpec> = integralHelperObject

export type HelperSpec =
  | GroupHelperSpec
  | ApplianceHelperSpec
  | StatisticHelperSpec
  | IntegralHelperSpec

export const HelperSpecSchema: z.ZodType<HelperSpec> = z.discriminatedUnion('kind', [
  GroupHelperSpecSchema,
  ApplianceHelperSpecSchema,
  statisticHelperObject,
  integralHelperObject,
])

/** Every member a helper reads. A group has many; the others have one. */
export function helperMembers(spec: HelperSpec): readonly HelperMember[] {
  switch (spec.kind) {
    case 'group':
      return spec.members
    case 'appliance':
      return [spec.member]
    case 'statistic':
    case 'integral':
      return [spec.source]
  }
}
