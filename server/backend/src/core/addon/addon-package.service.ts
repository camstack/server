import { userError } from '@camstack/types'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import {
  ADDON_VERSION_REASON_REGISTRY_LATEST,
  AddonInstaller,
  decideAddonVersionMove,
  detectWorkspacePackagesDir,
  ensureDir,
  scheduleSelfRestart,
  writePendingRestart,
} from '@camstack/system'
import type {
  AutoUpdateChannel,
  InstalledPackage,
  IScopedLogger,
  PackageUpdate,
  PackageVersionInfo,
  PendingRestartMarkerPayload,
  UpdateResult,
} from '@camstack/types'
import { EventCategory, errMsg } from '@camstack/types'
import { ConfigService } from '../config/config.service'
import { EventBusService } from '../events/event-bus.service'
import { LoggingService } from '../logging/logging.service'
import { NotificationServiceWrapper } from '../notification/notification-wrapper.service'
import { ToastServiceWrapper } from '../notification/toast-wrapper.service'
import type { RootRestartUpdate } from '../../server-root/index.js'
import type { UpdateAvailablePayload } from '../update-availability-emitter.js'
import { UpdateAvailabilityEmitter } from '../update-availability-emitter.js'
import type { IUpdateAvailabilityStore } from '../update-availability-store.js'
import {
  clampUpdateCheckInterval,
  DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
} from '../updates/update-check-scheduler.js'
import { buildRestartMarker } from '../updates/restart-marker.js'
import { AddonRegistryService } from './addon-registry.service'
import { computeDistBuildId, resolveHubClosurePackageDir } from './package-dir-utils.js'

const execFileAsync = promisify(execFile)

/**
 * The primary host-provided framework package (kernel + core). Kept as a named
 * export because `lifecycle-job-runner` + several tests reference it directly.
 */
export const SYSTEM_PACKAGE = '@camstack/system'

/**
 * Packages the npm auto-updater must NEVER touch: the framework/system tier
 * ships exclusively via `applyServerUpdate` (single-copy collapse). Listed
 * explicitly (not via a manifest flag) because the updater runs against
 * `listInstalled()` package names before any manifest is loaded.
 */
export const AUTO_UPDATE_EXCLUDED_PACKAGES: ReadonlySet<string> = new Set([
  SYSTEM_PACKAGE,
  '@camstack/types',
  '@camstack/kernel',
  '@camstack/core',
  '@camstack/sdk',
  '@camstack/ui-library',
  '@camstack/server',
])

/**
 * True when `target` is a STRICTLY newer semver than `current`. Minimal
 * x.y.z(-prerelease) comparator — our registry versions are plain publishes,
 * and a dedicated semver dependency isn't declared in this package. Numeric
 * triples compare first; a prerelease ranks BELOW its release (1.2.6-dev <
 * 1.2.6); when both carry prereleases they compare lexicographically.
 * Unparseable versions are never "newer" (fail safe: no update).
 */
export function isVersionNewer(target: string, current: string): boolean {
  const parse = (v: string): { nums: number[]; pre: string | null } | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
    if (!m) return null
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
  }
  const t = parse(target)
  const c = parse(current)
  if (!t || !c) return false
  for (let i = 0; i < 3; i += 1) {
    if (t.nums[i]! !== c.nums[i]!) return t.nums[i]! > c.nums[i]!
  }
  // Same triple: release > prerelease; two prereleases compare lexically.
  if (t.pre === null && c.pre !== null) return true
  if (t.pre !== null && c.pre === null) return false
  if (t.pre !== null && c.pre !== null) return t.pre > c.pre
  return false
}

/**
 * Host-provided framework packages that take a special path through
 * `camstack deploy` (the addon-upload route) instead of the normal
 * addon-install path.
 *
 * Since the runtime-updatable root package shipped (2026-07-12 design), a
 * framework upload on a DEPLOYED hub is rejected with guidance to update the
 * `@camstack/server` root instead — the hub main + framework deps update as
 * ONE npm closure via the `server-management` cap. In a WORKSPACE checkout
 * the upload still triggers a plain restart: the hub resolves the framework
 * from `packages/<pkg>/dist`, which the CLI rebuilt before uploading, so the
 * dev loop (`camstack deploy packages/system`) is unchanged.
 *
 * Membership is by package NAME, independent of the `camstack.system` manifest
 * flag (`@camstack/types` declares `system: false` yet is a framework package
 * here) — that flag drives Admin-UI grouping; this gate drives upload routing.
 */
export const FRAMEWORK_PACKAGES: readonly string[] = [
  SYSTEM_PACKAGE,
  '@camstack/types',
  '@camstack/sdk',
]

/**
 * Returns true for a host-provided framework package (special-cased by the
 * addon-upload route — never installed as a normal addon).
 */
export function isFrameworkPackage(packageName: string): boolean {
  return FRAMEWORK_PACKAGES.includes(packageName)
}

// ---------------------------------------------------------------------------
// Typed JSON helpers
//
// JSON.parse returns `any`, which sprays `no-unsafe-*` violations all over
// ESLint. These tiny wrappers keep the `any` contained to one place and
// return the `unknown` that callers must then narrow structurally.
// ---------------------------------------------------------------------------

function parseJsonUnknown(text: string): unknown {
  // Isolate the `any` from JSON.parse to this one assignment.
  const parsed: unknown = JSON.parse(text)
  return parsed
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = parseJsonUnknown(fs.readFileSync(filePath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...parsed }
    }
  } catch {
    /* ignore */
  }
  return null
}

async function fetchJsonObject(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json()
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }
  return { ...parsed }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Auto-update config types
// ---------------------------------------------------------------------------

interface AutoUpdateGlobalConfig {
  readonly channel: 'off' | 'latest' | 'beta'
  /** Cadence of the auto-APPLY sweep (`runAutoUpdate`); gated on `channel`. */
  readonly intervalSeconds: number
  /**
   * Cadence of the availability POLLER (`UpdateCheckScheduler`). Deliberately
   * a separate knob: it runs while `channel` is `off`, because "tell me" and
   * "install it" are different decisions.
   */
  readonly updateCheckIntervalSeconds: number
}

interface AutoUpdateConfig {
  readonly global: AutoUpdateGlobalConfig
  readonly overrides: Record<string, 'off' | 'latest' | 'beta' | 'inherit'>
}

/**
 * One npm "what is the latest version" lookup. `ok: false` is NOT the same as
 * "no newer version" — a snapshot built from a failed lookup would read as
 * "up to date" and wipe the availability dedup state, re-announcing everything
 * on the next successful poll. Callers must branch on it.
 */
/** Result of one addon-package sweep: the diff plus how much of it is unknown. */
interface AddonUpdateSweep {
  readonly updates: readonly PackageUpdate[]
  readonly failures: number
}

export type RegistryLookup =
  | { readonly ok: true; readonly latestVersion: string | null }
  | { readonly ok: false; readonly error: string }

type AddonLoader = import('@camstack/system').AddonLoader

// ---------------------------------------------------------------------------
// Npm search types
// ---------------------------------------------------------------------------

interface NpmSearchResult {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly keywords: string[]
  readonly date: string
  readonly publisher: { readonly username: string }
}

interface AddonSearchResult {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly keywords: readonly string[]
  readonly publishedAt: string
  readonly author: string
  readonly installed: boolean
  readonly installedVersion?: string
  /**
   * Capability names the package's addons declare (its `/latest` manifest), or
   * `null` when the registry could not be asked — never `[]` for "unknown".
   */
  readonly capabilities: readonly string[] | null
}

/** One package's declared capabilities and when the cached answer lapses. */
interface CachedCapabilities {
  readonly capabilities: readonly string[]
  readonly expiresAt: number
}

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

interface CachedUpdates {
  readonly updates: readonly PackageUpdate[]
  readonly expiresAt: number
}

interface CachedSearch {
  readonly results: readonly NpmSearchResult[]
  readonly timestamp: number
}

interface CachedVersions {
  readonly versions: readonly PackageVersionInfo[]
  readonly expiresAt: number
}

/**
 * The subset of an npm registry packument this service reads. `dist-tags` maps
 * a tag (`latest`, `next`) to a version key in `versions` — the two are
 * disjoint namespaces, which is the distinction `fetchAddonTarball` missed.
 */
interface NpmPackument {
  readonly 'dist-tags'?: Record<string, string>
  readonly versions?: Record<string, { readonly dist?: { readonly tarball?: string } }>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Core packages that live in the server's own node_modules */
const CORE_MANAGED_PACKAGES: readonly string[] = ['@camstack/system', '@camstack/types']

export class AddonPackageService {
  private readonly logger: IScopedLogger

  /** AddonInstaller from @camstack/system (may be null if kernel unavailable) */
  private installer: AddonInstaller | null = null

  /** AddonLoader for reloadPackages (may be null) */
  private loader: AddonLoader | null = null

  // -- Caches ---------------------------------------------------------------
  private cachedUpdates: CachedUpdates | null = null
  private searchCache: CachedSearch | null = null
  private readonly versionCache = new Map<string, CachedVersions>()
  private readonly capabilityCache = new Map<string, CachedCapabilities>()
  private readonly updateAvailability: UpdateAvailabilityEmitter

  // -- Auto-update state ----------------------------------------------------
  private autoUpdateConfig: AutoUpdateConfig = {
    global: {
      channel: 'off',
      intervalSeconds: 21600,
      updateCheckIntervalSeconds: DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
    },
    overrides: {},
  }
  private autoUpdateTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Re-arm hook for the availability poller, wired at boot (manual-boot). Kept
   * as a callback rather than a service reference so this module never imports
   * the scheduler's dependencies back.
   */
  private updateCheckRescheduler: (() => void) | null = null

  // -- Timing constants -----------------------------------------------------
  // Short TTL — operators expect to see freshly-published versions
  // within minutes of `npm publish`, not hours. The Addons page kicks
  // a force-refresh on mount so the first navigation after publish
  // always picks up the new version regardless of TTL state.
  private static readonly UPDATE_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
  private static readonly SEARCH_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
  private static readonly VERSION_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
  private static readonly CAPABILITY_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
  private static readonly CAPABILITY_LOOKUP_CONCURRENCY = 6
  private static readonly NPM_REGISTRY = 'https://registry.npmjs.org'
  private static readonly REGISTRY_TIMEOUT_MS = 10_000

