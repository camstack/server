/**
 * The one-liner an addon registers to join the channel mechanism.
 *
 * ```ts
 * context.registerProvider('log-channels', createLogChannelsProvider(this.ctx.logger))
 * ```
 *
 * Everything it does is bookkeeping over the process-wide
 * {@link LogChannelRegistry}: enumerate the declarations, and push the
 * document's armed set into the mirror. It holds no value of its own, so a
 * second provider in another addon of the same process cannot disagree with
 * this one — they share the registry.
 *
 * ## Why the ticker lives here
 *
 * A window is a deadline, and something has to notice the deadline passing.
 * It must not be the log path: a diagnostic that adds a `Date.now()` to the
 * path it is measuring measures itself. So the provider owns a coarse
 * interval that calls {@link LogChannelRegistry.tick} and writes ONE line per
 * closed channel — because a channel going quiet with no line reads as "that
 * branch was never taken", which is the wrong conclusion and an expensive one.
 */

import type { IScopedLogger } from '../interfaces/logging.js'
import type { LogChannelWindow } from './log-channel.js'
import { getLogChannelRegistry } from './log-channel.singleton.js'

/**
 * How often expiry is noticed. Coarse on purpose: the cost of a channel
 * running a few seconds past its deadline is a few extra lines, and the cost
 * of a tight timer in every addon process is paid forever.
 */
export const LOG_CHANNEL_TICK_MS = 5_000

export interface LogChannelsProviderHandle {
  readonly list: () => readonly LogChannelDescriptorOut[]
  readonly apply: (input: LogChannelApplyInput) => LogChannelApplyOut
  /** Stop the expiry ticker. Call from the addon's `shutdown()`. */
  readonly stop: () => void
}

export interface LogChannelApplyInput {
  readonly windows: readonly LogChannelWindow[]
}

export interface LogChannelApplyOut {
  readonly armed: number
  readonly unknown: readonly string[]
}

interface LogChannelDescriptorOut {
  readonly name: string
  readonly description: string
  readonly defaultLevel: 'info' | 'warn' | 'error'
  readonly perDevice: boolean
}

export interface LogChannelsProviderOptions {
  /** Injected so a spec can drive expiry without waiting. */
  readonly now?: () => number
  readonly tickMs?: number
}

/**
 * Build the `log-channels` provider for this process.
 *
 * `logger` is used ONLY off the hot path — for the arm/expiry lines — so a
 * channel that is never armed costs this module nothing but a timer.
 */
export function createLogChannelsProvider(
  logger: IScopedLogger,
  options: LogChannelsProviderOptions = {},
): LogChannelsProviderHandle {
  const registry = getLogChannelRegistry()
  const now = options.now ?? Date.now
  const tickMs = options.tickMs ?? LOG_CHANNEL_TICK_MS

  const timer = setInterval(() => {
    const closed = registry.tick(now())
    for (const name of closed) {
      logger.info('log channel window closed', {
        tags: { logChannel: name },
        meta: { channel: name },
      })
    }
  }, tickMs)
  // A diagnostic timer must never be the reason a process refuses to exit.
  timer.unref?.()

  return {
    list: () => registry.list(),
    apply: (input) => {
      const unknown = registry.apply(input.windows, now())
      const armed = registry.armed()
      logger.info('log channels applied', {
        meta: {
          armed: armed.map((window) => window.channel),
          unknown,
          declared: registry.list().length,
        },
      })
      return { armed: armed.length, unknown }
    },
    stop: () => {
      clearInterval(timer)
    },
  }
}
