/**
 * Stands in for the bare `@camstack/types` entry when a generated block is
 * bundled inside a spec. Deep modules only: the real entry pulls the whole
 * package (and every capability) into a one-file test bundle.
 */
export { EventCategory } from '../../enums/event-category.js'
export {
  collectWhenMirrorSources,
  ConditionMirror,
  evaluateWhenTree,
} from '../condition-eval.js'
export {
  ACTION_TARGET_INVALIDATION_EVENTS,
  ActionTargetResolver,
} from '../action-target.js'
export { DetectionTriggerFilter } from '../detection-trigger.js'
export { evaluateStationaryTrigger } from '../stationary-trigger.js'
export { RunGate } from '../run-gate.js'
export { coreBlockIdFromAddonId } from '../../capabilities/core-blocks.cap.js'
export { resolveDeviceTarget, resolveStepArgs, runForDevices, runSteps } from '../step-runner.js'
export { buildTriggerTrace, isSkippedTrace, mergeSkipTraces } from '../trace.js'
export {
  nextOccurrence,
  validateTimeSpecForSite,
  zoneOnlySite,
} from '../../time/time-spec.js'
