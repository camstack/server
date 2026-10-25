/**
 * Extracted from NotificationCenter (consumeEventAndReport, onChain, scheduleEvaluation, deliverUnlessSuperseded).
 * The class method forwards private state through {@link EvaluationCycleHost}.
 */

import { NcDispatcher } from './dispatcher.js'
import type { NcIncomingEvent, NcIntakeReport } from './event-intake.js'
import { deliveryForKind } from './event-intake.js'
import type { NcDeliverResult, NcOutboxEntry } from './outbox.js'
import { NcUpdateLandings } from './restart-supersede.js'
import type { IScopedLogger } from '@camstack/types'

export interface EvaluationCycleHost {
  readonly dispatcher: NcDispatcher
  evalChain: Promise<void>
  evaluateAndEnqueue(event: NcIncomingEvent): Promise<NcIntakeReport>
  readonly evaluationActive: boolean
  readonly logger: IScopedLogger
  readonly updateLandings: NcUpdateLandings
}

/**
 * The same consumption, awaited, with the verdict returned. Identical code
 * path — {@link consumeEvent} is this function with the report discarded — so
 * a producer that reads the report is testing what the live producers do, not
 * a parallel implementation of it.
 */
export async function consumeEventAndReport(
  host: EvaluationCycleHost,
  event: NcIncomingEvent,
): Promise<NcIntakeReport> {
  if (!host.evaluationActive) {
    return {
      recordId: event.subject.recordId,
      kind: event.kind,
      delivery: deliveryForKind(event.kind),
      origin: event.origin,
      candidates: 0,
      outcomes: [],
      droppedBy: 'evaluation-inactive',
    }
  }
  // Ride the SAME serialized chain: a report that jumped the queue would see
  // a cooldown state the live path had not reached yet.
  const result = host.evalChain.then(() => host.evaluateAndEnqueue(event))
  host.evalChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}
/**
 * Append one piece of grouped work (D692) to the serialized chain, with the same
 * catch-and-WARN shape as {@link scheduleEvaluation}. Returns the step's own promise.
 */
export function onChain(
  host: EvaluationCycleHost,
  name: string,
  run: () => Promise<void>,
  deviceId: number,
): Promise<void> {
  const step = host.evalChain.then(async () => {
    try {
      await run()
    } catch (err) {
      host.logger.warn('grouped notification step failed', {
        tags: { deviceId },
        meta: { step: name, error: String(err) },
      })
    }
  })
  host.evalChain = step
  return step
}
/** Append one evaluation to the serialized chain (see {@link evalChain}). */
export function scheduleEvaluation(host: EvaluationCycleHost, event: NcIncomingEvent): void {
  host.evalChain = host.evalChain.then(async () => {
    try {
      await host.evaluateAndEnqueue(event)
    } catch (err) {
      const ctx = event.log()
      host.logger.warn('rule evaluation failed', {
        tags: ctx.tags,
        meta: { ...ctx.meta, kind: event.kind, origin: event.origin, error: String(err) },
      })
    }
  })
}
/**
 * The outbox's executor: the dispatcher, unless the row is a `node-updating`
 * whose update has already LANDED (D723, `restart-supersede.ts`). Such a row
 * drained after the hub's own reboot and would read "about to update" next to
 * "updated". Dropped benignly (the row ends `sent`, like a snooze), and said.
 */
export function deliverUnlessSuperseded(
  host: EvaluationCycleHost,
  entry: NcOutboxEntry,
): Promise<NcDeliverResult> {
  const superseded = host.updateLandings.supersedes(entry)
  if (superseded === null) return host.dispatcher.deliver(entry)
  host.logger.info('node-updating not sent — the update already landed', {
    tags: { deviceId: entry.deviceId },
    meta: {
      nodeId: superseded.nodeId,
      toVersion: superseded.toVersion,
      landedAt: superseded.landedAt,
      ruleId: entry.ruleId,
      targetId: entry.targetId,
      outboxId: entry.id,
      createdAt: entry.createdAt,
    },
  })
  return Promise.resolve({ ok: true })
}
