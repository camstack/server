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
  /** Called with the devices whose held offline was applied (to persist them). */
  readonly onOfflineApplied?: (deviceIds: readonly number[]) => void
  /** Defaults to the process-wide registry. */
  readonly policies?: StateRefreshPolicySource
}

/** Start the scheduler; returns the stop. */
export function startStateRefresh(deps: StateRefreshWiringDeps): () => void {
  const scheduler = new StateRefreshScheduler({
    policies: deps.policies ?? getStateRefreshPolicyRegistry(),
    logger: deps.logger,
    holdsPending: (deviceId) => deps.mirror.isHoldingDevice(deviceId),
    holdRemainingMs: (deviceId) => deps.mirror.holdRemainingMs(deviceId),
    refresh: deps.refresh,
    resubscribe: deps.resubscribe,
    onFirstReadSettled: (deviceIds) => {
      const applied = deps.mirror.releaseDeferredOffline(deviceIds)
      if (applied.length > 0) deps.onOfflineApplied?.(applied)
    },
  })
  deps.mirror.setReportTap((deviceId) => scheduler.onReport(deviceId))
  deps.mirror.setReadinessGate((deviceId) => scheduler.isAwaitingFirstRead(deviceId))
  const uninstall = getCommandFollowUpRegistry().set(scheduler.onCommand)
  return () => {
    uninstall()
    deps.mirror.setReportTap(null)
    deps.mirror.setReadinessGate(null)
    scheduler.dispose()
  }
}
