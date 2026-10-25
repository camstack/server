/**
 * Download portable Python (headless) from bjia56/portable-python.
 *
 * Source: https://github.com/bjia56/portable-python
 *
 * Advantages over python-build-standalone:
 * - macOS universal2 binary (arm64+x86_64 in one)
 * - Lighter (~24-28MB headless zip)
 * - glibc 2.17 minimum (better compat)
 * - Headless variant excludes tkinter/UI (ideal for ML inference)
 *
 * The zip's top-level dir is platform-specific (e.g.
 * `python-headless-3.12.12-darwin-universal2/`); after extraction
 * we rename it to a stable `python/` so consumers can rely on
 * `<dataDir>/deps/python/bin/python3` (`bin/python.exe` on Windows: that build
 * keeps its launcher in `bin/` beside the DLLs, with `Lib/` at the root, so
 * `<root>/bin/<interpreter>` holds on every platform).
 */
import { join, basename } from 'node:path'
import {
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extractArchive } from './archive-extract.js'
import { verifySha256 } from './binary-downloader.js'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createWriteStream } from 'node:fs'
import type { IScopedLogger } from '../interfaces/logging.js'
import { errMsg } from '../utils/err-msg.js'

export const PYTHON_VERSION = '3.12.12'
const PP_BASE = `https://github.com/bjia56/portable-python/releases/download/cpython-v${PYTHON_VERSION}-build.0`

/**
 * One pinned artifact per target. The publisher ships no checksums on its
 * assets, so these are ours, taken (`shasum -a 256`) when the version was
 * pinned; the download is verified against them before a byte is extracted.
 * The Windows build is the same upstream, release and `headless` variant.
 */
const PYTHON_SHA256: Readonly<Record<string, string>> = {
  'linux-x86_64': 'b618bcf490ab24fcfcd8f69e091b9d6f3ba23279dd1255aa258617a4d2af6fb7',
  'linux-aarch64': 'de204124ee834851c77e3392b00c3950869d349f99dbc7345f8cd5959bdee5bf',
  'darwin-universal2': '7de186d2f865c9c9544dab2cf56d38de99767e243ed21ed7e1b0c31451783584',
  'windows-x86_64': '84c10dd1a202da4694f41a1f99aee359c7c1276355937401d2f8facd9567d026',
}

/** The upstream target token for a platform/arch, e.g. `windows-x86_64`. */
function pythonTarget(platform: string, arch: string): string {
  switch (platform) {
    case 'linux': {
      const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' }
      const a = archMap[arch]
      if (!a) throw new Error(`Unsupported Linux architecture for Python: ${arch}`)
      return `linux-${a}`
    }
    case 'darwin':
      // universal2 covers both arm64 and x86_64
      return 'darwin-universal2'
    case 'win32':
      if (arch !== 'x64') throw new Error(`Unsupported Windows architecture for Python: ${arch}`)
      return 'windows-x86_64'
    default:
      throw new Error(`Unsupported platform for portable Python: ${platform}`)
  }
}

export function getPythonDownloadUrl(platform: string, arch: string): string {
  return `${PP_BASE}/python-headless-${PYTHON_VERSION}-${pythonTarget(platform, arch)}.zip`
}

/** The SHA-256 the archive for this platform/arch must have. */
export function getPythonSha256(platform: string, arch: string): string {
  const sha = PYTHON_SHA256[pythonTarget(platform, arch)]
  if (sha === undefined) throw new Error(`No pinned checksum for Python on ${platform}-${arch}`)
  return sha
}

/** The interpreter's path relative to the install root. */
export function pythonInterpreterSegments(platform: string): readonly string[] {
  return platform === 'win32' ? ['bin', 'python.exe'] : ['bin', 'python3']
}

