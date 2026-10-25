/**
 * WHICH ffmpeg a node runs — one rule, on every node.
 *
 * ## The rule
 *
 * 1. `CAMSTACK_FFMPEG_PATH`, when the operator set it and it exists. Pointing
 *    at your own build is a deliberate act and it wins over everything.
 * 2. The pinned build this node has already downloaded, named by release
 *    (`ffmpeg-<release>`), in `<dataDir>/deps`.
 * 3. Nothing — the caller downloads it. See `ffmpeg-artifacts.ts`.
 *
 * The system PATH is not on that list and must never be. A host binary is an
 * unknown version with unknown vendor libraries, and it changes under us on any
 * host update; a self-hosted NVR cannot assume the host has ffmpeg at all
 * (D536).
 *
 * ## Why the container image is not special any more
 *
 * It was, for one day: the image installed ffmpeg, CamStack preferred it, and
 * that made the answer depend on where a node ran — an image node got VAAPI, a
 * native one got a portable build with none. Now every node downloads the same
 * pinned build, so:
 *
 *  - the ffmpeg version is DATA, not code: changing it is a framework bump, not
 *    an image rebuild and a container swap on every machine;
 *  - we ship no ffmpeg binary, so we convey no GPL work — the node fetches it
 *    from the project that publishes it;
 *  - one binary, one set of capabilities, everywhere. A bug that depends on
 *    which ffmpeg answered stops being possible.
 *
 * What the image still owes is the DRIVERS, which no binary can bring: libva
 * plus the iHD media driver for Intel. Measured 2026-09-19 — the portable build
 * encodes VAAPI inside our container and ABORTS on the bare Unraid host, where
 * `libva-drm.so.2` does not exist.
 *
 * ## Absent is absent
 *
 * The naming carries the release, so two versions coexist during a change and a
 * rollback is a file that is already on disk rather than a download.
 */

import { FFMPEG_RELEASE } from './ffmpeg-artifacts.js'

/** Operator override. Unset on every node unless a human deliberately set it. */
export const FFMPEG_PATH_ENV = 'CAMSTACK_FFMPEG_PATH'

export type FfmpegBinaryOrigin = 'override' | 'downloaded'

export interface FfmpegBinaryChoice {
  readonly origin: FfmpegBinaryOrigin
  readonly path: string
}

export interface FfmpegBinarySourceInput {
  readonly platform: string
  /** `<dataDir>/deps/ffmpeg-<release>` — where the pinned build lands. */
  readonly pinnedPath: string
  /** The raw value of {@link FFMPEG_PATH_ENV}, or null/empty when unset. */
  readonly override: string | null | undefined
  readonly exists: (path: string) => boolean
}

/**
 * The file name the pinned build is stored under.
 *
 * Versioned on purpose: a download is then idempotent, two releases can sit
 * side by side while a change rolls through a cluster, and going back is a path
 * that already exists instead of a fetch that has to succeed.
 */
export function ffmpegBinaryName(platform: string): string {
  const ext = platform === 'win32' ? '.exe' : ''
  return `ffmpeg-${FFMPEG_RELEASE}${ext}`
}

/**
 * The binary to use, or `null` when it has to be downloaded first.
 *
 * An override that does not exist is NOT silently skipped — it is an operator
 * mistake, and falling through to a different binary than the one they named
 * would hide it. The caller reports it and carries on with the pinned build,
 * which is the only safe direction: a typo must not stop a node serving video.
 */
export function chooseFfmpegBinary(input: FfmpegBinarySourceInput): FfmpegBinaryChoice | null {
  const override = input.override?.trim() ?? ''
  if (override.length > 0 && input.exists(override)) {
    return { origin: 'override', path: override }
  }
  if (input.exists(input.pinnedPath)) {
    return { origin: 'downloaded', path: input.pinnedPath }
  }
  return null
}
