import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { asJsonObject, asString, parseJsonUnknown } from '@camstack/types'
import {
  copyDirRecursive,
  copyExtraFileDirs,
  ensureDir,
  ensureLibraryBuilt,
  stripBundledDeps,
} from './fs-utils.js'

const execFileAsync = promisify(execFile)

/** Read and parse a `package.json` into a typed view, or return null on failure. */
interface PackageJsonView {
  readonly name: string
  readonly version: string
  readonly raw: Record<string, unknown>
  readonly camstackAddons: readonly unknown[] | null
}

/**
 * Minimal typed view of a meta-package `package.json` as consumed by the
 * bootstrap-list derivations. `camstack.agentOnlyBootstrapAddons` names the
 * addons carried in the closure for agent-role seeding that the HUB bootstrap
 * set must exclude; `camstack.agentBootstrapAddons` feeds the agent list.
 */
interface BootstrapManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly camstack?: {
    readonly agentBootstrapAddons?: readonly string[]
    readonly agentOnlyBootstrapAddons?: readonly string[]
  }
}

type InstalledSource = 'npm' | 'local' | 'upload' | 'bundled'

/**
 * Names declared in `camstack.nativeDependencies` — per-addon natives that
 * the closure dedupe must never replace with a link (their install path owns
 * ABI/prebuild handling; see `deps/manifest-native-deps.ts`).
 */
function readNativeDependencyNames(pkg: Record<string, unknown> | undefined): ReadonlySet<string> {
  if (pkg === undefined) return new Set()
  const camstack = asJsonObject(pkg['camstack'])
  if (camstack === null) return new Set()
  const native = asJsonObject(camstack['nativeDependencies'])
  return native === null ? new Set() : new Set(Object.keys(native))
}

function parseInstallSource(value: string): InstalledSource | undefined {
  switch (value) {
    case 'npm':
    case 'local':
    case 'upload':
    case 'bundled':
      return value
    default:
      return undefined
  }
}

function readPackageJson(pkgJsonPath: string): PackageJsonView | null {
  let raw: Record<string, unknown> | null
  try {
    raw = asJsonObject(parseJsonUnknown(fs.readFileSync(pkgJsonPath, 'utf-8')))
  } catch {
    return null
  }
  if (!raw) return null
  const name = asString(raw['name'])
  const version = asString(raw['version'])
  if (!name || !version) return null
  const camstack = asJsonObject(raw['camstack'])
  const addonsField = camstack ? camstack['addons'] : undefined
  const camstackAddons = Array.isArray(addonsField) ? addonsField : null
  return { name, version, raw, camstackAddons }
}

/**
 * Addon install source mode:
 * - 'npm'     — download from npm registry (production + dev default).
 * - 'local'   — copy dist/ from local workspace `packages/` (used by
 *               `installFromWorkspace` + the Electron-packaged bundled
 *               addons path).
 * - 'symlink' — point `data/addons/<pkg>` directly at the workspace
 *               source dir. Dev-only: workspace edits → next addon
 *               load picks them up after a `npm run build` of the
 *               package, without re-copying. Costs ~80ms per addon at
 *               cold boot instead of the ~200ms-per-package copy.
 *               Windows fallback: drops back to `'local'` if symlink
 *               creation fails (needs admin / developer-mode on Win10).
 *
 * The previous symlink mode (auto-on when workspace was detected) was
 * removed in `eb96df3c` once addons moved to self-contained bundles —
 * the legacy `symlinkAddonsToNodeModules` / `symlinkPeerDepsIntoAddonsDir`
 * helpers it relied on are GONE. This is the narrower successor: no
 * symlinks into the hub's `node_modules`, no peer-dep planting — just
 * `addonsDir/<pkg>` → `packages/<pkg>`.
 */
export type InstallSource = 'npm' | 'local' | 'symlink'

/** The one bootstrap package the server closure carries itself. */
export const CLOSURE_PROVIDED_PACKAGE = '@camstack/system'

/**
 * Should the bootstrap SKIP seeding `packageName` into /data/addons?
 *
 * True only for the package the closure provides, and only when it actually
 * resolves. Both halves are load-bearing:
 *
 *  - seeding a copy the closure already provides creates one that WINS over
 *    the closure and is never refreshed (bootstrap is seed-only, and
 *    `camstack deploy` of a framework package is rejected on an image hub), so
 *    the node runs first-boot builtins forever while reporting the new
 *    version;
 *  - skipping it when it does NOT resolve is how a fresh deployment was once
 *    made unbootable ("No addon provides required infrastructure capability
 *    storage-provider"). That is why the guard is resolvability rather than a
 *    blanket removal from the bootstrap list.
 */
export function shouldSkipClosureProvidedSeed(packageName: string, isResolvable: boolean): boolean {
  return packageName === CLOSURE_PROVIDED_PACKAGE && isResolvable
}

export interface AddonInstallerConfig {
  /** Directory where addons are stored (e.g., {dataDir}/addons) */
  readonly addonsDir: string
  /** npm registry URL */
  readonly registry?: string
  /** Workspace packages directory (e.g., /path/to/camstack-server/packages) */
  readonly workspacePackagesDir?: string
  /** Install source mode. Default: auto-detect */
  readonly installSource?: InstallSource
  /**
   * Override for "does the running closure already provide this package?".
   * Production leaves it unset (real `require.resolve`); a spec sets it to
   * reach the branch that still seeds `@camstack/system`, which is otherwise
   * unreachable in a process where that package always resolves.
   */
  readonly isPackageResolvable?: (packageName: string) => boolean
  /**
   * The server closure's node_modules to dedupe addon trees against.
   * Production leaves it unset (derived from `CAMSTACK_FRAMEWORK_DIR`);
   * specs point it at a fabricated closure dir.
   */
  readonly closureNodeModulesDir?: string
  /**
   * Resolve dist-tag `latest` for a package. `null` means the registry could
   * not be read — the caller leaves the installed copy alone (D942, D49).
   * Production leaves it unset and asks the registry; specs inject it.
   */
  readonly resolveLatestVersion?: (packageName: string) => Promise<string | null>
}

/** How long a boot-time `dist-tags.latest` read may take before it is "unreadable". */
const REGISTRY_LATEST_TIMEOUT_MS = 15_000

import type { InstalledPackage, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { AddonManifest } from './addon-manifest.js'
import {
  ADDON_VERSION_REASON_REGISTRY_LATEST,
  decideAddonVersionMove,
} from './addon-version-policy.js'
import {
  closureSatisfiesRange,
  collectAddonTreeState,
  executeClosureDedupe,
  isClosureLinkTarget,
  planClosureDedupe,
  readClosureVersions,
  resolveClosureNodeModulesDir,
} from './deps/closure-dedupe.js'
import { ensureAddonNativePrebuilds } from './deps/ensure-addon-natives.js'
import { copyBundledNativeModules, installManifestNativeDeps } from './deps/manifest-native-deps.js'
import { runNpm } from './deps/npm-command.js'

export type { InstalledPackage }

/** Outcome of {@link AddonInstaller.ensureAddonRuntimeDeps}. */
export interface EnsureAddonDepsResult {
  /** Installed addon packages examined. */
  readonly checked: number
  /** `"<package>:<dep>"` entries satisfied by a new closure link — no npm. */
  readonly linked: readonly string[]
  /** Packages whose deps required an in-place npm install. */
  readonly reinstalled: readonly string[]
  /** Packages whose deps could not be ensured (logged loudly, boot continues). */
  readonly failed: readonly string[]
}

/** Outcome of {@link AddonInstaller.sweepBackups}. Absolute paths. */
export interface BackupSweepResult {
  /** Backup dirs reclaimed by the sweep. */
  readonly removed: readonly string[]
  /** Backup dirs deliberately retained (rollback target / last copy). */
  readonly kept: readonly string[]
}

function readInstalledPackageVersion(addonDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(addonDir, 'package.json'), 'utf-8'))
    if (raw === null || typeof raw !== 'object') return null
    const version = Reflect.get(raw, 'version')
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    return null
  }
}

function distTagLatest(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const tags = Reflect.get(body, 'dist-tags')
  if (tags === null || typeof tags !== 'object') return null
  const latest = Reflect.get(tags, 'latest')
  return typeof latest === 'string' && latest.length > 0 ? latest : null
}

/** Minimal no-op logger for default parameter */
const noopLogger: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger
  },
  withTags() {
    return noopLogger
  },
}

/**
 * A staging tree younger than this may belong to an install still running —
 * possibly in another process. Only older trees are residue worth sweeping.
 * Generous on purpose: an addon's runtime-dependency `npm install` on a slow
 * host is minutes, and the cost of leaving residue one deploy longer is disk,
 * while the cost of sweeping a live one is a FAILED deploy.
 */
export const STAGING_RESIDUE_MIN_AGE_MS: number = 30 * 60_000

export interface StagingEntryAge {
  readonly name: string
  /** Age of the entry's mtime, in ms. */
  readonly ageMs: number
}

/**
 * Pick the staging entries that are safe to delete.
 *
 * `installFromTgz` used to clear the WHOLE `.staging` root before creating its
 * own dir. Two deploys arriving within one install's lifetime — the normal case
 * when the hub propagates two packages back to back — meant the second one
 * deleted the first one's tree out from under its running `npm install`:
 *
 *   npm error code ENOENT
 *   npm error path …/.staging/install-14820-2026-08-07T12-28-28-875Z/package/package.json
 *
 * which the propagation then reported as `runtime dependency install failed`.
 * Observed on the Mac desktop agent and on agent-a on 2026-08-07.
 *
 * So a sweep only removes what cannot be live: not a tree this process is
 * building, and not one young enough to belong to anybody's in-flight install.
 */
export function selectSweepableStaging(
  entries: readonly StagingEntryAge[],
  inFlight: ReadonlySet<string>,
  minAgeMs: number = STAGING_RESIDUE_MIN_AGE_MS,
): readonly string[] {
  return entries
    .filter((entry) => !inFlight.has(entry.name) && entry.ageMs >= minAgeMs)
    .map((entry) => entry.name)
}

export class AddonInstaller {
  readonly addonsDir: string
  private readonly registry: string | undefined
  readonly workspaceDir: string | undefined
  readonly installSource: InstallSource
  private readonly logger: IScopedLogger
  private readonly isPackageResolvable?: (packageName: string) => boolean
  /** Test seam — production resolves via `CAMSTACK_FRAMEWORK_DIR`. */
  private readonly closureNodeModulesDir: string | undefined
  private readonly resolveLatestVersionOverride: AddonInstallerConfig['resolveLatestVersion']
  /**
   * Central manifest of installed addons. Tracks version + source +
   * timestamps + last-backup pointer per package, written atomically
   * after every install/uninstall. Replaces the legacy per-addon
   * `.install-source` markers (which we still write for backward
   * compatibility with code that reads them directly — see fs-utils
   * `getAddonInstallSource`).
   */
  readonly manifest: AddonManifest