/**
 * Ensure the embedded portable Python is available.
 *
 * ALWAYS returns the path to the embedded interpreter under
 * `<dataDir>/deps/python/bin/python3` — downloads it on first call
 * and reuses it thereafter. The system PATH is intentionally NOT
 * consulted: addons rely on `installPythonRequirements()` to manage
 * deps inside the embedded site-packages, and a system interpreter
 * (different version, missing modules) silently breaks that contract.
 *
 * Returns null only if the download/extract step fails.
 */
export async function ensurePython(dataDir: string, logger: IScopedLogger): Promise<string | null> {
  const pythonDir = join(dataDir, 'deps', 'python')
  const pythonBin = join(pythonDir, ...pythonInterpreterSegments(process.platform))

  // 1. Already downloaded
  if (existsSync(pythonBin)) {
    logger.debug('Portable Python found', { meta: { pythonBin } })
    return pythonBin
  }

  // 2. Download portable python (no system PATH fallback — by design)
  logger.info('Downloading portable Python (headless)', { meta: { version: PYTHON_VERSION } })

  const depsDir = join(dataDir, 'deps')
  mkdirSync(depsDir, { recursive: true })

  const url = getPythonDownloadUrl(process.platform, process.arch)
  const tmpArchive = join(depsDir, 'python-download.zip')

  logger.info('Python download source', { meta: { url } })

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    logger.warn('Failed to download Python — ML detection will not be available', {
      meta: { status: response.status },
    })
    return null
  }

  const nodeStream = Readable.fromWeb(response.body as ReadableStream)
  await pipeline(nodeStream, createWriteStream(tmpArchive))

  // Extract — zip's top-level dir is e.g. `python-headless-3.12.12-darwin-universal2/`
  // (varies per platform/arch).
  // The sha256 is verified first: the bytes are the ones pinned, or nothing is
  // extracted and the partial file is removed.
  verifySha256(tmpArchive, getPythonSha256(process.platform, process.arch), 'python', url)
  extractArchive(tmpArchive, 'zip', depsDir)

  // Cleanup the archive
  const { unlinkSync } = await import('node:fs')
  unlinkSync(tmpArchive)

  // Locate the extracted directory and normalize it to `<depsDir>/python/`.
  // The zip's top-level name varies by platform (e.g.
  // `python-headless-3.12.12-darwin-universal2/`), so we look for any
  // `python-*` subdir that contains the expected interpreter and rename it.
  if (!existsSync(pythonBin)) {
    const candidates = readdirSync(depsDir).filter(
      (name) =>
        name.startsWith('python-') &&
        existsSync(join(depsDir, name, ...pythonInterpreterSegments(process.platform))),
    )
    if (candidates.length === 0) {
      logger.warn('Python extraction succeeded but no python3 binary found in any subdir', {
        meta: { depsDir },
      })
      return null
    }
    const extractedRoot = join(depsDir, candidates[0]!)
    // Drop any stale `python/` (e.g. from a previous failed install)
    // before renaming so the move always succeeds.
    if (existsSync(pythonDir)) {
      rmSync(pythonDir, { recursive: true, force: true })
    }
    renameSync(extractedRoot, pythonDir)
  }

  if (!existsSync(pythonBin)) {
    logger.warn('Python extraction succeeded but binary not found at expected path', {
      meta: { pythonBin },
    })
    return null
  }

  chmodSync(pythonBin, 0o755)

  // On macOS the bjia56 build is universal2 — the host arch is decided
  // at spawn time based on the parent process. That makes pip wheels
  // and runtime spawns silently disagree when the server is launched
  // from a Rosetta shell once and a native shell next time (e.g. pip
  // installs `numpy x86_64`, then the next boot under arm64 fails with
  // `incompatible architecture`). Lock the slice deterministically by
  // wrapping `python3` in a shell stub that always invokes the matching
  // host arch via `/usr/bin/arch`. Idempotent: detected via the renamed
  // `.real` binary.
  if (process.platform === 'darwin') {
    const realBin = join(pythonDir, 'bin', 'python3.real')
    if (!existsSync(realBin)) {
      renameSync(pythonBin, realBin)
      const archFlag = process.arch === 'arm64' ? '-arm64' : '-x86_64'
      writeFileSync(pythonBin, `#!/bin/sh\nexec /usr/bin/arch ${archFlag} "${realBin}" "$@"\n`)
      chmodSync(pythonBin, 0o755)
      // Mirror the same wrapping for the `python` symlink so consumers
      // that use the un-versioned name also lock the arch.
      const pyAlt = join(pythonDir, 'bin', 'python')
      if (existsSync(pyAlt)) {
        try {
          rmSync(pyAlt, { force: true })
        } catch {
          // ignore
        }
        writeFileSync(pyAlt, `#!/bin/sh\nexec /usr/bin/arch ${archFlag} "${realBin}" "$@"\n`)
        chmodSync(pyAlt, 0o755)
      }
      logger.info('Locked python3 to host arch via shell stub', {
        meta: { archFlag, realBin },
      })
    }
  }

  logger.info('Portable Python installed', { meta: { version: PYTHON_VERSION, pythonBin } })
  return pythonBin
}

