/**
 * THE ranking behind `cameraStreams.pickStream` — one place where "which
 * stream should this consumer get" is answered.
 *
 * It is pure, and it lives here rather than inside the broker, because the
 * point of the exercise was that there be exactly ONE of it. On 2026-09-13
 * there were two: this picker, and a private scorer inside the Alexa exporter
 * written the same day because the picker could not express Amazon's ceiling.
 * A second authority for a question that already had one is the defect this
 * repo keeps paying for — two knobs where the second outranks the first (D62),
 * a pin no UI could show, a flag that never reached ffmpeg.
 *
 * Each consumer passes ITS OWN numbers. Alexa's floor is Amazon's 480p and its
 * ceiling 1080p; HomeKit's are its own. The thresholds belong to whoever has
 * the requirement, never to a default in here.
 */

export interface PickCandidate {
  readonly camStreamId: string
  readonly codec?: string | undefined
  readonly height?: number | undefined
  readonly width?: number | undefined
}

export interface PickRanking {
  /** Codecs usable with no transcode. Empty ⇒ every codec is usable. */
  readonly acceptCodecs: readonly string[]
  /** Whether a codec outside `acceptCodecs` may win, transcoded. */
  readonly allowTranscode: boolean
  /** Ordered provider prefixes; earlier wins. */
  readonly preferredProviders: readonly string[]
  /** `highest` / `lowest`, used when `targetHeight` is absent. */
  readonly resolutionPreference: 'highest' | 'lowest'
  /** The height the consumer means to deliver. See the cap's docblock. */
  readonly targetHeight?: number | undefined
}

export interface RankedPick {
  readonly candidate: PickCandidate
  readonly transcodes: boolean
}

/**
 * THE target rule: which of two sizes serves a consumer better.
 *
 * "Prefer at or above the target so the consumer downscales instead of
 * upscaling; among those the SMALLEST, because the extra pixels are thrown
 * away and the decode is not; among the rest the LARGEST, because it is the
 * closest we can get." One sentence, and until now it was written twice — once
 * here in lines, once in `stream-selection.ts` in pixels, for the same two
 * exporters. The two agreed, which is luck, not a property.
 *
 * The `size` is whatever measure the caller ranks by: the cap ranks by LINES
 * (a consumer's requirement is stated in p), the RTSP picker by PIXELS (it
 * compares entries of possibly different aspect). The rule is the same either
 * way and the measure is the caller's business.
 *
 * Returns a sort delta: negative when `a` should come first.
 */
export function compareToTarget(a: number, b: number, target: number): number {
  const aReaches = a >= target
  const bReaches = b >= target
  if (aReaches !== bReaches) return aReaches ? -1 : 1
  return aReaches ? a - b : b - a
}

/** `h265` and `hevc` are one codec spelled two ways, and a camera publishes
 *  whichever its vendor felt like. */
function canonicalCodec(value: string): string {
  const v = value.toLowerCase().replace(/[.\s-]/g, '')
  if (v === 'hevc' || v === 'hvc1' || v === 'hev1') return 'h265'
  if (v === 'avc' || v === 'avc1') return 'h264'
  return v
}

export function codecIsAccepted(codec: string | undefined, accept: readonly string[]): boolean {
  if (accept.length === 0) return true
  if (codec === undefined) return false
  const c = canonicalCodec(codec)
  return accept.some((a) => canonicalCodec(a) === c)
}

function providerRank(camStreamId: string, preferred: readonly string[]): number {
  for (let i = 0; i < preferred.length; i += 1) {
    if (camStreamId.startsWith(preferred[i]!)) return i
  }
  return preferred.length
}

/**
 * Order the candidates and return the winner, or `null` when none qualifies.
 *
 * The order, and every term is there for a measured reason:
 *
 *  1. **A stream we can take AS IS beats one we must re-encode.** A transcode
 *     is a decode plus an encode for as long as the session lasts, and on this
 *     hub a concurrent HEVC decode is what exhausted the VAAPI device.
 *  2. **Provider preference**, unchanged — a native dial beats a relayed one.
 *  3. **The target**, when the consumer named one: the smallest stream that
 *     reaches it, else the tallest that does not. Absent, the caller's
 *     `resolutionPreference` decides, exactly as before.
 */
export function rankStreams(
  candidates: readonly PickCandidate[],
  ranking: PickRanking,
): RankedPick | null {
  const usable = candidates.filter(
    (c) => ranking.allowTranscode || codecIsAccepted(c.codec, ranking.acceptCodecs),
  )
  if (usable.length === 0) return null

  const target = ranking.targetHeight
  const scored = usable.map((candidate) => ({
    candidate,
    transcodes: !codecIsAccepted(candidate.codec, ranking.acceptCodecs),
    provider: providerRank(candidate.camStreamId, ranking.preferredProviders),
    height: candidate.height ?? 0,
  }))

  scored.sort((a, b) => {
    if (a.transcodes !== b.transcodes) return a.transcodes ? 1 : -1
    if (a.provider !== b.provider) return a.provider - b.provider
    if (target !== undefined) return compareToTarget(a.height, b.height, target)
    return ranking.resolutionPreference === 'highest' ? b.height - a.height : a.height - b.height
  })

  const winner = scored[0]
  if (winner === undefined) return null
  return { candidate: winner.candidate, transcodes: winner.transcodes }
}
