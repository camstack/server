/**
 * Which restream ffmpeg should grab a snapshot JPEG from.
 *
 * `status: 'streaming'` is not enough. A derived whose source profile is
 * unassigned sits in that state with zero packets (618, 2026-08-16: `derived:Mid
 * to low` had four subscribers and never a frame). Preferring it as "warm"
 * parked every grab on a 15 s ffmpeg timeout, so the connecting poster never
 * moved.
 *
 * Derived brokers are never the warm shortcut. A native that is actually
 * streaming still wins; otherwise the caller walks the ranked list and will
 * wake an idle source.
 */

export function isDerivedBrokerId(brokerId: string, devicePrefix: string): boolean {
  const streamId = brokerId.startsWith(devicePrefix)
    ? brokerId.slice(devicePrefix.length)
    : brokerId
  return streamId.startsWith('derived:')
}

export interface SnapshotGrabCandidate {
  readonly brokerId: string
  readonly status: string
}

/** Highest-quality currently-streaming NON-derived broker, or undefined. */
export function pickWarmSnapshotBroker(
  ranked: readonly SnapshotGrabCandidate[],
  devicePrefix: string,
): SnapshotGrabCandidate | undefined {
  return ranked.find(
    (c) => c.status === 'streaming' && !isDerivedBrokerId(c.brokerId, devicePrefix),
  )
}
