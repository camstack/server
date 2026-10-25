import {
  existsSync,
  mkdirSync,
  chmodSync,
  createWriteStream,
  unlinkSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extractArchive } from './archive-extract.js'
import type { IScopedLogger } from '../interfaces/logging.js'

/**
 * Recursively find the first file named exactly `name` under `dir`. Used as the
 * archive-extraction fallback when the declared inner path misses (the archive's
 * top-level dir carries an unpredictable version/arch, e.g. johnvansickle's
 * `ffmpeg-<version>-<arch>-static/`). Returns the absolute path, or `null`.
 */
export function findFileByName(dir: string, name: string): string | null {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const nested = findFileByName(full, name)
        if (nested !== null) return nested
      } else if (entry.isFile() && entry.name === name) {
        return full
      }
    }
  } catch {
    // Unreadable dir → treat as no match.
  }
  return null
}

export interface PlatformInfo {
  readonly platform: NodeJS.Platform
  readonly arch: NodeJS.Architecture
}

export function getPlatformInfo(): PlatformInfo {
  return {
    platform: process.platform,
    arch: process.arch,
  }
}

export function buildBinaryPath(dataDir: string, name: string, platform?: string): string {
  const ext = (platform ?? process.platform) === 'win32' ? '.exe' : ''
  return join(dataDir, 'deps', `${name}${ext}`)
}

/** Check if a binary exists in PATH */
export function findInPath(name: string): string | null {
  try {
    execFileSync(name, ['--version'], { stdio: 'pipe', timeout: 5000 })
    return name
  } catch {
    return null
  }
}

export interface DownloadOptions {
  readonly name: string
  readonly url: string
  readonly targetDir: string
  readonly targetName: string
  readonly logger: IScopedLogger
  readonly isArchive?: boolean
  readonly archiveFormat?: 'zip' | 'tar.gz' | 'tar.xz'
  /** Relative path within archive to the binary (e.g., 'ffmpeg-6.1/bin/ffmpeg') */
  readonly archiveInnerPath?: string
  /**
   * SHA-256 the downloaded ARCHIVE must have, verified before a byte of it is
   * extracted.
   *
   * Optional only because the python downloader predates it. For ffmpeg it is
   * not optional in practice: the download is the ONLY source of the binary
   * every transcode runs through, it arrives over a redirect to a third-party
   * host, and the publisher ships no checksums of its own — so ours is the only
   * thing standing between a changed artifact and a silent swap of the most
   * privileged subprocess this system spawns.
   */
  readonly sha256?: string
}

/**
 * Refuse an artifact that is not the one we pinned, and leave nothing behind.
 *
 * The failure is deliberately loud and terminal rather than a warning: a
 * mismatch means the bytes are not what was verified, and "not what was
 * verified" is the only state in which running this binary is worse than not
 * having it. The partial file is removed so a retry cannot pick it up.
 */
export function verifySha256(
  file: string,
  expected: string | undefined,
  name: string,
  url: string,
): void {
  if (expected === undefined) return
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual === expected) return
  try {
    unlinkSync(file)
  } catch {
    // Best effort — the throw below is what matters.
  }
  throw new Error(
    `${name}: downloaded artifact does not match its pinned checksum — refusing it. ` +
      `url=${url} expected=${expected} actual=${actual}`,
  )
}

/**
 * Download a binary to the target directory.
 * Handles archives (zip, tar.gz, tar.xz) and raw binaries.
 */
export async function downloadBinary(opts: DownloadOptions): Promise<string> {
  const { name, url, targetDir, targetName, logger, isArchive, archiveFormat, archiveInnerPath } =
    opts
  const targetPath = join(targetDir, targetName)

  if (existsSync(targetPath)) {
    logger.debug('Binary already exists', { meta: { name, targetPath } })
    return targetPath
  }

  mkdirSync(targetDir, { recursive: true })

  logger.info('Downloading binary', { meta: { name, url } })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${name}: ${response.status} ${response.statusText}`)
  }

  if (isArchive) {
    const ext = archiveFormat ?? 'tar.gz'
    const tmpArchive = join(targetDir, `${name}-download.${ext}`)
    const nodeStream = Readable.fromWeb(response.body as ReadableStream)
    await pipeline(nodeStream, createWriteStream(tmpArchive))
    verifySha256(tmpArchive, opts.sha256, name, url)

    // Extract
    const tmpExtractDir = join(targetDir, `${name}-extract`)
    mkdirSync(tmpExtractDir, { recursive: true })

    extractArchive(tmpArchive, ext, tmpExtractDir)

    // Copy binary from archive
    if (archiveInnerPath) {
      const { copyFileSync } = await import('node:fs')
      let sourcePath = join(tmpExtractDir, archiveInnerPath)
      if (!existsSync(sourcePath)) {
        // The archive's top-level dir usually carries the build VERSION and
        // ARCH (johnvansickle: `ffmpeg-<version>-<arch>-static/`), which a
        // hardcoded inner path can't predict — a version bump or an arm64 host
        // breaks the literal path. Fall back to a recursive search for the
        // binary by name so ANY archive layout resolves.
        const found =
          findFileByName(tmpExtractDir, targetName) ?? findFileByName(tmpExtractDir, name)
        if (found === null) {
          throw new Error(
            `Binary "${name}" not found in archive (tried inner path "${archiveInnerPath}" and a recursive search)`,
          )
        }
        sourcePath = found
      }
      copyFileSync(sourcePath, targetPath)
    }

    // Cleanup
    unlinkSync(tmpArchive)
    const { rmSync } = await import('node:fs')
    rmSync(tmpExtractDir, { recursive: true, force: true })
  } else {
    // Direct binary download
    const nodeStream = Readable.fromWeb(response.body as ReadableStream)
    await pipeline(nodeStream, createWriteStream(targetPath))
    verifySha256(targetPath, opts.sha256, name, url)
  }

  chmodSync(targetPath, 0o755)
  logger.info('Binary downloaded', { meta: { name, targetPath } })
  return targetPath
}

/**
 * Ensure a binary is available. Checks:
 * 1. Target path (already downloaded)
 * 2. System PATH
 * 3. Download from URL
 */
export async function ensureBinary(opts: {
  readonly name: string
  readonly targetDir: string
  readonly downloadUrl: string
  readonly logger: IScopedLogger
  readonly isArchive?: boolean
  readonly archiveFormat?: 'zip' | 'tar.gz' | 'tar.xz'
  readonly archiveInnerPath?: string
}): Promise<string> {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const targetName = `${opts.name}${ext}`
  const targetPath = join(opts.targetDir, targetName)

  // 1. Already downloaded
  if (existsSync(targetPath)) {
    opts.logger.debug('Binary found at target path', { meta: { name: opts.name, targetPath } })
    return targetPath
  }

  // 2. System PATH
  const inPath = findInPath(opts.name)
  if (inPath) {
    opts.logger.info('Binary found in system PATH', { meta: { name: opts.name } })
    return inPath
  }

  // 3. Download
  return downloadBinary({
    name: opts.name,
    url: opts.downloadUrl,
    targetDir: opts.targetDir,
    targetName,
    logger: opts.logger,
    isArchive: opts.isArchive,
    archiveFormat: opts.archiveFormat,
    archiveInnerPath: opts.archiveInnerPath,
  })
}
