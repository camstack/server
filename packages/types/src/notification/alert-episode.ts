/**
 * An alert EPISODE as a notification subject.
 *
 * The alert centre sends nothing of its own. A critical or error alert reaches
 * the operator through Notification Center system-event rules, and this file is
 * the one vocabulary the two sides share: the alert centre mints the episode
 * identity and announces its two edges on the bus (`alert.episode`), and
 * Notification Center derives the same identity when it RECONCILES from the
 * alerts store, because a bus event may be dropped (D8, D11).
 *
 * ## Episode identity
 *
 * `metadata.episodeId`, minted by the alert centre when an alert opens (new, or
 * re-opened after it was completed/dismissed, or its emitter changed
 * `metadata.episodeKey`) and kept through every re-emit while it stays open. An
 * alert row written before the alert centre minted ids has none: its episode is
 * `<id>@<createdAt>`, derived here so both sides agree.
 */
import { z } from 'zod'
import {
  AlertSeveritySchema,
  type Alert,
  type AlertSeverity,
  type AlertStatus,
} from '../capabilities/alerts.cap.js'
import type { NcSystemEventKind } from '../capabilities/notification-rules.cap.js'

export type AlertEpisodePhase = 'raised' | 'resolved'

/** The bus payload of `EventCategory.AlertEpisode`. */
export const AlertEpisodePayloadSchema = z.object({
  phase: z.enum(['raised', 'resolved']),
  episodeId: z.string().min(1),
  alertId: z.string().min(1),
  severity: AlertSeveritySchema,
  category: z.string(),
  title: z.string(),
  message: z.string(),
  sourceType: z.string().optional(),
  sourceId: z.string().optional(),
  nodeId: z.string().optional(),
  /** The alert's own action link (where the operator acts on it), when it has one. */
  actionUrl: z.string().optional(),
  at: z.number(),
})

export type AlertEpisodePayload = z.infer<typeof AlertEpisodePayloadSchema>

/** The payload of an `alert.episode` event's `data`, or `null` when it is not one. */
export function parseAlertEpisodePayload(data: unknown): AlertEpisodePayload | null {
  const parsed = AlertEpisodePayloadSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** An episode is closed once its alert is completed or dismissed. */
export function isAlertEpisodeOpen(status: AlertStatus): boolean {
  return status !== 'completed' && status !== 'dismissed'
}

/** Only these severities are ever announced. */
export function isAlertEpisodeSeverity(severity: AlertSeverity): boolean {
  return severity === 'critical' || severity === 'error'
}

export function alertEpisodeId(alert: Pick<Alert, 'id' | 'createdAt' | 'metadata'>): string {
  const minted = alert.metadata?.['episodeId']
  return typeof minted === 'string' && minted.length > 0
    ? minted
    : `${alert.id}@${String(alert.createdAt)}`
}

/** The node an alert is about, from the places emitters put it. */
export function alertNodeId(alert: Pick<Alert, 'source' | 'metadata'>): string | undefined {
  const direct = alert.metadata?.['nodeId']
  if (typeof direct === 'string') return direct
  const runner = alert.metadata?.['runner']
  if (typeof runner === 'object' && runner !== null && 'nodeId' in runner) {
    const id = runner.nodeId
    if (typeof id === 'string') return id
  }
  return alert.source?.type === 'node' ? alert.source.id : undefined
}

/**
 * The system-event kind of an episode edge, or `null` when none is announced
 * (an `error` episode announces its opening only).
 */
export function alertEpisodeKind(
  severity: AlertSeverity,
  phase: AlertEpisodePhase,
): NcSystemEventKind | null {
  if (severity === 'critical') {
    return phase === 'raised' ? 'alert-critical' : 'alert-critical-resolved'
  }
  if (severity === 'error' && phase === 'raised') return 'alert-error'
  return null
}

/**
 * The kind of a CRITICAL episode edge about a DEVICE (D911): the alert's source
 * is `device`, so it is announced in the devices family as
 * `device-attention-required` / `-resolved` INSTEAD of `alert-critical`. One
 * alert notifies once, through one family. `null` for any other severity.
 */
export function deviceAttentionKind(
  severity: AlertSeverity,
  phase: AlertEpisodePhase,
): NcSystemEventKind | null {
  if (severity !== 'critical') return null
  return phase === 'raised' ? 'device-attention-required' : 'device-attention-resolved'
}

export function alertEpisodePayload(
  alert: Alert,
  phase: AlertEpisodePhase,
  at: number,
): AlertEpisodePayload {
  const nodeId = alertNodeId(alert)
  return {
    phase,
    episodeId: alertEpisodeId(alert),
    alertId: alert.id,
    severity: alert.severity,
    category: alert.category,
    title: alert.title,
    message: alert.message,
    ...(alert.source !== undefined
      ? { sourceType: alert.source.type, sourceId: alert.source.id }
      : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(alert.action?.href !== undefined ? { actionUrl: alert.action.href } : {}),
    at,
  }
}
