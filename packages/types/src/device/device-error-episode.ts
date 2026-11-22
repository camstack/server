import type { Alert, AlertSeverity } from '../capabilities/alerts.cap.js'
import type { DeviceErrorSeverity, DeviceFault, ErrorStatus } from '../capabilities/error.cap.js'
import { DEVICE_ERROR_ALERT_CATEGORY } from '../notification/alert-episode.js'

/**
 * The attention episode of a device fault.
 *
 * A fault that STARTS raises one alert whose source is the device, at the
 * severity of the fault's own tier (`deviceErrorAlertSeverity`). The
 * notification center announces it as `device-attention-required`, and its
 * completion as `device-attention-resolved` (D911), at EVERY tier: the event
 * carries the tier, and a rule's `faultSeverities` or a notifier's minimum
 * priority decides who hears a warning. No default rule listens: it notifies
 * only when the operator makes one.
 */
export type DeviceErrorEdge = 'start' | 'resolve'

/**
 * The edge between two readings, or `null` for no edge.
 *
 * - `null`/cold → `true` is a START (a fault already open at boot is one);
 * - `true` → `false` is a RESOLVE;
 * - an UNKNOWN reading (`active: null`) is never an edge, in either direction —
 *   a failed read must neither raise nor close an episode (D393, D49);
 * - `true` → `true` is the same episode, whatever the code did.
 */
export function deviceErrorEdge(
  previous: Pick<ErrorStatus, 'active'> | null | undefined,
  next: Pick<ErrorStatus, 'active'>,
): DeviceErrorEdge | null {
  if (next.active === true && previous?.active !== true) return 'start'
  if (next.active === false && previous?.active === true) return 'resolve'
  return null
}

/**
 * The alert severity of a fault tier. `error` is the cap's top tier and asks
 * for attention (`critical`); `warning` stays a warning.
 */
export function deviceErrorAlertSeverity(severity: DeviceErrorSeverity): AlertSeverity {
  return severity === 'error' ? 'critical' : 'warning'
}

/** How many times one alert write (an open, or a close) is tried before it is given up. */
export const DEVICE_ERROR_ALERT_MAX_ATTEMPTS = 5

export type DeviceErrorAlertWrite = 'open' | 'close'

/**
 * What a device knows, in this process, about its own alert. `neverOpened` is
 * true from a fault's start until the alerts cap ACCEPTS the open; it is false
 * for a fault restored from before a restart, whose alert is assumed open.
 * `pending` is a write that failed and is tried again on the next reading that
 * still asks for it.
 */
export interface DeviceErrorAlertDelivery {
  readonly neverOpened: boolean
  readonly pending: DeviceErrorAlertWrite | null
  readonly attempts: number
}

export const DEVICE_ERROR_ALERT_IDLE: DeviceErrorAlertDelivery = {
  neverOpened: false,
  pending: null,
  attempts: 0,
}

export interface DeviceErrorAlertPlan {
  readonly write: DeviceErrorAlertWrite | null
  /** The delivery state to hold while the write runs (attempts reset on a new ask). */
  readonly delivery: DeviceErrorAlertDelivery
}

type ErrorTier = Pick<ErrorStatus, 'active' | 'severity'>

/**
 * The alert write a reading asks for.
 *
 * - a START opens; a `warning` fault that becomes an `error` opens again (same
 *   alert id and episode, now critical). An error that eases to a warning
 *   writes nothing: its critical alert stays until the fault resolves;
 * - a RESOLVE closes, except an alert this process knows was never accepted —
 *   that one has nothing to close, and its failed open is dropped;
 * - with no edge, a failed write is tried again while the reading still asks
 *   for it. An unknown reading asks for nothing (D49).
 */
export function planDeviceErrorAlert(
  delivery: DeviceErrorAlertDelivery,
  edge: DeviceErrorEdge | null,
  previous: ErrorTier | null | undefined,
  next: ErrorTier,
): DeviceErrorAlertPlan {
  if (edge === 'start') {
    return { write: 'open', delivery: { neverOpened: true, pending: 'open', attempts: 0 } }
  }
  if (edge === 'resolve') {
    if (delivery.neverOpened) return { write: null, delivery: DEVICE_ERROR_ALERT_IDLE }
    return { write: 'close', delivery: { neverOpened: false, pending: 'close', attempts: 0 } }
  }
  if (next.active === true) {
    const escalates =
      previous?.active === true && previous.severity === 'warning' && next.severity === 'error'
    if (escalates) return { write: 'open', delivery: { ...delivery, pending: 'open', attempts: 0 } }
    if (delivery.pending === 'open') return { write: 'open', delivery }
  }
  if (next.active === false && delivery.pending === 'close') return { write: 'close', delivery }
  return { write: null, delivery }
}

export function deviceErrorAlertId(deviceId: number): string {
  return `device-error:${String(deviceId)}`
}

/** Every active fault, the principal first; a status that lists none still names its principal. */
function activeFaults(status: ErrorStatus): DeviceFault[] {
  if (status.faults !== undefined && status.faults.length > 0) {
    return status.faults.map(({ code, label, severity }) => ({ code, label, severity }))
  }
  if (status.code === null) return []
  return [{ code: status.code, label: status.label ?? status.code, severity: status.severity }]
}

/** The alert that opens an episode. `since` is the fault's own start, else `now`. */
export function buildDeviceErrorAlert(
  deviceId: number,
  deviceName: string,
  status: ErrorStatus,
  now: number,
): Alert {
  const label = status.label ?? status.code ?? 'Fault'
  const startedAt = status.since ?? now
  const alertId = deviceErrorAlertId(deviceId)
  return {
    id: alertId,
    category: DEVICE_ERROR_ALERT_CATEGORY,
    severity: deviceErrorAlertSeverity(status.severity),
    title: `${deviceName}: ${label}`,
    message: `${deviceName} reports a fault: ${label}.`,
    action: { label: 'Open device', href: `/devices/${String(deviceId)}`, navigation: 'app' },
    status: 'active',
    read: false,
    createdAt: now,
    updatedAt: now,
    source: { type: 'device', id: String(deviceId) },
    metadata: {
      episodeId: `${alertId}@${String(startedAt)}`,
      code: status.code,
      deviceSeverity: status.severity,
      label: status.label,
      faults: activeFaults(status),
    },
  }
}
