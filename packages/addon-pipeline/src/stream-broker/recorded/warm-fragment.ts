import type { AccessUnit } from './segment-demux'
import type { LocateResult, ReadGopFn } from './recorded-feeder'
import type { ScrubFragmentCache } from './scrub-fragment-cache'

/**
 * warm-fragment — pre-run the first-scrub chain on timeline OPEN.
 *
 * The first drag of a session used to pay a serial chain through a saturated
 * hub: locate (a cap RPC measured at 1–8 s) → segment read → demux — all of it
 * between finger-down and the first painted frame. The viewer knows the
 * playhead the timeline opens on, so the client sends `{t:'warm'}` when the
 * timeline UI appears and this pre-runs exactly that chain — locate, the GOP
 * byte-range fetch, the demux — into the session's {@link ScrubFragmentCache}.
 * The first `scrubTo` is then a coverage hit: zero RPCs before its push.
 *
 * Fire-and-forget and STATELESS: never touches the live gate, the feeder, or
 * playback mode — warming must be safe while the operator is still watching
 * live. Every outcome logs (a warm that silently did nothing reads exactly
 * like a warm that worked).
 */

export interface WarmFragmentDeps {
  readonly deviceId: number
  locate(args: { deviceId: number; profile: string; epochMs: number }): Promise<LocateResult>
  readonly readGop: ReadGopFn
  demux(bytes: Uint8Array): Promise<AccessUnit[]>
  readonly cache: ScrubFragmentCache
  onLog?(msg: string, data: Record<string, unknown>): void
}

/** Warm the fragment covering `epochMs` at `profile` into the session cache. */
export async function warmFragment(
  deps: WarmFragmentDeps,
  profile: string,
  epochMs: number,
): Promise<void> {
  const t0 = performance.now()
  if (deps.cache.covering(profile, epochMs)) {
    deps.onLog?.('recorded:warm-hit', { profile, epochMs })
    return
  }
  const loc = await deps.locate({ deviceId: deps.deviceId, profile, epochMs })
  const locatedAt = performance.now()
  if (loc.kind !== 'segment') {
    // No footage under the cursor — nothing to warm, and it says so.
    deps.onLog?.('recorded:warm-no-footage', { profile, epochMs })
    return
  }
  const gop = await deps.readGop({
    deviceId: deps.deviceId,
    profile,
    segmentStartMs: loc.startMs,
    segmentDurMs: loc.durMs,
    epochMs,
  })
  const readAt = performance.now()
  const aus = await deps.demux(gop.bytes)
  deps.cache.put(profile, { startMs: gop.gopStartMs, durMs: gop.gopDurMs, aus })
  // The chain's real cost, hop by hop — the numbers that used to be paid
  // between finger-down and first frame, now paid before the finger arrives.
  deps.onLog?.('recorded:warmed', {
    profile,
    epochMs,
    gopStartMs: gop.gopStartMs,
    locateMs: Math.round(locatedAt - t0),
    readMs: Math.round(readAt - locatedAt),
    demuxMs: Math.round(performance.now() - readAt),
    aus: aus.length,
  })
}
