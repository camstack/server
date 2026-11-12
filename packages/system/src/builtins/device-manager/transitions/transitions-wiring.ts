/**
 * Starts the hub's device-transition audit (D1022): command observations and
 * mirror slice changes meet in the correlator, its rows ride a bounded queue to
 * device-history. Everything here is best-effort telemetry (D8): a failure
 * costs rows, never a command or a mirror write.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  expandCapMethods,
  isCommand,
  vocabActionIdFor,
  type DeviceCommandSettledEvent,
  type DeviceTransition,
} from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'
import type { z } from 'zod'
import { getCommandObserverRegistry } from '../../../kernel/command-observation.js'
import type { DeviceStateMirror } from '../device-state-mirror.js'
import { createCommandArgsPreparer } from './command-args.js'
import { TransitionCorrelator } from './transition-correlator.js'
import { TransitionSender } from './transitions-sender.js'

export const TRANSITIONS_FLUSH_INTERVAL_MS = 2_000

/** Runs `fn` every `ms` until the returned function is called. */
export type TransitionTicker = (fn: () => void, ms: number) => () => void

export interface DeviceTransitionsDeps {
  readonly mirror: DeviceStateMirror
  readonly logger: IScopedLogger
  readonly record: (transitions: readonly DeviceTransition[]) => Promise<void>
  /**
   * Told of each COMMAND the correlator settles (never a device's own change). Telemetry (D8):
   * a throw is logged and costs the notification, never the row.
   */
  readonly onCommandSettled?: (event: DeviceCommandSettledEvent) => void
  readonly now?: () => number
  readonly ticker?: TransitionTicker
}

export interface DeviceTransitionsHandle {
  forgetDevice(deviceId: number): void
  /** Unsubscribe, stop the timers, send what is queued. */
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
  const now = deps.now ?? Date.now
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
        `device-transitions: announcing a settled ${row.capName}.${row.command.method} failed: ${err instanceof Error ? err.message : String(err)}`,
        { tags: { deviceId: row.deviceId } },
      )
    }
  }
  const correlator = new TransitionCorrelator({
    now,
    currentSlice: (deviceId, capName) => deps.mirror.currentSlice(deviceId, capName),
    emit: (row) => {
      sender.enqueue(row)
      announce(row)
    },
    prepareArgs: createCommandArgsPreparer(inputFor),
  })
  deps.mirror.setTransitionTap((deviceId, capName, prior, slice) => {
    try {
      correlator.onSliceChange(deviceId, capName, prior, slice)
    } catch (err) {
      deps.logger.error(
        `device-transitions: correlating a ${capName} change failed: ${err instanceof Error ? err.message : String(err)}`,
        { tags: { deviceId } },
      )
    }
  })
  const unsubscribe = getCommandObserverRegistry().subscribe((obs) => {
    if (!isCommand(obs.capName, obs.method)) return
    try {
      correlator.recordCommand(obs)
    } catch (err) {
      deps.logger.error(
        `device-transitions: recording a ${obs.capName}.${obs.method} command failed: ${err instanceof Error ? err.message : String(err)}`,
        { tags: { deviceId: obs.deviceId } },
      )
    }
  })
  const stopTicker = ticker(() => {
    correlator.sweep()
    void sender.flush()
  }, TRANSITIONS_FLUSH_INTERVAL_MS)
  return {
    forgetDevice: (deviceId) => correlator.forgetDevice(deviceId),
    stop: async () => {
      unsubscribe()
      deps.mirror.setTransitionTap(null)
      stopTicker()
      await sender.flush()
      sender.abandon()
    },
  }
}
