/**
 * A helper spec is what the editor stores and reads back (D944). The compiled
 * features are a projection; the editor never edits the expression.
 */
import { z } from 'zod'
import { STATISTIC_STATS } from './history-math.js'
import {
  RESET_PERIODS,
  type ResetPeriod,
  type RollingWindow,
  RollingWindowSchema,
  type StatisticWindow,
  StatisticWindowSchema,
} from './history-window.js'
import { type CompositionSourceRef, CompositionSourceRefSchema } from '../source-ref.js'

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
  'fan',
  'cover',
  'valve',
  'lock',
  'media-player',
  'climate',
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

/** Math (D944 phase 3). A reading in, a reading or a yes/no out. */
export type ThresholdHelperSpec = {
  readonly kind: 'threshold'
  readonly source: HelperMember
  /** The output turns on once the reading is at or above this. */
  readonly high: number
  /** The output turns off once the reading is at or below this. `low <= high`. */
  readonly low: number
  readonly onForMs: number
  readonly offForMs: number
}

const thresholdHelperObject = z.object({
  kind: z.literal('threshold'),
  source: HelperMemberSchema,
  high: z.number(),
  low: z.number(),
  onForMs: z.number().int().nonnegative(),
  offForMs: z.number().int().nonnegative(),
})

export const ThresholdHelperSpecSchema: z.ZodType<ThresholdHelperSpec> = thresholdHelperObject

export const ARITHMETIC_OPS = ['sum', 'difference', 'ratio'] as const
export type ArithmeticOp = (typeof ARITHMETIC_OPS)[number]

export type ArithmeticHelperSpec = {
  readonly kind: 'arithmetic'
  readonly op: ArithmeticOp
  /** Sum: two or more. Difference and ratio: exactly two, first minus / over second. */
  readonly inputs: readonly HelperMember[]
}

const arithmeticHelperObject = z.object({
  kind: z.literal('arithmetic'),
  op: z.enum(ARITHMETIC_OPS),
  inputs: z.array(HelperMemberSchema).min(2).max(MAX_HELPER_MEMBERS),
})

export const ArithmeticHelperSpecSchema: z.ZodType<ArithmeticHelperSpec> = arithmeticHelperObject

export const EXPRESSION_OUTPUTS = ['number', 'boolean'] as const
export type ExpressionOutput = (typeof EXPRESSION_OUTPUTS)[number]

export interface ExpressionInput {
  readonly name: string
  readonly member: HelperMember
}

export type ExpressionHelperSpec = {
  readonly kind: 'expression'
  readonly expr: string
  readonly inputs: readonly ExpressionInput[]
  readonly output: ExpressionOutput
}

const expressionHelperObject = z.object({
  kind: z.literal('expression'),
  expr: z.string().min(1),
  inputs: z
    .array(z.object({ name: z.string().min(1), member: HelperMemberSchema }))
    .min(1)
    .max(MAX_HELPER_MEMBERS),
  output: z.enum(EXPRESSION_OUTPUTS),
})

export const ExpressionHelperSpecSchema: z.ZodType<ExpressionHelperSpec> = expressionHelperObject

export const DERIVATIVE_UNITS = ['second', 'minute', 'hour'] as const
export type DerivativeUnit = (typeof DERIVATIVE_UNITS)[number]

export type DerivativeHelperSpec = {
  readonly kind: 'derivative'
  readonly window: RollingWindow
  readonly per: DerivativeUnit
  readonly source: HelperMember
}

const derivativeHelperObject = z.object({
  kind: z.literal('derivative'),
  window: RollingWindowSchema,
  per: z.enum(DERIVATIVE_UNITS),
  source: HelperMemberSchema,
})

export const DerivativeHelperSpecSchema: z.ZodType<DerivativeHelperSpec> = derivativeHelperObject

/** The stream profiles a camera grid can publish. */
export const GRID_PROFILES = ['high', 'mid', 'low'] as const
export type GridProfile = (typeof GRID_PROFILES)[number]
export const MAX_GRID_CELLS: number = 16

export type GridRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A rectangle in normalized [0,1] coordinates of whatever contains it. */
export const GridRectSchema: z.ZodType<GridRect> = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
})

