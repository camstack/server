/**
 * `ensureNativePrebuilds` — the post-install native-prebuild ENSURE step the
 * shared `RootUpdateService` runs while staging a `@camstack/server` closure,
 * BEFORE its `findMissingNativePrebuilds` validator (in `@camstack/node-root`)
 * decides whether to arm the swap.
 *
 * Why this exists (Mac desktop incident, 2026-07-21): a runtime
 * `applyServerUpdate` on a packaged desktop stages the closure with
 * `npm install @camstack/server@X` under the app's BUNDLED bare Node. The one
 * TRADITIONAL (non-N-API) native, `better-sqlite3`, resolves its `.node` via
 * its `install` script `prebuild-install || node-gyp rebuild`. On a user's Mac
 * with no build toolchain (and where the auto `prebuild-install` does not
 * target the bundled Node's ABI/arch the way the DMG build's EXPLICIT
 * `prebuild-install --runtime node --target <bundled> --arch <arch>` call does)
 * that leaves the module SOURCE-ONLY → the closure has no `better-sqlite3`
 * `.node` → the validator refuses the swap ("staged closure missing native
 * prebuilds: better-sqlite3"). The docker image never hits this: its Node ABI
 * has a published prebuild the auto path fetches cleanly, and it carries a
 * build toolchain fallback.
 *
 * This mirrors the DMG build's explicit re-fetch (`scripts/stage-deps.mjs`)
 * into the runtime staging path: for each traditional native that is present
 * in the closure but missing its compiled `.node`, fetch the prebuild for the
 * RUNNING Node ABI/arch (the same Node that will load the swapped closure).
 *
 * N-API natives (`sharp`, `node-av`) are ABI-stable and ship their binaries as
 * platform SIBLING packages that npm fetches reliably with no compile step, so
 * they are not in scope here — a genuine miss there is a broken install the
 * validator should still reject, not something a prebuild re-fetch can heal.
 *
 * Injected into the update service from the construction site so the zero-dep
 * `@camstack/node-root` layer never depends on npm/@camstack/system, and the
 * fetch is unit-testable with a fake fetcher.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { errMsg } from '@camstack/types/addon'
import type { IScopedLogger } from '@camstack/types'

const execFileAsync = promisify(execFile)

/** Bounded recursive `.node` scan depth inside a module dir. */
export const NATIVE_SCAN_DEPTH = 4

/** Timeout for a single `prebuild-install` fetch. */
const PREBUILD_FETCH_TIMEOUT_MS = 120_000

/**
 * Traditional (compile-or-prebuild) natives an installed closure must carry a
 * `.node` for. Only these are ENSURE-able by a prebuild re-fetch; N-API natives
 * are excluded (see file header).
 */
export const TRADITIONAL_NATIVE_PACKAGES: readonly string[] = ['better-sqlite3']

/** The running Node ABI/arch the fetched prebuild must match. */
export interface PrebuildTarget {
  /** Node version, e.g. `process.versions.node` (`24.16.0`). */
  readonly nodeVersion: string
  /** CPU arch, e.g. `process.arch` (`arm64` | `x64`). */
  readonly arch: string
}

/** Fetch a `<moduleDir>`'s prebuild for `target`. Test seam. */
export type PrebuildFetchFn = (moduleDir: string, target: PrebuildTarget) => Promise<void>

export interface EnsureNativePrebuildsOptions {
  readonly logger: IScopedLogger
  /** Defaults to the running process (`process.versions.node` / `process.arch`). */
  readonly target?: PrebuildTarget
  /** Override the native package set (tests). */
  readonly packages?: readonly string[]
  /** Override the fetcher (tests). Production uses the bundled `prebuild-install`. */
  readonly fetchPrebuild?: PrebuildFetchFn
}

/** Bounded recursive scan for ANY `*.node` file under `dir`. */
export function hasDotNode(dir: string, maxDepth: number): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.node')) return true
  }
  if (maxDepth <= 0) return false
  for (const entry of entries) {
    if (entry.isDirectory() && hasDotNode(path.join(dir, entry.name), maxDepth - 1)) return true
  }
  return false
}

/** Locate the bundled `prebuild-install` bin.js inside the staged closure. */
function resolvePrebuildInstallBin(closureDir: string, moduleDir: string): string | null {
  const candidates = [
    path.join(moduleDir, 'node_modules', 'prebuild-install', 'bin.js'),
    path.join(closureDir, 'node_modules', 'prebuild-install', 'bin.js'),
  ]
  return candidates.find((c) => fs.existsSync(c)) ?? null
}

/**
 * Default fetcher: run the closure's own `prebuild-install` under the CURRENT
 * Node (`process.execPath`) — no reliance on `npx`/`npm` on PATH (a packaged
 * app ships a bare Node). Explicitly targets the running ABI/arch, mirroring
 * `scripts/stage-deps.mjs`.
 */
function makeDefaultFetch(closureDir: string, logger: IScopedLogger): PrebuildFetchFn {
  return async (moduleDir, target) => {
    const bin = resolvePrebuildInstallBin(closureDir, moduleDir)
    if (bin === null) {
      throw new Error(`prebuild-install not found in the staged closure for ${moduleDir}`)
    }
    logger.info('fetching native prebuild via prebuild-install', {
      meta: { moduleDir, bin, nodeVersion: target.nodeVersion, arch: target.arch },
    })
    await execFileAsync(
      process.execPath,
      [bin, '--runtime', 'node', '--target', target.nodeVersion, '--arch', target.arch],
      { cwd: moduleDir, timeout: PREBUILD_FETCH_TIMEOUT_MS },
    )
  }
}

/**
 * Ensure every traditional native in `<closureDir>/node_modules` carries its
 * compiled `.node`, fetching the prebuild for the running ABI when missing.
 *
 * A NO-OP when nothing is missing (docker / tests) and when a native package is
 * absent from the closure. Never throws for a single package's fetch failure —
 * it logs and continues so the downstream `findMissingNativePrebuilds`
 * validator makes the final swap/abort decision. Returns the packages whose
 * prebuild was successfully fetched (for logging/tests).
 */
export async function ensureNativePrebuilds(
  closureDir: string,
  options: EnsureNativePrebuildsOptions,
): Promise<readonly string[]> {
  const nm = path.join(closureDir, 'node_modules')
  const target: PrebuildTarget = options.target ?? {
    nodeVersion: process.versions.node,
    arch: process.arch,
  }
  const packages = options.packages ?? TRADITIONAL_NATIVE_PACKAGES
  const fetchPrebuild = options.fetchPrebuild ?? makeDefaultFetch(closureDir, options.logger)
  const fetched: string[] = []

  for (const pkg of packages) {
    const moduleDir = path.join(nm, pkg)
    if (!fs.existsSync(moduleDir)) continue // native not part of this closure — skip
    if (hasDotNode(moduleDir, NATIVE_SCAN_DEPTH)) continue // already carries its .node — no-op

    options.logger.warn('staged closure native prebuild missing — fetching for running ABI', {
      meta: { pkg, moduleDir, nodeVersion: target.nodeVersion, arch: target.arch },
    })
    try {
      await fetchPrebuild(moduleDir, target)
    } catch (err) {
      options.logger.error('native prebuild fetch failed (validator will decide)', {
        meta: { pkg, error: errMsg(err) },
      })
      continue
    }
    if (hasDotNode(moduleDir, NATIVE_SCAN_DEPTH)) {
      fetched.push(pkg)
      options.logger.info('native prebuild fetched', { meta: { pkg } })
    } else {
      options.logger.error('native prebuild still missing after fetch', { meta: { pkg } })
    }
  }
  return fetched
}