  constructor(
    private readonly loggingService: LoggingService,
    private readonly eventBusService: EventBusService,
    private readonly configService: ConfigService,
    private readonly addonRegistry: AddonRegistryService,
    private readonly notificationService: NotificationServiceWrapper,
    private readonly toastService: ToastServiceWrapper,
    /**
     * Durable dedup state for `update.available`. Injected by boot wiring
     * (manual-boot) — unit tests leave it out and get the RAM-only emitter.
     */
    updateAvailabilityStore?: IUpdateAvailabilityStore,
  ) {
    this.logger = this.loggingService.createLogger('AddonPackageService')
    this.updateAvailability = new UpdateAvailabilityEmitter(
      this.eventBusService,
      { type: 'core', id: 'addon-package-service' },
      updateAvailabilityStore,
    )

    // Initialize installer eagerly (no async needed).
    // Ensures install/uninstall works before full module init completes.
    try {
      const addonsDir = this.resolveAddonsDir()
      const workspacePackagesDir = detectWorkspacePackagesDir(__dirname)
      // `CAMSTACK_NPM_REGISTRY` override exists primarily for the e2e
      // harness — it points the installer at a sandboxed verdaccio so
      // the CLI-vs-npm version-interaction tests don't hit the public
      // registry. In production this stays unset and the installer
      // falls back to `https://registry.npmjs.org` (the default in
      // AddonInstaller). Both the `npm install` shell-out AND the
      // metadata HTTPS fetch honour this value.
      const registry = process.env['CAMSTACK_NPM_REGISTRY']
      this.installer = new AddonInstaller({
        addonsDir,
        workspacePackagesDir: workspacePackagesDir ?? undefined,
        ...(registry ? { registry } : {}),
      })
      ensureDir(addonsDir)
    } catch (error: unknown) {
      const msg = errMsg(error)
      this.logger.warn('Installer init failed', { meta: { error: msg } })
    }

    // Load auto-update config from disk
    this.autoUpdateConfig = this.loadAutoUpdateConfig()

    // Start auto-update timer after a delay (give server time to boot)
    setTimeout(() => this.scheduleAutoUpdate(), 30_000)
  }

  // =========================================================================
  // Install / Uninstall
  // =========================================================================

  /** Install an addon from npm registry */
  async installFromNpm(name: string, version?: string): Promise<{ name: string; version: string }> {
    this.requireInstaller()
    this.logger.info(`installFromNpm: ${name}@${version ?? 'latest'}`, {
      meta: { addonsDir: this.installer!['addonsDir'] as string },
    })
    const result = await this.installer!.installFromNpm(name, version)
    this.logger.info('installFromNpm result', {
      meta: { name: result.name, version: result.version },
    })
    return result
  }

  /** Install an addon from the local workspace (dev mode) */
  async installFromWorkspace(name: string): Promise<{ name: string; version: string }> {
    this.requireInstaller()
    const result = await this.installer!.install(name)
    this.logger.info('Installed from workspace', {
      meta: { name: result.name, version: result.version },
    })
    return result
  }

  /** Install an addon from an uploaded tgz file */
  async installFromUpload(tgzPath: string): Promise<{ name: string; version: string }> {
    this.requireInstaller()
    const result = await this.installer!.installFromTgz(tgzPath)

    // Mark install source as 'upload' in both legacy marker + central manifest
    const addonsDir = this.resolveAddonsDir()
    const targetDir = path.join(addonsDir, result.name)
    try {
      fs.writeFileSync(path.join(targetDir, '.install-source'), 'upload')
    } catch (err) {
      this.logger.debug('Non-fatal: failed to write .install-source marker', {
        meta: { error: errMsg(err) },
      })
    }
    this.installer!.manifest.upsert(result.name, {
      version: result.version,
      source: 'upload',
    })

    this.logger.info('Installed from upload', {
      meta: { name: result.name, version: result.version },
    })
    return result
  }

  /**
   * Roll an addon back to the version it had before the most recent
   * `updatePackage` call. The backup directory pointer lives in the
   * AddonInstaller manifest; this method restores it, refreshes the
   * registry, restarts the addon, and notifies the user via toast.
   *
   * Returns `{ rolledBackTo }` — null when there's no backup available
   * (the previous update either succeeded its health check or never
   * happened), the restored version string otherwise.
   */
  async rollbackPackage(name: string): Promise<{ rolledBackTo: string | null }> {
    this.requireInstaller()
    if (!this.isAllowedPackage(name)) {
      throw userError(
        'server.package-not-allowed',
        { name: String(name) },
        `Package "${name}" is not an allowed @camstack/* package`,
      )
    }
    if (AUTO_UPDATE_EXCLUDED_PACKAGES.has(name)) {
      throw new Error(
        `"${name}" is a framework package — roll it back via serverManagement, not the addon-package path`,
      )
    }

    const previousVersion = this.getInstalledPackageVersion(name)
    const rolledBackTo = await this.installer!.rollbackAddon(name)
    if (rolledBackTo == null) {
      this.logger.info('No backup available to roll back', { meta: { name } })
      return { rolledBackTo: null }
    }

    // Refresh registry + emit a synthetic 'updated' lifecycle event
    // (the version went BACK, but downstream consumers care about the
    // version change itself, not the direction).
    this.addonRegistry.refreshPackageVersion(name, rolledBackTo)
    this.addonRegistry.emitUpdateEvent(name, previousVersion, rolledBackTo)

    try {
      const restart = await this.addonRegistry.restartPackage(name)
      if (restart.success) {
        this.logger.info('Addon(s) restarted after rollback', {
          meta: { name, rolledBackTo, restarted: restart.restarted },
        })
      } else {
        this.logger.warn('Restart after rollback did not confirm', {
          meta: { name, errors: restart.errors },
        })
      }
    } catch (reloadError: unknown) {
      this.logger.warn('Restart failed after rollback', {
        meta: { name, error: errMsg(reloadError) },
      })
    }

    // Clear update cache so the UI reflects the new state.
    this.cachedUpdates = null
    return { rolledBackTo }
  }

  /** Uninstall an addon (refuses to uninstall protected/required packages) */
  async uninstall(name: string): Promise<void> {
    this.requireInstaller()

    if (this.isProtected(name)) {
      throw userError(
        'server.package-protected',
        { name: String(name) },
        `Cannot uninstall protected package "${name}"`,
      )
    }

    await this.installer!.uninstall(name)
    this.logger.info('Uninstalled', { meta: { name } })
  }

  // =========================================================================
  // Full install orchestration (npm install → reload → load addons → toast)
  // =========================================================================

  /**
   * Full install-from-npm orchestration:
   * 1. npm install
   * 2. Reload packages
   * 3. Load new addons into registry
   * 4. Broadcast toast notification
   *
   * Returns loaded/failed addon ids.
   */
  async installAndLoad(
    packageName: string,
    version?: string,
  ): Promise<{ success: true; loaded: string[]; failed: string[] }> {
    const versionLabel = version ? `@${version}` : '@latest'
    this.logger.info('Installing package...', { meta: { packageName, version: versionLabel } })

    try {
      const installResult = await this.installFromNpm(packageName, version)
      this.logger.info('npm install complete', {
        meta: { name: installResult.name, version: installResult.version },
      })
    } catch (err) {
      const msg = errMsg(err)
      this.logger.error('npm install failed', { meta: { packageName, error: msg } })
      this.toastService.broadcast({
        title: 'Install Failed',
        message: `Failed to install ${packageName}: ${msg}`,
        severity: 'warning',
      })
      throw new Error(`Install failed: ${msg}`, { cause: err })
    }

    try {
      await this.reloadPackages()
    } catch (err) {
      const msg = errMsg(err)
      this.logger.error('reloadPackages failed', { meta: { error: msg } })
    }

    let loaded: string[] = []
    let failed: string[] = []
    try {
      const result = await this.addonRegistry.loadNewAddons()
      loaded = result.loaded
      failed = result.failed
    } catch (err) {
      const msg = errMsg(err)
      this.logger.error('loadNewAddons failed', { meta: { error: msg } })
      failed.push(packageName)
    }

    this.toastService.broadcast({
      title: failed.length ? 'Addon Installed (with warnings)' : 'Addon Installed',
      message: `${packageName} installed${loaded.length ? ` — addons: ${loaded.join(', ')}` : ''}${failed.length ? ` — failed: ${failed.join(', ')}` : ''}`,
      severity: failed.length ? 'warning' : 'info',
    })
    return { success: true, loaded, failed }
  }

  /**
   * Full install-from-workspace orchestration:
   * 1. Workspace install
   * 2. Reload packages
   * 3. Load new addons into registry
   * 4. Broadcast toast notification
   */
  async installFromWorkspaceAndLoad(
    packageName: string,
  ): Promise<{ success: true; loaded: string[]; failed: string[] }> {
    this.logger.info('Installing from workspace...', { meta: { packageName } })

    try {
      const result = await this.installFromWorkspace(packageName)
      this.logger.info('Workspace install complete', {
        meta: { name: result.name, version: result.version },
      })
    } catch (err) {
      const msg = errMsg(err)
      this.logger.error('Workspace install failed', { meta: { error: msg } })
      this.toastService.broadcast({ title: 'Install Failed', message: msg, severity: 'warning' })
      throw new Error(`Workspace install failed: ${msg}`, { cause: err })
    }

    try {
      await this.reloadPackages()
    } catch (err) {
      this.logger.warn('Non-fatal: failed to reload packages after workspace install', {
        meta: { error: errMsg(err) },
      })
    }

    let loaded: string[] = []
    let failed: string[] = []
    try {
      const result = await this.addonRegistry.loadNewAddons()
      loaded = result.loaded
      failed = result.failed
    } catch (err) {
      this.logger.warn('Failed to load new addons after install', { meta: { error: errMsg(err) } })
      failed.push(packageName)
    }

    this.toastService.broadcast({
      title: 'Addon Installed from Workspace',
      message: `${packageName} installed${loaded.length ? ` — addons: ${loaded.join(', ')}` : ''}`,
      severity: failed.length ? 'warning' : 'info',
    })
    return { success: true, loaded, failed }
  }

