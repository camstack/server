/**
 * Provisioning the ffmpeg binary for this node.
 *
 * WHICH build, and why every node downloads the same one instead of using
 * anything the machine already has, is in `ffmpeg-binary-source.ts` and
 * `ffmpeg-artifacts.ts`. This module is the act: resolve, download if needed,
 * probe, and say what it got.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { IScopedLogger } from '../interfaces/logging.js'
import { downloadBinary } from './binary-downloader.js'
import { probeFfmpegBinary } from '../ffmpeg/binary-capabilities.js'
import { FFMPEG_PATH_ENV, chooseFfmpegBinary, ffmpegBinaryName } from './ffmpeg-binary-source.js'
import { FFMPEG_RELEASE, getFfmpegArtifact, getFfmpegDownloadUrl } from './ffmpeg-artifacts.js'

/**
 * The ffmpeg this node runs, downloading the pinned build if it is not here
 * yet, and reporting what it got.
 *
 * Order: the operator's `CAMSTACK_FFMPEG_PATH` → the pinned build already on
 * disk → download it. No PATH, no image copy, no per-platform special case —
 * see `ffmpeg-binary-source.ts` for why the image stopped being special after
 * exactly one day.
 *
 * The line it logs is half the point. "Which ffmpeg am I running, and does it
 * have vaapi" had no answer anywhere in the product, and that is what let a
 * hardware-incapable binary serve every transcode on a hub with a working iGPU
 * for months. The other half is the assertion beneath it: a build that probes
 * short of what its artifact claims is a source that changed under us, and it
 * says so with both lists.
 */
export async function ensureFfmpeg(dataDir: string, logger: IScopedLogger): Promise<string> {
  const depsDir = join(dataDir, 'deps')
  const platform = process.platform
  const arch = process.arch
  const pinnedPath = join(depsDir, ffmpegBinaryName(platform))
  const override = process.env[FFMPEG_PATH_ENV]

  const chosen = chooseFfmpegBinary({ platform, pinnedPath, override, exists: existsSync })

  if (override !== undefined && override.trim().length > 0 && chosen?.origin !== 'override') {
    logger.error(`${FFMPEG_PATH_ENV} names a binary that does not exist — ignoring it`, {
      meta: { [FFMPEG_PATH_ENV]: override },
    })
  }

  const artifact = chosen === null ? getFfmpegArtifact(platform, arch) : null
  if (artifact !== null) {
    logger.info('ffmpeg is not on this node yet — downloading the pinned build', {
      meta: {
        release: FFMPEG_RELEASE,
        url: artifact.url,
        sizeMb: Math.round(artifact.sizeBytes / 1_000_000),
      },
    })
  }
  const path =
    chosen?.path ??
    (await downloadBinary({
      name: 'ffmpeg',
      url: artifact?.url ?? getFfmpegDownloadUrl(platform, arch),
      targetDir: depsDir,
      targetName: ffmpegBinaryName(platform),
      logger,
      isArchive: true,
      archiveFormat: artifact?.archiveFormat ?? 'tar.xz',
      // The archive holds `ffmpeg` and `ffprobe` at its root; the recursive
      // fallback finds the one we asked for whatever the layout.
      archiveInnerPath: 'ffmpeg',
      ...(artifact === null ? {} : { sha256: artifact.sha256 }),
    }))

  const capabilities = await probeFfmpegBinary(path)
  logger.info('ffmpeg binary resolved', {
    meta: {
      path,
      origin: chosen?.origin ?? 'downloaded',
      release: FFMPEG_RELEASE,
      version: capabilities.version,
      hwaccels: [...capabilities.hwaccels].join(',') || 'none',
    },
  })

  // A build that cannot do what its artifact promises is a SOURCE that changed
  // under us. Nothing said so when a static build turned out to carry no VAAPI,
  // and that silence is what let it serve every transcode for months (D536).
  // An OVERRIDE is exempt: the operator's own build is theirs to characterise.
  if (chosen?.origin !== 'override') {
    const expected = getFfmpegArtifact(platform, arch).expectedHwaccels
    const missing = expected.filter((name) => !capabilities.hwaccels.has(name))
    if (missing.length > 0) {
      logger.error(
        'this ffmpeg cannot do what its artifact is supposed to — the source changed under us',
        {
          meta: {
            path,
            release: FFMPEG_RELEASE,
            expected: expected.join(','),
            missing: missing.join(','),
            got: [...capabilities.hwaccels].join(',') || 'none',
          },
        },
      )
    }
  }
  return path
}
