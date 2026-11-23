import type { CamStreamDescriptor } from '@camstack/types'

/**
 * How long the broker lets a Home Hub child's session run before it re-dials on
 * its own terms.
 *
 * Observed 2026-11-20 on two DC-powered children of one Home Hub: the hub cut
 * BOTH sessions at the same second, every 28 min 07 s (16:16:36, then 16:44:43),
 * which is a hub session limit, not the camera. Declared a minute under that so
 * the planned re-dial always wins the race against the hub's cut and the
 * recording rolls over at a time of our choosing.
 */
export const HOME_HUB_SESSION_LIMIT_MS = 27 * 60_000

/**
 * The same cut on a STANDALONE battery camera: four consecutive live sessions
 * ended at 1799-1806 s (2026-11-23), so the firmware limits a session to about
 * 30 min there too. Declared two minutes under it so the broker's planned
 * re-dial wins the race against the camera's cut and the recording rolls over
 * at a time of our choosing, not as a hole.
 */
export const STANDALONE_BATTERY_SESSION_LIMIT_MS = 28 * 60_000

/** What a camera's place in the cluster says about its stream's session limit. */
export interface SessionLimitInput {
  /** Adopted through an NVR / Home Hub integration, not standalone. */
  readonly isHubChild: boolean
  /** Battery cameras are the ones a Home Hub (not an NVR) carries. */
  readonly isBattery: boolean
}

/**
 * Stamp the descriptors with the session limit the broker acts on. Only a
 * battery camera gets one (a hub child at 27 min, a standalone one at 28 min):
 * a mains-powered camera or a wired hub child has no such cut, and declaring
 * one there would re-dial a healthy stream for nothing.
 */
export function withSessionLimit(
  descriptors: readonly CamStreamDescriptor[],
  input: SessionLimitInput,
): CamStreamDescriptor[] {
  if (!input.isBattery) return [...descriptors]
  const maxSessionMs = input.isHubChild
    ? HOME_HUB_SESSION_LIMIT_MS
    : STANDALONE_BATTERY_SESSION_LIMIT_MS
  return descriptors.map((d) => ({ ...d, maxSessionMs }))
}
