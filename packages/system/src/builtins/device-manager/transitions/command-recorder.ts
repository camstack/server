/**
 * The command recorder of the device audit (D1022, D1084).
 *
 * A command is what the kernel saw leave its caller. It is written as ONE row,
 * when the call completes: `ok` when it returned, `failed` when the caller saw it
 * throw. Nothing waits for the device to obey and nothing is matched to a slice
 * change: the change, when the device reports one, is read back from device-history
 * on the Interactions read, beside the command row.
 *
 * Pure and clock-injected; it reads memory only (D49): the mirror's current slice,
 * for the `from` value of a command that names an effect. What it produces is
 * handed to `emit`, whose queue is bounded.
 */
import {
  commandEffect,
  type DeviceCommandObservation,
  type DeviceTransition,
  type IScopedLogger,
  type TransitionValue,
} from '@camstack/types'
import { redactLogText } from '../../../logging/log-redactor.js'

/** Longest error text a row keeps. */
const ERROR_MAX_CHARS = 300
/** The field of a row whose command named none (a toggle, a press, a stop). */
export const NO_FIELD = '*'

export type CurrentSlice = (
  deviceId: number,
  capName: string,
) => Readonly<Record<string, unknown>> | undefined

export interface RecorderDeps {
  /** Optional: names the branch that writes nothing. */
  readonly logger?: IScopedLogger
  readonly emit: (transition: DeviceTransition) => void
  readonly currentSlice: CurrentSlice
  /** The command's arguments as a row stores them: redacted by the input schema's secret paths and capped. */
  readonly prepareArgs: (
    capName: string,
    method: string,
    args: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>
}

/** A status value in the shape a transition stores: unknown is `null` (D393), an array is wrapped. */
export function toTransitionValue(value: unknown): TransitionValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) return { items: value }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value))
  }
  return String(value)
}

export class CommandRecorder {
  private seq = 0

  constructor(private readonly deps: RecorderDeps) {}

  /**
   * A command left its caller. Where the seam can see the call settle (`obs.outcome`), the row is
   * written when it does; where it cannot (the UDS parent and in-process clients report only the
   * departure) the call is recorded as `ok` at once, since a throw there is not observable.
   */
  recordCommand(obs: DeviceCommandObservation): void {
    const effect = commandEffect(obs.capName, obs.method, obs.args)
    const field = effect?.field ?? NO_FIELD
    const from =
      effect === null
        ? null
        : toTransitionValue(this.deps.currentSlice(obs.deviceId, obs.capName)?.[effect.field])
    const to = effect === null ? null : toTransitionValue(effect.value)
    const write = (outcome: 'ok' | 'failed', error?: string): void => {
      this.seq += 1
      const commandId = `${obs.deviceId}:${obs.at}:c${this.seq}`
      this.deps.emit({
        id: commandId,
        deviceId: obs.deviceId,
        at: obs.at,
        capName: obs.capName,
        field,
        from,
        to,
        outcome,
        actor: obs.actor,
        command: {
          commandId,
          method: obs.method,
          args: this.deps.prepareArgs(obs.capName, obs.method, obs.args),
          requestedAt: obs.at,
          ...(error !== undefined ? { error: redactLogText(error).slice(0, ERROR_MAX_CHARS) } : {}),
        },
      })
    }
    if (obs.outcome === undefined) {
      write('ok')
      return
    }
    obs.outcome.then(
      () => write('ok'),
      (err: unknown) => write('failed', err instanceof Error ? err.message : String(err)),
    )
  }
}
