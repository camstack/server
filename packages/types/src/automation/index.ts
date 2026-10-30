/**
 * Automation recipes — the declarative half of a visually-authored automation,
 * and the generator that turns one into the TypeScript of an ordinary core
 * block. There is no engine here and there must never be one: the block runner
 * is the runtime and `core_blocks` is the store.
 *
 * This is the module barrel; leaf files inside @camstack/types MUST import from
 * the deep modules (e.g. `../automation/recipe.js`), never through this file OR
 * the root barrel (see biome-plugins/no-types-barrel-leaf-import.grit).
 */
export type { GenerateAutomationBlockInput } from './codegen.js'
export { generateAutomationBlock } from './codegen.js'
export type {
  ConditionEvaluation,
  ConditionReader,
  MirrorRefreshFetchers,
  MirrorRefreshReport,
  MirrorSource,
} from './condition-eval.js'
export {
  collectMirrorSources,
  collectWhenMirrorSources,
  ConditionMirror,
  evaluateConditionTree,
  evaluateWhenTree,
} from './condition-eval.js'
export type {
  DetectionDecision,
  DetectionTrigger,
  DetectionVars,
  TrackLifecycleInput,
} from './detection-trigger.js'
export {
  DetectionTriggerFilter,
  detectionClassMatches,
  FIRED_MAX,
  FIRED_TTL_MS,
} from './detection-trigger.js'
export type {
  StationaryChangedInput,
  StationaryDecision,
  StationaryTrigger,
  StationaryVars,
} from './stationary-trigger.js'
export { evaluateStationaryTrigger } from './stationary-trigger.js'
export type { CooldownInput, CooldownVerdict, RunGateAdmission } from './run-gate.js'
export { RunGate } from './run-gate.js'
export type {
  AutomationConditionTraceNode,
  AutomationRunOutcome,
  AutomationRunTrace,
  AutomationRunVerdict,
  AutomationStateDoc,
  AutomationStepTrace,
  AutomationTriggerTrace,
  TraceNodeOutcome,
  TraceValue,
} from './trace.js'
export {
  AutomationConditionTraceNodeSchema,
  EMPTY_AUTOMATION_STATE,
  mergeSkipTraces,
  AutomationRunOutcomeSchema,
  AutomationRunTraceSchema,
  AutomationRunVerdictSchema,
  AutomationStateDocSchema,
  AutomationStepTraceSchema,
  AutomationTriggerTraceSchema,
  appendTrace,
  buildStepArgsTrace,
  buildTriggerTrace,
  isSkippedTrace,
  MAX_TRACE_ARG_LENGTH,
  MAX_TRACE_ARGS,
  REDACTED_ARG,
  skipSignature,
  TraceNodeOutcomeSchema,
  TraceValueSchema,
} from './trace.js'
export type {
  ActionStep,
  AutomationAction,
  AutomationCapStep,
  AutomationRecipe,
  AutomationRunMode,
  LegacyAutomationRecipe,
} from './recipe.js'
export {
  ActionStepSchema,
  AutomationActionSchema,
  AutomationCapStepSchema,
  AutomationWaitStepSchema,
  AutomationRecipeSchema,
  AutomationRunModeSchema,
  CurrentAutomationRecipeSchema,
  convertLegacyRecipe,
  DEFAULT_TRACE_KEEP,
  LegacyAutomationRecipeSchema,
  MAX_TRACE_KEEP,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
  validateRecipeBounds,
} from './recipe.js'
export type {
  AutomationAll,
  AutomationAny,
  AutomationConditionOperator,
  AutomationEventLeaf,
  AutomationLeaf,
  AutomationNot,
  AutomationStateLeaf,
  AutomationWhen,
  DetectionLeaf,
  DeviceBecomesLeaf,
  DeviceIsLeaf,
  ExpressionLeaf,
  StationaryLeaf,
  StationaryPresentLeaf,
} from './when.js'
export {
  AutomationConditionOperatorSchema,
  AutomationWhenSchema,
  countWhenLeaves,
  forEachLeaf,
  hasEventLeaves,
  isEventLeaf,
  isLeaf,
  MAX_WHEN_DEPTH,
  MAX_WHEN_LEAVES,
  validateWhenTree,
  whenDepth,
} from './when.js'
export type {
  LegacyCondition,
  LegacyTrigger,
} from './legacy-recipe.js'
export {
  convertLegacyCondition,
  convertLegacyWhen,
  LegacyConditionSchema,
  LegacyTriggerSchema,
} from './legacy-recipe.js'
export type {
  DetectionLabelSource,
  DetectionSubject,
  IdentityLabel,
  PlateLabel,
  SubClassLabel,
  SubjectObservation,
  SubjectVerdict,
} from './detection-subject.js'
export {
  anySubjectMatches,
  DETECTION_LABEL_SOURCES,
  DetectionSubjectSchema,
  describeSubject,
  StationarySubjectSchema,
  subClassesOf,
  subjectFromClassName,
  subjectMatches,
} from './detection-subject.js'
export * from './action.js'
export * from './step-runner.js'
export {
  UnitWarningSchema,
  capUnitResolver,
  normalizeActionUnits,
  normalizeConditionUnits,
  normalizeRecipeUnits,
} from './normalize-units.js'
export type { UnitResolver, UnitWarning, UnitsNormalized } from './normalize-units.js'
export { prepareRecipeUnits } from './prepare-units.js'
export type { PreparedRecipe } from './prepare-units.js'
