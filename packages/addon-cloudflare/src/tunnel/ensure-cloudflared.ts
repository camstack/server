/**
 * On-demand provisioning of the `cloudflared` binary.
 *
 * `cloudflared` is NOT an npm package and is needed ONLY by this (optional)
 * addon, so it is no longer baked into the base hub image. Instead the addon
 * obtains it the first time a tunnel starts:
 *   1. if `cloudflared` is on PATH (dev box with brew/apt, or a legacy image
 *      that still ships it) AND is ≥ {@link MIN_CLOUDFLARED_VERSION} → use it;
 *   2. else if a cached copy in the addon's bin dir is ≥ the minimum → use it;
 *   3. else download the pinned release asset for this OS/arch, verify its
 *      SHA-256 and that it runs and meets the minimum, then atomically move it
 *      into place. A cached copy below the minimum is replaced; a PATH copy
 *      below the minimum is skipped.
 *
 * Keeping the binary in the addon's own data dir means an optional feature
 * carries its own dependency — the base image stays lean and its build no
 * longer depends on reaching github.com.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IScopedLogger } from '@camstack/types'
import {
  parseCloudflaredVersion,
  versionAtLeast,
  type CloudflaredVersion,
} from './cloudflared-invocation'

/** Default cloudflared release pinned for reproducible downloads. */
export const DEFAULT_CLOUDFLARED_VERSION = '2026.10.5'

/**
 * Oldest cloudflared this addon will run. 2026.10.5 carries the fix for
 * corrupted certificates; older builds (the hub ran 2025.4.2) are never used —
 * a cached one is re-downloaded over, a PATH one is skipped. Raise it together
 * with {@link DEFAULT_CLOUDFLARED_VERSION} (and add that version's checksums).
 */
export const MIN_CLOUDFLARED_VERSION: CloudflaredVersion = [2026, 10, 5]

/** Expected SHA-256 (hex) per release version, per asset file name. */
export type ChecksumTable = Readonly<Record<string, Readonly<Record<string, string>>>>

/**
 * SHA-256 of the pinned release's assets, shipped as constants (not fetched
 * from the release notes: the notes list the darwin `.tgz` with a hash that
 * does not match the downloadable archive, and a fetch adds a second network
 * dependency on the provisioning path). Taken from the GitHub release asset
 * digests and checked against downloaded bytes. A version not listed here is
 * refused.
 */
export const CLOUDFLARED_SHA256: ChecksumTable = {
  '2026.10.5': {
    'cloudflared-linux-amd64': 'e1bc0cf084fd9e590554fe769a86b1db46701c3f847a43d902f7b974a4e16298',
    'cloudflared-linux-arm64': '72e0d05a67e09da87cf495e409a28c3cc5994dd23fc66a982eebea6a55923b7d',
    'cloudflared-linux-arm': 'a018911e1bbfd739937f3011f589e9e73245baeee14742f8b3413472bb007adc',
    'cloudflared-darwin-amd64.tgz':
      '6699392fed92367808c248c2d90bed66e49bbf66e1b4ee3e4141230f3f7391b3',
    'cloudflared-windows-amd64.exe':
      'db4e4c413612a0916f3e1679d3caaf376f94911952d163028fb726fb2e0516a9',
  },
}

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/download'

