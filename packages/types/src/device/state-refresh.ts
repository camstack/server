/**
 * Server-driven device state refresh (D1062): the core decides WHEN a device is
 * re-read, the integration only knows HOW.
 *
 * A provider states its policy where it registers the device's
 * `device-state-refresh` cap (`ctx.registerNativeCap(cap, provider, {
 * stateRefresh })`). It reaches the hub by the road the command-hold options
 * take (D1061): written directly in-process, carried on a forked child's cap
 * descriptors otherwise. Plain data, wire-safe.
 */
import { z } from 'zod'

/** Why the core asks for a refresh. */
export const StateRefreshReasonSchema = z.enum(['schedule', 'command', 'burst'])
export type StateRefreshReason = z.infer<typeof StateRefreshReasonSchema>

/**
 * What arrives without asking: `none` (everything is read), `partial` (some
 * fields arrive by push, the rest is read on the schedule), `full` (everything
 * arrives by push — never read on a schedule).
 */
export const StateRefreshPushSchema = z.enum(['none', 'partial', 'full'])
export type StateRefreshPush = z.infer<typeof StateRefreshPushSchema>

/** The fastest base cadence the core accepts from any provider. */
export const MIN_STATE_REFRESH_INTERVAL_MS = 1_000

export const StateRefreshPolicySchema = z.object({
  /**
   * The integration instance the device belongs to. Devices of one instance
   * share one schedule group: a batching provider is asked once for all of
   * them, and the heartbeat is judged across them.
   */
  integrationId: z.string().min(1),
  /** The fastest interval the integration can afford for its devices. The core polls at it by default. */
  minIntervalMs: z.number().int().min(MIN_STATE_REFRESH_INTERVAL_MS),
  /**
   * The operator's per-integration setting, when there is one. It can only SLOW
   * the cadence: the core polls at `max(minIntervalMs, intervalMs)`.
   */
  intervalMs: z.number().int().positive().optional(),
  /** One `refresh` call can read every device of the integration at once. */
  batch: z.boolean(),
  push: StateRefreshPushSchema,
  /** Longest silence a push integration may keep before the core re-reads it and asks it to resubscribe. */
  heartbeatMs: z.number().int().positive().optional(),
  /**
   * Bumped by the provider each time its push subscription reconnected on its
   * own. A change makes the core re-read every device of the integration
   * (pushes lost while it was down; events may be dropped, D8).
   */
  connectionEpoch: z.number().int().nonnegative().optional(),
})
export type StateRefreshPolicy = z.infer<typeof StateRefreshPolicySchema>

/** The cadence the core runs a policy at: the declared minimum, slowed (never sped up) by the setting. */
export function effectiveRefreshIntervalMs(policy: StateRefreshPolicy): number {
  const setting = policy.intervalMs ?? 0
  return Math.max(policy.minIntervalMs, setting)
}

/** The first reads after a command on a read (non-push) device: offsets from the command, in ms. */
export const COMMAND_BURST_OFFSETS_MS: readonly number[] = [3_000, 10_000]

/** After the first reads, a pending hold is re-read this often. */
export const COMMAND_BURST_STEP_MS = 10_000

/** The last read of a hold lands this long before it expires. */
export const COMMAND_BURST_TAIL_MS = 2_000

/**
 * The reads after a command on a read device, for a hold that lasts `holdMs`
 * more: {@link COMMAND_BURST_OFFSETS_MS}, then one every
 * {@link COMMAND_BURST_STEP_MS}, then a last one {@link COMMAND_BURST_TAIL_MS}
 * before the hold expires. A slow cloud is re-read for the whole hold, not
 * only at the start. Offsets are in ms from now, ascending, all below `holdMs`.
 */
export function commandBurstOffsets(holdMs: number): readonly number[] {
  const out: number[] = COMMAND_BURST_OFFSETS_MS.filter((offset) => offset < holdMs)
  const tail = holdMs - COMMAND_BURST_TAIL_MS
  let next = (out[out.length - 1] ?? 0) + COMMAND_BURST_STEP_MS
  while (next < tail) {
    out.push(next)
    next += COMMAND_BURST_STEP_MS
  }
  if (tail > (out[out.length - 1] ?? 0)) out.push(tail)
  return out
}

/** How long the core waits for a push device to confirm a command before reading it once. */
export const PUSH_CONFIRM_WINDOW_MS = 2_500
