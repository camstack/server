/**
 * The ONE reader of a system-event rule's delivery (D1019). A rule speaks at up
 * to three moments — when a condition STARTS (activation), when it CLEARS
 * (deactivation), and on a SCHEDULE (a state summary) — and every consumer
 * (the engine, the scheduler, the validator, both editors) asks this module,
 * never the stored `mode` tag.
 *
 * Three stored shapes answer it: `modes` (the editors' shape), and the two
 * that came before it — absent / `instant` (D906: both edges, no summary) and
 * `summary` (no instant message, a summary on `schedule`). Pure.
 */
import type {
  NcSchedule,
  NcStateSummarySplit,
  NcSystemEventDelivery,
} from '../capabilities/notification-rules.cap.js'

export interface NcSystemEventScheduledSummary {
  readonly schedule: NcSchedule
  readonly grouping: NcStateSummarySplit
}

export interface NcSystemEventDeliveryModes {
  readonly activation: boolean
  readonly deactivation: boolean
  /** The summary, or `null` when the rule sends none. */
  readonly schedule: NcSystemEventScheduledSummary | null
}

export function systemEventDeliveryModesOf(rule: {
  readonly systemEventDelivery?: NcSystemEventDelivery
}): NcSystemEventDeliveryModes {
  const delivery = rule.systemEventDelivery
  if (delivery === undefined || delivery.mode === 'instant') {
    return { activation: true, deactivation: true, schedule: null }
  }
  if (delivery.mode === 'summary') {
    return {
      activation: false,
      deactivation: false,
      schedule: { schedule: delivery.schedule, grouping: delivery.split ?? 'rule' },
    }
  }
  return {
    activation: delivery.onActivation,
    deactivation: delivery.onDeactivation,
    schedule: delivery.onSchedule ?? null,
  }
}
