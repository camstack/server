/**
 * Stands in for the bare `@camstack/types` entry when a generated block is
 * bundled inside a spec. Deep modules only: the real entry pulls the whole
 * package (and every capability) into a one-file test bundle.
 */
export { EventCategory } from '../../enums/event-category.js'
export {
  collectMirrorSources,
  ConditionMirror,
  evaluateConditionTree,
} from '../condition-eval.js'
export { DetectionTriggerFilter } from '../detection-trigger.js'
export { RunGate } from '../run-gate.js'
export {
  AUTOMATION_STATE_LOCATION,
  AutomationStateDocSchema,
  appendTrace,
  buildTriggerTrace,
} from '../trace.js'
