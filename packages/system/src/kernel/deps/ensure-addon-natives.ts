/**
 * `ensureAddonNativePrebuilds` — the POST-install native-prebuild ENSURE pass an
 * addon install runs on the INSTALLED addon dir AFTER `npm install`.
 *
 * Why this exists (Mac desktop first-boot FATAL, 2026-07-21): `installCopy`
 * copies `dist/`, plants prebuilt natives from the bundled addon copy
 * (`copyBundledNativeModules`), then `npm install`s the addon's runtime deps.
 * On a TOOLCHAIN-LESS host that `npm install` RE-CREATES the traditional native
 * `better-sqlite3` SOURCE-ONLY — clobbering the good `.node` the pre-install
 * copy just planted — and the runner later dies at addon init with a cryptic
 * "Could not locate the bindings file". The copy-BEFORE-install fix was
 * empirically insufficient: npm's own install in the copied dir replaces the
 * satisfied dep without its binary.
 *
 * This pass runs LAST, so it always sees the final on-disk state npm left, and
 * per referenced traditional native still lacking its compiled `.node`:
 *   1. bundled-copy first — if the bundled addon copy carries the matching
 *      `.node` (same machine → same platform/arch/ABI), re-plant it DIRECTLY.
 *      Cheapest + offline-safe; runs BEFORE any network fetch.
 *   2. fetch fallback — otherwise fetch the prebuild for the running ABI via the
 *      shared `ensureNativePrebuilds` pointed at the addon dir.
 *   3. FAIL LOUD — if the native is STILL source-only after both, log a clear
 *      error naming module + addon and THROW so the install fails at install
 *      time rather than at addon init.
 *
 * N-API natives (`sharp`, `node-av`) ship their binaries as ABI-stable platform
 * SIBLING packages npm fetches without a compile step, so they are excluded from
 * the default set — a miss there is a broken install, not something a prebuild
 * re-fetch heals (same rationale as `ensureNativePrebuilds`).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import {
  ensureNativePrebuilds,
  hasDotNode,
  NATIVE_SCAN_DEPTH,
  TRADITIONAL_NATIVE_PACKAGES,
  type PrebuildFetchFn,
  type PrebuildTarget,
} from './ensure-native-prebuilds.js'

/** Per-native outcome of the ensure pass. */
export type NativeEnsureOutcome = 'already-present' | 'copied' | 'fetched' | 'missing'

export interface NativeEnsureResult {
  readonly pkg: string
  readonly outcome: NativeEnsureOutcome
}

export interface EnsureAddonNativePrebuildsOptions {
  /** Addon package name — for loud error messages naming module + addon. */
  readonly addonName: string
  readonly logger: IScopedLogger
  /**
   * Bundled addon copy dir (the `installCopy` `sourceDir` / a
   * `CAMSTACK_BUNDLED_ADDONS_DIR/<addon>` copy) whose own
   * `node_modules/<pkg>` may carry a prebuilt `.node` for THIS machine.
   * Copied in directly before any network fetch. Absent on the npm/tgz path.
   */
  readonly bundledSourceDir?: string
  /** Running ABI/arch the fetched prebuild must match. Defaults to the process. */
  readonly target?: PrebuildTarget
  /** Native package set. Defaults to `TRADITIONAL_NATIVE_PACKAGES`. */
  readonly packages?: readonly string[]
  /** Override the fetcher (tests). Production uses the bundled `prebuild-install`. */
  readonly fetchPrebuild?: PrebuildFetchFn
  /** Override the `.node` presence scan (tests). */
  readonly hasNative?: (moduleDir: string) => boolean
}

/**
 * Re-plant `<srcModuleDir>` → `<dstModuleDir>` when the source carries a `.node`.
 * Returns whether the destination ends up with a compiled binary.
 */
function replantFromBundled(
  srcModuleDir: string,
  dstModuleDir: string,
  hasNative: (dir: string) => boolean,
): boolean {
  if (!hasNative(srcModuleDir)) return false
  try {
    fs.rmSync(dstModuleDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dstModuleDir), { recursive: true })
    fs.cpSync(srcModuleDir, dstModuleDir, { recursive: true, dereference: true })
  } catch {
    return false
  }
  return hasNative(dstModuleDir)
}

/**
 * Ensure every referenced traditional native in `<addonDir>/node_modules`
 * carries its compiled `.node` after the addon's `npm install`. Bundled-copy
 * first (offline), prebuild-fetch fallback, LOUD throw on a residual miss.
 *
 * SKIPS a native absent from the addon's own `node_modules` (it resolves via a
 * hoisted host copy — not this addon's concern). A NO-OP in docker / dev where
 * npm produced a working `.node` (already-present). Returns the per-native
 * outcomes for logging/tests.
 *
 * @throws if any required native is still source-only after copy + fetch.
 */
export async function ensureAddonNativePrebuilds(
  addonDir: string,
  options: EnsureAddonNativePrebuildsOptions,
): Promise<readonly NativeEnsureResult[]> {
  const packages = options.packages ?? TRADITIONAL_NATIVE_PACKAGES
  const hasNative =
    options.hasNative ?? ((dir: string): boolean => hasDotNode(dir, NATIVE_SCAN_DEPTH))
  const nm = path.join(addonDir, 'node_modules')

  const results: NativeEnsureResult[] = []
  const missing: string[] = []

  for (const pkg of packages) {
    const moduleDir = path.join(nm, pkg)
    // Absent from the addon's own tree → relies on a hoisted host copy; not this
    // addon's binary to guarantee. Mirrors `ensureNativePrebuilds` skip-absent.
    if (!fs.existsSync(moduleDir)) continue
    if (hasNative(moduleDir)) {
      results.push({ pkg, outcome: 'already-present' })
      continue
    }

    // 1) Bundled-copy first — offline, cheapest, no network.
    if (options.bundledSourceDir) {
      const src = path.join(options.bundledSourceDir, 'node_modules', pkg)
      if (replantFromBundled(src, moduleDir, hasNative)) {
        options.logger.info('addon native prebuild re-planted from bundled copy (offline)', {
          meta: { addon: options.addonName, pkg, src, moduleDir },
        })
        results.push({ pkg, outcome: 'copied' })
        continue
      }
    }

    // 2) Fetch fallback — prebuild for the running ABI, via the shared
    //    `ensureNativePrebuilds` pointed at the addon dir (never throws; logs).
    const fetched = await ensureNativePrebuilds(addonDir, {
      logger: options.logger,
      packages: [pkg],
      ...(options.target ? { target: options.target } : {}),
      ...(options.fetchPrebuild ? { fetchPrebuild: options.fetchPrebuild } : {}),
    })
    if (fetched.includes(pkg)) {
      results.push({ pkg, outcome: 'fetched' })
      continue
    }

    // 3) Still source-only — LOUD. Surface here (naming module + addon) rather
    //    than dying later at addon init with a cryptic bindings error.
    options.logger.error(
      'addon native prebuild MISSING after ensure — module has no compiled .node',
      { meta: { addon: options.addonName, pkg, moduleDir } },
    )
    results.push({ pkg, outcome: 'missing' })
    missing.push(pkg)
  }

  if (missing.length > 0) {
    throw new Error(
      `${options.addonName} — required native module(s) missing a compiled .node after install ` +
        `(bundled-copy + prebuild-fetch both failed): ${missing.join(', ')}`,
    )
  }

  return results
}
