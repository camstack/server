/**
 * The result of planning part of a composition, and the two helpers every
 * planner builds it with. Internal to the composition module — NOT in the
 * barrel (`problem`/`refused` are too generic a name for `@camstack/types`).
 */
import type {
  CompositionFeaturePlan,
  CompositionFieldPlan,
  CompositionProblem,
  CompositionProblemCode,
} from './composition-report.js'
import type { CompositionEventPlan } from './composition-events.js'

export interface CompositionPlanResult {
  readonly problems: readonly CompositionProblem[]
  readonly fields: readonly CompositionFieldPlan[]
  /** One entry per planned feature, with its mode; empty for a per-field or per-item result. */
  readonly features: readonly CompositionFeaturePlan[]
  readonly events: readonly CompositionEventPlan[]
}

export function problem(
  code: CompositionProblemCode,
  path: string,
  message: string,
): CompositionProblem {
  return { code, path, message }
}

export function refused(...problems: readonly CompositionProblem[]): CompositionPlanResult {
  return { problems, fields: [], features: [], events: [] }
}

/** Where a planned field sits in the composition: `features[N].fields.<path>` or `features[N].items.<key>.fields.<path>`. */
export function compositionFieldAt(field: CompositionFieldPlan): string {
  const inner = field.item === undefined ? 'fields' : `items.${field.item.key}.fields`
  return `features[${field.featureIndex}].${inner}.${field.path}`
}