  /**
   * Basenames under `.staging` this process is currently building. Never swept
   * — see {@link selectSweepableStaging}.
   */
  private readonly inFlightStaging = new Set<string>()

  constructor(config: AddonInstallerConfig, logger: IScopedLogger = noopLogger) {
    this.addonsDir = config.addonsDir
    this.registry = config.registry
    this.workspaceDir = config.workspacePackagesDir
    this.logger = logger
    this.manifest = new AddonManifest(config.addonsDir)
    this.isPackageResolvable = config.isPackageResolvable
    this.closureNodeModulesDir = config.closureNodeModulesDir
    this.resolveLatestVersionOverride = config.resolveLatestVersion

    // Default: 'npm'. The legacy "auto-detect symlink if workspace
    // present" branch was removed — dev now pushes via `camstack
    // deploy`, prod resolves from the registry. The explicit `'local'`
    // mode (copy-from-workspace) stays available for the Electron
    // bundled-addons path; callers set it explicitly.
    if (config.installSource) {
      this.installSource = config.installSource
    } else {
      this.installSource = 'npm'
    }
  }

  /**
   * Where a bootstrapped npm lives when the host has none on PATH (packaged
   * Electron agents ship a bare node binary). Persistent — sibling of the
   * installed addons, survives restarts, downloaded at most once per host.
   */
  private get npmCacheDir(): string {
    return path.join(this.addonsDir, '.npm-bootstrap')
  }

  /** Shared options for every npm invocation this installer performs. */
  private npmRunOptions(cwd: string, timeout: number): Parameters<typeof runNpm>[1] {
    return {
      cacheDir: this.npmCacheDir,
      registry: this.registry,
      logger: this.logger,
      cwd,
      timeout,
    }
  }

  /**
   * Derive the bootstrap addon list from a meta-package's runtime dependencies.
   * Single source of truth: the meta-package's `package.json` declares which
   * `@camstack/addon-*` packages the deployment needs. Replaces previously
   * hardcoded lists — see design spec
   * docs/superpowers/specs/2026-05-20-docker-install-from-npm-design.md.
   */
  /**
   * Is `packageName` reachable through normal resolution — i.e. does the
   * running closure already provide it?
   *
   * Overridable via `AddonInstallerConfig.isPackageResolvable` so a spec can
   * exercise BOTH sides. That matters more than it looks: the branch that
   * still seeds is the one protecting a fresh deployment from an unbootable
   * node, and it is unreachable in a test process where `@camstack/system`
   * always resolves.
   */
  private isResolvableFromClosure(packageName: string): boolean {
    if (this.isPackageResolvable) return this.isPackageResolvable(packageName)
    try {
      require.resolve(`${packageName}/package.json`)
      return true
    } catch {
      return false
    }
  }

  private static deriveBootstrapList(metaPackageName: string): readonly string[] {
    const pkgJsonId = `${metaPackageName}/package.json`
    let pkgPath: string
    try {
      pkgPath = require.resolve(pkgJsonId)
    } catch {
      // The meta-package (`@camstack/server`) is absent in this context
      // (e.g. a minimal test harness with no installed root package). The
      // bootstrap list is eagerly derived as a static field, so this must not
      // throw when the meta-package cannot be resolved.
      return Object.freeze([])
    }
    const raw = fs.readFileSync(pkgPath, 'utf-8')
    const parsed = JSON.parse(raw) as BootstrapManifest
    const deps = Object.keys(parsed.dependencies ?? {})
    // Agent-only bootstrap addons ride along in the @camstack/server closure so
    // agent-role nodes can seed them (e.g. @camstack/addon-agent-ui), but they
    // are NOT part of the HUB bootstrap set — the hub must never install them.
    // They are declared as a runtime dependency (so the closure carries them)
    // AND listed here so this derivation excludes them, keeping the hub
    // REQUIRED_PACKAGES identical to the pre-single-root-consolidation set.
    const agentOnly = new Set(parsed.camstack?.agentOnlyBootstrapAddons ?? [])
    // Bootstrap set = every @camstack/addon-* PLUS @camstack/system. core is the
    // system package that provides the REQUIRED infrastructure builtins
    // (storage-provider / settings / logging via its filesystem-storage etc.
    // addons); without it AddonRegistryService aborts boot with "No addon
    // provides required infrastructure capability storage-provider". It was
    // wrongly filtered out before (only ever present in data/addons via a
    // manual `camstack deploy core`), so a fresh deployment could never boot.
    // The install loop already special-cases '@camstack/system' (a failed core
    // install is fatal), confirming it is meant to be in this list.
    return Object.freeze(
      deps.filter(
        (name) =>
          !agentOnly.has(name) &&
          (name.startsWith('@camstack/addon-') || name === '@camstack/system'),
      ),
    )
  }

  /**
   * Bootstrap packages installed on first boot — derived from the
   * `@camstack/server` meta-package's runtime dependencies. Adding a
   * bootstrap addon = adding it to `server/backend/package.json`.
   * See design spec
   * docs/superpowers/specs/2026-05-20-docker-install-from-npm-design.md.
   *
   * Camera provider drivers are NOT preinstalled with the hub — users
   * pick providers from the admin UI ("Install addon"). Saves ~80MB per
   * hub install and avoids shipping driver code unused on most hubs.
   */
  static readonly REQUIRED_PACKAGES: readonly string[] =
    AddonInstaller.deriveBootstrapList('@camstack/server')

  /**
   * Agent-only bootstrap packages — derived from the `@camstack/server`
   * meta-package's `camstack.agentBootstrapAddons` manifest field (single
   * source of truth; the separate agent meta-package is gone).
   * The agent runtime boots from the SAME `@camstack/server` closure, so its
   * bootstrap addon set is declared alongside the hub's. Adding an agent
   * bootstrap addon = adding it to `server/backend/package.json`'s
   * `camstack.agentBootstrapAddons`.
   */
  static readonly AGENT_PACKAGES: readonly string[] =
    AddonInstaller.deriveAgentBootstrapList('@camstack/server')

  /**
   * Derive the agent bootstrap addon list from a meta-package's
   * `camstack.agentBootstrapAddons` manifest field, prepending
   * `@camstack/system` (the required infrastructure builtins carrier — same
   * rationale as `deriveBootstrapList`). Mirrors `deriveBootstrapList`'s
   * `require.resolve` nuance: the meta-package may be absent in a deployment
   * (this field is eagerly evaluated at class-load), so a failed resolve
   * yields an empty list rather than throwing.
   */
  private static deriveAgentBootstrapList(metaPackageName: string): readonly string[] {
    const pkgJsonId = `${metaPackageName}/package.json`
    let pkgPath: string
    try {
      pkgPath = require.resolve(pkgJsonId)
    } catch {
      return Object.freeze([])
    }
    const raw = fs.readFileSync(pkgPath, 'utf-8')
    const parsed = JSON.parse(raw) as {
      readonly camstack?: { readonly agentBootstrapAddons?: readonly string[] }
    }
    const addons = parsed.camstack?.agentBootstrapAddons ?? []
    return Object.freeze(['@camstack/system', ...addons])
  }

  /**
   * Ensure all required packages are installed in the addons directory.
   *
   * Bootstrap-only — prefers the workspace/bundle copy when available
   * (offline-first, faster, container-self-contained). On-demand
   * installs from the admin UI go through `install()` instead, which
   * defaults to npm in production.
   *
   * There is no version argument and there is deliberately no pin: the system is
   * addons-agnostic and `latest` is the whole contract (operator, 2026-08-13,
   * restated 2026-10-25 — D942). A copy already under the addon root is left
   * alone when this installer is not on the npm source (a workspace or a
   * bundled desktop seed) and when the package is the closure-provided
   * `@camstack/system` (a copy there would shadow the closure). Every other
   * required addon already on disk is moved to registry `latest` when that
   * tag differs, higher or lower. An unreadable registry changes nothing.
   *
   * @param packages — optional custom package list (default: REQUIRED_PACKAGES)
   */
  async ensureRequiredPackages(packages?: readonly string[]): Promise<void> {
    const pkgList = packages ?? AddonInstaller.REQUIRED_PACKAGES
    ensureDir(this.addonsDir)

    // Bootstrap prefers local whenever workspace/bundle is available,
    // regardless of `installSource` (which governs on-demand installs).
    // Only an explicit `installSource: 'npm'` overrides this.
    const isLocal = this.installSource !== 'npm' && this.workspaceDir != null

    this.logger.info(
      `Install source: ${this.installSource}${this.workspaceDir ? ` (${this.workspaceDir})` : ''}, ${pkgList.length} package(s)`,
    )

    // Build library deps first when using local packages
    if (isLocal && this.workspaceDir) {
      ensureLibraryBuilt('@camstack/kernel', this.workspaceDir)
      ensureLibraryBuilt('@camstack/types', this.workspaceDir)
    }

    for (const packageName of pkgList) {
      const addonDir = path.join(this.addonsDir, packageName)

      // An on-disk copy is not a pin. On the npm source it is moved to
      // registry `latest` when that tag differs (D942). A workspace or bundled
      // seed (`installSource` local/symlink) is the checkout itself and is
      // left alone, as is `@camstack/system` when the closure already provides
      // it — a copy under the addon root would shadow the closure (D15).
      if (fs.existsSync(path.join(addonDir, 'package.json'))) {
        if (
          this.installSource !== 'npm' ||
          shouldSkipClosureProvidedSeed(packageName, this.isResolvableFromClosure(packageName))
        ) {
          this.logger.debug(`${packageName} — already installed, skipping`)
          continue
        }
        try {
          await this.followInstalledAddonToLatest(packageName, addonDir)
        } catch (err) {
          const msg = errMsg(err)
          this.logger.error(`Failed to move ${packageName} to registry latest`, {
            meta: { error: msg },
          })
        }
        continue
      }

      // `@camstack/system` is the exception, and the reason is that seed-only
      // is a TRAP for it specifically. It is host-provided (D15): every node
      // resolves it from the running server closure, which `applyServerUpdate`
      // keeps current. A copy under /data/addons does not get that update —
      // `camstack deploy` of a framework package is rejected on an image hub,
      // so nothing refreshes it — and it WINS over the closure, so the node
      // runs first-boot builtins forever while reporting the new version.
      // Measured 2026-08-03: both agents on a 1.2.0 copy seeded 2026-07-21
      // against a 1.2.29 closure; the hub, which has no copy, was current.
      //
      // It is still seeded when it is NOT resolvable, because that is the
      // failure this install was originally added for: without the package a
      // fresh deployment aborts boot with "No addon provides required
      // infrastructure capability storage-provider". That predates the
      // data-root closure, when /data/addons was the only source — so the
      // guard is resolvability, not a version check.
      if (shouldSkipClosureProvidedSeed(packageName, this.isResolvableFromClosure(packageName))) {
        this.logger.info(
          `${packageName} — provided by the server closure, not seeding a copy that would shadow it`,
        )
        continue
      }

      try {
        if (isLocal) {
          const pkgDir = this.findLocalPackage(packageName)
          if (pkgDir) {
            await this.installLocal(packageName, pkgDir)
            continue
          }
          // Local package not found — fall through to npm
          this.logger.info(`${packageName} — not found locally, trying npm`)
        }

        await this.installFromNpm(packageName)
      } catch (err) {
        const msg = errMsg(err)
        if (packageName === '@camstack/system') {
          throw new Error(`Required package ${packageName} failed to install: ${msg}`, {
            cause: err,
          })
        }
        this.logger.error(`Failed to install ${packageName}`, { meta: { error: msg } })
      }
    }
  }