/**
 * One grid cell: a source camera (by its addon-facing identity, never a
 * numeric id), the part of its picture taken, and where it lands on the canvas.
 */
export type GridCellSpec = {
  readonly source: CompositionSourceRef
  readonly region: GridRect
  readonly cell: GridRect
}

export const GridCellSpecSchema: z.ZodType<GridCellSpec> = z.object({
  source: CompositionSourceRefSchema,
  region: GridRectSchema,
  cell: GridRectSchema,
})

/**
 * A camera grid (planning#580). The composer declares its camera
 * (`composed-<blockId>`); the camera-grid engine serves the camera caps on it.
 * No canvas size: it is derived from the cells and the sources.
 */
export type GridHelperSpec = {
  readonly kind: 'grid'
  readonly fps: number
  readonly publishedProfiles: readonly GridProfile[]
  readonly cells: readonly GridCellSpec[]
}

const gridHelperObject = z.object({
  kind: z.literal('grid'),
  fps: z.number().int().min(1).max(60),
  publishedProfiles: z.array(z.enum(GRID_PROFILES)).max(3),
  cells: z.array(GridCellSpecSchema).max(MAX_GRID_CELLS),
})

export const GridHelperSpecSchema: z.ZodType<GridHelperSpec> = gridHelperObject

/**
 * A Terminal camera (planning#580): the camera of one Terminal, created on the
 * Terminal page. The composer declares the camera; addon-terminal serves it.
 */
export type TerminalHelperSpec = {
  readonly kind: 'terminal'
  readonly terminalId: string
}

const terminalHelperObject = z.object({
  kind: z.literal('terminal'),
  terminalId: z.string().uuid(),
})

export const TerminalHelperSpecSchema: z.ZodType<TerminalHelperSpec> = terminalHelperObject

export type HelperSpec =
  | GroupHelperSpec
  | StatisticHelperSpec
  | IntegralHelperSpec
  | ThresholdHelperSpec
  | ArithmeticHelperSpec
  | ExpressionHelperSpec
  | DerivativeHelperSpec
  | GridHelperSpec
  | TerminalHelperSpec

export const HelperSpecSchema: z.ZodType<HelperSpec> = z.discriminatedUnion('kind', [
  gridHelperObject,
  terminalHelperObject,
  GroupHelperSpecSchema,
  statisticHelperObject,
  integralHelperObject,
  thresholdHelperObject,
  arithmeticHelperObject,
  expressionHelperObject,
  derivativeHelperObject,
])

/** The kinds the composer runs from device history, on a schedule. */
export type HistoryHelperSpec = StatisticHelperSpec | IntegralHelperSpec | DerivativeHelperSpec

export function isHistoryHelper(spec: HelperSpec): spec is HistoryHelperSpec {
  return spec.kind === 'statistic' || spec.kind === 'integral' || spec.kind === 'derivative'
}

/** Every member a helper reads. A group has many; the others have one. */
export function helperMembers(spec: HelperSpec): readonly HelperMember[] {
  switch (spec.kind) {
    case 'group':
      return spec.members
    case 'statistic':
    case 'integral':
    case 'threshold':
    case 'derivative':
      return [spec.source]
    case 'arithmetic':
      return spec.inputs
    case 'expression':
      return spec.inputs.map((input) => input.member)
    case 'grid':
    case 'terminal':
      return []
  }
}

/** The kinds whose camera an engine serves on the composer's row (planning#580). */
export const ENGINE_HOSTED_HELPER_KINDS = ['grid', 'terminal'] as const
export type EngineHostedHelperKind = (typeof ENGINE_HOSTED_HELPER_KINDS)[number]
export type EngineHostedHelperSpec = GridHelperSpec | TerminalHelperSpec

export function isEngineHostedHelper(spec: HelperSpec): spec is EngineHostedHelperSpec {
  return spec.kind === 'grid' || spec.kind === 'terminal'
}

/** The devices a helper depends on without reading a field of them: a grid's cell sources. */
export function helperDeviceRefs(spec: HelperSpec): readonly CompositionSourceRef[] {
  return spec.kind === 'grid' ? spec.cells.map((cell) => cell.source) : []
}