const PROVISION_TAGS = { topic: 'tunnel', phase: 'provision' } as const

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
      return {
        fileName: `cloudflared-darwin-${a === 'arm64' ? 'amd64' : a}.tgz`,
        isArchive: true,
      }
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
      const child = spawn(bin, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
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

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body)
    throw new Error(`cloudflared download failed: HTTP ${res.status} for ${url}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
}

/** Extract the `cloudflared` entry of a .tgz into `intoDir` (a scratch dir). */
function extractArchive(archivePath: string, intoDir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', intoDir], {
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
  })
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

/** The side effects of provisioning, replaceable in tests. */
export interface EnsureCloudflaredDeps {
  /** `<bin> --version` output, or null when the binary does not run. */
  readonly probeVersion: (bin: string) => Promise<string | null>
  /** Download `url` into the file `dest`. */
  readonly download: (url: string, dest: string) => Promise<void>
  /** Extract the `cloudflared` entry of `.tgz` into the directory `intoDir`. */
  readonly extract: (archive: string, intoDir: string) => Promise<void>
  /** Remove one entry of the bin dir (a file, a symlink itself, or a directory tree). */
  readonly remove?: (entry: string) => Promise<void>
}

/** Remove an entry without ever following a symlink out of its directory. */
async function removeEntry(entry: string): Promise<void> {
  const st = await fsp.lstat(entry)
  if (st.isDirectory()) await fsp.rm(entry, { recursive: true, force: true })
  else await fsp.unlink(entry)
}

/** Bytes an entry occupies; symlinks count as themselves, never their target. */
async function entryBytes(entry: string): Promise<number> {
  const st = await fsp.lstat(entry)
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const name of await fsp.readdir(entry)) total += await entryBytes(path.join(entry, name))
  return total
}

/** Scratch dirs of provisions running in THIS process; a sweep must not touch them. */
const activeScratch = new Set<string>()

/**
 * The bin dir is owned by this addon: it holds the current binary and nothing
 * else. Remove every other entry (crashed `.provision-*` dirs, old archives,
 * backups, `.old` files). Never follows a symlink, never removes `binDir`
 * itself; a failure on one entry is a warning, never a failed provision.
 */
async function sweepBinDir(
  binDir: string,
  keep: ReadonlySet<string>,
  deps: EnsureCloudflaredDeps,
  logger: IScopedLogger,
): Promise<void> {
  let names: string[]
  try {
    names = await fsp.readdir(binDir)
  } catch {
    return // no bin dir yet: nothing to sweep
  }
  const removed: string[] = []
  let freed = 0
  for (const name of names) {
    const entry = path.join(binDir, name)
    if (keep.has(name) || activeScratch.has(entry)) continue
    try {
      const bytes = await entryBytes(entry)
      await (deps.remove ?? removeEntry)(entry)
      removed.push(name)
      freed += bytes
    } catch (err) {
      logger.warn('could not remove a stale entry from the cloudflared bin dir', {
        meta: { entry: name, error: err instanceof Error ? err.message : String(err) },
        tags: PROVISION_TAGS,
      })
    }
  }
  if (removed.length > 0) {
    logger.info('removed stale entries from the cloudflared bin dir', {
      meta: { removed, bytesFreed: freed },
      tags: PROVISION_TAGS,
    })
  }
}

const DEFAULT_DEPS: EnsureCloudflaredDeps = {
  probeVersion,
  download: downloadTo,
  extract: extractArchive,
}

export interface EnsureCloudflaredOptions {
  /** Directory to cache the downloaded binary in (e.g. `<dataDir>/bin`). */
  readonly binDir: string
  readonly logger: IScopedLogger
  /** Release version to download when no acceptable copy is present. */
  readonly version?: string
  /** Expected SHA-256 table; defaults to {@link CLOUDFLARED_SHA256}. */
  readonly checksums?: ChecksumTable
  readonly deps?: EnsureCloudflaredDeps
}

const formatVersion = (v: CloudflaredVersion | null): string => (v ? v.join('.') : 'unknown')
const REQUIRED = MIN_CLOUDFLARED_VERSION.join('.')

/**
 * Return a path/command for a runnable `cloudflared` ≥ the minimum, downloading
 * + verifying the pinned release when neither PATH nor the cache has one.
 * Throws (with an actionable message) if it cannot be provisioned; a failed
 * attempt never touches a working cached binary.
 */
export async function ensureCloudflared(opts: EnsureCloudflaredOptions): Promise<string> {
  const deps = opts.deps ?? DEFAULT_DEPS
  const probe = async (
    bin: string,
  ): Promise<{ runs: boolean; version: CloudflaredVersion | null }> => {
    const out = await deps.probeVersion(bin)
    return {
      runs: out !== null,
      version: out === null ? null : parseCloudflaredVersion(out),
    }
  }

  const binName = os.platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const onPath = await probe('cloudflared')
  if (versionAtLeast(onPath.version, MIN_CLOUDFLARED_VERSION)) {
    // PATH wins, so binDir's cached copy is stale too: sweep all of it.
    await sweepBinDir(opts.binDir, new Set(), deps, opts.logger)
    return 'cloudflared'
  }
  if (onPath.runs) {
    opts.logger.warn('cloudflared on PATH is below the minimum — skipping it for the pinned copy', {
      meta: { found: formatVersion(onPath.version), required: REQUIRED },
      tags: PROVISION_TAGS,
    })
  }

  const cached = path.join(opts.binDir, binName)
  const haveCached = fs.existsSync(cached)
  if (haveCached) {
    const c = await probe(cached)
    if (versionAtLeast(c.version, MIN_CLOUDFLARED_VERSION)) {
      await sweepBinDir(opts.binDir, new Set([binName]), deps, opts.logger)
      return cached
    }
    opts.logger.warn('cached cloudflared is below the minimum — replacing it', {
      meta: {
        found: c.runs ? formatVersion(c.version) : 'not runnable',
        required: REQUIRED,
      },
      tags: PROVISION_TAGS,
    })
  }

  const version = opts.version ?? DEFAULT_CLOUDFLARED_VERSION
  const asset = cloudflaredAsset(os.platform(), os.arch())
  const expected = (opts.checksums ?? CLOUDFLARED_SHA256)[version]?.[asset.fileName]
  if (expected === undefined) {
    throw new Error(`cloudflared ${version}: no known checksum for ${asset.fileName} — refusing`)
  }
  const url = `${RELEASE_BASE}/${version}/${asset.fileName}`
  await fsp.mkdir(opts.binDir, { recursive: true })

  opts.logger.info('Provisioning cloudflared — downloading', {
    meta: { version, asset: asset.fileName, dest: cached, required: REQUIRED },
    tags: PROVISION_TAGS,
  })

  // Everything lands in a scratch dir inside binDir (same filesystem, so the
  // final rename is atomic); the working cached binary is only replaced after
  // the candidate is verified.
  const scratch = await fsp.mkdtemp(path.join(opts.binDir, '.provision-'))
  activeScratch.add(scratch)
  try {
    const downloaded = path.join(scratch, asset.fileName)
    await deps.download(url, downloaded)
    const actual = await sha256Of(downloaded)
    if (actual !== expected) {
      throw new Error(
        `cloudflared ${version} checksum mismatch for ${asset.fileName} (expected ${expected}, got ${actual}) — refusing`,
      )
    }
    let candidate = downloaded
    if (asset.isArchive) {
      const unpacked = path.join(scratch, 'unpacked')
      await fsp.mkdir(unpacked)
      await deps.extract(downloaded, unpacked)
      candidate = path.join(unpacked, 'cloudflared')
    }
    await fsp.chmod(candidate, 0o755)
    const c = await probe(candidate)
    if (!versionAtLeast(c.version, MIN_CLOUDFLARED_VERSION)) {
      throw new Error(
        `cloudflared ${version} downloaded but is ${c.runs ? formatVersion(c.version) : 'not runnable'}, below the minimum ${REQUIRED} — refusing`,
      )
    }
    await fsp.rename(candidate, cached)
    await sweepBinDir(opts.binDir, new Set([binName]), deps, opts.logger)
    opts.logger.info('cloudflared ready', {
      meta: {
        path: cached,
        version,
        found: formatVersion(c.version),
        replaced: haveCached,
      },
      tags: { topic: 'tunnel', phase: 'provision-done' },
    })
    return cached
  } catch (err) {
    opts.logger.error('cloudflared provisioning refused — keeping the existing binary', {
      meta: {
        version,
        error: err instanceof Error ? err.message : String(err),
      },
      tags: PROVISION_TAGS,
    })
    throw err
  } finally {
    activeScratch.delete(scratch)
    await fsp.rm(scratch, { recursive: true, force: true })
  }
}
