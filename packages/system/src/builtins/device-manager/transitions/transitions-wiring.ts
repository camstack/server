/**
 * Starts the hub's device command audit (D1022, D1084): command observations meet
 * the recorder, its rows ride a bounded queue to device-history. Everything here is
 * best-effort telemetry (D8): a failure costs rows, never a command or a mirror
 * write.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  expandCapMethods,
  isCommand,
  vocabActionIdFor,
  type DeviceCommandSettledEvent,
  type DeviceTransition,
} from '@dominevo/types'
import type { IScopedLogger } from '@dominevo/types'
import type { z } from 'zod'
import { getCommandObserverRegistry } from '../../../kernel/command-observation.js'
import type { DeviceStateMirror } from '../device-state-mirror.js'
import { createCommandArgsPreparer } from './command-args.js'
import { CommandRecorder } from './command-recorder.js'
import { TransitionSender } from './transitions-sender.js'

export const TRANSITIONS_FLUSH_INTERVAL_MS = 2_000

/** Runs `fn` every `ms` until the returned function is called. */
export type TransitionTicker = (fn: () => void, ms: number) => () => void

export interface DeviceTransitionsDeps {
  /** Read for the value a command's effect field held when it was given. */
  readonly mirror: DeviceStateMirror
  readonly logger: IScopedLogger
  readonly record: (transitions: readonly DeviceTransition[]) => Promise<void>
  /**
   * Told of each command that completed. Telemetry (D8): a throw is logged and costs the
   * notification, never the row.
   */
  readonly onCommandSettled?: (event: DeviceCommandSettledEvent) => void
  readonly ticker?: TransitionTicker
}

export interface DeviceTransitionsHandle {
  /** Unsubscribe, stop the timer, send what is queued. */
  stop(): Promise<void>
}

const realTicker: TransitionTicker = (fn, ms) => {
  const handle = setInterval(fn, ms)
  return () => clearInterval(handle)
}

function inputFor(capName: string, method: string): z.ZodType | undefined {
  const def = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === capName)
  return def === undefined ? undefined : expandCapMethods(def)[method]?.input
}

export function startDeviceTransitions(deps: DeviceTransitionsDeps): DeviceTransitionsHandle {
  const ticker = deps.ticker ?? realTicker
  const sender = new TransitionSender({
    send: (batch) => deps.record(batch),
    logger: deps.logger,
  })
  const announce = (row: DeviceTransition): void => {
    if (deps.onCommandSettled === undefined || row.command === undefined) return
    if (row.outcome === 'device') return
    // A command is named by its vocabulary action id only (D983); the arguments name no single
    // action: nothing is announced, and the row still records it.
    const action = vocabActionIdFor(row.capName, row.command.method, row.command.args)
    if (action === undefined) {
      deps.logger.debug(
        `device-transitions: ${row.capName}.${row.command.method} names no single vocabulary action; not announced`,
        { tags: { deviceId: row.deviceId } },
      )
      return
    }
    try {
      deps.onCommandSettled({
        deviceId: row.deviceId,
        action,
        outcome: row.outcome,
        actor: row.actor,
        at: row.at,
      })
    } catch (err) {
      deps.logger.warn(
        `device-transitions: announcing a completed ${row.capName}.${row.command.method} failed: ${err instanceof Error ? err.message : String(err)}`,
        { tags: { deviceId: row.deviceId } },
      )
    }
  }
  const recorder = new CommandRecorder({
    logger: deps.logger,
    currentSlice: (deviceId, capName) => deps.mirror.currentSlice(deviceId, capName),
    emit: (row) => {
      sender.enqueue(row)
      announce(row)
    },
    prepareArgs: createCommandArgsPreparer(inputFor),
  })
  const unsubscribe = getCommandObserverRegistry().subscribe((obs) => {
    if (!isCommand(obs.capName, obs.method)) return
    try {
      recorder.recordCommand(obs)
    } catch (err) {
      deps.logger.error(
        `device-transitions: recording a ${obs.capName}.${obs.method} command failed: ${err instanceof Error ? err.message : String(err)}`,
        { tags: { deviceId: obs.deviceId } },
      )
    }
  })
  const stopTicker = ticker(() => {
    void sender.flush()
  }, TRANSITIONS_FLUSH_INTERVAL_MS)
  return {
    stop: async () => {
      unsubscribe()
      stopTicker()
      await sender.flush()
      sender.abandon()
    },
  }
}