  /**
   * Full uninstall orchestration:
   * 1. Emit uninstall lifecycle event
   * 2. Uninstall package
   * 3. Reload packages
   * 4. Load addons (to update registry)
   * 5. Broadcast toast notification
   */
  async uninstallAndReload(packageName: string): Promise<{ success: true }> {
    if (this.isProtected(packageName)) {
      throw userError(
        'server.package-required',
        { packageName: String(packageName) },
        `Package ${packageName} is required and cannot be uninstalled`,
      )
    }

    try {
      this.addonRegistry.emitUninstallEvent(packageName)
      this.logger.info('Uninstalling package...', { meta: { packageName } })
      await this.uninstall(packageName)
      this.logger.info('Uninstall complete', { meta: { packageName } })
    } catch (err) {
      const msg = errMsg(err)
      this.logger.error('Uninstall failed', { meta: { packageName, error: msg } })
      this.toastService.broadcast({ title: 'Uninstall Failed', message: msg, severity: 'warning' })
      throw new Error(`Uninstall failed: ${msg}`, { cause: err })
    }

    await this.reloadPackages().catch((err) => {
      this.logger.warn('Non-fatal: failed to reload packages after uninstall', {
        meta: { error: errMsg(err) },
      })
    })
    await this.addonRegistry.loadNewAddons().catch((err) => {
      this.logger.warn('Non-fatal: failed to load new addons after uninstall', {
        meta: { error: errMsg(err) },
      })
    })

    this.toastService.broadcast({
      title: 'Addon Uninstalled',
      message: `${packageName} has been removed`,
      severity: 'info',
    })
    return { success: true }
  }

  // =========================================================================
  // Workspace
  // =========================================================================

  /** Check if workspace packages directory is available (dev mode) */
  isWorkspaceAvailable(): boolean {
    return this.installer?.workspaceDir != null
  }

  /** List addon packages available in the workspace but not necessarily installed */
  listWorkspacePackages(): Array<{ name: string; version: string; installed: boolean }> {
    const workspaceDir = this.installer?.workspaceDir
    if (!workspaceDir) return []

    const results: Array<{ name: string; version: string; installed: boolean }> = []
    const installed = new Set(this.listInstalled().map((p) => p.name))

    try {
      for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const pkgJsonPath = path.join(workspaceDir, entry.name, 'package.json')
        if (!fs.existsSync(pkgJsonPath)) continue
        const pkg = readJsonObject(pkgJsonPath)
        if (!pkg) {
          this.logger.debug('Skipping malformed package.json', { meta: { entryName: entry.name } })
          continue
        }
        const name = asString(pkg['name'])
        if (!name.startsWith('@camstack/')) continue
        const camstack = asRecord(pkg['camstack'])
        if (!Array.isArray(camstack['addons'])) continue
        results.push({
          name,
          version: asString(pkg['version'], '0.0.0'),
          installed: installed.has(name),
        })
      }
    } catch (err) {
      this.logger.warn('Failed to read workspace directory', { meta: { error: errMsg(err) } })
    }

    return results
  }

  // =========================================================================
  // Query
  // =========================================================================

  /** List all installed addon packages */
  listInstalled(): InstalledPackage[] {
    if (!this.installer) {
      throw new Error(
        'AddonInstaller is not available — cannot list installed packages. Ensure @camstack/system is installed and the addons directory is accessible',
      )
    }
    return this.installer.listInstalled()
  }

  /**
   * Check whether a package is currently protected from uninstall.
   *
   * Source of truth: the running `AddonRegistry`'s loaded manifests —
   * any addon in this package with `camstack.addons[N].protected: true`
   * marks the whole package non-removable. This replaces the legacy
   * `AddonInstaller.REQUIRED_PACKAGES` hardcoded list.
   *
   * Fallback: if the registry hasn't loaded yet (early-boot install
   * paths, tests with stub registries), fall back to the legacy list
   * so we don't accidentally allow uninstalling `@camstack/system` etc.
   * during a window where protection metadata isn't yet readable.
   */
  isProtected(name: string): boolean {
    const fromRegistry = this.addonRegistry?.isPackageProtected?.(name)
    if (typeof fromRegistry === 'boolean') return fromRegistry
    return AddonInstaller.REQUIRED_PACKAGES.includes(name)
  }

  /**
   * Set of package names with a pending pre-update backup on disk —
   * i.e. packages where `applyUpdate` last ran and the post-update
   * health-check hasn't cleared the backup pointer yet, OR the user
   * explicitly hasn't called `clearBackup`.
   *
   * The Rollback button in admin-ui's AddonCard reads this via the
   * cap-router's `hasBackup` flag on `addons.list`.
   */
  getRollbackablePackages(): ReadonlySet<string> {
    if (!this.installer) return new Set()
    const out = new Set<string>()
    for (const entry of this.installer.manifest.list()) {
      if (entry.lastBackupDir) out.add(entry.name)
    }
    return out
  }

  // =========================================================================
  // Update checks
  // =========================================================================

  /**
   * Check npm registry for newer versions of all managed @camstack/* packages.
   * Includes both core packages (server root) and addon packages (data/addons).
   * Results are cached for 6 hours.
   */
  async checkUpdates(force?: boolean): Promise<readonly PackageUpdate[]> {
    if (force) {
      this.cachedUpdates = null
    }

    const now = Date.now()
    if (this.cachedUpdates && this.cachedUpdates.expiresAt > now) {
      // this.logger.debug('Returning cached update check results')
      return this.cachedUpdates.updates
    }

    this.logger.info('Checking for package updates...')
    const updates: PackageUpdate[] = []

    // Check installed addon packages in addons dir
    const sweep = await this.checkAddonPackageUpdates()
    updates.push(...sweep.updates)

    this.logger.info('Found package updates', {
      meta: {
        count: updates.length,
        updates: updates.map((u) => ({
          name: u.name,
          currentVersion: u.currentVersion,
          latestVersion: u.latestVersion,
        })),
      },
    })

    this.cachedUpdates = {
      updates,
      expiresAt: now + AddonPackageService.UPDATE_CACHE_TTL_MS,
    }
    this.publishAddonAvailability(updates, sweep.failures)
    return updates
  }

  /** Clear the cached update check results */
  clearUpdateCache(): void {
    this.cachedUpdates = null
    this.logger.info('Update cache cleared')
  }

  /**
   * Diff an explicit list of installed packages against npm — the
   * agent-targeted counterpart of `checkUpdates`. The hub owns the npm
   * machinery; an agent only reports what it has installed (via
   * `$agent.status`), so the hub does the registry lookups + diff here.
   *
   * Not cached: the caller decides freshness (an agent roster changes
   * per deploy, and `forceRefresh` must always be live).
   */
  async checkUpdatesForInstalled(
    installed: readonly { name: string; version: string }[],
    nodeId?: string,
  ): Promise<readonly PackageUpdate[]> {
    // De-dup by package name — one npm package may bundle several addons.
    const seen = new Map<string, string>()
    for (const pkg of installed) {
      if (pkg.name.length > 0 && !seen.has(pkg.name)) seen.set(pkg.name, pkg.version)
    }
    const updates: PackageUpdate[] = []
    let failures = 0
    await Promise.all(
      [...seen].map(async ([name, version]) => {
        if (!this.isAllowedPackage(name)) return
        // Never OFFER a framework package as an addon update: clicking it would
        // route to `updatePackage`, which now refuses it anyway. Filtering here
        // keeps the UI honest (no dead "Update" button for @camstack/server).
        if (AUTO_UPDATE_EXCLUDED_PACKAGES.has(name)) return
        const lookup = await this.lookupLatestVersion(name)
        if (!lookup.ok) {
          failures += 1
          this.logger.warn('Registry lookup failed for installed package', {
            tags: { nodeId: nodeId ?? 'hub' },
            meta: { name, error: lookup.error },
          })
          return
        }
        const decision = decideAddonVersionMove(
          version,
          lookup.latestVersion,
          ADDON_VERSION_REASON_REGISTRY_LATEST,
        )
        if (!decision.move) return
        const category = this.categorize(name)
        updates.push({
          name,
          currentVersion: version,
          latestVersion: decision.to,
          category,
          requiresRestart: category === 'core',
        })
      }),
    )
    this.publishAddonAvailability(updates, failures, nodeId)
    return updates
  }

