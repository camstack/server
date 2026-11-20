import type { Alert } from '../capabilities/alerts.cap.js'
import type { DeviceFault, ErrorStatus } from '../capabilities/error.cap.js'

/**
 * The attention episode of a device fault.
 *
 * A fault that STARTS raises one alert whose source is the device; the
 * notification center announces a device-sourced critical alert as
 * `device-attention-required`, and its completion as `device-attention-resolved`
 * (D911). No default rule listens: it notifies only when the operator makes one.
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
    category: 'device.error',
    severity: 'critical',
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