/**
 * Install Python packages into the portable Python environment.
 */
export async function installPythonPackages(
  pythonPath: string,
  packages: readonly string[],
  logger: IScopedLogger,
): Promise<void> {
  if (packages.length === 0) return

  logger.info('Installing Python packages', { meta: { packages } })
  try {
    execFileSync(pythonPath, ['-m', 'pip', 'install', '--quiet', ...packages], {
      stdio: 'pipe',
      timeout: 300_000, // 5 minutes for large packages like torch
    })
    logger.info('Python packages installed successfully')
  } catch (err) {
    logger.error('Failed to install Python packages', { meta: { error: errMsg(err) } })
    throw err
  }
}

/**
 * Install a pip requirements file into the embedded Python.
 *
 * Idempotent: keyed on (requirements file basename + sha256 of its
 * contents). The marker is written under
 * `<python-install-dir>/.requirements-installed/` so it lives and
 * dies with the python install — re-downloading python wipes both
 * the site-packages and the markers, forcing a fresh re-install.
 *
 * The marker is updated only after `pip install` succeeds. A failed
 * install never writes a marker, so the next call retries.
 */
export async function installPythonRequirements(
  pythonPath: string,
  requirementsFile: string,
  logger: IScopedLogger,
): Promise<void> {
  if (!existsSync(requirementsFile)) {
    throw new Error(`Requirements file not found: ${requirementsFile}`)
  }

  const contents = readFileSync(requirementsFile)
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16)
  const fileBase = basename(requirementsFile).replace(/\.txt$/i, '')

  // Markers live under the python install dir → wiped together when
  // the embedded interpreter is re-downloaded.
  const pythonRoot = join(pythonPath, '..', '..') // <root>/bin/<interpreter> → <root>
  const markerDir = join(pythonRoot, '.requirements-installed')
  const markerPath = join(markerDir, `${fileBase}-${hash}.marker`)

  if (existsSync(markerPath)) {
    logger.debug('Python requirements already installed', { meta: { requirementsFile, hash } })
    return
  }

  logger.info('Installing Python requirements', { meta: { requirementsFile, hash } })
  try {
    execFileSync(
      pythonPath,
      ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', requirementsFile],
      {
        stdio: 'pipe',
        timeout: 600_000, // 10 minutes — coremltools + tensorflow can be slow
      },
    )
  } catch (err) {
    logger.error('Failed to install Python requirements', {
      meta: { requirementsFile, error: errMsg(err) },
    })
    throw err
  }

  mkdirSync(markerDir, { recursive: true })
  writeFileSync(markerPath, `${requirementsFile}\n${new Date().toISOString()}\n`)
  logger.info('Python requirements installed', { meta: { requirementsFile, hash } })
}
