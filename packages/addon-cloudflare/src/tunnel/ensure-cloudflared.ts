/**
 * On-demand provisioning of the `cloudflared` binary.
 *
 * `cloudflared` is NOT an npm package and is needed ONLY by this (optional)
 * addon, so it is no longer baked into the base hub image. Instead the addon
 * obtains it the first time a tunnel starts:
 *   1. if `cloudflared` is already on PATH (dev box with brew/apt, or a legacy
 *      image that still ships it) AND is ≥ 2025.4.0 (`--token-file`) → use
 *      that, no download;
 *   2. else if a cached copy exists in the addon's bin dir → use it;
 *   3. else download the right release asset for this OS/arch into the bin dir.
 *
 * Keeping the binary in the addon's own data dir means an optional feature
 * carries its own dependency — the base image stays lean and its build no
 * longer depends on reaching github.com.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IScopedLogger } from '@camstack/types'
import { parseCloudflaredVersion, supportsTokenFile } from './cloudflared-invocation'

/** Default cloudflared release pinned for reproducible downloads. */
export const DEFAULT_CLOUDFLARED_VERSION = '2025.4.2'

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/download'

export interface CloudflaredAsset {
  /** Release asset file name (e.g. `cloudflared-linux-amd64`). */
  readonly fileName: string
  /** True when the asset is a `.tgz` archive that must be extracted. */
  readonly isArchive: boolean
}

/**
 * Map a Node `platform`/`arch` to the matching cloudflared release asset.
 * Pure + exported for testing. Throws on an unsupported combination.
 */
export function cloudflaredAsset(platform: NodeJS.Platform, arch: string): CloudflaredAsset {
  const a = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : null
  if (a === null) throw new Error(`cloudflared: unsupported arch '${arch}'`)
  switch (platform) {
    case 'linux':
      // Bare ELF binary.
      return { fileName: `cloudflared-linux-${a}`, isArchive: false }
    case 'darwin':
      // macOS ships only a .tgz (and only amd64; arm64 runs it via Rosetta).
      return { fileName: `cloudflared-darwin-${a === 'arm64' ? 'amd64' : a}.tgz`, isArchive: true }
    case 'win32':
      return { fileName: `cloudflared-windows-${a}.exe`, isArchive: false }
    default:
      throw new Error(`cloudflared: unsupported platform '${platform}'`)
  }
}

/**
 * Run `<bin> --version` and return its output, or null when the binary is
 * missing / not executable / exits non-zero.
 */
function probeVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    let out = ''
    const finish = (v: string | null): void => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
      child.stderr?.on('data', (c: Buffer) => (out += c.toString('utf8')))
      child.on('error', () => finish(null))
      child.on('exit', (code) => finish(code === 0 ? out : null))
      setTimeout(() => {
        child.kill('SIGKILL')
        finish(null)
      }, 5_000)
    } catch {
      finish(null)
    }
  })
}

/**
 * True when `bin` runs AND is new enough for `tunnel run --token-file`
 * (≥ 2025.4.0). An older binary is treated as absent: the token is never
 * passed on argv or in the environment as a fallback (D783).
 */
async function usable(bin: string): Promise<boolean> {
  const out = await probeVersion(bin)
  return out !== null && supportsTokenFile(parseCloudflaredVersion(out))
}

/** True when `<bin> --version` exits 0 (binary present + executable). */
async function runsOk(bin: string): Promise<boolean> {
  return (await probeVersion(bin)) !== null
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body)
    throw new Error(`cloudflared download failed: HTTP ${res.status} for ${url}`)
  const tmp = `${dest}.partial`
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp))
  await fsp.rename(tmp, dest)
}

/** Extract the `cloudflared` entry from a downloaded .tgz into `destBin`. */
async function extractArchive(
  archivePath: string,
  destBin: string,
  logger: IScopedLogger,
): Promise<void> {
  const dir = path.dirname(destBin)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', dir], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
  })
  // The archive expands to a `cloudflared` file in `dir`; nothing else to move.
  if (!fs.existsSync(destBin)) {
    logger.warn('cloudflared archive did not yield expected binary name', {
      meta: { destBin },
      tags: { topic: 'tunnel', phase: 'extract' },
    })
  }
  await fsp.rm(archivePath, { force: true })
}

export interface EnsureCloudflaredOptions {
  /** Directory to cache the downloaded binary in (e.g. `<dataDir>/bin`). */
  readonly binDir: string
  readonly logger: IScopedLogger
  /** Release version to download when not already present. */
  readonly version?: string
}

/**
 * Return a path/command for a runnable `cloudflared`, downloading + caching it
 * on first use. Prefers an existing PATH install; otherwise caches under
 * `binDir`. Throws (with an actionable message) if it cannot be provisioned.
 */
export async function ensureCloudflared(opts: EnsureCloudflaredOptions): Promise<string> {
  if (await usable('cloudflared')) return 'cloudflared'
  if (await runsOk('cloudflared')) {
    opts.logger.warn(
      'cloudflared on PATH predates --token-file (< 2025.4.0) — using a pinned copy',
      {
        tags: { topic: 'tunnel', phase: 'provision' },
      },
    )
  }

  const cached = path.join(
    opts.binDir,
    os.platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared',
  )
  // A cached copy older than the token-file floor is re-downloaded over.
  if (fs.existsSync(cached) && (await usable(cached))) return cached

  const version = opts.version ?? DEFAULT_CLOUDFLARED_VERSION
  const asset = cloudflaredAsset(os.platform(), os.arch())
  const url = `${RELEASE_BASE}/${version}/${asset.fileName}`
  await fsp.mkdir(opts.binDir, { recursive: true })

  opts.logger.info('Provisioning cloudflared (not on PATH) — downloading', {
    meta: { version, asset: asset.fileName, dest: cached },
    tags: { topic: 'tunnel', phase: 'provision' },
  })

  if (asset.isArchive) {
    const archive = path.join(opts.binDir, asset.fileName)
    await downloadTo(url, archive)
    await extractArchive(archive, cached, opts.logger)
  } else {
    await downloadTo(url, cached)
  }
  await fsp.chmod(cached, 0o755)

  if (!(await usable(cached))) {
    throw new Error(
      `cloudflared ${version} downloaded to ${cached} but is not runnable or predates --token-file`,
    )
  }
  opts.logger.info('cloudflared ready', {
    meta: { path: cached, version },
    tags: { topic: 'tunnel', phase: 'provision-done' },
  })
  return cached
}
