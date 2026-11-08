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

export interface TransitionTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface DeviceTransitionsDeps {
  readonly mirror: DeviceStateMirror
  readonly logger: IScopedLogger
  readonly record: (transitions: readonly DeviceTransition[]) => Promise<void>
  readonly now?: () => number
  readonly timers?: TransitionTimers
}

export interface DeviceTransitionsHandle {
  forgetDevice(deviceId: number): void
  /** Unsubscribe, stop the timers, send what is queued. */
  stop(): Promise<void>
}

const REAL_TIMERS: TransitionTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => {
    if (handle !== undefined && handle !== null && typeof handle === 'object') clearInterval(handle as NodeJS.Timeout)
  },
}

function inputFor(capName: string, method: string): z.ZodType | undefined {
  const def = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === capName)
  return def === undefined ? undefined : expandCapMethods(def)[method]?.input
}

export function startDeviceTransitions(deps: DeviceTransitionsDeps): DeviceTransitionsHandle {
  const now = deps.now ?? Date.now
  const timers = deps.timers ?? REAL_TIMERS
  const sender = new TransitionSender({
    send: (batch) => deps.record(batch),
    logger: deps.logger,
  })
  const correlator = new TransitionCorrelator({
    now,
    currentSlice: (deviceId, capName) => deps.mirror.currentSlice(deviceId, capName),
    emit: (row) => sender.enqueue(row),
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
  const tick = timers.setInterval(() => {
    correlator.sweep()
    void sender.flush()
  }, TRANSITIONS_FLUSH_INTERVAL_MS)
  return {
    forgetDevice: (deviceId) => correlator.forgetDevice(deviceId),
    stop: async () => {
      unsubscribe()
      deps.mirror.setTransitionTap(null)
      timers.clearInterval(tick)
      await sender.flush()
    },
  }
}
