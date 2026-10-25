/**
 * Decode-hwaccel ranking for `reprobeHwaccel`: the kernel resolver's preferred
 * order, re-ranked so the backend this node reports is the one that actually
 * decodes (vaapi above qsv on Intel). A copy of the broker's
 * `packages/addon-pipeline/src/shared/ffmpeg-decode-args.ts` ranking — addons
 * do not import each other.
 */

/**
 * Canonical decode-hwaccel preference order.
 *
 * `vaapi` is ranked ABOVE `qsv` deliberately: on the Intel hub the `qsv` decode
 * child exits early (`code=171`, no frames) while the `vaapi` path decodes 8MP
 * h264 cleanly at ~50fps. The kernel probe (`resolveHwAccel`) tends to surface
 * `qsv` first on Intel, so we re-rank its result through this table before
 * building the attempt chain. `videotoolbox` leads for macOS; `cuda` / `nvdec`
 * trail for NVIDIA. A method not listed here keeps its incoming relative order,
 * placed AFTER every ranked one.
 */
const DECODE_HWACCEL_RANK: readonly string[] = [
  'videotoolbox',
  'vaapi',
  'qsv',
  'cuda',
  'nvdec',
  'd3d11va',
  'dxva2',
  'amf',
  'vdpau',
  'drm',
]

/** Rank index for {@link DECODE_HWACCEL_RANK} — unranked methods sort last. */
function decodeHwAccelRankIndex(method: string): number {
  const idx = DECODE_HWACCEL_RANK.indexOf(method.toLowerCase())
  return idx < 0 ? DECODE_HWACCEL_RANK.length : idx
}

/**
 * Build the ORDERED list of hardware `-hwaccel` methods to attempt for an
 * `'auto'` decode session, best-first. The session walks this chain on an
 * early-exit-with-no-frames and only falls to software once it is exhausted.
 *
 * Strategy:
 * - Seed candidates from the kernel-preferred order UNION the canonical rank
 *   UNION the build's supported list, so a method the kernel omitted but the
 *   build supports (the Intel `vaapi` case — kernel surfaces only `qsv`) is
 *   still attempted.
 * - When the build's supported-method list is known (non-empty), keep only
 *   methods it actually offers; on a probe miss (empty) keep just the kernel
 *   preferences (avoid blindly spawning every backend).
 * - Re-rank the survivors by {@link DECODE_HWACCEL_RANK} so `vaapi` precedes
 *   `qsv`. A supported method not in the rank table keeps its position AFTER
 *   every ranked one (stable sort). Returns lowercased method names; empty ⇒
 *   pure software.
 */
export function rankDecodeHwAccels(
  preferred: readonly string[],
  supportedMethods: readonly string[],
): string[] {
  const supported = new Set(supportedMethods.map((m) => m.toLowerCase()))
  const hasSupportList = supported.size > 0
  const pool = hasSupportList
    ? [...preferred, ...DECODE_HWACCEL_RANK, ...supportedMethods]
    : [...preferred]
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const raw of pool) {
    const method = raw.toLowerCase()
    if (seen.has(method)) continue
    seen.add(method)
    if (hasSupportList && !supported.has(method)) continue
    candidates.push(method)
  }
  return candidates.sort((a, b) => decodeHwAccelRankIndex(a) - decodeHwAccelRankIndex(b))
}
