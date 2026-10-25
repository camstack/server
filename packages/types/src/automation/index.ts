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
  AutomationAction,
  AutomationCondition,
  AutomationConditionAll,
  AutomationConditionAny,
  AutomationConditionExpression,
  AutomationConditionLeaf,
  AutomationConditionNot,
  AutomationConditionOperator,
  AutomationRecipe,
  AutomationTrigger,
} from './recipe.js'
export {
  AutomationActionSchema,
  AutomationConditionOperatorSchema,
  AutomationConditionSchema,
  AutomationRecipeSchema,
  AutomationTriggerSchema,
  conditionDepth,
  countConditionLeaves,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
  validateRecipeBounds,
} from './recipe.js'
