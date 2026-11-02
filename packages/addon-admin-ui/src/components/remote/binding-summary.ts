/**
 * What a remote binding does, as data the editor's rows and side panel print:
 * the target a person recognises (`device · board`), the `cap.method` it calls
 * and, for an infrared train, how many timings it carries. Pure: no hook, no
 * translation — the caller words it.
 */
import type { RemoteBindingAction } from '@camstack/types'
import type { AutomationDevice } from '../../pages/build/automation/automation-data'

export interface BindingSummary {
  /** `cap.method`, e.g. `ir-transmitter.send`. */
  readonly call: string
  /** Pulses of an infrared train, or null when the action carries none. */
  readonly timings: number | null
  /** The carrier of an infrared train, in Hz, when stated. */
  readonly carrierHz: number | null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function summarizeBinding(action: RemoteBindingAction): BindingSummary {
  const args = action.args ?? {}
  const timings = args['timings']
  const settings = args['settings']
  const carrier =
    typeof settings === 'object' && settings !== null && 'carrierHz' in settings
      ? numberOrNull(settings.carrierHz)
      : null
  return {
    call: `${action.cap}.${action.method}`,
    timings: Array.isArray(timings) ? timings.length : null,
    carrierHz: carrier,
  }
}

/** `device name · parent board name`: a board's raw service name alone says nothing. */
export function targetLabel(
  deviceId: number,
  devices: readonly AutomationDevice[],
  fallback: string,
): string {
  const device = devices.find((d) => d.id === deviceId)
  return device === undefined ? fallback : deviceLabel(device)
}

export function deviceLabel(device: AutomationDevice): string {
  return device.parentName ? `${device.name} · ${device.parentName}` : device.name
}