  /**
   * Pack the bytes the HUB IS RUNNING for `name`, when it has them installed.
   *
   * The addon back-fill's own comment has always said "bytes come from the
   * hub's own resolution of the package", and it was not true: it called
   * `packPackage`, which is `npm pack <name>@<version>` — the REGISTRY. A
   * version string is not a build. `@camstack/addon-pipeline@1.2.43` deployed
   * from the workspace and `@camstack/addon-pipeline@1.2.43` on npm were two
   * different bundles all of 2026-08-07, and every `camstack deploy` to
   * agent-a was silently reverted ~1.5s later: the deploy's own
   * `$agent.reload` briefly emptied the node's reported addon list, the hub's
   * reconcile read it as "package missing", and the back-fill repaired the node
   * by installing the PUBLISHED 1.2.43 over the one just delivered. Nothing
   * looked wrong — same name, same version, different code. Four deploys were
   * attributed to a stale tarball cache that does not exist.
   *
   * Returns `null` when the hub has no installed copy; the caller then falls
   * back to the registry, which is the only correct source in that case.
   */
  async packInstalledPackage(
    name: string,
  ): Promise<{ buffer: Buffer; version: string; filename: string } | null> {
    const installedDir = path.join(this.resolveAddonsDir(), name)
    if (!fs.existsSync(path.join(installedDir, 'package.json'))) return null
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-pack-local-'))
    try {
      await execFileAsync('npm', ['pack', installedDir, '--pack-destination', destDir], {
        timeout: 120_000,
      })
      const onDisk = fs.readdirSync(destDir).find((f) => f.endsWith('.tgz'))
      if (onDisk === undefined) return null
      const buffer = fs.readFileSync(path.join(destDir, onDisk))
      const parsed: unknown = JSON.parse(
        fs.readFileSync(path.join(installedDir, 'package.json'), 'utf-8'),
      )
      const version =
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { version?: unknown }).version === 'string'
          ? (parsed as { version: string }).version
          : '0.0.0'
      return { buffer, version, filename: onDisk }
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true })
    }
  }

  /**
   * Resolve `name@version` and `npm pack` it into a tarball buffer
   * WITHOUT installing. Used to push a package update to an agent: the
   * hub packs here, then ships the tgz via `$agent.deploy` — agents
   * need no npm runtime of their own.
   *
   * For the addon back-fill prefer {@link packInstalledPackage}: this one
   * returns the REGISTRY's build of a version, which is not necessarily the
   * build the hub runs.
   */
  async packPackage(
    name: string,
    version?: string,
  ): Promise<{ buffer: Buffer; version: string; filename: string }> {
    const registry = process.env['CAMSTACK_NPM_REGISTRY']
    const resolvedVersion = await resolveNpmVersion(name, version ?? 'latest', registry)
    const spec = `${name}@${resolvedVersion}`
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-pack-'))
    try {
      const args = ['pack', spec, '--pack-destination', destDir, ...buildNpmRegistryArgs(registry)]
      await execFileAsync('npm', args, { timeout: 120_000 })
      const onDisk = fs.readdirSync(destDir).find((f) => f.endsWith('.tgz'))
      if (onDisk === undefined) {
        throw new Error(`packPackage: npm pack produced no tarball for ${spec}`)
      }
      const buffer = fs.readFileSync(path.join(destDir, onDisk))
      return { buffer, version: resolvedVersion, filename: onDisk }
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // npm search
  // =========================================================================

  /**
   * Search npm for camstack addon packages, optionally filtered by query and
   * by a capability the package must declare. The capabilities come from each
   * package's own `/latest` manifest (`camstack.addons[].capabilities`) — the
   * single source of truth (D4), no hand-kept keywords. A package whose
   * manifest could not be read carries `capabilities: null` and is excluded
   * from a capability-filtered result (unknown is not a match).
   */
  async searchNpm(query?: string, capability?: string): Promise<AddonSearchResult[]> {
    const npmResults = await this.fetchSearchFromNpm()

    let filtered: readonly NpmSearchResult[] = npmResults
    if (query) {
      const q = query.toLowerCase()
      filtered = npmResults.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q) ||
          r.keywords?.some((k) => k.toLowerCase().includes(q)),
      )
    }

    const capabilitiesByName = await this.lookupCapabilities(filtered.map((r) => r.name))
    const failed = filtered.filter((r) => capabilitiesByName.get(r.name) === null).length
    if (failed > 0) {
      this.logger.warn('npm capability lookup failed for some packages', {
        meta: { failed, total: filtered.length, capability: capability ?? null },
      })
    }

    const withCapabilities: AddonSearchResult[] = filtered.map((r) => ({
      name: r.name,
      version: r.version,
      description: r.description ?? '',
      keywords: r.keywords ?? [],
      publishedAt: r.date ?? '',
      author: r.publisher?.username ?? '',
      installed: false, // caller will enrich
      installedVersion: undefined,
      capabilities: capabilitiesByName.get(r.name) ?? null,
    }))
    if (capability === undefined) return withCapabilities
    return withCapabilities.filter((r) => r.capabilities?.includes(capability) === true)
  }

  /**
   * Declared capabilities per package, through a bounded worker pool and the
   * 10-minute cache. `null` = the lookup failed (not cached, so the next
   * search retries).
   */
  private async lookupCapabilities(
    names: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[] | null>> {
    const result = new Map<string, readonly string[] | null>()
    const now = Date.now()
    const pending: string[] = []
    for (const name of names) {
      const cached = this.capabilityCache.get(name)
      if (cached !== undefined && cached.expiresAt > now) result.set(name, cached.capabilities)
      else pending.push(name)
    }
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const name = pending[next++]
        if (name === undefined) return
        const capabilities = await this.fetchPackageCapabilities(name)
        result.set(name, capabilities)
        if (capabilities !== null) {
          this.capabilityCache.set(name, {
            capabilities,
            expiresAt: Date.now() + AddonPackageService.CAPABILITY_CACHE_TTL_MS,
          })
        }
      }
    }
    const poolSize = Math.min(AddonPackageService.CAPABILITY_LOOKUP_CONCURRENCY, pending.length)
    await Promise.all(Array.from({ length: poolSize }, worker))
    return result
  }

  /** Read `camstack.addons[].capabilities` from a package's `/latest`; null on any failure. */
  private async fetchPackageCapabilities(packageName: string): Promise<readonly string[] | null> {
    try {
      const url = `${this.resolveRegistryBase()}/${packageName.replace('/', '%2F')}/latest`
      const response = await fetch(url, {
        signal: AbortSignal.timeout(AddonPackageService.REGISTRY_TIMEOUT_MS),
      })
      if (!response.ok) return null
      const data = await fetchJsonObject(response)
      const addons = asRecord(data['camstack'])['addons']
      const names = new Set<string>()
      for (const addon of Array.isArray(addons) ? addons : []) {
        const caps = asRecord(addon)['capabilities']
        for (const cap of Array.isArray(caps) ? caps : []) {
          const name = typeof cap === 'string' ? cap : asString(asRecord(cap)['name'])
          if (name) names.add(name)
        }
      }
      return [...names]
    } catch {
      return null
    }
  }

  // =========================================================================
  // Package versions
  // =========================================================================

  /**
   * Fetch all published versions of a package from npm, including dist-tags.
   * Results are cached for 10 minutes per package.
   */
  async getPackageVersions(name: string): Promise<readonly PackageVersionInfo[]> {
    const now = Date.now()
    const cached = this.versionCache.get(name)
    if (cached && cached.expiresAt > now) {
      return cached.versions
    }

    try {
      const encodedName = name.replace('/', '%2F')
      const url = `${AddonPackageService.NPM_REGISTRY}/${encodedName}`
      const response = await fetch(url, {
        signal: AbortSignal.timeout(AddonPackageService.REGISTRY_TIMEOUT_MS),
      })

      if (!response.ok) {
        this.logger.debug('Registry returned non-ok status', {
          meta: { name, status: response.status },
        })
        return []
      }

      const data = await fetchJsonObject(response)
      const distTags = asRecord(data['dist-tags'])
      const versions = asRecord(data['versions'])
      const time = asRecord(data['time'])

      // Build a reverse lookup: version -> list of dist-tag names
      const tagsByVersion = new Map<string, string[]>()
      for (const [tag, ver] of Object.entries(distTags)) {
        const verStr = asString(ver)
        if (!verStr) continue
        const existing = tagsByVersion.get(verStr) ?? []
        tagsByVersion.set(verStr, [...existing, tag])
      }

      const result: PackageVersionInfo[] = Object.entries(versions).map(([ver, rawMeta]) => {
        const meta = asRecord(rawMeta)
        return {
          version: ver,
          publishedAt: asString(time[ver]),
          deprecated: typeof meta['deprecated'] === 'string' ? meta['deprecated'] : undefined,
          distTags: tagsByVersion.get(ver) ?? [],
        }
      })

      // Sort by published date descending (newest first)
      result.sort((a, b) => {
        if (!a.publishedAt && !b.publishedAt) return 0
        if (!a.publishedAt) return 1
        if (!b.publishedAt) return -1
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
      })

      this.versionCache.set(name, {
        versions: result,
        expiresAt: now + AddonPackageService.VERSION_CACHE_TTL_MS,
      })

      return result
    } catch (error: unknown) {
      const msg = errMsg(error)
      this.logger.warn('Failed to fetch versions', { meta: { name, error: msg } })
      return cached?.versions ?? []
    }
  }

  // =========================================================================
  // Update / restart
  // =========================================================================

  /**
   * The post-update health check: restart every addon the package declares
   * and decide what happens to the pre-update backup.
   *
   * SUCCESS ⇒ the backup is removed and `lastBackupDir` cleared. This is the
   * only place that knows the new version actually came up; deleting inside
   * `applyUpdate` would destroy the rollback exactly when it is needed.
   * FAILURE ⇒ the backup is retained so the operator can roll back.
   *
   * Never throws. `clearBackup` swallows its own IO failures, and any
   * surprise from the restart path is logged rather than propagated: an
   * undeleted backup is a disk-space problem, a throw after a successful
   * update is an outage.
   */
  private async confirmOrRetainBackup(name: string, backupDir?: string): Promise<void> {
    try {
      const result = await this.addonRegistry.restartPackage(name)
      if (result.success) {
        this.logger.info('Addon(s) restarted after update', {
          meta: { name, restarted: result.restarted },
        })
        if (backupDir != null) await this.installer!.clearBackup(name)
        return
      }
      this.logger.warn('Restart after update did not confirm — backup retained for rollback', {
        meta: { name, backupDir, errors: result.errors },
      })
    } catch (err: unknown) {
      this.logger.warn('Post-update confirmation failed — backup retained for rollback', {
        meta: { name, backupDir, error: errMsg(err) },
      })
    }
  }

  /**
   * Update a specific package. For addon packages, triggers hot-reload.
   * For core packages, installs in the server root and returns requiresRestart: true.
   */
  async updatePackage(name: string, version?: string): Promise<UpdateResult> {
    if (!this.isAllowedPackage(name)) {
      return {
        success: false,
        version: '',
        requiresRestart: false,
        error: `Package "${name}" is not an allowed @camstack/* package`,
      }
    }
    const frameworkRefusal = this.refuseExcludedFramework(name)
    if (frameworkRefusal) return frameworkRefusal

    // Dev-mode npm-install gate REMOVED (2026-05-12). The legacy
    // workspace-link flow assumed addons in dev came from `packages/*`
    // and a stray "Update" click would clobber the source. With the
    // CLI's `camstack push` flow taking over that responsibility, the
    // hub now treats every install identically — straight from npm
    // (or from the operator's deliberate push). No more env var
    // gymnastics required to update an addon from the UI.

    const category = this.categorize(name)
    this.logger.info('Updating package', { meta: { name, version, category } })

    try {
      let updatedVersion: string

      if (category === 'addon') {
        // Reuse the long-lived installer the registry already configured
        // (correct addonsDir + installSource + workspaceDir) — building a
        // fresh one with `new AI({ addonsDir })` would lose installSource
        // detection and skip the central manifest write.
        this.requireInstaller()
        const addonInstaller = this.installer!
        const previousVersion = this.getInstalledPackageVersion(name)
        // `null` = no readable installed copy, which is exactly a first
        // install. This used to test the truthiness of a lookup that answered
        // `'0.0.0'` when it found nothing — always truthy — so a genuine first
        // install took the update path and `applyUpdate` threw "not currently
        // tracked in manifest".
        const isFirstInstall = previousVersion === null

        // First-time installs go through the original installFromNpm path;
        // applyUpdate explicitly refuses when the package isn't tracked yet.
        // Subsequent updates take the safe path: backup current install,
        // run the install, auto-restore on failure (PR2).
        let result: { version: string; backupDir?: string }
        if (isFirstInstall) {
          const r = await addonInstaller.installFromNpm(name, version)
          result = { version: r.version }
        } else {
          const r = await addonInstaller.applyUpdate(name, version)
          result = { version: r.version, backupDir: r.backupDir }
        }
        updatedVersion = result.version

        // Update version in registry so UI reflects the change immediately
        this.addonRegistry.refreshPackageVersion(name, updatedVersion)

        // Emit addon.updated lifecycle event
        this.addonRegistry.emitUpdateEvent(name, previousVersion, updatedVersion)

        this.logger.info('Addon package updated, triggering hot-reload', {
          meta: { name, updatedVersion },
        })
        await this.confirmOrRetainBackup(name, result.backupDir)

        // Clear update cache so next check reflects new state
        this.cachedUpdates = null

        this.sendUpdateNotification(name, updatedVersion)
        return { success: true, version: updatedVersion, requiresRestart: false }
      }

      // Core package -- install to data/addons/. Self-contained addon
      // bundles no longer require the reverse symlink under
      // hub/node_modules/@camstack/ — addons resolve everything from
      // their own inlined deps.
      const addonsDir = this.resolveAddonsDir()
      const { installPackageFromNpm } = await import('@camstack/system')
      const dirName = name.replace(/^@camstack\//, '')
      const targetDir = path.join(addonsDir, dirName)
      const packageSpec = version ? `${name}@${version}` : name
      await installPackageFromNpm(packageSpec, targetDir)

      // Core packages install FLAT (`<addonsDir>/<dirName>`), which the
      // installer's lookup covers alongside the scoped form.
      const installedVersion = this.getInstalledPackageVersion(name)
      updatedVersion = installedVersion ?? ''

      // Invalidate cache after update
      this.cachedUpdates = null

      this.logger.info('Core package updated -- restart required', {
        meta: { name, updatedVersion: installedVersion },
      })
      this.sendUpdateNotification(name, installedVersion)
      return { success: true, version: updatedVersion, requiresRestart: true }
    } catch (error: unknown) {
      const msg = errMsg(error)
      this.logger.error('Failed to update package', { meta: { name, error: msg } })
      return { success: false, version: '', requiresRestart: false, error: msg }
    }
  }

  /**
   * Apply a staged addon update without running npm — the fast swap-from-staged
   * path. Mirrors the addon branch of `updatePackage` exactly, but calls
   * `addonInstaller.applyUpdateFromStaged(name, version, stagedPath)` instead
   * of `applyUpdate`/`installFromNpm`.
   *
   * The staged directory must already be validated and unpacked by the caller
   * (e.g. the upload handler that previously called `installFromTgz`). This
   * method performs the atomic swap, restarts the addon, and clears the backup
   * on success — identical lifecycle to `updatePackage` addon branch.
   */
  async applyStagedAddonUpdate(
    name: string,
    version: string,
    stagedPath: string,
  ): Promise<UpdateResult> {
    if (!this.isAllowedPackage(name)) {
      return {
        success: false,
        version: '',
        requiresRestart: false,
        error: `Package "${name}" is not an allowed @camstack/* package`,
      }
    }
    const frameworkRefusal = this.refuseExcludedFramework(name)
    if (frameworkRefusal) return frameworkRefusal

    const category = this.categorize(name)
    this.logger.info('Applying staged addon update', { meta: { name, version, category } })

    try {
      if (category !== 'addon') {
        return {
          success: false,
          version: '',
          requiresRestart: false,
          error: `applyStagedAddonUpdate only supports addon packages; "${name}" categorized as "${category}"`,
        }
      }

      this.requireInstaller()
      const addonInstaller = this.installer!
      const previousVersion = this.getInstalledPackageVersion(name)

      const r = await addonInstaller.applyUpdateFromStaged(name, version, stagedPath)
      const updatedVersion = r.version

      // Update version in registry so UI reflects the change immediately
      this.addonRegistry.refreshPackageVersion(name, updatedVersion)

      // Emit addon.updated lifecycle event
      this.addonRegistry.emitUpdateEvent(name, previousVersion, updatedVersion)

      this.logger.info('Staged addon swap complete, triggering hot-reload', {
        meta: { name, updatedVersion },
      })
      await this.confirmOrRetainBackup(name, r.backupDir)

      // Clear update cache so next check reflects new state
      this.cachedUpdates = null

      this.sendUpdateNotification(name, updatedVersion)
      return { success: true, version: updatedVersion, requiresRestart: false }
    } catch (error: unknown) {
      const msg = errMsg(error)
      this.logger.error('Failed to apply staged addon update', { meta: { name, error: msg } })
      return { success: false, version: '', requiresRestart: false, error: msg }
    }
  }

  /**
   * Download the npm tarball for `name@version` as a Buffer.
   *
   * Resolves the tarball URL from the registry packument, then fetches it,
   * for use by the lifecycle job engine (TarballFetcher signature). The
   * `signal` is forwarded to the underlying fetch calls so the AbortController
   * timeout wired in LifecycleJobEngine fires correctly.
   *
   * `version` may be an exact semver OR a dist-tag. It looked up only
   * `versions[version]` until 2026-08-11, so every caller that passed the
   * DEFAULT — `updatePackage` resolves an absent input to `'latest'` — failed
   * with `no tarball url`, because `latest` is a dist-tag key and never a
   * `versions` key. The Addons page hid this by always sending the resolved
   * `latestVersion` from `listUpdates`; the API path had no such caller and
   * could not update anything. Mirrors `AddonInstaller.downloadNpmTarball`.
   * Ranges (`^1.2.0`) are still not supported — resolve those upstream.
   */
  async fetchAddonTarball(name: string, version: string, signal: AbortSignal): Promise<Buffer> {
    const registry = process.env['CAMSTACK_NPM_REGISTRY']
    const reg = (registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
    const metaUrl = `${reg}/${encodeURIComponent(name).replace(/^%40/, '@')}`
    const metaRes = await fetch(metaUrl, { signal })
    if (!metaRes.ok) throw new Error(`registry GET ${metaUrl} → ${metaRes.status}`)
    const meta = (await metaRes.json()) as NpmPackument
    const versions = meta.versions ?? {}
    const distTags = meta['dist-tags'] ?? {}
    const resolvedVersion = versions[version] ? version : distTags[version]
    if (resolvedVersion === undefined) {
      throw new Error(`no version resolved for ${name}@${version}`)
    }
    const tarballUrl = versions[resolvedVersion]?.dist?.tarball
    if (typeof tarballUrl !== 'string') {
      throw new Error(`no tarball url for ${name}@${resolvedVersion}`)
    }
    const tarRes = await fetch(tarballUrl, { signal })
    if (!tarRes.ok) throw new Error(`tarball GET ${tarballUrl} → ${tarRes.status}`)
    return Buffer.from(await tarRes.arrayBuffer())
  }

  /**
   * Extract a gzipped tarball Buffer into `destDir`.
   *
   * Wraps the existing `tar -xzf` shell call for use by the lifecycle job
   * engine (ExtractFn signature). The Buffer is written to a temp file,
   * extracted with `--strip-components=1` (removes the npm `package/` prefix),
   * then the temp file is removed.
   */
  async extractTarball(tgz: Buffer, destDir: string): Promise<void> {
    await extractTgzStripped(tgz, destDir)
  }

  /**
   * Gracefully restart the server process.
   *
   * Writes the restart marker so the post-boot service can emit
   * `system.restart-completed` on the next boot (powers the admin-UI
   * "Server restarted" toast AND the operator's "Server aggiornato"
   * notification). `update` is passed by `RootUpdateService` for an
   * update-driven restart and is the ONLY source of the version being left
   * behind — see `updates/restart-marker.ts`. Emits `system.restarting`
   * with the same payload so subscribers can show a reconnect overlay
   * immediately. Then delegates to `scheduleSelfRestart` which picks
   * the right exit path (Electron `app.relaunch` vs supervisor-driven
   * `process.exit`).
   */
  restartServer(requestedBy?: string, update?: RootRestartUpdate): void {
    this.logger.info('Server restart requested -- initiating graceful shutdown')

    // Both versions, one builder, shared with the agent — see `restart-marker.ts`.
    const payload: PendingRestartMarkerPayload = buildRestartMarker({
      requestedAt: Date.now(),
      ...(requestedBy !== undefined ? { requestedBy } : {}),
      ...(update !== undefined ? { update } : {}),
    })

    try {
      writePendingRestart(this.resolveDataDir(), payload)
    } catch (err) {
      // Marker write failure shouldn't block the restart — log + continue.
      this.logger.warn(
        'Failed to write restart marker; restart will proceed without completion toast',
        {
          meta: { error: errMsg(err) },
        },
      )
    }

    this.eventBusService.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'core', id: 'addon-package-service' },
      category: EventCategory.SystemRestarting,
      // The node, as `system.restart-completed` names it after the boot
      // (`post-boot.service.ts`): the announcement and the landing of one
      // restart must name the same node, or a stale `node-updating` could not
      // be matched to the `server-updated` that supersedes it (D723).
      data: { ...payload, nodeId: process.env['CAMSTACK_NODE_ID'] ?? 'hub' },
    })

    // 10s grace gives in-flight requests time to drain.
    scheduleSelfRestart({ delayMs: 10_000 })
  }

  // =========================================================================
  // Framework live-update
  //
  // Spec: docs/superpowers/specs/2026-05-14-framework-live-update-design.md
  // =========================================================================

  /**
   * Snapshot of installed framework packages — drives the admin-UI
   * "System packages" panel. Best-effort: `latestVersion` is null when
   * the npm lookup fails (offline, registry unreachable), and the UI
   * hides the Update button for those rows.
   *
   * Latest-version lookups run in parallel against npm so the full
   * snapshot returns in roughly the slowest individual lookup, not
   * the sum.
   */
  async listFrameworkPackages(): Promise<
    readonly {
      packageName: string
      currentVersion: string
      latestVersion: string | null
      hasUpdate: boolean
      description?: string
      buildId: string | null
    }[]
  > {
    const registry = process.env['CAMSTACK_NPM_REGISTRY']

    const rows = await Promise.all(
      [SYSTEM_PACKAGE].map(async (packageName) => {
        const manifest = readResolvedPackageManifest(packageName)
        const currentVersion =
          manifest !== null && typeof manifest['version'] === 'string'
            ? manifest['version']
            : 'unknown'
        const description =
          manifest !== null && typeof manifest['description'] === 'string'
            ? manifest['description']
            : undefined

        // Content build-id of the code the hub ACTUALLY loaded — resolved from
        // the same closure the running process uses. Surfaces "same semver,
        // new code" (framework packages ship changes without always bumping).
        const hubPkgDir = resolveHubClosurePackageDir(packageName)
        const buildId = hubPkgDir !== null ? computeDistBuildId(path.join(hubPkgDir, 'dist')) : null

        let latestVersion: string | null = null
        let lookupFailed = false
        try {
          const args = [
            'view',
            `${packageName}@latest`,
            'version',
            ...buildNpmRegistryArgs(registry),
          ]
          const { stdout } = await execFileAsync('npm', args, { timeout: 15_000 })
          const trimmed = stdout.trim()
          latestVersion = trimmed.length > 0 ? trimmed : null
        } catch (err) {
          lookupFailed = true
          this.logger.debug('listFrameworkPackages: npm view failed', {
            meta: { packageName, error: errMsg(err) },
          })
        }

        // STRICTLY newer, never merely different. The hub runs
        // `1.2.x-dev.<timestamp>` builds that are AHEAD of the npm tag, and
        // `latest !== current` lit an "update available" badge whose only
        // possible outcome was a downgrade. `publishFrameworkAvailability`
        // already gated on this; the row the UI reads did not, so the same
        // page disagreed with itself.
        const hasUpdate =
          latestVersion !== null &&
          currentVersion !== 'unknown' &&
          isVersionNewer(latestVersion, currentVersion)

        return {
          packageName,
          currentVersion,
          latestVersion,
          hasUpdate,
          buildId,
          lookupFailed,
          ...(description !== undefined ? { description } : {}),
        }
      }),
    )

    this.publishFrameworkAvailability(rows)

    return rows.map(({ lookupFailed: _lookupFailed, ...row }) => row)
  }

  /**
   * Announce framework updates. This surface SHOWED `@camstack/system` had an
   * update and emitted nothing, so the operator was never told — it was the
   * only discovery path with no publish at all.
   *
   * Two rules it must not break:
   *  - **Strictly newer only.** `hasUpdate` is `latest !== current`, which is
   *    true for a hub running a `-dev.<timestamp>` build AHEAD of the npm tag.
   *    Announcing that would be telling the operator to downgrade.
   *  - **A failed lookup publishes nothing.** Not even an empty snapshot: an
   *    empty snapshot means "up to date" and would clear the dedup state, so
   *    the next successful poll would re-announce everything.
   */
  private publishFrameworkAvailability(
    rows: readonly {
      packageName: string
      currentVersion: string
      latestVersion: string | null
      lookupFailed: boolean
    }[],
  ): void {
    const failed = rows.filter((row) => row.lookupFailed)
    if (failed.length > 0) {
      this.logger.warn('Framework update check incomplete — availability not published', {
        meta: { packages: failed.map((row) => row.packageName) },
      })
      return
    }
    const candidates: UpdateAvailablePayload[] = []
    for (const row of rows) {
      if (row.latestVersion === null || row.currentVersion === 'unknown') continue
      if (!isVersionNewer(row.latestVersion, row.currentVersion)) continue
      candidates.push({
        target: 'server',
        packageName: row.packageName,
        currentVersion: row.currentVersion,
        latestVersion: row.latestVersion,
        nodeId: this.resolveNodeId(),
      })
    }
    this.updateAvailability.publishSnapshot('server', candidates, this.resolveNodeId())
  }

  /** Node id stamped on availability events emitted by THIS process. */
  private resolveNodeId(): string {
    return process.env['CAMSTACK_NODE_ID'] ?? 'hub'
  }

  // =========================================================================
  // Reload
  // =========================================================================

  /** Re-discover addons from the addons directory (call after install/uninstall) */
  async reloadPackages(): Promise<void> {
    try {
      const kernel = await import('@camstack/system')
      this.loader = new kernel.AddonLoader(this.logger.child('AddonLoader'))

      const addonsDir = this.resolveAddonsDir()
      await this.loader.loadFromDirectory(addonsDir)

      this.logger.info('Reloaded', { meta: { count: this.loader.listAddons().length } })
    } catch (error: unknown) {
      const msg = errMsg(error)
      this.logger.warn('reloadPackages failed', { meta: { error: msg } })
    }
  }

  // =========================================================================
  // Auto-update channel resolution
  // =========================================================================

  /** Resolve effective auto-update channel for a package */
  getEffectiveAutoUpdateChannel(
    _addonId: string,
    globalChannel: AutoUpdateChannel,
    perAddonChannel: AutoUpdateChannel,
  ): 'off' | 'latest' | 'beta' {
    if (perAddonChannel !== 'inherit') return perAddonChannel as 'off' | 'latest' | 'beta'
    if (globalChannel === 'inherit') return 'off' // shouldn't happen at global level
    return globalChannel as 'off' | 'latest' | 'beta'
  }

  // =========================================================================
  // Auto-update settings
  // =========================================================================

  /**
   * Register the availability poller's re-arm hook. Called once at boot so a
   * `setAutoUpdateSettings` write takes effect without a restart.
   */
  setUpdateCheckRescheduler(reschedule: () => void): void {
    this.updateCheckRescheduler = reschedule
  }

  /** Get global auto-update settings */
  getAutoUpdateSettings(): AutoUpdateGlobalConfig {
    return { ...this.autoUpdateConfig.global }
  }

  /** Set global auto-update settings and restart the timer */
  async setAutoUpdateSettings(
    channel: 'off' | 'latest' | 'beta',
    intervalSeconds?: number,
    updateCheckIntervalSeconds?: number,
  ): Promise<void> {
    const previousCheckInterval = this.autoUpdateConfig.global.updateCheckIntervalSeconds
    const nextCheckInterval =
      updateCheckIntervalSeconds === undefined
        ? previousCheckInterval
        : clampUpdateCheckInterval(updateCheckIntervalSeconds)
    this.autoUpdateConfig = {
      ...this.autoUpdateConfig,
      global: {
        channel,
        intervalSeconds: intervalSeconds ?? this.autoUpdateConfig.global.intervalSeconds,
        updateCheckIntervalSeconds: nextCheckInterval,
      },
    }
    this.saveAutoUpdateConfig()
    this.scheduleAutoUpdate()
    if (updateCheckIntervalSeconds === undefined) return
    this.logger.info('Update-check interval changed', {
      meta: { from: previousCheckInterval, to: nextCheckInterval },
    })
    this.updateCheckRescheduler?.()
  }

  /** Get per-addon auto-update override */
  getAddonAutoUpdate(addonId: string): 'off' | 'latest' | 'beta' | 'inherit' {
    return this.autoUpdateConfig.overrides[addonId] ?? 'inherit'
  }

  /** Set per-addon auto-update override */
  async setAddonAutoUpdate(
    addonId: string,
    channel: 'off' | 'latest' | 'beta' | 'inherit',
  ): Promise<void> {
    const newOverrides = { ...this.autoUpdateConfig.overrides }
    if (channel === 'inherit') {
      delete newOverrides[addonId]
    } else {
      newOverrides[addonId] = channel
    }
    this.autoUpdateConfig = { ...this.autoUpdateConfig, overrides: newOverrides }
    this.saveAutoUpdateConfig()
  }

  /** Schedule periodic auto-update check */
  scheduleAutoUpdate(): void {
    if (this.autoUpdateTimer) {
      clearInterval(this.autoUpdateTimer)
      this.autoUpdateTimer = null
    }

    const hasOverrides = Object.values(this.autoUpdateConfig.overrides).some((ch) => ch !== 'off')
    if (this.autoUpdateConfig.global.channel === 'off' && !hasOverrides) {
      this.logger.info('Auto-update disabled')
      return
    }

    const intervalMs = this.autoUpdateConfig.global.intervalSeconds * 1000
    this.logger.info('Auto-update scheduled', {
      meta: {
        intervalSeconds: this.autoUpdateConfig.global.intervalSeconds,
        channel: this.autoUpdateConfig.global.channel,
      },
    })

    this.autoUpdateTimer = setInterval(() => {
      this.runAutoUpdate().catch((err) => {
        this.logger.error('Auto-update check failed', { meta: { error: errMsg(err) } })
      })
    }, intervalMs)
  }

  /**
   * Run auto-update: check each installed package against its configured
   * channel, then route ALL addon packages that have a newer version through ONE
   * durable engine bulk job (F3 Task 5); auto-updates survive a reboot via the
   * boot reconcile, exactly like a manual "Update all". The framework
   * (`@camstack/system`) is NOT applied by the engine — it ships via
   * `applyServerUpdate` (single-copy collapse), so a swept framework target is
   * skipped by the engine.
   *
   * Candidate selection resolves dist-tag `latest` (or `beta` on that channel)
   * and moves when the installed version DIFFERS — higher or lower (D942).
   * A registry read that fails leaves that package alone. Execution is one
   * `startJob`, not a per-package `updatePackage`.
   */
  async runAutoUpdate(): Promise<void> {
    this.logger.info('Running auto-update check...')
    const installed = this.listInstalled()
    const targets: { name: string; version: string }[] = []
    const available: Array<{
      target: 'addon'
      packageName: string
      currentVersion: string
      latestVersion: string
    }> = []

    for (const pkg of installed) {
      try {
        // Framework packages NEVER auto-update from npm — they ship via
        // `applyServerUpdate` (single-copy collapse). The engine already
        // skipped a swept framework target; excluding it here also kills the
        // useless candidate churn that participated in the 2026-07-22 hub
        // wedge (mass staged swap right after a publish train).
        if (AUTO_UPDATE_EXCLUDED_PACKAGES.has(pkg.name)) continue
        // Determine effective channel for this addon
        const addonId = pkg.name.replace('@camstack/addon-', '').replace('@camstack/', '')
        const override = this.autoUpdateConfig.overrides[addonId]
        const effectiveChannel = this.getEffectiveAutoUpdateChannel(
          addonId,
          this.autoUpdateConfig.global.channel,
          override ?? 'inherit',
        )

        if (effectiveChannel === 'off') continue

        // Fetch dist-tags for this package
        const encodedName = pkg.name.replace('/', '%2F')
        const url = `${AddonPackageService.NPM_REGISTRY}/${encodedName}`
        const response = await fetch(url, {
          signal: AbortSignal.timeout(AddonPackageService.REGISTRY_TIMEOUT_MS),
        })
        if (!response.ok) {
          this.logger.warn('Auto-update left package unchanged — registry unreadable', {
            meta: { name: pkg.name, status: response.status },
          })
          continue
        }

        const data = await fetchJsonObject(response)
        const distTags = asRecord(data['dist-tags'])

        // Determine target version based on channel
        const targetVersion =
          effectiveChannel === 'beta'
            ? asString(distTags['beta']) || asString(distTags['latest'])
            : asString(distTags['latest'])

        // D942: follow the tag in either direction. An empty tag is an
        // unreadable authority — leave the installed copy (D49).
        const followed = decideAddonVersionMove(
          pkg.version,
          targetVersion ?? null,
          ADDON_VERSION_REASON_REGISTRY_LATEST,
        )
        if (!followed.move) continue

        this.logger.info('Moving addon to registry latest', {
          meta: {
            name: pkg.name,
            from: followed.from,
            to: followed.to,
            reason: followed.reason,
            channel: effectiveChannel,
          },
        })
        targets.push({ name: pkg.name, version: followed.to })
        available.push({
          target: 'addon',
          packageName: pkg.name,
          currentVersion: pkg.version,
          latestVersion: followed.to,
        })
      } catch (err) {
        this.logger.warn('Auto-update check failed', {
          meta: { name: pkg.name, error: errMsg(err) },
        })
      }
    }

    this.updateAvailability.publishCandidates(available)

    if (targets.length === 0) {
      this.logger.debug('Auto-update: all packages up-to-date')
      return
    }

    // Execute as ONE durable engine bulk job. The runner singleton is resolved
    // lazily via a dynamic import (the singleton module transitively imports
    // SYSTEM_PACKAGE back from this module) to avoid an init-order cycle. The
    // singleton is initialized at boot, before the scheduler timer fires. A
    // framework target, if present, is skipped by the engine (framework updates
    // ship via applyServerUpdate). Wrap so a failure is logged, not thrown out
    // of the timer callback.
    try {
      const { getLifecycleRunner } = await import('../lifecycle/lifecycle-runner.singleton.js')
      const runner = getLifecycleRunner()
      const { jobId } = await runner.startJob({ kind: 'update', targets, createdBy: 'system' })
      this.logger.info('Auto-update job started', {
        meta: { jobId, packageCount: targets.length },
      })
    } catch (err) {
      this.logger.error('Auto-update job failed to start', { meta: { error: errMsg(err) } })
    }
  }

  // =========================================================================
  // Private: auto-update config persistence
  // =========================================================================

  /** Load auto-update config from disk */
  private loadAutoUpdateConfig(): AutoUpdateConfig {
    const configPath = path.join(this.resolveDataDir(), 'auto-update.json')
    try {
      if (fs.existsSync(configPath)) {
        const raw = readJsonObject(configPath)
        if (raw) {
          const global = asRecord(raw['global'])
          const channel = asString(global['channel'])
          const validChannel: AutoUpdateConfig['global']['channel'] =
            channel === 'latest' || channel === 'beta' ? channel : 'off'
          const rawCheckInterval = global['updateCheckIntervalSeconds']
          return {
            global: {
              channel: validChannel,
              intervalSeconds:
                typeof global['intervalSeconds'] === 'number' ? global['intervalSeconds'] : 3600,
              updateCheckIntervalSeconds:
                typeof rawCheckInterval === 'number'
                  ? clampUpdateCheckInterval(rawCheckInterval)
                  : DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
            },
            overrides: Object.fromEntries(
              Object.entries(asRecord(raw['overrides'])).map(([k, v]) => {
                const s = asString(v)
                const valid: AutoUpdateConfig['overrides'][string] =
                  s === 'off' || s === 'latest' || s === 'beta' || s === 'inherit' ? s : 'inherit'
                return [k, valid]
              }),
            ),
          }
        }
      }
    } catch (err) {
      this.logger.debug('Corrupt auto-update config, falling back to defaults', {
        meta: { error: errMsg(err) },
      })
    }
    return {
      global: {
        channel: 'off',
        intervalSeconds: 21600,
        updateCheckIntervalSeconds: DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS,
      },
      overrides: {},
    }
  }

  /** Save auto-update config to disk */
  private saveAutoUpdateConfig(): void {
    const dataDir = this.resolveDataDir()
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
      }
      const configPath = path.join(dataDir, 'auto-update.json')
      fs.writeFileSync(configPath, JSON.stringify(this.autoUpdateConfig, null, 2))
    } catch (err) {
      this.logger.warn('Failed to save auto-update config', { meta: { error: errMsg(err) } })
    }
  }

  /** Resolve the top-level data directory */
  private resolveDataDir(): string {
    return path.resolve(process.env.CAMSTACK_DATA ?? 'camstack-data')
  }

  // =========================================================================
  // Private: core package update checks
  // =========================================================================

  /**
   * Check addon packages for updates by reading installed versions from
   * data/addons/{name}/package.json and comparing against npm registry.
   *
   * Reports `failures` alongside the diff: a registry lookup that could not be
   * MADE is not evidence that a package is up to date, and the availability
   * publish branches on it.
   */
  private async checkAddonPackageUpdates(): Promise<AddonUpdateSweep> {
    const addonsDir = this.resolveAddonsDir()
    const updates: PackageUpdate[] = []
    let failures = 0

    if (!fs.existsSync(addonsDir)) return { updates, failures }

    // Collect all package.json paths -- handles both flat and scoped layouts
    const pkgJsonPaths: string[] = []
    const topDirs = fs
      .readdirSync(addonsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())

    for (const dir of topDirs) {
      const dirPath = path.join(addonsDir, dir.name)
      if (dir.name.startsWith('@')) {
        // Scoped package directory -- scan one level deeper
        const scopedDirs = fs
          .readdirSync(dirPath, { withFileTypes: true })
          .filter((d) => d.isDirectory())
        for (const scopedDir of scopedDirs) {
          const pkgJson = path.join(dirPath, scopedDir.name, 'package.json')
          if (fs.existsSync(pkgJson)) pkgJsonPaths.push(pkgJson)
        }
      } else {
        const pkgJson = path.join(dirPath, 'package.json')
        if (fs.existsSync(pkgJson)) pkgJsonPaths.push(pkgJson)
      }
    }

    for (const pkgJsonPath of pkgJsonPaths) {
      try {
        const pkgJson = readJsonObject(pkgJsonPath)
        if (!pkgJson) continue
        const name = asString(pkgJson['name'])
        const version = asString(pkgJson['version'])
        if (!name || !version || !this.isAllowedPackage(name)) continue

        // Skip non-addon packages (core, types, etc.) — only check packages with camstack.addons
        const camstackField = asRecord(pkgJson['camstack'])
        if (!camstackField['addons']) continue

        // Skip workspace-installed packages (dev mode) — they always lag behind npm
        const addonDir = path.dirname(pkgJsonPath)
        const installSourcePath = path.join(addonDir, '.install-source')
        if (fs.existsSync(installSourcePath)) {
          const source = fs.readFileSync(installSourcePath, 'utf-8').trim()
          if (source === 'workspace') continue
        }

        const lookup = await this.lookupLatestVersion(name)
        if (!lookup.ok) {
          failures += 1
          this.logger.warn('Registry lookup failed for installed addon package', {
            tags: { nodeId: this.resolveNodeId() },
            meta: { name, error: lookup.error },
          })
          continue
        }
        const decision = decideAddonVersionMove(
          version,
          lookup.latestVersion,
          ADDON_VERSION_REASON_REGISTRY_LATEST,
        )
        if (!decision.move) continue
        updates.push({
          name,
          currentVersion: version,
          latestVersion: decision.to,
          category: this.categorize(name),
          requiresRestart: this.categorize(name) === 'core',
        })
      } catch (error: unknown) {
        // The package could not be evaluated at all (unreadable manifest, …).
        // Counted as a failure for the same reason a registry miss is.
        failures += 1
        const msg = errMsg(error)
        this.logger.warn('Failed to check updates for addon', {
          meta: { pkgJsonPath, error: msg },
        })
      }
    }

    return { updates, failures }
  }

  // =========================================================================
  // Private: npm registry helpers
  // =========================================================================

  /**
   * Base URL for npm registry METADATA fetches.
   *
   * Honours `CAMSTACK_NPM_REGISTRY` so update checks resolve against
   * the same registry the installer/pack paths use. Without this, a
   * per-node `listUpdates` (which diffs an agent's roster via
   * `checkUpdatesForInstalled` → `lookupLatestVersion`) would bypass a
   * private registry — including the e2e harness's verdaccio — and
   * silently report "no update" for packages that only exist there.
   * Trailing slashes are stripped so the `${base}/${name}` join is clean.
   */
  private resolveRegistryBase(): string {
    const override = process.env['CAMSTACK_NPM_REGISTRY']
    const base = override && override.length > 0 ? override : AddonPackageService.NPM_REGISTRY
    return base.replace(/\/+$/, '')
  }

  /**
   * Ask the registry for a package's latest version, distinguishing "there is
   * no such package" (a definitive answer) from "I could not ask" (a failure).
   * The difference decides whether an availability SNAPSHOT may be published —
   * see {@link RegistryLookup}.
   */
  private async lookupLatestVersion(packageName: string): Promise<RegistryLookup> {
    try {
      const encodedName = packageName.replace('/', '%2F')
      const url = `${this.resolveRegistryBase()}/${encodedName}/latest`
      const response = await fetch(url, {
        signal: AbortSignal.timeout(AddonPackageService.REGISTRY_TIMEOUT_MS),
      })
      if (response.status === 404) return { ok: true, latestVersion: null }
      if (!response.ok) {
        this.logger.debug('Registry returned non-ok status', {
          meta: { packageName, status: response.status },
        })
        return { ok: false, error: `registry status ${response.status}` }
      }
      const data = await fetchJsonObject(response)
      const version = asString(data['version'])
      return { ok: true, latestVersion: version || null }
    } catch (error: unknown) {
      return { ok: false, error: errMsg(error) }
    }
  }

  /**
   * Announce the addon-update set for one scope (hub or a node).
   *
   * `failures > 0` means at least one registry lookup could not be made, so
   * the set is INCOMPLETE — publish it as candidates (additive) rather than a
   * snapshot (authoritative). A snapshot built from a partial sweep silently
   * marks the unreachable packages "up to date", clears their dedup state and
   * re-announces them on the next good poll.
   */
  private publishAddonAvailability(
    updates: readonly PackageUpdate[],
    failures: number,
    nodeId?: string,
  ): void {
    // The hub's own sweep passes no nodeId — but its rows are about a NODE
    // like any other, and a list whose lines cannot be attributed is what made
    // three announcements look like one.
    const scope = nodeId ?? this.resolveNodeId()
    const candidates: UpdateAvailablePayload[] = updates.map((update) => ({
      target: 'addon',
      packageName: update.name,
      currentVersion: update.currentVersion,
      latestVersion: update.latestVersion,
      nodeId: scope,
    }))
    if (failures > 0) {
      this.logger.warn('Addon update check incomplete — availability published as partial', {
        tags: { nodeId: scope },
        meta: { failures, published: candidates.length },
      })
      this.updateAvailability.publishCandidates(candidates)
      return
    }
    this.updateAvailability.publishSnapshot('addon', candidates, scope)
  }

  /** Fetch npm search results for camstack addon packages (cached 5 min) */
  private async fetchSearchFromNpm(): Promise<readonly NpmSearchResult[]> {
    if (
      this.searchCache &&
      Date.now() - this.searchCache.timestamp < AddonPackageService.SEARCH_CACHE_TTL_MS
    ) {
      return this.searchCache.results
    }

    const url =
      'https://registry.npmjs.org/-/v1/search?text=keywords:camstack+keywords:addon&size=250'

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(AddonPackageService.REGISTRY_TIMEOUT_MS),
      })

      if (!response.ok) {
        throw new Error(`npm search failed: ${response.status}`)
      }

      const data = await fetchJsonObject(response)
      const rawObjects = Array.isArray(data['objects']) ? data['objects'] : []
      const results: NpmSearchResult[] = []
      for (const raw of rawObjects) {
        const wrapper = asRecord(raw)
        const pkg = asRecord(wrapper['package'])
        const name = asString(pkg['name'])
        if (!name) continue
        const rawKeywords = Array.isArray(pkg['keywords']) ? pkg['keywords'] : []
        const publisher = asRecord(pkg['publisher'])
        results.push({
          name,
          version: asString(pkg['version']),
          description: asString(pkg['description']),
          keywords: rawKeywords.filter((k): k is string => typeof k === 'string'),
          date: asString(pkg['date']),
          publisher: { username: asString(publisher['username']) },
        })
      }

      this.searchCache = { results, timestamp: Date.now() }
      return results
    } catch (err: unknown) {
      this.logger.warn('npm search failed', { meta: { error: errMsg(err) } })
      // Stale cache is better than nothing on transient network failure
      return this.searchCache?.results ?? []
    }
  }

  // =========================================================================
  // Private: general helpers
  // =========================================================================

  /**
   * The version of `packageName` INSTALLED RIGHT NOW, or `null` when the hub
   * has no readable copy.
   *
   * Delegates to the installer, which is the one place that knows the on-disk
   * layout (`<addonsDir>/@camstack/<pkg>/`, with the pre-scope flat form as a
   * fallback). This method used to restate that path and got it wrong —
   * `packageName.replace(/^@camstack\//, '')` looked ONLY in the flat form, so
   * every scoped install missed. It then fell back to
   * `require.resolve('<pkg>/package.json')`, which cannot succeed either: an
   * addon is installed under the data directory, not in the hub's own
   * node_modules. Both misses landed on the literal `'0.0.0'`, and that string
   * was published on the `addon.updated` event as the version the operator had
   * been running ("@camstack/addon-terminal 0.0.0 → latest", 2026-08-30).
   *
   * `null`, not `'0.0.0'`: a version nobody installed is indistinguishable
   * from one that was, and the caller must be forced to decide what to say
   * about "unknown" rather than inherit a number that looks like an answer.
   */
  private getInstalledPackageVersion(packageName: string): string | null {
    try {
      const installed = this.installer?.getInstalledPackage(packageName) ?? null
      const version = installed === null ? '' : asString(installed.version)
      if (version) return version
    } catch (err) {
      this.logger.debug('Installed-version lookup failed', {
        meta: { packageName, error: errMsg(err) },
      })
    }
    this.logger.debug('No readable installed copy — previous version is unknown', {
      meta: { packageName },
    })
    return null
  }

  /** Only allow @camstack/* scoped packages */
  private isAllowedPackage(name: string): boolean {
    return name.startsWith('@camstack/')
  }

  /**
   * A framework/system-tier package (`@camstack/server`, `system`, `types`,
   * `sdk`, `kernel`, `core`, `ui-library`) must NEVER be installed by the
   * addon-package path: it ships exclusively through `applyServerUpdate`
   * (single-copy collapse). The auto-updater already skips these; the MANUAL
   * entry points (`updatePackage`, `applyStagedAddonUpdate`, `rollbackPackage`)
   * resolved them to `'core'` and ran a raw `npm install @camstack/server@X`,
   * which bypasses the single-copy engine and — on 2026-08-13 — saturated the
   * host mid-`applyServerUpdate` publish. A refusal, not a silent no-op.
   */
  private refuseExcludedFramework(name: string): UpdateResult | null {
    if (!AUTO_UPDATE_EXCLUDED_PACKAGES.has(name)) return null
    return {
      success: false,
      version: '',
      requiresRestart: false,
      error: `"${name}" is a framework package — install it via serverManagement.applyServerUpdate, not the addon-package path`,
    }
  }

  /** Categorize a package as 'addon' or 'core' */
  private categorize(name: string): 'addon' | 'core' {
    if (CORE_MANAGED_PACKAGES.includes(name)) {
      return 'core'
    }
    return name.includes('/addon-') ? 'addon' : 'core'
  }

  // `extractAddonId` (package name → single addon id) is GONE. It was wrong
  // for every multi-addon package — `@camstack/addon-pipeline` declares six
  // addons and none of them is `pipeline` — so the post-update restart it fed
  // silently targeted an addon that does not exist. Use
  // `addonRegistry.restartPackage(name)` / `listAddonIdsForPackage(name)`.

  /** Resolve the addons directory from config or fall back to default */
  private resolveAddonsDir(): string {
    // Must match where the runtime LOADS addons (launcher.ts +
    // addon-registry.service.ts honor CAMSTACK_ADDONS_DIR). If this service
    // installed/reloaded from a different dir than the runtime loads, a
    // post-install reload re-registers the hub node from an INCOMPLETE set
    // (registerNode replaces the cap set atomically) — dropping in-process
    // builtins like device-manager/addon-pages/addon-widgets.
    const envDir = process.env.CAMSTACK_ADDONS_DIR
    if (envDir && envDir.trim().length > 0) return path.resolve(envDir)
    const dataPath = this.configService.get<string>('server.dataPath') ?? 'camstack-data'
    return path.resolve(dataPath, 'addons')
  }

  /** Throw if installer was not initialised */
  private requireInstaller(): void {
    if (!this.installer) {
      throw new Error('AddonInstaller is not available -- @camstack/system may not be installed')
    }
  }

  /**
   * Send notification and toast for a successful package update.
   *
   * `version === null` means the hub could not read back what it just
   * installed. The sentence then says the package was updated and stops —
   * never "updated to v0.0.0", which reads as a real version.
   */
  private sendUpdateNotification(name: string, version: string | null): void {
    const sentence = version === null ? `${name} updated` : `${name} updated to v${version}`
    this.notificationService
      .notify({
        title: 'Package Updated',
        body: sentence,
        format: 'text',
        priority: 3,
        category: 'system',
        timestamp: Date.now(),
      })
      .catch((err: unknown) => {
        const msg = errMsg(err)
        this.logger.debug('Update notification failed', { meta: { error: msg } })
      })

    this.toastService.broadcast({
      title: 'Package Updated',
      message: sentence,
      severity: 'info',
      duration: 5000,
    })
  }
}