  /**
   * Move an already-installed required addon to registry `latest` when the
   * installed version differs. `applyUpdate` keeps the previous tree as a
   * backup and restores it if the install throws. A null latest (registry
   * down, or no tag) leaves the copy where it is.
   */
  private async followInstalledAddonToLatest(packageName: string, addonDir: string): Promise<void> {
    const installedVersion = readInstalledPackageVersion(addonDir)
    const latest = await this.readRegistryLatest(packageName)
    const decision = decideAddonVersionMove(
      installedVersion,
      latest,
      ADDON_VERSION_REASON_REGISTRY_LATEST,
    )
    if (!decision.move) {
      this.logger.debug(
        `${packageName} — installed copy matches registry latest, or the registry could not be read`,
      )
      return
    }
    this.logger.info(
      `${packageName} — moving ${decision.from} → ${decision.to}: ${decision.reason}`,
      {
        meta: { from: decision.from, to: decision.to, reason: decision.reason },
      },
    )
    if (this.manifest.get(packageName) == null) {
      this.manifest.upsert(packageName, {
        version: installedVersion ?? '0.0.0',
        source: 'npm',
      })
    }
    await this.applyUpdate(packageName, decision.to)
  }

  /** `dist-tags.latest`, or `null` when the registry cannot be read. */
  private async readRegistryLatest(packageName: string): Promise<string | null> {
    if (this.resolveLatestVersionOverride) {
      try {
        return await this.resolveLatestVersionOverride(packageName)
      } catch (err) {
        this.logger.warn(`${packageName} — registry unreadable, leaving the installed copy`, {
          meta: { error: errMsg(err) },
        })
        return null
      }
    }
    return this.fetchRegistryLatest(packageName)
  }

