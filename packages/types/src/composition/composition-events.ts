import { z } from 'zod'
import type { CapabilityDefinition } from '../capabilities/capability-definition.js'
import { EventCategory } from '../enums/event-category.js'
import { describeStateField } from './state-fields.js'

export const COMPOSITION_EVENT_CATEGORY = {
  'doorbell.onPressed': EventCategory.DoorbellOnPressed,
} as const satisfies Readonly<Record<string, EventCategory>>

const EVENT_CATEGORIES: Readonly<Record<string, EventCategory>> = COMPOSITION_EVENT_CATEGORY

export const CompositionEventPlanSchema = z.object({
  featureIndex: z.number().int().nonnegative(),
  cap: z.string(),
  eventName: z.string(),
  category: z.enum(EventCategory),
  stateField: z.string(),
  fieldKey: z.string(),
})
export type CompositionEventPlan = z.infer<typeof CompositionEventPlanSchema>

type EventProblemCode = 'unknown-field' | 'kind-mismatch' | 'not-composable'

export interface CompositionEventProblem {
  readonly code: EventProblemCode
  readonly path: string
  readonly message: string
}

export interface CompositionEventFeatureInput {
  readonly featureIndex: number
  readonly cap: string
  readonly mode: 'new' | 'add' | 'replace'
}

export interface CompositionEventFieldInput {
  readonly featureIndex: number
  readonly cap: string
  readonly path: string
  readonly item?: unknown
}

export interface CompositionEventPlanningResult {
  readonly problems: readonly CompositionEventProblem[]
  readonly events: readonly CompositionEventPlan[]
}

function eventProblem(
  code: EventProblemCode,
  path: string,
  message: string,
): CompositionEventProblem {
  return { code, path, message }
}

function payloadReason(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? 'payload' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ')
}

/**
 * Plan one capability's state-derived events after its feature mode and fields
 * are known. A native replacement never becomes a second event authority.
 */
export function planCompositionEvents(
  def: CapabilityDefinition,
  feature: CompositionEventFeatureInput,
  fields: readonly CompositionEventFieldInput[],
): CompositionEventPlanningResult {
  if (feature.mode === 'replace') return { problems: [], events: [] }

  const problems: CompositionEventProblem[] = []
  const events: CompositionEventPlan[] = []
  for (const [eventName, declaration] of Object.entries(def.events ?? {})) {
    const fromState = declaration.fromState
    if (fromState === undefined) continue

    const statePath = `features[${feature.featureIndex}].fields.${fromState.field}`
    const state = def.runtimeState ? describeStateField(def.runtimeState, fromState.field) : null
    if (state === null) {
      problems.push(
        eventProblem(
          'unknown-field',
          statePath,
          `\`${def.name}.${eventName}\` derives from missing state field \`${fromState.field}\``,
        ),
      )
      continue
    }
    if (state.kind !== 'number') {
      problems.push(
        eventProblem(
          'kind-mismatch',
          statePath,
          `\`${def.name}.${eventName}\` needs a numeric state field; \`${fromState.field}\` is ${state.kind}`,
        ),
      )
      continue
    }

    const eventKey = `${def.name}.${eventName}`
    const category = EVENT_CATEGORIES[eventKey]
    if (category === undefined) {
      problems.push(
        eventProblem(
          'not-composable',
          `features[${feature.featureIndex}].cap`,
          `\`${eventKey}\` has no explicit composition event-category mapping`,
        ),
      )
      continue
    }

    const payload = declaration.data.safeParse({ deviceId: 1, timestamp: 1 })
    if (!payload.success) {
      problems.push(
        eventProblem(
          'not-composable',
          `features[${feature.featureIndex}].cap`,
          `\`${eventKey}\` cannot be derived from { deviceId, timestamp }: ${payloadReason(payload.error)}`,
        ),
      )
      continue
    }

    const field = fields.find(
      (candidate) =>
        candidate.featureIndex === feature.featureIndex &&
        candidate.cap === def.name &&
        candidate.path === fromState.field &&
        candidate.item === undefined,
    )
    if (field === undefined) {
      problems.push(
        eventProblem(
          'unknown-field',
          statePath,
          `\`${eventKey}\` derives from \`${fromState.field}\`, but that field is not composed`,
        ),
      )
      continue
    }

    events.push({
      featureIndex: feature.featureIndex,
      cap: def.name,
      eventName,
      category,
      stateField: fromState.field,
      fieldKey: `${field.cap}.${field.path}`,
    })
  }
  return { problems, events }
}