// ---------------------------------------------------------------------------
// Tarball extraction helper (exported for regression tests)
// ---------------------------------------------------------------------------

/**
 * Extract a gzipped tarball Buffer into `destDir`, stripping the npm
 * `package/` top-level prefix so that the extracted `package.json` lands at
 * `destDir/package.json` (not `destDir/package/package.json`).
 *
 * Uses `tar --strip-components=1` which mirrors what `installFromTgz` does
 * when it reads `path.join(tmpDir, 'package')` after a plain extract and
 * then uses that sub-directory as the source root.
 *
 * Exported so the regression spec in
 * `src/core/addon/__tests__/extract-tarball-strip.spec.ts` can test the real
 * implementation without instantiating `AddonPackageService`.
 */
export async function extractTgzStripped(tgz: Buffer, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  const tmpFile = path.join(os.tmpdir(), `camstack-tgz-${randomUUID()}.tgz`)
  try {
    fs.writeFileSync(tmpFile, tgz)
    await execFileAsync('tar', ['--strip-components=1', '-xzf', tmpFile, '-C', destDir], {
      timeout: 60_000,
    })
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
}

// ---------------------------------------------------------------------------
// npm tarball / version helpers
// ---------------------------------------------------------------------------

/**
 * Build the npm CLI args that pin every relevant registry to
 * `CAMSTACK_NPM_REGISTRY`. We pass BOTH the default `--registry` and
 * the scope-specific `--@camstack:registry=` flag because workspace or
 * user-home `.npmrc` files commonly declare
 * `@camstack:registry=https://registry.npmjs.org/`, and that scoped
 * entry takes precedence over the plain `--registry` CLI flag for
 * `@camstack/*` lookups.
 *
 * Without this, an operator running their own private npm proxy via
 * `@camstack:registry` would have package downloads silently route around it.
 */
function buildNpmRegistryArgs(registry: string | undefined): readonly string[] {
  if (registry === undefined || registry.length === 0) return []
  return ['--registry', registry, `--@camstack:registry=${registry}`]
}

/**
 * Read a framework package's `package.json`, resolved however the
 * running hub actually loads it — workspace symlink in dev, a real
 * `node_modules` tree in prod, bundled in Electron.
 *
 * `require.resolve('<pkg>/package.json')` is the happy path. Packages
 * whose `exports` map omits the `./package.json` subpath (e.g.
 * `@camstack/sdk`, `@camstack/ui-library`) make that throw — so we
 * fall back to resolving the package's main entry and walking up to
 * the first `package.json` whose `name` matches.
 */
function readResolvedPackageManifest(packageName: string): Record<string, unknown> | null {
  try {
    return readJsonObject(require.resolve(`${packageName}/package.json`))
  } catch {
    // `exports` map blocks the package.json subpath — fall through.
  }
  try {
    let dir = path.dirname(require.resolve(packageName))
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json')
      const obj = fs.existsSync(candidate) ? readJsonObject(candidate) : null
      if (obj !== null && obj['name'] === packageName) return obj
      dir = path.dirname(dir)
    }
  } catch {
    // The package itself is not resolvable — treat as not installed.
  }
  return null
}

/**
 * Resolve a version specifier (`'latest'`, semver tag, exact) to a concrete
 * version string via `npm view <pkg>@<spec> version`. Returns the spec as-is
 * when `npm view` is unavailable or fails — better to attempt the install
 * than to block.
 */
async function resolveNpmVersion(
  packageName: string,
  versionSpec: string,
  registry: string | undefined,
): Promise<string> {
  const args = [
    'view',
    `${packageName}@${versionSpec}`,
    'version',
    ...buildNpmRegistryArgs(registry),
  ]
  try {
    const { stdout } = await execFileAsync('npm', args, { timeout: 30_000 })
    const trimmed = stdout.trim()
    // `npm view` returns just the version line for a single match, or
    // "pkg@1.2.3 '1.2.3'" lines for a range. Take the last token on the
    // last non-empty line which is the most specific resolved version.
    const lines = trimmed.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length === 0) return versionSpec
    const last = lines[lines.length - 1]!.trim()
    const match = last.match(/'([^']+)'\s*$/)
    return match ? match[1]! : last
  } catch {
    return versionSpec
  }
}
