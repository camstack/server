/**
 * How a runtime site gets the ffmpeg it spawns: the node's PINNED build, asked
 * of `ctx.deps.ensureFfmpeg()` and never looked up on PATH (D540).
 *
 * Why a memo and not a bare `ensureFfmpeg()` per spawn: every call takes the
 * deps file lock, probes the binary (`-version`, `-hwaccels`, `-encoders` —
 * three children) and logs the resolution. That is right once per process and
 * wrong once per still, per fragment or per preview.
 *
 * Why a memo and not a string resolved at init with a default: a default is
 * what this repo kept writing — `ffmpegPath ?? 'ffmpeg'`, `binaryPath =
 * 'ffmpeg'` — and every one of them turned "the pinned build is unavailable"
 * into "run the host's binary" without a line in the log. A resolver that
 * REJECTS has no such value to fall back to; the caller must say what it
 * refused. `scripts/check-no-bare-ffmpeg.ts` refuses the default at commit.
 */

/** The pinned ffmpeg for this node; rejects when there is none to be had. */
export type PinnedFfmpegResolver = () => Promise<string>

/**
 * Memoize `ensure` on SUCCESS only.
 *
 * A failure is not remembered: the next caller asks again, so a node whose
 * first download failed (no network at boot) recovers on the next spawn that
 * needs it — with no timer and no retry loop, because the ask is driven by
 * work that actually wants the binary.
 */
export function memoizePinnedFfmpeg(ensure: () => Promise<string>): PinnedFfmpegResolver {
  let pending: Promise<string> | null = null
  return () => {
    if (pending !== null) return pending
    const attempt = ensure()
    pending = attempt
    attempt.catch(() => {
      if (pending === attempt) pending = null
    })
    return attempt
  }
}