  private async fetchRegistryLatest(packageName: string): Promise<string | null> {
    const registry = (this.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
    const metadataUrl = `${registry}/${encodeURIComponent(packageName).replace(/^%40/, '@')}`
    try {
      const metadataRes = await fetch(metadataUrl, {
        signal: AbortSignal.timeout(REGISTRY_LATEST_TIMEOUT_MS),
      })
      if (!metadataRes.ok) {
        this.logger.warn(
          `${packageName} — registry answered ${metadataRes.status}, leaving the installed copy`,
        )
        return null
      }
      const latest = distTagLatest(await metadataRes.json())
      if (latest === null) {
        this.logger.warn(
          `${packageName} — registry returned no dist-tags.latest, leaving the installed copy`,
        )
      }
      return latest
    } catch (err) {
      this.logger.warn(`${packageName} — registry unreadable, leaving the installed copy`, {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * Reconcile the install manifest against the addons actually present on
   * disk: register seeded addons, correct a version that disagrees with the
   * installed `package.json`, and drop entries naming a directory that does
   * not exist. Call once after `ensureRequiredPackages`, before any update
   * can be in flight. See `AddonManifest.reconcileFromDisk` for the rules.
   *
   * Every correction is logged by name — a manifest that silently disagreed
   * with disk is what made "@camstack/system 1.2.29" read as installed on a
   * hub that deliberately has no copy of it.
   *
   * Returns the number of changes.
   */
  reconcileManifest(): number {
    const changes = this.manifest.reconcileFromDisk(this.addonsDir, (c) => {
      switch (c.kind) {
        case 'added':
          this.logger.info(`Manifest — registered seeded addon ${c.name}@${c.to}`)
          break
        case 'version-corrected':
          this.logger.info(
            `Manifest — ${c.name} recorded ${c.from} but disk has ${c.to}; adopting disk`,
          )
          break
        case 'pruned':
          this.logger.info(`Manifest — dropped ${c.name}@${c.from}: no install directory on disk`)
          break
      }
    })
    if (changes > 0) {
      this.logger.info(`Manifest reconciled — ${changes} correction(s)`)
    }
    return changes
  }

  /**
   * Make every INSTALLED addon's runtime dependencies resolvable — doing the
   * least work that achieves it. Runs at boot on hub and agent, which is what
   * turns a restore back into a working node: a system backup archives no
   * node_modules (D338), so before this pass every restored non-bootstrap
   * addon failed its first import until someone redeployed it by hand.
   *
   * Per addon, in order:
   *  1. drop closure links that no longer hold (dangling, or the closure
   *     moved to a version the addon tree's recorded ranges refuse) — those
   *     addons get a reinstall;
   *  2. a declared dep that already resolves in the addon tree costs nothing;
   *  3. a missing declared dep the closure provides at a COMPATIBLE version
   *     becomes a link — no npm, no network;
   *  4. only an addon left with a genuinely unresolvable dep gets an npm
   *     install (then dedupe + native ensure, same tail as a fresh install).
   *
   * "Only when necessary" is the contract: an addon whose deps are all
   * satisfied is not touched at all. Failures are per-addon and non-fatal —
   * a dep that cannot be re-fetched leaves that addon exactly as broken as
   * it already was, but LOUDLY, and never blocks the rest of the boot.
   */
  async ensureAddonRuntimeDeps(): Promise<EnsureAddonDepsResult> {
    const closureNodeModules = resolveClosureNodeModulesDir(this.closureNodeModulesDir)
    const linked: string[] = []
    const reinstalled: string[] = []
    const failed: string[] = []
    const installedPackages = this.listInstalled()

    for (const pkg of installedPackages) {
      // A dir that is itself a symlink is a dev workspace install — its
      // node_modules belong to the workspace, never to this pass.
      try {
        if (fs.lstatSync(pkg.dir).isSymbolicLink()) continue
      } catch {
        continue
      }
      try {
        const outcome = this.ensureOneAddonDeps(pkg.dir, pkg.name, closureNodeModules)
        for (const dep of outcome.linked) linked.push(`${pkg.name}:${dep}`)
        if (outcome.needsInstall) {
          await this.reinstallAddonDeps(pkg.dir, pkg.name)
          reinstalled.push(pkg.name)
        }
      } catch (err) {
        failed.push(pkg.name)
        this.logger.error(
          `${pkg.name} — runtime dependencies could NOT be ensured; the addon will fail to load until its deps install`,
          { meta: { dir: pkg.dir, error: errMsg(err) } },
        )
      }
    }
    return { checked: installedPackages.length, linked, reinstalled, failed }
  }

  /**
   * One addon's dependency audit (steps 1–3 of `ensureAddonRuntimeDeps`).
   * Pure decision + link creation; the npm fallback is the caller's.
   */
  private ensureOneAddonDeps(
    addonDir: string,
    packageName: string,
    closureNodeModules: string | null,
  ): { linked: readonly string[]; needsInstall: boolean } {
    const pkgView = readPackageJson(path.join(addonDir, 'package.json'))
    const declared = pkgView === null ? null : asJsonObject(pkgView.raw['dependencies'])
    const declaredEntries = declared === null ? [] : Object.entries(declared)
    const state = collectAddonTreeState(addonDir)
    const nodeModulesDir = path.join(addonDir, 'node_modules')
    let needsInstall = false

    // 1. Closure links that stopped holding: dangling, or now incompatible.
    if (closureNodeModules !== null) {
      for (const link of state.existingLinks) {
        if (!isClosureLinkTarget(link.target, closureNodeModules)) continue
        const linkDir = path.join(nodeModulesDir, link.name)
        const targetManifest = fs.existsSync(path.join(linkDir, 'package.json'))
        const ranges = state.requirements.get(link.name) ?? []
        let holds = targetManifest
        if (holds && ranges.length > 0) {
          const version = readClosureVersions(closureNodeModules, [link.name]).get(link.name)
          holds =
            version !== undefined && ranges.every((range) => closureSatisfiesRange(range, version))
        }
        if (!holds) {
          this.logger.warn(
            `${packageName} — closure link for ${link.name} no longer holds; reinstalling this addon's deps`,
            { meta: { target: link.target } },
          )
          fs.rmSync(linkDir, { force: true })
          needsInstall = true
        }
      }
    }

    // 2 + 3. Declared deps: resolve locally, else link from the closure,
    // else npm.
    const linked: string[] = []
    for (const [depName, range] of declaredEntries) {
      if (typeof range !== 'string') continue
      if (fs.existsSync(path.join(nodeModulesDir, depName, 'package.json'))) continue
      const closureVersion =
        closureNodeModules === null
          ? undefined
          : readClosureVersions(closureNodeModules, [depName]).get(depName)
      if (
        closureNodeModules !== null &&
        closureVersion !== undefined &&
        closureSatisfiesRange(range, closureVersion)
      ) {
        const restored = executeClosureDedupe(
          addonDir,
          closureNodeModules,
          { links: [{ name: depName, closureVersion }], keeps: [] },
          this.logger,
        )
        if (restored.length === 1) {
          this.logger.info(`${packageName} — ${depName} linked from the server closure`, {
            meta: { closureVersion },
          })
          linked.push(depName)
          continue
        }
      }
      needsInstall = true
    }
    return { linked, needsInstall }
  }

  /**
   * npm-install an installed addon's runtime deps IN PLACE (the restore /
   * repair path — the tree is not yet running at boot), then the same tail
   * every fresh install gets: closure dedupe + native deps + prebuild ensure.
   * Closure links are stripped first so npm reifies against plain missing
   * dirs instead of symlinks it does not own.
   */
  private async reinstallAddonDeps(addonDir: string, packageName: string): Promise<void> {
    const closureNodeModules = resolveClosureNodeModulesDir(this.closureNodeModulesDir)
    if (closureNodeModules !== null) {
      const state = collectAddonTreeState(addonDir)
      for (const link of state.existingLinks) {
        if (isClosureLinkTarget(link.target, closureNodeModules)) {
          fs.rmSync(path.join(addonDir, 'node_modules', link.name), { force: true })
        }
      }
    }
    this.logger.info(`${packageName} — reinstalling runtime dependencies`, {
      meta: { addonDir },
    })
    await runNpm(
      [
        'install',
        '--omit=dev',
        '--omit=peer',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        ...(this.registry ? ['--registry', this.registry] : []),
      ],
      this.npmRunOptions(addonDir, 240_000),
    )
    this.dedupeTreeAgainstClosure(addonDir, packageName)
    await this.installNativeDependencies(addonDir, packageName)
  }

  // ── Install methods ──────────────────────────────────────────────────────

  /**
   * Install a single addon — on-demand installer used by AddonPackageService
   * (admin UI "Install addon" / "Reinstall" buttons).
   *
   * Always npm. The legacy "auto-use workspace symlink in dev" branch
   * was removed; local development pushes via `camstack deploy` (CLI
   * tarball upload). Operators wanting to install from workspace use
   * `installFromWorkspace` (explicit `'local'` codepath) instead.
   */
  async install(packageName: string, version?: string): Promise<{ name: string; version: string }> {
    return this.installFromNpm(packageName, version)
  }

  /**
   * Install addon from a local workspace package. Two strategies
   * depending on `installSource`:
   *   - `'symlink'` (dev): create a directory symlink
   *     `addonsDir/<pkg>` → `<workspace>/packages/<pkg>`. Edits to
   *     the workspace are visible at the next addon load after a
   *     `npm run build` of that package — no copy step. Falls back
   *     to `'local'` if symlink creation fails (Windows w/o
   *     developer-mode).
   *   - `'local'` (default): copy `package.json` (stripped) + `dist/`
   *     into `addonsDir/<pkg>/`. The Electron bundled-addons path
   *     uses this so the runtime owns its on-disk copy.
   */
  /**
   * Re-install one addon from the running server closure.
   *
   * The closure carries a copy of every addon it declares as a dependency, and
   * NOTHING loads an addon from there — `AddonLoader` reads the addon root and
   * only the addon root, on every role. So those copies are transport, and
   * this is the only thing that moves them into the place that runs code.
   *
   * Without it a server update advances the closure and changes nothing: six
   * addons on the hub were behind by up to nineteen versions on 2026-09-17,
   * each frozen at whenever somebody last ran `camstack deploy`.
   *
   * WHICH addons deserve this is not decided here — see `planAddonRealignment`,
   * which needs two gates because a version comparison alone would overwrite a
   * deliberate deploy. This only carries out a decision already made.
   */
  async realignFromClosure(
    packageName: string,
    closureDir: string,
  ): Promise<{ name: string; version: string }> {
    const targetDir = path.join(this.addonsDir, packageName)
    const result = await this.installLocal(packageName, closureDir)
    // `installLocal` stamps `local`, which would read as a dev checkout. This
    // says what it really was, and it is the only way an operator can later
    // tell "I deployed this" from "the server update brought it".
    await fs.promises.writeFile(path.join(targetDir, '.install-source'), 'closure')
    this.manifest.upsert(result.name, { version: result.version, source: 'closure' })
    return result
  }

  private async installLocal(
    packageName: string,
    sourceDir: string,
  ): Promise<{ name: string; version: string }> {
    const pkgView = readPackageJson(path.join(sourceDir, 'package.json'))
    if (!pkgView) {
      throw new Error(`Invalid package.json at ${sourceDir}`)
    }
    const targetDir = path.join(this.addonsDir, packageName)
    if (this.installSource === 'symlink') {
      try {
        return await this.installSymlink(packageName, sourceDir, pkgView.raw, targetDir)
      } catch (err) {
        this.logger.warn(`${packageName} — symlink failed, falling back to copy: ${errMsg(err)}`)
        // Windows without developer-mode rejects symlink creation —
        // copy is functionally equivalent for boot, just slower.
      }
    }
    return this.installCopy(packageName, sourceDir, pkgView.raw, targetDir)
  }

  /**
   * Symlink `addonsDir/<pkg>` at the workspace source dir. Dev-only.
   * After this, the AddonLoader resolves `<addonsDir>/<pkg>/dist/...`
   * through the symlink straight to `packages/<pkg>/dist/...` — a fresh
   * `npm run build` of the package is immediately picked up by the
   * next addon load.
   *
   * Auto-runs `ensureBuilt` so a workspace freshly cloned (with no
   * dist/ yet) still boots — same auto-build hook installCopy uses.
   *
   * Does NOT plant peer-dep symlinks into `<targetDir>/node_modules/`
   * the way the pre-`eb96df3c` symlink mode did. Self-contained
   * addons bundle their own copy of types/zod/sdk — no shared
   * workspace symlinks needed.
   */
  private async installSymlink(
    packageName: string,
    sourceDir: string,
    pkgData: Record<string, unknown>,
    targetDir: string,
  ): Promise<{ name: string; version: string }> {
    await this.ensureBuilt(packageName, sourceDir, pkgData)

    fs.rmSync(targetDir, { recursive: true, force: true })
    ensureDir(path.dirname(targetDir))
    fs.symlinkSync(sourceDir, targetDir, 'dir')

    this.manifest.upsert(packageName, {
      version: asString(pkgData.version, '0.0.0'),
      source: 'local',
    })

    this.logger.info(`${packageName} — symlinked → ${sourceDir}`)
    return {
      name: asString(pkgData.name, packageName),
      version: asString(pkgData.version, '0.0.0'),
    }
  }

  private async installCopy(
    packageName: string,
    sourceDir: string,
    pkgData: Record<string, unknown>,
    targetDir: string,
  ): Promise<{ name: string; version: string }> {
    // Auto-build if dist is missing or incomplete
    await this.ensureBuilt(packageName, sourceDir, pkgData)

    const distDir = path.join(sourceDir, 'dist')
    if (!fs.existsSync(distDir)) {
      throw new Error(`${packageName} has no dist/ after build`)
    }

    await fs.promises.rm(targetDir, { recursive: true, force: true })
    ensureDir(targetDir)

    // Write stripped package.json (no @camstack/* deps)
    await fs.promises.writeFile(
      path.join(targetDir, 'package.json'),
      JSON.stringify(stripBundledDeps(pkgData), null, 2),
    )

    await copyDirRecursive(distDir, path.join(targetDir, 'dist'))
    await copyExtraFileDirs(pkgData, sourceDir, targetDir)
    // Propagate PREBUILT natives the packaged desktop planted in the bundled
    // addon copy (better-sqlite3/sharp/node-av) into the target BEFORE the npm
    // install — else that install leaves better-sqlite3 source-only on a
    // toolchain-less Mac, shadowing the good hoisted `.node` and bricking the
    // runner. No-op in dev / docker (source carries no bundled natives).
    copyBundledNativeModules(sourceDir, targetDir, this.logger)
    await fs.promises.writeFile(path.join(targetDir, '.install-source'), 'local')

    // Mirror to centralised manifest (single source-of-truth for UI + update flow)
    const localPkgVersion = asString(pkgData.version, '0.0.0')
    this.manifest.upsert(packageName, {
      version: localPkgVersion,
      source: 'local',
    })

    // Install production dependencies (non-fatal). Skip entirely when
    // the stripped package.json has zero runtime deps — most
    // self-contained addons inline everything into dist, so
    // `npm install` would spin up node + npm for ~2-3s with nothing
    // to do. With 25 REQUIRED_PACKAGES that adds 60-75s to boot.
    const strippedDeps = stripBundledDeps(pkgData) as Record<string, unknown>
    const hasRuntimeDeps =
      strippedDeps['dependencies'] &&
      typeof strippedDeps['dependencies'] === 'object' &&
      Object.keys(strippedDeps['dependencies'] as Record<string, unknown>).length > 0
    if (hasRuntimeDeps) {
      try {
        await runNpm(
          ['install', '--omit=dev', '--ignore-scripts=false'],
          this.npmRunOptions(targetDir, 120_000),
        )
      } catch (err) {
        // Non-fatal on the copy path (dev: workspace-hoisted deps usually
        // cover) — but LOUD, never a bare swallow (the Mac ran for days on
        // addons whose deps had silently never installed).
        this.logger.warn(`${packageName} — npm install failed (continuing)`, {
          meta: { error: errMsg(err) },
        })
      }
    }

    // Manifest-driven native deps — see `installFromTgz` for rationale.
    // Wrapped in try/catch (non-fatal): copy installs are typically used
    // in dev where workspace-hoisted deps cover the natives at root, so
    // failure here doesn't necessarily mean the addon won't load.
    try {
      await installManifestNativeDeps(
        targetDir,
        pkgData,
        this.logger,
        this.registry,
        this.npmCacheDir,
      )
    } catch (err) {
      this.logger.warn(`${packageName} — native deps install failed (continuing)`, {
        meta: { error: errMsg(err) },
      })
    }

    // POST-INSTALL native-prebuild ENSURE. The `npm install` above RE-CREATES a
    // traditional native (`better-sqlite3`, a runtime dep of `@camstack/system`)
    // SOURCE-ONLY on a toolchain-less host, clobbering the good `.node` the
    // pre-install `copyBundledNativeModules` planted (Mac desktop first-boot
    // FATAL, 2026-07-21 — the copy-before-install fix was empirically
    // insufficient). Re-plant from the bundled copy (offline) or fetch the
    // prebuild for the running ABI; THROW LOUD naming module + addon if a
    // required native is still source-only, rather than dying later at addon
    // init with a cryptic bindings error. A no-op in docker/dev (npm produced a
    // working `.node`) and when the native isn't part of this addon.
    await ensureAddonNativePrebuilds(targetDir, {
      addonName: packageName,
      logger: this.logger,
      bundledSourceDir: sourceDir,
    })

    // Last materialisation step, mirroring installFromTgz: closure-provided
    // deps become links instead of copies.
    this.dedupeTreeAgainstClosure(targetDir, packageName)

    this.logger.info(`${packageName} — copied from ${sourceDir}`)
    return { name: pkgData.name as string, version: pkgData.version as string }
  }

  /**
   * Install addon from npm (download tgz, then extract). Tries the
   * registry HTTPS API first (works inside packaged Electron — no need
   * for `npm` on PATH); falls back to `npm pack` for parity with the
   * legacy path when the registry call fails (private registries with
   * unusual auth, offline mode, etc).
   */
  async installFromNpm(
    packageName: string,
    version?: string,
  ): Promise<{ name: string; version: string }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-addon-npm-'))
    const packageSpec = version ? `${packageName}@${version}` : packageName

    this.logger.info(`${packageName} — installing from npm`)

    try {
      const tgzPath = await this.downloadNpmTarball(packageName, version, tmpDir).catch(
        async (httpErr: unknown) => {
          this.logger.warn(
            `Registry HTTP fetch failed for ${packageSpec} — falling back to 'npm pack'`,
            { meta: { error: httpErr instanceof Error ? httpErr.message : String(httpErr) } },
          )
          const args = ['pack', packageSpec, '--pack-destination', tmpDir]
          if (this.registry) args.push('--registry', this.registry)
          const { stdout } = await runNpm(args, this.npmRunOptions(tmpDir, 120_000))
          const tgzFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tgz'))
          if (tgzFiles.length === 0) {
            throw new Error(`npm pack produced no tgz. stdout: ${stdout.trim()}`)
          }
          return path.join(tmpDir, tgzFiles[0]!)
        },
      )

      const result = await this.installFromTgz(tgzPath)
      fs.writeFileSync(path.join(this.addonsDir, result.name, '.install-source'), 'npm')
      // Override the 'bundled' source written by installFromTgz with the
      // more specific 'npm' source.
      this.manifest.upsert(result.name, {
        version: result.version,
        source: 'npm',
      })
      return result
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  /**
   * Resolve `{packageName, version?}` against the configured registry
   * over HTTPS and download the tarball into `tmpDir`. Returns the path
   * to the downloaded `.tgz`.
   *
   * Versioning rules (mirrors `npm pack` semantics):
   *   - `version === undefined` → uses `dist-tags.latest`
   *   - exact semver string → looked up in `versions[version]`
   *   - dist-tag name (e.g. `next`, `beta`) → resolved via `dist-tags`
   *
   * Range specs (`^1.0.0`, `~1.2`, `>=2`) are NOT supported here — the
   * caller should resolve those upstream. `npm pack` handles them, so
   * the legacy fallback path remains the right answer for those.
   */
  private async downloadNpmTarball(
    packageName: string,
    version: string | undefined,
    tmpDir: string,
  ): Promise<string> {
    const registry = (this.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
    const metadataUrl = `${registry}/${encodeURIComponent(packageName).replace(/^%40/, '@')}`
    const metadataRes = await fetch(metadataUrl)
    if (!metadataRes.ok) {
      throw new Error(`registry GET ${metadataUrl} → ${metadataRes.status}`)
    }
    const metadata = (await metadataRes.json()) as {
      'dist-tags'?: Record<string, string>
      versions?: Record<string, { dist?: { tarball?: string } }>
    }

    const distTags = metadata['dist-tags'] ?? {}
    const versions = metadata.versions ?? {}
    let resolvedVersion: string | undefined
    if (version == null) {
      resolvedVersion = distTags['latest']
    } else if (versions[version]) {
      resolvedVersion = version
    } else if (distTags[version]) {
      resolvedVersion = distTags[version]
    }
    if (!resolvedVersion) {
      throw new Error(`no version resolved for ${packageName}@${version ?? 'latest'}`)
    }
    const tarballUrl = versions[resolvedVersion]?.dist?.tarball
    if (!tarballUrl) {
      throw new Error(`no dist.tarball for ${packageName}@${resolvedVersion}`)
    }

    const tarRes = await fetch(tarballUrl)
    if (!tarRes.ok) {
      throw new Error(`tarball GET ${tarballUrl} → ${tarRes.status}`)
    }
    const tgzPath = path.join(
      tmpDir,
      `${packageName.replace(/[/@]/g, '-').replace(/^-+/, '')}-${resolvedVersion}.tgz`,
    )
    const buf = Buffer.from(await tarRes.arrayBuffer())
    fs.writeFileSync(tgzPath, buf)
    return tgzPath
  }

  /**
   * Evict an existing install dir by atomic rename-aside, then best-effort
   * delete the aside copy.
   *
   * Why not a plain `fs.promises.rm(targetDir, {recursive})`: during a
   * `camstack deploy` the addon's live runner still holds its native
   * prebuilds (`.node`/`.so`) open. On the hub's shfs/FUSE `/data/addons`,
   * a recursive rm of a held subdir fails `ENOTEMPTY` mid-walk and leaves
   * the dir gutted. A rename only touches the dirent (metadata), so it
   * succeeds with the inodes still open — the old runner keeps its fds on
   * the moved inodes until it restarts.
   *
   * The aside copy is removed best-effort: the held native libs are only
   * released once the post-install `restartAddon` recycles the runner, so a
   * failure to delete it now must NOT fail the install. Any residue is swept
   * on the next deploy.
   */
  private async evictInstallDir(targetDir: string): Promise<void> {
    if (!fs.existsSync(targetDir)) return

    const graveyard = path.join(this.addonsDir, '.evicting')
    ensureDir(graveyard)
    // Sweep residue from earlier deploys first (held libs since released).
    await this.sweepGraveyard(graveyard)

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const flatName = path.relative(this.addonsDir, targetDir).replace(/[/\\]/g, '-')
    const asideDir = path.join(graveyard, `${flatName}-${ts}`)
    try {
      fs.renameSync(targetDir, asideDir)
    } catch (renameErr: unknown) {
      // Cross-device move (EXDEV) can't happen inside one shfs/FUSE mount,
      // but mirror the staged-swap fallback: drop back to an in-place rm.
      if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
        await fs.promises.rm(targetDir, { recursive: true, force: true })
        return
      }
      throw renameErr
    }
    // Best-effort delete; swallow held-open failures (released post-restart).
    await fs.promises
      .rm(asideDir, { recursive: true, force: true })
      .catch((cleanupErr: unknown) => {
        this.logger.debug('evictInstallDir: aside cleanup deferred (likely held open)', {
          meta: { asideDir, error: errMsg(cleanupErr) },
        })
      })
  }

  /**
   * Best-effort removal of `.staging` residue left by a CRASHED earlier deploy.
   *
   * Deliberately not `sweepGraveyard`: an evicted `.evicting/*` dir is dead by
   * construction, but a `.staging/*` dir may be an install still running — in
   * this process or another one. Deleting one of those fails a live deploy with
   * an ENOENT on its own package.json, which is what happened on 2026-08-07.
   */
  private async sweepStagingResidue(stagingRoot: string): Promise<void> {
    let names: string[]
    try {
      names = fs.readdirSync(stagingRoot)
    } catch {
      return
    }
    const now = Date.now()
    const ages: StagingEntryAge[] = []
    for (const name of names) {
      try {
        const stat = fs.statSync(path.join(stagingRoot, name))
        ages.push({ name, ageMs: now - stat.mtimeMs })
      } catch {
        /* vanished under us — nothing to sweep */
      }
    }
    const sweepable = selectSweepableStaging(ages, this.inFlightStaging)
    if (sweepable.length > 0) {
      this.logger.info('sweeping staging residue from a crashed earlier deploy', {
        meta: { stagingRoot, entries: sweepable },
      })
    }
    await Promise.all(
      sweepable.map((name) =>
        fs.promises
          .rm(path.join(stagingRoot, name), { recursive: true, force: true })
          .catch(() => undefined),
      ),
    )
  }

  /** Best-effort removal of leftover `.evicting/*` dirs from earlier deploys. */
  private async sweepGraveyard(graveyard: string): Promise<void> {
    let entries: string[]
    try {
      entries = fs.readdirSync(graveyard)
    } catch {
      return
    }
    await Promise.all(
      entries.map((name) =>
        fs.promises
          .rm(path.join(graveyard, name), { recursive: true, force: true })
          .catch(() => undefined),
      ),
    )
  }

  /**
   * Make `pkgDir` (an addon tree that has NOT been swapped in yet) runnable:
   * strip the host-provided deps from its manifest, then `npm install` whatever
   * survives.
   *
   * ONE implementation for every path that materialises an addon tree —
   * `installFromTgz` (deploy/upload) and `applyUpdateFromStaged` (OTA). The OTA
   * path did not have it, and that is a whole outage class: an addon declaring
   * `camstack.runtimeDependencies` was broken by its FIRST OTA update, its dist
   * landing without `node_modules`. Every load then threw `Cannot find module`
   * and the retry loop replayed it — `@camstack/addon-export-hap`, 126 failed
   * load retries over 10.5h on 2026-08-12; `@camstack/addon-remote-storage`
   * (`@aws-sdk/*`, `webdav`) is the same landmine.
   *
   * **Strip.** `@camstack/*` are host-provided system packages that resolve via
   * the host's node_modules (Node walks up from the installed addon dir). Left
   * in, this `npm install` pulls the LAST PUBLISHED `@camstack/types` (etc.)
   * into the addon's OWN node_modules where it SHADOWS the host's fresh copy —
   * local additions to a system package silently never reach the deployed
   * addon. Addon dists are self-contained besides, so `stripBundledDeps` keeps
   * only what the manifest explicitly declares in
   * `camstack.runtimeDependencies` (see fs-utils / ADR-0027). Nothing left to
   * install is the COMMON case: skip npm rather than pay an empty round-trip.
   *
   * **Failure is FATAL.** This used to warn-and-continue on the tgz path ("the
   * addon may still load if imports are lazy") — live cost: a host with no npm
   * (packaged Electron Mac agent) installed every runtime-dep addon WITHOUT its
   * node_modules for DAYS; each reported "running" while its entry failed at
   * import (`Cannot find module 'sharp'`), the detection group ran 1/3 members,
   * and the node silently dropped out of the balancer. Throwing here is what
   * keeps the PREVIOUS install intact: every caller builds the tree before it
   * swaps, so an abort simply means the swap never happens.
   *
   * A missing/unreadable manifest is NOT fatal — it is logged and skipped. The
   * callers validate the tree themselves, and a tree with no readable
   * package.json has no declared deps to install (the loader will skip the
   * package entirely).
   */
  private async installRuntimeDependencies(pkgDir: string, packageName: string): Promise<void> {
    const pkgJsonPath = path.join(pkgDir, 'package.json')
    const pkgView = readPackageJson(pkgJsonPath)
    if (pkgView == null) {
      this.logger.error(
        `${packageName} — no readable package.json in the prepared tree; runtime dependencies NOT installed`,
        { meta: { pkgJsonPath } },
      )
      return
    }

    const strippedManifest = stripBundledDeps(pkgView.raw)
    await fs.promises.writeFile(pkgJsonPath, JSON.stringify(strippedManifest, null, 2))

    const deps = asJsonObject(strippedManifest['dependencies'])
    const depNames = deps ? Object.keys(deps) : []
    if (depNames.length === 0) return

    this.logger.info(`${packageName} — installing runtime dependencies`, {
      meta: { stagingDir: pkgDir, dependencies: depNames },
    })
    try {
      await runNpm(
        [
          'install',
          '--omit=dev',
          '--omit=peer',
          '--no-audit',
          '--no-fund',
          '--no-package-lock',
          ...(this.registry ? ['--registry', this.registry] : []),
        ],
        this.npmRunOptions(pkgDir, 240_000),
      )
    } catch (err) {
      // Name WHY at the site. The caller only ever reports "update failed";
      // this line is what says the update failed because the addon's OWN
      // dependencies could not be fetched — which is otherwise indistinguishable
      // from a bad bundle when the addon later fails to import.
      this.logger.error(
        `${packageName} — runtime dependency install FAILED; update ABORTED (a swapped-in copy would fail every load with "Cannot find module")`,
        { meta: { pkgDir, dependencies: depNames, error: errMsg(err) } },
      )
      throw new Error(`${packageName} — runtime dependency install failed: ${errMsg(err)}`, {
        cause: err,
      })
    }
  }

  /**
   * Make `pkgDir`'s NATIVE modules loadable on THIS host, before it is swapped
   * in: install whatever `camstack.nativeDependencies` declares, then ensure
   * every traditional native present in the tree actually carries a compiled
   * `.node` for the running ABI.
   *
   * ONE implementation, for the same reason as {@link installRuntimeDependencies}
   * — every path that materialises an addon tree calls it, so no call site can
   * forget it. `installFromTgz` (deploy/upload) always ran these two steps; the
   * OTA staged-swap path ran NEITHER even after the runtime-dep fix (2026-08-12,
   * task #15, which named this gap explicitly). Same outage class one layer
   * down: an addon with native modules was broken by its FIRST OTA update, its
   * dist landing without an ABI-matched binary, and every load dying at the
   * binding (`Could not locate the bindings file`) — from the outside
   * indistinguishable from a bad bundle.
   *
   * **Two distinct steps, both load-bearing.**
   * `installManifestNativeDeps` fetches the DECLARED natives (prebuilt host copy
   * first — offline — then npm + an ABI rebuild), and is idempotent through a
   * content-hash marker. `ensureAddonNativePrebuilds` is the post-install pass:
   * npm can leave a traditional native (`better-sqlite3`) SOURCE-ONLY on a
   * toolchain-less host, so it re-fetches the prebuild for the running ABI and
   * THROWS naming module + addon if the binary is still absent. No bundled
   * source is available on this path (unlike `installCopy`) — fetch only.
   *
   * **Failure is FATAL**, mirroring the tgz path: callers complete the tree
   * BEFORE they swap, so an abort simply means the swap never happens and the
   * previous version keeps serving. Shipping a native-less copy instead would
   * trade one broken version for a crash-loop.
   *
   * A missing/unreadable manifest is logged and skipped — `installRuntimeDependencies`
   * has already said so loudly, and a tree with no readable package.json
   * declares no natives.
   */
  private async installNativeDependencies(pkgDir: string, packageName: string): Promise<void> {
    const pkgJsonPath = path.join(pkgDir, 'package.json')
    const pkgView = readPackageJson(pkgJsonPath)
    if (pkgView == null) {
      this.logger.error(
        `${packageName} — no readable package.json in the prepared tree; native dependencies NOT installed`,
        { meta: { pkgJsonPath } },
      )
      return
    }

    // Manifest-driven native deps. Mirror of `python.requirements` — declared in
    // `camstack.nativeDependencies`, installed per-addon so the host's regular
    // `npm install` doesn't pull in every camera driver's native deps. Installed
    // into the PREPARED tree: a failure throws before anything live is touched.
    try {
      await installManifestNativeDeps(
        pkgDir,
        pkgView.raw,
        this.logger,
        this.registry,
        this.npmCacheDir,
      )
    } catch (nativeErr) {
      // Name WHY at the site — the caller only ever reports "update failed".
      this.logger.error(
        `${packageName} — native dependency install FAILED; install ABORTED (a swapped-in copy would fail every load at the binding)`,
        { meta: { pkgDir, error: errMsg(nativeErr) } },
      )
      throw new Error(`${packageName} — native deps install failed: ${errMsg(nativeErr)}`, {
        cause: nativeErr,
      })
    }

    // POST-INSTALL native-prebuild ENSURE. The npm install above can leave a
    // traditional native SOURCE-ONLY on a toolchain-less host; fetch the
    // prebuild for the running ABI into the prepared tree, and THROW LOUD naming
    // module + addon if it is still missing so the swap never ships a broken
    // install. A no-op in docker where npm produced a working `.node`.
    await ensureAddonNativePrebuilds(pkgDir, {
      addonName: packageName,
      logger: this.logger,
    })
  }

  /**
   * Stop copying what the server closure already provides: replace each
   * top-level `node_modules` entry the closure serves at a COMPATIBLE version
   * with a symlink into the closure (see `deps/closure-dedupe.ts` for the
   * plan rules and the live measurements). Runs LAST in tree
   * materialisation — after the runtime-dep npm install AND the native-dep
   * steps — so no later npm invocation can fight the links.
   *
   * Non-fatal by design: dedupe is an optimisation, and its failure mode is
   * "the addon keeps its own copies", which is exactly today's behaviour. A
   * refusal on version grounds is logged loudly — that line is the answer to
   * "why does this addon still carry its own zod".
   */
  private dedupeTreeAgainstClosure(pkgDir: string, packageName: string): void {
    const closureNodeModules = resolveClosureNodeModulesDir(this.closureNodeModulesDir)
    if (closureNodeModules === null) return
    try {
      const state = collectAddonTreeState(pkgDir)
      if (state.candidates.length === 0) return
      const pkgView = readPackageJson(path.join(pkgDir, 'package.json'))
      const plan = planClosureDedupe({
        candidates: state.candidates,
        closureVersions: readClosureVersions(
          closureNodeModules,
          state.candidates.map((c) => c.name),
        ),
        requirements: state.requirements,
        neverLink: readNativeDependencyNames(pkgView?.raw),
      })
      const linked = executeClosureDedupe(pkgDir, closureNodeModules, plan, this.logger)
      if (linked.length > 0) {
        this.logger.info(
          `${packageName} — ${linked.length} node_modules entr${linked.length === 1 ? 'y' : 'ies'} now resolve from the server closure`,
          { meta: { linked } },
        )
      }
      const refused = plan.keeps.filter((k) => k.reason === 'version-incompatible')
      if (refused.length > 0) {
        this.logger.info(
          `${packageName} — kept own copy where the closure version is incompatible`,
          { meta: { kept: refused.map((k) => k.name) } },
        )
      }
    } catch (err) {
      this.logger.warn(`${packageName} — closure dedupe failed (copies kept)`, {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Install addon from a tgz file (uploaded or downloaded) */
  async installFromTgz(tgzPath: string): Promise<{ name: string; version: string }> {
    // STAGED UNPACK ON THE FUSE MOUNT + ATOMIC RENAME.
    //
    // This runs on the LIVE hub event loop during a `camstack deploy`, and
    // `this.addonsDir` is the slow Unraid shfs/FUSE `/data/addons`. The former
    // path extracted to /tmp then `fs.promises.cp`'d the large dist ACROSS to
    // the FUSE mount file-by-file on the main process. That recursive copy of a
    // big bundle (addon-pipeline) saturated the libuv threadpool AND the disk
    // IO so hard it starved the whole host — HTTP listener wedged, SSH/web/docker
    // unreachable, and the kernel's RCU watchdog fired stall warnings on the
    // console. Fix: extract the tgz DIRECTLY into a staging dir on the SAME FUSE
    // mount via the `tar` SUBPROCESS (all the heavy per-file writes happen off
    // the Node event loop), build it in place (strip + npm + native deps, all
    // subprocesses), then swap it in with a single ATOMIC RENAME — a metadata op,
    // not a copy. No main-thread file IO touches the event loop.
    const stagingRoot = path.join(this.addonsDir, '.staging')
    ensureDir(stagingRoot)
    // Clear staging residue from a CRASHED earlier deploy — never a live one.
    await this.sweepStagingResidue(stagingRoot)
    const stagingName = `install-${process.pid}-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const stagingDir = path.join(stagingRoot, stagingName)
    ensureDir(stagingDir)
    this.inFlightStaging.add(stagingName)

    try {
      // Heavy extract → the FUSE mount, in the `tar` subprocess (off the event
      // loop). Slower than /tmp, but it can no longer wedge the event loop.
      await execFileAsync('tar', ['-xzf', tgzPath, '-C', stagingDir], {
        timeout: 120_000,
      })

      // npm-packed tgzs carry a `package/` prefix; tolerate root-level too.
      const pkgDir = fs.existsSync(path.join(stagingDir, 'package', 'package.json'))
        ? path.join(stagingDir, 'package')
        : stagingDir
      const pkgJsonPath = path.join(pkgDir, 'package.json')
      if (!fs.existsSync(pkgJsonPath)) {
        throw new Error('No package.json found in tgz archive')
      }

      const pkgView = readPackageJson(pkgJsonPath)
      if (!pkgView) {
        throw new Error(`Invalid package.json at ${pkgJsonPath}`)
      }
      if (!pkgView.camstackAddons) {
        throw new Error(`Package ${pkgView.name} has no camstack.addons manifest`)
      }

      const targetDir = path.join(this.addonsDir, pkgView.name)

      // dist/ + extra `files` dirs (python/, …) are already extracted into
      // `pkgDir` by tar — they ride along in the atomic rename below, so there is
      // NO separate main-thread copy (the old wedge). Strip + npm + native deps
      // all land in `pkgDir`, then it swaps.
      await this.installRuntimeDependencies(pkgDir, pkgView.name)

      // Manifest-driven native deps + the post-install prebuild ENSURE, both
      // into the STAGING dir — a failure just throws; the `finally` removes the
      // whole staging tree, so the live install is never touched. Shared with
      // the OTA staged-swap path (see `installNativeDependencies`).
      await this.installNativeDependencies(pkgDir, pkgView.name)

      // Last materialisation step: link closure-provided deps instead of
      // keeping the copies npm just wrote (non-fatal — see the method).
      this.dedupeTreeAgainstClosure(pkgDir, pkgView.name)

      // ATOMIC SWAP. The staging tree is fully built; evict the previous install
      // by rename-aside (a metadata op that survives the old runner holding its
      // native prebuilds open on shfs/FUSE — an in-place recursive rm throws
      // ENOTEMPTY mid-delete and GUTS the dir), then rename staging → target.
      // Both live under `this.addonsDir` (same FUSE mount) so the rename is a
      // pure metadata op — no per-file copy, no event-loop / libuv saturation,
      // no host IO storm. This is the whole point of the staged unpack.
      await this.evictInstallDir(targetDir)
      ensureDir(path.dirname(targetDir))
      await fs.promises.rename(pkgDir, targetDir)

      // Mirror to centralised manifest. Default source is 'bundled' (the
      // most conservative); callers like installFromNpm/installFromUpload
      // overwrite the source after this call returns.
      this.manifest.upsert(pkgView.name, {
        version: pkgView.version,
        source: 'bundled',
      })

      return { name: pkgView.name, version: pkgView.version }
    } finally {
      // Remove the staging tree. After a successful install `pkgDir` has been
      // renamed away, so this only clears the wrapper dir (and any residue on a
      // failure path). Best-effort — held-open inodes are swept next deploy.
      this.inFlightStaging.delete(stagingName)
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // ── Update / rollback ────────────────────────────────────────────────────

  /**
   * Apply an update to an installed addon, backing up the current
   * version first so the caller can roll back atomically on failure.
   *
   * Steps:
   *   1. Rename current install dir → {addonsDir}/.backups/{name}/{ts}/
   *   2. Run a fresh install (npm or local depending on installSource)
   *   3. Record `lastBackupDir` in the manifest entry
   *   4. Prune every OTHER backup of this addon — the previous one just
   *      lost its only pointer and would otherwise be orphaned forever.
   *
   * The post-install caller (restart + health-check) is responsible for
   * verifying the new version actually works, and for calling either
   * `clearBackup()` on success or `rollbackAddon()` on failure. This
   * method must NOT delete the backup itself: at this point the new
   * version has not been proven to work.
   *
   * Throws if there is no installed version to update — caller should
   * prefer plain `install()` for first-time installs.
   */
  async applyUpdate(
    packageName: string,
    version?: string,
  ): Promise<{ name: string; version: string; backupDir: string }> {
    const current = this.manifest.get(packageName)
    if (current == null) {
      throw new Error(`Cannot update ${packageName}: not currently tracked in manifest`)
    }
    const addonDir = path.join(this.addonsDir, packageName)
    if (!fs.existsSync(addonDir)) {
      throw new Error(`Cannot update ${packageName}: install dir ${addonDir} missing`)
    }

    // 1. Backup
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupRoot = path.join(this.addonsDir, '.backups', packageName)
    ensureDir(backupRoot)
    const backupDir = path.join(backupRoot, ts)
    this.logger.info(`${packageName} — backing up v${current.version} → ${backupDir}`)
    fs.renameSync(addonDir, backupDir)

    // 2. Install new version
    let result: { name: string; version: string }
    try {
      if (this.installSource === 'local' || this.installSource === 'symlink') {
        const pkgDir = this.findLocalPackage(packageName)
        if (pkgDir == null) {
          throw new Error(
            `Local source not found for ${packageName} (installSource=${this.installSource})`,
          )
        }
        await this.installLocal(packageName, pkgDir)
        result = {
          name: packageName,
          version: this.manifest.get(packageName)?.version ?? current.version,
        }
      } else {
        result = await this.installFromNpm(packageName, version)
      }
    } catch (installErr) {
      // Restore the backup so the addon stays online with the old version
      this.logger.error(`${packageName} — install failed, restoring backup`, {
        meta: { error: errMsg(installErr) },
      })
      try {
        // Defensive cleanup: install may have left a partial directory
        if (fs.existsSync(addonDir)) {
          fs.rmSync(addonDir, { recursive: true, force: true })
        }
        fs.renameSync(backupDir, addonDir)
        this.manifest.upsert(packageName, {
          version: current.version,
          source: current.source,
          lastBackupDir: undefined,
        })
      } catch (restoreErr) {
        this.logger.error(`${packageName} — backup restore ALSO failed; manual recovery needed`, {
          meta: { backupDir, error: errMsg(restoreErr) },
        })
      }
      throw installErr
    }

    // 3. Record the backup pointer so callers can rollback later
    this.manifest.upsert(packageName, {
      version: result.version,
      source: this.manifest.get(packageName)?.source ?? 'npm',
      lastBackupDir: backupDir,
    })

    // 4. Exactly one backup per addon survives. Any earlier one just lost
    //    its last pointer.
    await this.pruneBackups(packageName, backupDir)

    return { name: result.name, version: result.version, backupDir }
  }

  /**
   * Apply an update from a pre-validated staged directory — the fast
   * swap-from-staged path that skips npm entirely.
   *
   * Mirrors `applyUpdate` exactly for backup/restore/manifest, but
   * replaces step 2 ("install new version") with an atomic directory
   * move of `stagedPath` into `addonDir`.
   *
   * "Skips npm entirely" is true only of the REGISTRY round-trip: the staged
   * tree is the raw unpacked tarball, so the addon's own
   * `camstack.runtimeDependencies` AND `camstack.nativeDependencies` still have
   * to be installed into it, exactly as `installFromTgz` does. Skipping the
   * first broke every runtime-dep addon on its first OTA update; skipping the
   * second broke every addon with a native module the same way, one layer down
   * (`Could not locate the bindings file` instead of `Cannot find module`) —
   * see {@link installRuntimeDependencies} and {@link installNativeDependencies}.
   *
   * Order matters and is `installFromTgz`'s: the tree is COMPLETED FIRST, and
   * the live install is only then backed up and replaced. So the addon keeps
   * serving the old version for the whole (minutes-long) npm install, the swap
   * window stays two renames wide, and a dependency failure aborts with the
   * previous version untouched instead of leaving a dependency-less copy live.
   *
   * On cross-device move (EXDEV) falls back to a recursive copy followed
   * by removal of the staged directory. On any swap failure the backup is
   * restored and the error is rethrown — identical recovery to `applyUpdate`.
   *
   * Throws if the package is not tracked in the manifest, if `addonDir`
   * is missing (same preconditions as `applyUpdate`), or if the runtime-dep /
   * native-dep install fails.
   */
  async applyUpdateFromStaged(
    packageName: string,
    version: string,
    stagedPath: string,
  ): Promise<{ name: string; version: string; backupDir: string }> {
    const current = this.manifest.get(packageName)
    if (current == null) {
      throw new Error(`Cannot update ${packageName}: not currently tracked in manifest`)
    }
    const addonDir = path.join(this.addonsDir, packageName)
    if (!fs.existsSync(addonDir)) {
      throw new Error(`Cannot update ${packageName}: install dir ${addonDir} missing`)
    }

    // 1. Complete the staged tree — strip host-provided deps, install the
    //    addon's declared runtime deps, then its native deps + the prebuild
    //    ensure. Before the backup rename on purpose: the old version stays live
    //    and serving for the duration, and a failure here aborts the update
    //    having touched nothing.
    await this.installRuntimeDependencies(stagedPath, packageName)
    await this.installNativeDependencies(stagedPath, packageName)
    this.dedupeTreeAgainstClosure(stagedPath, packageName)

    // 2. Backup (identical to applyUpdate)
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupRoot = path.join(this.addonsDir, '.backups', packageName)
    ensureDir(backupRoot)
    const backupDir = path.join(backupRoot, ts)
    this.logger.info(`${packageName} — backing up v${current.version} → ${backupDir}`)
    fs.renameSync(addonDir, backupDir)

    // 3. Swap: move the completed staged dir into addonDir (no registry npm)
    try {
      try {
        fs.renameSync(stagedPath, addonDir)
      } catch (renameErr: unknown) {
        const code = (renameErr as NodeJS.ErrnoException).code
        if (code === 'EXDEV') {
          // Cross-device move: fall back to recursive copy + remove staged
          fs.cpSync(stagedPath, addonDir, { recursive: true })
          fs.rmSync(stagedPath, { recursive: true, force: true })
        } else {
          throw renameErr
        }
      }
    } catch (swapErr) {
      // Restore the backup so the addon stays online with the old version
      this.logger.error(`${packageName} — staged swap failed, restoring backup`, {
        meta: { error: errMsg(swapErr) },
      })
      try {
        if (fs.existsSync(addonDir)) {
          fs.rmSync(addonDir, { recursive: true, force: true })
        }
        fs.renameSync(backupDir, addonDir)
        this.manifest.upsert(packageName, {
          version: current.version,
          source: current.source,
          lastBackupDir: undefined,
        })
      } catch (restoreErr) {
        this.logger.error(`${packageName} — backup restore ALSO failed; manual recovery needed`, {
          meta: { backupDir, error: errMsg(restoreErr) },
        })
      }
      throw swapErr
    }

    // 4. Record the backup pointer so callers can rollback later
    this.manifest.upsert(packageName, {
      version,
      source: this.manifest.get(packageName)?.source ?? 'npm',
      lastBackupDir: backupDir,
    })

    // 5. Exactly one backup per addon survives (see `applyUpdate` step 4).
    await this.pruneBackups(packageName, backupDir)

    return { name: packageName, version, backupDir }
  }

  /**
   * Roll back an addon to its most recent backup. Used after an update
   * passes installation but fails its post-restart health check.
   *
   * Returns the version that was restored, or `null` if there was no
   * backup to roll back to.
   */
  async rollbackAddon(packageName: string): Promise<string | null> {
    const entry = this.manifest.get(packageName)
    if (entry?.lastBackupDir == null) {
      this.logger.warn(`${packageName} — no backup to rollback to`)
      return null
    }
    if (!fs.existsSync(entry.lastBackupDir)) {
      this.logger.warn(`${packageName} — backup dir vanished: ${entry.lastBackupDir}`)
      return null
    }

    const addonDir = path.join(this.addonsDir, packageName)
    if (fs.existsSync(addonDir)) {
      fs.rmSync(addonDir, { recursive: true, force: true })
    }
    fs.renameSync(entry.lastBackupDir, addonDir)

    // Read the package.json of the restored install to learn its version
    const pkgJsonPath = path.join(addonDir, 'package.json')
    let restoredVersion = entry.version
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
        if (typeof parsed === 'object' && parsed != null) {
          const v = (parsed as { version?: string }).version
          if (typeof v === 'string' && v.length > 0) restoredVersion = v
        }
      } catch {
        /* keep manifest-recorded version */
      }
    }

    this.manifest.upsert(packageName, {
      version: restoredVersion,
      source: entry.source,
      lastBackupDir: undefined,
    })
    this.logger.info(`${packageName} — rolled back to v${restoredVersion}`)
    return restoredVersion
  }

  // ── Backup retention ─────────────────────────────────────────────────────

  /** Root of the pre-update rollback copies: `{addonsDir}/.backups`. */
  private get backupsRoot(): string {
    return path.join(this.addonsDir, '.backups')
  }

  /**
   * True only when `target` resolves to something strictly INSIDE
   * `{addonsDir}/.backups/`.
   *
   * Every deletion in this section funnels through here. `lastBackupDir`
   * is read back from a manifest file on disk — an operator edit, a
   * restored manifest from another host, or a `..` in the recorded path
   * must never turn "reclaim a backup" into "delete the live install".
   */
  private isInsideBackups(target: string): boolean {
    const rel = path.relative(path.resolve(this.backupsRoot), path.resolve(target))
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  /**
   * Best-effort removal of one path under `.backups/`.
   *
   * Never throws: an undeleted backup is a disk-space problem, whereas a
   * throw on the post-update success path would turn a working update into
   * a reported outage. Returns true only when the path is gone.
   */
  private async removeBackupPath(target: string, reason: string): Promise<boolean> {
    if (!this.isInsideBackups(target)) {
      this.logger.error('Refusing to remove a backup path outside .backups/', {
        meta: { target, backupsRoot: this.backupsRoot, reason },
      })
      return false
    }
    try {
      await fs.promises.rm(target, { recursive: true, force: true })
      return true
    } catch (err) {
      // Held-open inodes on shfs/FUSE make a recursive rm fail mid-delete.
      // Log and move on — the boot sweep retries next start.
      this.logger.warn('Backup removal failed; leaving residue for the next boot sweep', {
        meta: { target, reason, error: errMsg(err) },
      })
      return false
    }
  }

  /** List the timestamped backup dirs recorded for one package. */
  private listBackupsFor(packageName: string): string[] {
    const dir = path.join(this.backupsRoot, packageName)
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(dir, e.name))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * Keep at most ONE backup per addon: drop every backup dir for
   * `packageName` except `keepDir`.
   *
   * Called right after a new backup is recorded. Without this, a second
   * update overwrites `lastBackupDir` and the previous backup becomes
   * unreachable — no pointer, so neither `rollbackAddon` nor `clearBackup`
   * can ever see it again. That is how the live hub accumulated two 398 MiB
   * copies of one addon. Never throws.
   */
  private async pruneBackups(packageName: string, keepDir?: string): Promise<string[]> {
    const keep = keepDir == null ? null : path.resolve(keepDir)
    const removed: string[] = []
    for (const candidate of this.listBackupsFor(packageName)) {
      if (keep != null && path.resolve(candidate) === keep) continue
      if (await this.removeBackupPath(candidate, 'superseded-backup')) removed.push(candidate)
    }
    if (removed.length > 0) {
      this.logger.info(`${packageName} — pruned ${removed.length} superseded backup(s)`)
    }
    await this.removeEmptyBackupDirs(packageName)
    return removed
  }

  /** Drop `.backups/{pkg}` (and its `@scope` parent) once they are empty. */
  private async removeEmptyBackupDirs(packageName: string): Promise<void> {
    const pkgDir = path.join(this.backupsRoot, packageName)
    for (const dir of [pkgDir, path.dirname(pkgDir)]) {
      if (!this.isInsideBackups(dir)) continue
      try {
        await fs.promises.rmdir(dir)
      } catch {
        // Not empty, or already gone — both fine.
        return
      }
    }
  }

  /**
   * Drop the recorded backup for an addon — call once the post-update
   * health check confirms the new version actually works.
   *
   * Never throws and never rejects. The manifest pointer is cleared even
   * when the bytes could not be removed: a pointer at a half-deleted tree
   * would make `rollbackAddon` restore a gutted install, and the boot sweep
   * reclaims the residue on the next start.
   */
  async clearBackup(packageName: string): Promise<void> {
    const entry = this.manifest.get(packageName)
    if (entry?.lastBackupDir == null) return
    const removed = await this.removeBackupPath(entry.lastBackupDir, 'update-confirmed')
    if (removed) {
      this.logger.info(`${packageName} — update confirmed, backup reclaimed`, {
        meta: { backupDir: entry.lastBackupDir },
      })
    }
    try {
      this.manifest.upsert(packageName, {
        version: entry.version,
        source: entry.source,
        lastBackupDir: undefined,
      })
    } catch (err) {
      this.logger.warn(`${packageName} — could not clear the backup pointer`, {
        meta: { error: errMsg(err) },
      })
    }
    await this.removeEmptyBackupDirs(packageName)
  }

  /**
   * Boot-time retention sweep over `{addonsDir}/.backups/`.
   *
   * RULE: for each addon, the ONLY backup that survives is the one the
   * manifest's `lastBackupDir` points at — everything else is unreachable
   * by construction (no pointer ⇒ neither `rollbackAddon` nor `clearBackup`
   * can ever reach it). One exception: when the addon's LIVE install dir is
   * missing, the newest backup is the only surviving copy of that addon (a
   * crash between the rename-aside and the manifest write in `applyUpdate`),
   * so it is kept instead of reclaimed.
   *
   * Why not "delete everything once the addon is healthy": this installer
   * has no health signal, and the pointed-at backup is precisely the one a
   * failed update left for the operator's Rollback button. Bounding to one
   * per addon is enough — the observed 814 MiB was duplicate copies, not a
   * single retained rollback target.
   *
   * Never throws. Safe to run on every boot; runs before any update can be
   * in flight.
   */
  async sweepBackups(): Promise<BackupSweepResult> {
    const removed: string[] = []
    const kept: string[] = []
    for (const packageName of this.listBackedUpPackages()) {
      const backups = this.listBackupsFor(packageName)
      if (backups.length === 0) {
        await this.removeEmptyBackupDirs(packageName)
        continue
      }
      const keep = this.resolveBackupToKeep(packageName, backups)
      for (const candidate of backups) {
        if (keep != null && path.resolve(candidate) === path.resolve(keep)) {
          kept.push(candidate)
          continue
        }
        if (await this.removeBackupPath(candidate, 'boot-sweep')) removed.push(candidate)
      }
      await this.removeEmptyBackupDirs(packageName)
    }
    if (removed.length > 0 || kept.length > 0) {
      this.logger.info(
        `Backup sweep — reclaimed ${removed.length}, retained ${kept.length} rollback target(s)`,
      )
    }
    return { removed, kept }
  }

  /**
   * Which backup of `packageName` survives the sweep: the manifest's
   * rollback target, or — when the live install is gone — the newest copy,
   * which is then the only one that exists. `null` means "reclaim them all".
   */
  private resolveBackupToKeep(packageName: string, backups: readonly string[]): string | null {
    const liveDir = path.join(this.addonsDir, packageName)
    if (!fs.existsSync(liveDir)) {
      // Crash between the rename-aside and the manifest write: the backup IS
      // the addon. Never reclaim the last copy.
      const newest = backups[backups.length - 1] ?? null
      if (newest != null) {
        this.logger.warn(
          `${packageName} — live install dir missing; retaining its newest backup as the only surviving copy`,
          { meta: { liveDir, backupDir: newest } },
        )
      }
      return newest
    }
    const pointer = this.manifest.get(packageName)?.lastBackupDir
    if (pointer == null) return null
    const resolved = path.resolve(pointer)
    return backups.some((b) => path.resolve(b) === resolved) ? pointer : null
  }

  /** Package names that have a `.backups/{pkg}` directory, scoped or not. */
  private listBackedUpPackages(): string[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.backupsRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const names: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith('@')) {
        names.push(entry.name)
        continue
      }
      const scopeDir = path.join(this.backupsRoot, entry.name)
      for (const inner of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (inner.isDirectory()) names.push(`${entry.name}/${inner.name}`)
      }
    }
    return names
  }

  // ── Uninstall / query ────────────────────────────────────────────────────

  async uninstall(packageName: string): Promise<void> {
    const addonDir = path.join(this.addonsDir, packageName)
    if (fs.existsSync(addonDir)) {
      fs.rmSync(addonDir, { recursive: true, force: true })
      this.manifest.remove(packageName)
      return
    }
    const legacyDir = path.join(this.addonsDir, packageName.replace(/^@[^/]+\//, ''))
    if (fs.existsSync(legacyDir)) {
      fs.rmSync(legacyDir, { recursive: true, force: true })
      this.manifest.remove(packageName)
    }
  }

  listInstalled(): InstalledPackage[] {
    if (!fs.existsSync(this.addonsDir)) return []

    const packageDirs: string[] = []
    for (const entry of fs.readdirSync(this.addonsDir, {
      withFileTypes: true,
    })) {
      if (!isDirEntry(entry, this.addonsDir)) continue
      if (entry.name.startsWith('@')) {
        const scopeDir = path.join(this.addonsDir, entry.name)
        for (const inner of fs.readdirSync(scopeDir, { withFileTypes: true })) {
          if (isDirEntry(inner, scopeDir)) packageDirs.push(path.join(scopeDir, inner.name))
        }
      } else {
        packageDirs.push(path.join(this.addonsDir, entry.name))
      }
    }

    return packageDirs
      .map((dir) => {
        const pkgPath = path.join(dir, 'package.json')
        if (!fs.existsSync(pkgPath)) return null
        const pkg = readPackageJson(pkgPath)
        if (!pkg || !pkg.camstackAddons) return null
        const sourceFile = path.join(dir, '.install-source')
        const installSource = fs.existsSync(sourceFile)
          ? parseInstallSource(fs.readFileSync(sourceFile, 'utf-8').trim())
          : undefined
        return {
          name: pkg.name,
          version: pkg.version,
          dir,
          ...(installSource ? { installSource } : {}),
        }
      })
      .filter((item): item is InstalledPackage => item !== null)
  }

  isInstalled(packageName: string): boolean {
    if (fs.existsSync(path.join(this.addonsDir, packageName, 'package.json'))) return true
    return fs.existsSync(
      path.join(this.addonsDir, packageName.replace(/^@[^/]+\//, ''), 'package.json'),
    )
  }

  getInstalledPackage(packageName: string): InstalledPackage | null {
    let pkgPath = path.join(this.addonsDir, packageName, 'package.json')
    if (!fs.existsSync(pkgPath)) {
      pkgPath = path.join(this.addonsDir, packageName.replace(/^@[^/]+\//, ''), 'package.json')
    }
    if (!fs.existsSync(pkgPath)) return null
    const pkg = readPackageJson(pkgPath)
    if (!pkg) return null
    return {
      name: pkg.name,
      version: pkg.version,
      dir: path.dirname(pkgPath),
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private findLocalPackage(packageName: string): string | null {
    if (!this.workspaceDir) return null
    const shortName = packageName.replace('@camstack/', '')
    for (const dirName of [shortName, `addon-${shortName}`, shortName.replace('addon-', '')]) {
      const candidate = path.join(this.workspaceDir, dirName)
      try {
        const pkg = asJsonObject(
          parseJsonUnknown(fs.readFileSync(path.join(candidate, 'package.json'), 'utf-8')),
        )
        if (pkg && asString(pkg['name']) === packageName) return candidate
      } catch {
        /* not found */
      }
    }
    return null
  }

  /** Ensure a package is built (dist/ exists and page bundles present) */
  private async ensureBuilt(
    packageName: string,
    sourceDir: string,
    pkgData: Record<string, unknown>,
  ): Promise<void> {
    const distDir = path.join(sourceDir, 'dist')
    const needsBuild = !fs.existsSync(distDir) || this.isDistIncomplete(pkgData, sourceDir)
    if (!needsBuild) return

    this.logger.info(`${packageName} — building (dist/ missing or incomplete)`)
    try {
      await runNpm(['run', 'build'], this.npmRunOptions(sourceDir, 180_000))
    } catch (err) {
      const msg = errMsg(err)
      this.logger.warn(`${packageName} auto-build failed`, { meta: { error: msg } })
    }
  }

  /** Check if page bundles declared in package.json are missing from dist/ */
  private isDistIncomplete(pkgData: Record<string, unknown>, sourceDir: string): boolean {
    const camstack = pkgData['camstack'] as
      | { addons?: Array<{ pages?: Array<{ bundle?: string }> }> }
      | undefined
    if (!camstack?.addons) return false
    for (const addon of camstack.addons) {
      if (!addon.pages) continue
      for (const page of addon.pages) {
        if (page.bundle && !fs.existsSync(path.join(sourceDir, 'dist', page.bundle))) return true
      }
    }
    return false
  }
}

/** Check if a Dirent is a directory (or a symlink to one) */
function isDirEntry(entry: fs.Dirent, parentDir: string): boolean {
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    try {
      return fs.statSync(path.join(parentDir, entry.name)).isDirectory()
    } catch {
      return false
    }
  }
  return false
}
