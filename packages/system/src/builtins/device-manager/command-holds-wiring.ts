/**
 * Arms the command hold (D1061) from the D1022 command seams.
 *
 * Every device command the hub sees — its tRPC mount, the UDS parent for a
 * forked addon's `ctx.api`, an in-process addon's `ctx.api` — reaches the
 * process-wide observer registry BEFORE the call runs. Here each one resolves
 * what it leads to (the vocabulary's effects under the provider's option) on
 * the slice the device last reported, and the mirror holds it; a refused call
 * rolls the hold back at once.
 *
 * Telemetry in, never a gate (D8): a throw here costs the hold, never the call.
 */
import { type CommandHoldOptions, type IScopedLogger, resolveCommandHold } from '@dominevo/types'
import { getCommandObserverRegistry } from '../../kernel/command-observation.js'
import { getCommandHoldOverrideRegistry } from '../../kernel/command-hold-overrides.js'
import type { DeviceStateMirror } from './device-state-mirror.js'

export interface CommandHoldsWiringDeps {
  readonly mirror: DeviceStateMirror
  readonly logger: IScopedLogger
  /** The provider's options for a device cap; defaults to the process-wide registry. */
  readonly optionsFor?: (deviceId: number, capName: string) => CommandHoldOptions | undefined
}

/** Subscribe the hold to the command observations; returns the unsubscribe. */
export function startCommandHolds(deps: CommandHoldsWiringDeps): () => void {
  const optionsFor =
    deps.optionsFor ??
    ((deviceId: number, capName: string) => getCommandHoldOverrideRegistry().get(deviceId, capName))
  const unsubscribe = getCommandObserverRegistry().subscribe((obs) => {
    try {
      const current = deps.mirror.capSlice(obs.deviceId, obs.capName, 'confirmed') ?? undefined
      const shown = deps.mirror.capSlice(obs.deviceId, obs.capName) ?? undefined
      const option = optionsFor(obs.deviceId, obs.capName)?.[obs.method]
      const hold = resolveCommandHold(obs.capName, obs.method, obs.args, current, option, shown)
      if (hold === null) return
      const token = deps.mirror.holdCommand({
        deviceId: obs.deviceId,
        capName: obs.capName,
        method: obs.method,
        effects: hold.effects,
        holdMs: hold.holdMs,
      })
      if (token === null) return
      obs.outcome?.catch(() => deps.mirror.releaseCommand(token, 'refused'))
    } catch (err) {
      deps.logger.error(
        `command hold: arming ${obs.capName}.${obs.method} failed: ${err instanceof Error ? err.message : String(err)}`,
        { tags: { deviceId: obs.deviceId } },
      )
    }
  })
  return () => {
    unsubscribe()
    deps.mirror.disposeHolds()
  }
}
