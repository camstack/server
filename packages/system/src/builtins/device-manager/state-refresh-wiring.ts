/**
 * Starts the state-refresh scheduler (D1062) in the hub's device-manager.
 *
 * The scheduler reads the providers' declared policies from the process-wide
 * registry, is told of every report by the mirror's report tap (push health,
 * push confirmation), asks the mirror whether a command hold is still pending
 * (the burst stops when none is), and is installed as the command follow-up
 * the D1022 seams await. The calls reach the provider's process through the
 * `device-state-refresh` cap.
 */
import type { IScopedLogger, StateRefreshReason } from '@camstack/types'
import { getCommandFollowUpRegistry } from '../../kernel/command-follow-up.js'
import { getStateRefreshPolicyRegistry } from '../../kernel/state-refresh-policies.js'
import type { DeviceStateMirror } from './device-state-mirror.js'
import { StateRefreshScheduler, type StateRefreshPolicySource } from './state-refresh-scheduler.js'

export interface StateRefreshWiringDeps {
  readonly mirror: DeviceStateMirror
  readonly logger: IScopedLogger
  readonly refresh: (
    deviceId: number,
    deviceIds: readonly number[],
    reason: StateRefreshReason,
  ) => Promise<void>
  readonly resubscribe: (deviceId: number) => Promise<void>
  /** Defaults to the process-wide registry. */
  readonly policies?: StateRefreshPolicySource
}

/** Start the scheduler; returns the stop. */
export function startStateRefresh(deps: StateRefreshWiringDeps): () => void {
  const scheduler = new StateRefreshScheduler({
    policies: deps.policies ?? getStateRefreshPolicyRegistry(),
    logger: deps.logger,
    holdsPending: (deviceId) => deps.mirror.isHoldingDevice(deviceId),
    refresh: deps.refresh,
    resubscribe: deps.resubscribe,
  })
  deps.mirror.setReportTap((deviceId) => scheduler.onReport(deviceId))
  const uninstall = getCommandFollowUpRegistry().set(scheduler.onCommand)
  return () => {
    uninstall()
    deps.mirror.setReportTap(null)
    scheduler.dispose()
  }
}
