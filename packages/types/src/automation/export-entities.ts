/**
 * What a device exporter (HomeKit, Alexa, Home Assistant) does with the
 * non-device entities it may expose (D967): run an action, send through a
 * notification target, drop what was deleted.
 *
 * One implementation, so the three exporters refuse and log the same way:
 *  - running goes through `actions.run` and RESPECTS its refusal — an action
 *    that is already running or in cooldown is logged with a named reason and
 *    never queued or retried (D391);
 *  - an exported action or target that no longer exists is dropped from the
 *    export, and the drop is logged.
 *
 * Actions are list entries, not devices (D954): the log tag is `actionId`,
 * never `deviceId`.
 */
import type { IScopedLogger } from '../interfaces/logging.js'
import type { ActionRunResult } from './action.js'
import type { ExportEntityRef } from '../capabilities/device-export.cap.js'
import {
  NotificationSchema,
  type SendResult,
  type Target,
} from '../capabilities/notification-output.cap.js'
import type { z } from 'zod'

/** What an exporter needs to know about an action to offer it. */
export interface ExportableAction {
  readonly id: string
  readonly name: string
}

/** The slice of `ctx.api` the exporters use for non-device entities. */
export interface ExportEntityApi {
  readonly actions: {
    readonly list: { query(input?: Record<string, never>): Promise<readonly ExportableAction[]> }
    readonly run: {
      mutate(input: { readonly actionId: string }): Promise<ActionRunResult>
    }
  }
  readonly notificationOutput: {
    readonly listTargets: { query(input?: Record<string, never>): Promise<readonly Target[]> }
    readonly send: {
      mutate(input: {
        readonly targetId: string
        readonly addonId: string
        readonly notification: z.output<typeof NotificationSchema>
      }): Promise<SendResult>
    }
  }
}

export type ExportActionRefusalReason = 'already-running' | 'cooldown' | 'not-found'

export type ExportedActionRun =
  | { readonly status: 'started' }
  | { readonly status: 'refused'; readonly reason: ExportActionRefusalReason }
  | { readonly status: 'failed'; readonly message: string }

export interface RunExportedActionInput {
  /** The exporter's own name, for the log line (`hap`, `alexa`, `ha`). */
  readonly exporter: string
  readonly actionId: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `actions.run` flattens a refusal to `[code] text`; the code leads. */
function refusalFromThrown(message: string): ExportActionRefusalReason | null {
  if (message.startsWith('[busy]')) return 'already-running'
  if (message.startsWith('[not-found]')) return 'not-found'
  return null
}

export async function runExportedAction(
  api: ExportEntityApi,
  log: IScopedLogger,
  input: RunExportedActionInput,
): Promise<ExportedActionRun> {
  const { exporter, actionId } = input
  const tags = { actionId }
  const refuse = (reason: ExportActionRefusalReason, detail?: string): ExportedActionRun => {
    log.warn(`${exporter}: exported action not run — ${reason}`, {
      tags,
      meta: { reason, ...(detail ? { detail } : {}) },
    })
    return { status: 'refused', reason }
  }
  try {
    const result = await api.actions.run.mutate({ actionId })
    if (result.outcome === 'skipped-overlap') return refuse('already-running', result.message)
    if (result.outcome === 'skipped-cooldown') return refuse('cooldown', result.message)
    if (result.outcome === 'failed' || result.outcome === 'aborted') {
      const message = result.message ?? result.outcome
      log.warn(`${exporter}: exported action failed`, {
        tags,
        meta: { outcome: result.outcome, message },
      })
      return { status: 'failed', message }
    }
    log.info(`${exporter}: exported action ran`, { tags, meta: { outcome: result.outcome } })
    return { status: 'started' }
  } catch (err) {
    const message = errorText(err)
    const reason = refusalFromThrown(message)
    if (reason !== null) return refuse(reason, message)
    log.warn(`${exporter}: exported action failed`, { tags, meta: { message } })
    return { status: 'failed', message }
  }
}

export type ExportTargetRefusalReason = 'target-gone' | 'target-disabled'

export type ExportedTargetSend =
  | { readonly status: 'sent' }
  | { readonly status: 'refused'; readonly reason: ExportTargetRefusalReason }
  | { readonly status: 'failed'; readonly message: string }

export interface SendToExportedTargetInput {
  readonly exporter: string
  readonly targetId: string
  readonly notification: z.input<typeof NotificationSchema>
}

/** Send through one CamStack notification target on behalf of an exporter. */
export async function sendToExportedTarget(
  api: ExportEntityApi,
  log: IScopedLogger,
  input: SendToExportedTargetInput,
): Promise<ExportedTargetSend> {
  const { exporter, targetId } = input
  const tags = { targetId }
  try {
    const targets = await api.notificationOutput.listTargets.query({})
    const target = targets.find((t) => t.id === targetId)
    if (target === undefined) {
      log.warn(`${exporter}: exported notifier not used — target-gone`, {
        tags,
        meta: { reason: 'target-gone' },
      })
      return { status: 'refused', reason: 'target-gone' }
    }
    if (!target.enabled) {
      log.warn(`${exporter}: exported notifier not used — target-disabled`, {
        tags,
        meta: { reason: 'target-disabled' },
      })
      return { status: 'refused', reason: 'target-disabled' }
    }
    const result = await api.notificationOutput.send.mutate({
      targetId,
      addonId: target.addonId,
      notification: NotificationSchema.parse(input.notification),
    })
    if (!result.success) {
      const message = result.error ?? 'send failed'
      log.warn(`${exporter}: exported notifier send failed`, { tags, meta: { message } })
      return { status: 'failed', message }
    }
    return { status: 'sent' }
  } catch (err) {
    const message = errorText(err)
    log.warn(`${exporter}: exported notifier send failed`, { tags, meta: { message } })
    return { status: 'failed', message }
  }
}

export interface LiveEntityIds {
  readonly actionIds: ReadonlySet<string>
  readonly targetIds: ReadonlySet<string>
}

export interface PrunedEntities {
  readonly kept: readonly ExportEntityRef[]
  readonly dropped: readonly ExportEntityRef[]
}

/**
 * Split an exporter's selection into what still exists and what was deleted.
 * Devices are never judged here (their lifecycle is the tombstone, D865).
 * Callers pass ids from a query that ANSWERED — an unanswered list must not
 * reach this function (D49: a failed read changes nothing).
 */
export function pruneDeletedEntities(
  selection: readonly ExportEntityRef[],
  live: LiveEntityIds,
  log: IScopedLogger,
  exporter: string,
): PrunedEntities {
  const kept: ExportEntityRef[] = []
  const dropped: ExportEntityRef[] = []
  for (const ref of selection) {
    if (ref.kind === 'action' && !live.actionIds.has(ref.actionId)) {
      dropped.push(ref)
      log.warn(`${exporter}: exported action was deleted — dropped from the export`, {
        tags: { actionId: ref.actionId },
      })
    } else if (ref.kind === 'notifier' && !live.targetIds.has(ref.targetId)) {
      dropped.push(ref)
      log.warn(`${exporter}: exported notifier target was deleted — dropped from the export`, {
        tags: { targetId: ref.targetId },
      })
    } else {
      kept.push(ref)
    }
  }
  return { kept, dropped }
}
