/**
 * What a remote binding does, as data the editor's rows and side panel print:
 * the target a person recognises (`device · board`), the `cap.method` it calls
 * and, for an infrared train, how many timings it carries. Pure: no hook, no
 * translation — the caller words it.
 */
import type { RemoteBindingAction } from '@camstack/types'
import type { AutomationDevice } from '../../pages/build/automation/automation-data'
import { IR_CAP, IR_SEND, isCompleteAction } from './remote-config-model'

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

export interface DescribedArg {
  readonly name: string
  readonly value: string
}

/**
 * What a button does, in the terms a person recognises. `unbound` is no
 * binding at all, `incomplete` one still missing its device, cap or method.
 * An infrared send is told apart from any other cap call only by the cap and
 * method it names; everything shown is read off the binding itself.
 */
export type BindingDescription =
  | { readonly kind: 'unbound' }
  | { readonly kind: 'incomplete' }
  | {
      readonly kind: 'infrared'
      readonly target: string
      readonly pulses: number | null
      readonly carrierKhz: number | null
      readonly args: readonly DescribedArg[]
    }
  | {
      readonly kind: 'call'
      readonly target: string
      readonly call: string
      readonly args: readonly DescribedArg[]
    }

/** Scalar arguments only: a list or object has no one-word reading. */
function scalarArgs(args: Readonly<Record<string, unknown>>): readonly DescribedArg[] {
  return Object.entries(args).flatMap(([name, value]): DescribedArg[] =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? [{ name, value: String(value) }]
      : [],
  )
}

export function describeBinding(
  action: RemoteBindingAction | undefined,
  devices: readonly AutomationDevice[],
): BindingDescription {
  if (action === undefined) return { kind: 'unbound' }
  if (!isCompleteAction(action)) return { kind: 'incomplete' }
  const target = targetLabel(action.deviceId, devices, `#${action.deviceId}`)
  const summary = summarizeBinding(action)
  const args = scalarArgs(action.args ?? {})
  if (action.cap === IR_CAP && action.method === IR_SEND) {
    return {
      kind: 'infrared',
      target,
      pulses: summary.timings,
      carrierKhz: summary.carrierHz === null ? null : Math.round(summary.carrierHz / 1000),
      args,
    }
  }
  return { kind: 'call', target, call: summary.call, args }
}

/**
 * The code behind a button, as the panel shows it the moment the button is
 * selected: an infrared train in signed microseconds (what the transmitter is
 * handed, copyable as is), or the capability call any other binding makes.
 */
export type BindingCode =
  | {
      readonly kind: 'infrared'
      readonly timings: readonly number[]
      readonly pulses: number
      readonly carrierKhz: number | null
      /** The timings joined by `, `. */
      readonly text: string
    }
  | { readonly kind: 'call'; readonly text: string }

function isTimings(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'number')
}

export function bindingCode(action: RemoteBindingAction): BindingCode | null {
  if (!isCompleteAction(action)) return null
  const args = action.args ?? {}
  if (action.cap === IR_CAP && action.method === IR_SEND && isTimings(args['timings'])) {
    const timings = args['timings']
    const carrierHz = summarizeBinding(action).carrierHz
    return {
      kind: 'infrared',
      timings,
      pulses: timings.length,
      carrierKhz: carrierHz === null ? null : carrierHz / 1000,
      text: timings.join(', '),
    }
  }
  const spelledArgs = Object.keys(args).length === 0 ? '' : JSON.stringify(args)
  return { kind: 'call', text: `${action.cap}.${action.method}(${spelledArgs})` }
}
