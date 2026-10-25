/**
 * Reclaiming an egress handle whose session is gone.
 *
 * An Alexa egress is released by ONE thing: the `SessionDisconnected`
 * directive. That works until a session ends some other way — and on
 * 2026-09-13 one did. An Echo got stuck, never sent the directive, and a
 * 2304x1296 HEVC to 720p H.264 transcode kept running for NOBODY for more than
 * twenty minutes; the hub had 22 ffmpeg children at the time. The WebRTC
 * session had logged `WebRTC session closed` minutes earlier: the broker knew,
 * and the holder of the handle had no way to ask.
 *
 * Now it asks. `webrtcSession.getSessionState` carries `alive`, and a handle
 * whose session is not alive is released with a line saying so — a resource
 * reclaimed silently is indistinguishable from one that was never leaked, and
 * the operator needs to know the directive went missing.
 *
 * A SWEEP and not a subscription, deliberately: a missed teardown is exactly
 * the case where an event would have been missed too, and the thing that must
 * not be lost here is the reclaim. It is cheap — one call per held handle per
 * sweep, and the map is empty for all but the seconds an Echo is watching.
 */
import type { IScopedLogger } from '@camstack/types'

export interface HeldEgressHandle {
  readonly deviceId: number
  readonly sessionId: string
  readonly pipelineKey: string
}

export interface EgressReapInput {
  readonly held: readonly HeldEgressHandle[]
  /** `alive` for the session, or `null` when the question could not be asked. */
  readonly isAlive: (handle: HeldEgressHandle) => Promise<boolean | null>
}

/**
 * Which handles should be released now.
 *
 * A session the broker says is GONE is reclaimed. A session it could not be
 * asked about is KEPT — a read that failed is not evidence of death, and
 * releasing a live session's transcode would black out a working stream to
 * save a process (D393, read in the direction that destroys work).
 */
export async function reapDeadEgressHandles(
  input: EgressReapInput,
): Promise<readonly HeldEgressHandle[]> {
  const dead: HeldEgressHandle[] = []
  for (const handle of input.held) {
    const alive = await input.isAlive(handle)
    if (alive === false) dead.push(handle)
  }
  return dead
}

/** How often the sweep runs. Well under the minute Amazon requires a session
 *  to survive, so a genuinely dead one is not transcoding for long. */
export const EGRESS_REAP_INTERVAL_MS = 30_000

export function logReaped(logger: IScopedLogger | undefined, handle: HeldEgressHandle): void {
  logger?.warn('alexa egress: session is GONE — reclaiming the transcode it still held', {
    tags: { deviceId: handle.deviceId },
    meta: {
      sessionId: handle.sessionId,
      pipelineKey: handle.pipelineKey,
      // Said out loud because it means a directive never arrived. A reclaim
      // that looked like routine housekeeping would hide that.
      reason: 'no SessionDisconnected directive',
    },
  })
}
