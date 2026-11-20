/**
 * Control-plane reachability, read by the core (D1062).
 *
 * `device.online` must reflect CONTROL-PLANE REACHABILITY (can we talk to the
 * camera's management API right now), not whether video flows through the
 * stream broker. Each camera provider owns a cheap round-trip (`probe`). This
 * helper registers `device-state-refresh` for the device so the hub's scheduler
 * decides WHEN the probe runs (every {@link REACHABILITY_REFRESH_INTERVAL_MS},
 * `push: 'none'`); the provider keeps no timer.
 *
 * The probe's verdict is the state itself, not a failed read, so a refresh
 * never throws for an unreachable camera: the cadence stays steady and the
 * device goes offline by hysteresis ({@link REACHABILITY_FAILURES_TO_OFFLINE}
 * consecutive misses; ONLINE on the first success). A probe is bounded by
 * {@link REACHABILITY_PROBE_TIMEOUT_MS}; a thrown probe counts as a miss;
 * `isEnabled() === false` reads nothing and leaves `online` untouched.
 *
 * The core's first read is one interval after registration, so registering
 * probes once at once (no blind window; a caller cannot forget it). A
 * re-attach of the control client calls `reattach()`: it forgets the misses
 * so far and probes again.
 */
import { deviceStateRefreshCapability } from '../capabilities/device-state-refresh.cap.js'
import type { InferNativeProvider } from '../capabilities/capability-definition.js'
import type { StateRefreshPolicy } from './state-refresh.js'
import type { DeviceContext } from './device-context.js'
import {
  REACHABILITY_FAILURES_TO_OFFLINE,
  REACHABILITY_POLL_INTERVAL_MS,
  REACHABILITY_PROBE_TIMEOUT_MS,
  type ReachabilityPollLogger,
} from './reachability-poll.js'

/** The cadence the core reads a camera's reachability at. */
export const REACHABILITY_REFRESH_INTERVAL_MS = REACHABILITY_POLL_INTERVAL_MS

/** The part of a device context the registration uses. */
export type ReachabilityRefreshContext = Pick<
  DeviceContext,
  'registerNativeCap' | 'stableId' | 'id'
>

export interface ReachabilityRefreshOptions {
  readonly ctx: ReachabilityRefreshContext
  /** Resolve `true` when reachable, `false` (or throw) when not. */
  readonly probe: () => Promise<boolean>
  /** Drives the online flag, called only on a decision (idempotent setters are fine). */
  readonly setOnline: (online: boolean) => void
  /** `false` skips the read (soft-disabled, sleeping); a skip is not a miss. */
  readonly isEnabled?: () => boolean
  readonly logger?: ReachabilityPollLogger
  /** The schedule group; defaults to the device's stable id (one group per camera). */
  readonly integrationId?: string
  /** Test seams. */
  readonly failuresToOffline?: number
  readonly probeTimeoutMs?: number
}

export interface ReachabilityRefreshHandle {
  /** One probe now; never rejects. */
  readonly probeNow: () => Promise<void>
  /** The control client was replaced: forget the misses and probe again. */
  readonly reattach: () => Promise<void>
  /** Ignore every later verdict (device removed). Idempotent. */
  readonly stop: () => void
}

export function reachabilityRefreshPolicy(integrationId: string): StateRefreshPolicy {
  return {
    integrationId,
    minIntervalMs: REACHABILITY_REFRESH_INTERVAL_MS,
    batch: false,
    push: 'none',
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`reachability probe timed out after ${String(ms)}ms`)),
      ms,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function registerReachabilityRefresh(
  options: ReachabilityRefreshOptions,
): ReachabilityRefreshHandle {
  const failuresToOffline = options.failuresToOffline ?? REACHABILITY_FAILURES_TO_OFFLINE
  const probeTimeoutMs = options.probeTimeoutMs ?? REACHABILITY_PROBE_TIMEOUT_MS
  let stopped = false
  let running = false
  let consecutiveFailures = 0

  const miss = (reason: string): void => {
    consecutiveFailures += 1
    options.logger?.debug('reachability probe failed', {
      tags: { deviceId: options.ctx.id },
      reason,
      consecutiveFailures,
      failuresToOffline,
    })
    if (consecutiveFailures >= failuresToOffline) options.setOnline(false)
  }

  const read = async (): Promise<void> => {
    if (stopped || running) return
    if (options.isEnabled !== undefined && !options.isEnabled()) return
    running = true
    try {
      const reachable = await withTimeout(Promise.resolve().then(options.probe), probeTimeoutMs)
      if (stopped) return
      if (reachable) {
        consecutiveFailures = 0
        options.setOnline(true)
      } else {
        miss('probe resolved unreachable')
      }
    } catch (error: unknown) {
      if (stopped) return
      miss(error instanceof Error ? error.message : 'probe threw')
    } finally {
      running = false
    }
  }

  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await read()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  options.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: reachabilityRefreshPolicy(options.integrationId ?? options.ctx.stableId),
  })

  void read()

  return {
    probeNow: read,
    reattach: () => {
      consecutiveFailures = 0
      return read()
    },
    stop: () => {
      stopped = true
    },
  }
}
