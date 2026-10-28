/**
 * The `stationary` trigger's per-event decision: does this parked-object change
 * start a run, and if not, WHY not.
 *
 * Source: `EventCategory.PipelineAnalyticsStationaryChanged` — payload
 * {@link PipelineAnalyticsStationaryChangedPayload} (`deviceId`, `entryId`,
 * `className`, `phase` appeared|departed, `zones`). The device is in the DATA.
 *
 * Stateless: the registry emits one event per transition, so there is no
 * once-per-subject set to keep (unlike `detection`, whose track emits many
 * updates). A change of the OTHER phase is not this trigger's business and is
 * ignored without a trace. Events are telemetry (D8): a dropped one delays or
 * misses a fire, and nothing durable depends on it.
 */

import type { PipelineAnalyticsStationaryChangedPayload } from '../interfaces/event-bus.js'
import { detectionClassMatches } from './detection-trigger.js'
import type { AutomationTrigger } from './recipe.js'

export type StationaryTrigger = Extract<AutomationTrigger, { kind: 'stationary' }>

/** The fields of a stationary-changed event the trigger reads (all `unknown`: off the bus). */
export interface StationaryChangedInput {
  readonly deviceId?: unknown
  readonly entryId?: unknown
  readonly className?: unknown
  readonly phase?: unknown
  readonly zones?: unknown
}

/** What a stationary run exposes to conditions and actions. */
export interface StationaryVars {
  readonly deviceId: number
  readonly className: string
  readonly zones: readonly string[]
  readonly phase: PipelineAnalyticsStationaryChangedPayload['phase']
  readonly entryId: string
}

export type StationaryDecision =
  | { readonly kind: 'ignore'; readonly why: string }
  | { readonly kind: 'reject'; readonly reason: string; readonly vars: StationaryVars }
  | { readonly kind: 'fire'; readonly reason: string; readonly vars: StationaryVars }

function isPhase(value: unknown): value is StationaryVars['phase'] {
  return value === 'appeared' || value === 'departed'
}

export function evaluateStationaryTrigger(
  trigger: StationaryTrigger,
  event: StationaryChangedInput,
): StationaryDecision {
  const { deviceId, entryId, phase } = event
  if (typeof deviceId !== 'number' || typeof entryId !== 'string' || !isPhase(phase)) {
    return { kind: 'ignore', why: 'malformed stationary-changed event' }
  }
  if (!trigger.deviceIds.includes(deviceId)) {
    return { kind: 'ignore', why: `device ${deviceId} is not one of the trigger's devices` }
  }
  if (phase !== trigger.phase) {
    return { kind: 'ignore', why: `phase ${phase}, the trigger wants ${trigger.phase}` }
  }
  const className = typeof event.className === 'string' ? event.className : ''
  const zones = Array.isArray(event.zones)
    ? event.zones.filter((z): z is string => typeof z === 'string')
    : []
  const vars: StationaryVars = { deviceId, className, zones, phase, entryId }

  if (
    trigger.classes !== undefined &&
    !trigger.classes.some((c) => detectionClassMatches(c, className))
  ) {
    return {
      kind: 'reject',
      reason: `class ${className || 'unknown'} not in [${trigger.classes.join(', ')}]`,
      vars,
    }
  }
  if (trigger.zones !== undefined && !trigger.zones.some((z) => zones.includes(z))) {
    return {
      kind: 'reject',
      reason: `zone mismatch: in [${zones.join(', ')}], wanted [${trigger.zones.join(', ')}]`,
      vars,
    }
  }
  return {
    kind: 'fire',
    reason: `${className} ${phase} on device ${deviceId}`,
    vars,
  }
}
