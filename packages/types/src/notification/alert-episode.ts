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
  AlertActionSchema,
  AlertSeveritySchema,
  type Alert,
  type AlertSeverity,
  type AlertStatus,
} from '../capabilities/alerts.cap.js'
import {
  DeviceFaultSchema,
  type DeviceErrorSeverity,
  type DeviceFault,
} from '../capabilities/error.cap.js'
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
  /**
   * The alert's WHOLE action — label, link, navigation and `invoke` — on a
   * raised episode, so a notification can offer it (an absolute open-URL
   * button, a token-authed invoke button). `actionUrl` stays for the
   * `{{actionUrl}}` template variable. Additive: an episode published before
   * this field has none.
   */
  action: AlertActionSchema.optional(),
  /** A device fault episode: every active fault (`metadata.faults`), principal first. */
  faults: z.array(DeviceFaultSchema).optional(),
  at: z.number(),
})

export type AlertEpisodePayload = z.infer<typeof AlertEpisodePayloadSchema>
/** The alert's own action, as an episode carries it. */
export type AlertEpisodeAction = NonNullable<AlertEpisodePayload['action']>

/** The payload of an `alert.episode` event's `data`, or `null` when it is not one. */
export function parseAlertEpisodePayload(data: unknown): AlertEpisodePayload | null {
  const parsed = AlertEpisodePayloadSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** An episode is closed once its alert is completed or dismissed. */
export function isAlertEpisodeOpen(status: AlertStatus): boolean {
  return status !== 'completed' && status !== 'dismissed'
}

/** The severities every alert announces, whatever it is about. */
export function isAlertEpisodeSeverity(severity: AlertSeverity): boolean {
  return severity === 'critical' || severity === 'error'
}

/** The category of the alert a device's `error` cap opens for its fault. */
export const DEVICE_ERROR_ALERT_CATEGORY = 'device.error'

/** What decides whether an alert's episode is announced. */
export type AnnouncedAlertFacts = Pick<Alert, 'severity' | 'category'>

/**
 * How loud an episode is, `0` when it is not announced at all. A device FAULT
 * is announced at every tier, its warning included: who is told about a fault
 * is the operator's choice (a rule's severity filter, a notifier's minimum
 * priority), never the system's. Any other alert is announced from `error` up.
 */
export function alertEpisodeRank(alert: AnnouncedAlertFacts): number {
  if (alert.severity === 'critical') return 3
  if (alert.severity === 'error') return 2
  return alert.severity === 'warning' && alert.category === DEVICE_ERROR_ALERT_CATEGORY ? 1 : 0
}

/** Is an episode of this alert announced on the bus and reconciled from the store? */
export function isAnnouncedAlertEpisode(alert: AnnouncedAlertFacts): boolean {
  return alertEpisodeRank(alert) > 0
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
 * The tier a DEVICE episode is announced at, or `null` when it is not a
 * device-attention episode: a critical alert is an `error`, and a device fault
 * at its warning tier is a `warning`. A rule narrows on it (`faultSeverities`)
 * and a delivery takes its priority from it.
 */
export function deviceAttentionSeverity(alert: AnnouncedAlertFacts): DeviceErrorSeverity | null {
  if (alert.severity === 'critical') return 'error'
  return alertEpisodeRank(alert) === 1 ? 'warning' : null
}

/**
 * The kind of an episode edge about a DEVICE (D911): the alert's source is
 * `device`, so it is announced in the devices family as
 * `device-attention-required` / `-resolved` INSTEAD of `alert-critical`. One
 * alert notifies once, through one family. `null` when the alert has no
 * device-attention tier ({@link deviceAttentionSeverity}).
 */
export function deviceAttentionKind(
  alert: AnnouncedAlertFacts,
  phase: AlertEpisodePhase,
): NcSystemEventKind | null {
  if (deviceAttentionSeverity(alert) === null) return null
  return phase === 'raised' ? 'device-attention-required' : 'device-attention-resolved'
}

/**
 * The system-event kind one edge is sent as: the device-attention pair for a
 * device source that has a tier, the generic alert kinds for everything else.
 * `null` when the edge has nothing to send.
 */
export function alertEpisodeEdgeKind(
  payload: Pick<AlertEpisodePayload, 'severity' | 'category' | 'sourceType' | 'phase'>,
): NcSystemEventKind | null {
  const attention =
    payload.sourceType === 'device' ? deviceAttentionKind(payload, payload.phase) : null
  return attention ?? alertEpisodeKind(payload.severity, payload.phase)
}

/** The faults a device-error alert carries in its metadata; none when absent or malformed. */
function alertFaults(alert: Pick<Alert, 'metadata'>): DeviceFault[] | undefined {
  const parsed = z.array(DeviceFaultSchema).safeParse(alert.metadata?.['faults'])
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined
}

export function alertEpisodePayload(
  alert: Alert,
  phase: AlertEpisodePhase,
  at: number,
): AlertEpisodePayload {
  const nodeId = alertNodeId(alert)
  const faults = alertFaults(alert)
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
    // A resolved episode has nothing left to act on.
    ...(phase === 'raised' && alert.action !== undefined ? { action: alert.action } : {}),
    ...(faults !== undefined ? { faults } : {}),
    at,
  }
}
