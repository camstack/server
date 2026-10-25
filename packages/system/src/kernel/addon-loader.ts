import type {
  AddonDeclaration,
  AddonPackageManifest,
  ICamstackAddon,
  IScopedLogger,
  StorageLocationDeclaration,
} from '@camstack/types'
import { asJsonObject, parseJsonUnknown } from '@camstack/types'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveAddonClass } from './addon-class-resolver.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * How far up from the entry file to look for the owning `package.json`
 * (`<pkg>/dist/chunks/x.js` → 3 hops). Bounded so a loose module outside a
 * package can't walk to the filesystem root.
 */
const PACKAGE_JSON_LOOKUP_DEPTH = 4

/** Version from the `package.json` that owns `entryPath`, or null. */
function readOwningPackageVersion(entryPath: string): string | null {
  let dir = path.dirname(entryPath)
  for (let hop = 0; hop < PACKAGE_JSON_LOOKUP_DEPTH; hop++) {
    try {
      const pkg = asJsonObject(
        parseJsonUnknown(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')),
      )
      const version = pkg?.['version']
      if (typeof version === 'string' && version.length > 0) return version
    } catch {
      // Not a package root (or unreadable) — keep walking up.
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Cache-bust key for an addon entry module: the `?v=` query that makes each
 * on-disk REVISION of `entryPath` a distinct ESM module URL. Returns null when
 * the entry cannot be stat'd — the caller then does a plain import.
 *
 * The key is `<version>-<content hash>`, and BOTH halves are load-bearing
 * because each on its own has a documented way of not changing across a real
 * redeploy:
 *
 *  - **mtime does not change.** `npm pack` normalises every file's mtime in the
 *    tarball to 499162500000 (1985-10-26); every install path here extracts
 *    such a tarball, so the entry file of v1.0.0 and of v1.0.99 carry the same
 *    mtime. An mtime-only key (what this used to be) is a NO-OP — it produced
 *    one byte-identical URL for every version of every addon ever installed.
 *  - **the version does not change** on a `camstack deploy` of an unbumped
 *    workspace package — the whole dev loop.
 *  - **the entry hash does not change** when a multi-chunk dist alters a chunk
 *    the entry only re-exports; the version bump covers that case.
 *
 * Hashing the entry costs one extra read of an already-read file (~1.5 MB for
 * the largest addon bundle, single-digit ms) once per addon load. Cheap against
 * what a stale key costs: hub-main keeps validating `addons.custom` input
 * against the OLD `customActions` schema — silently STRIPPING newly-added
 * fields — and, worse, Node caches a load that THREW as a rejected module and
 * replays that rejection for every later retry at the same URL. On 2026-08-12
 * `@camstack/addon-export-hap` burned 126 identical failed load retries over
 * 10.5h, none of which could have succeeded: the fixed bytes on disk were never
 * read.
 *
 * Never throws: an unreadable version degrades to the mtime, an unreadable body
 * to mtime+size.
 */
export function addonModuleCacheKey(entryPath: string): string | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(entryPath)
  } catch {
    return null
  }
  const version = readOwningPackageVersion(entryPath) ?? `m${stat.mtimeMs}`
  let content: string
  try {
    content = createHash('sha1').update(fs.readFileSync(entryPath)).digest('hex').slice(0, 16)
  } catch {
    content = `m${stat.mtimeMs}s${stat.size}`
  }
  return `${version}-${content}`
}

/**
 * Import an addon entry module FRESH on every load, defeating Node's
 * per-URL ESM module cache.
 *
 * `camstack deploy` overwrites an addon's `dist/` in place (same path). Node
 * caches ESM modules by resolved URL, so a plain `import(entryPath)` after a
 * redeploy returns the STALE previously-cached module. The addon RUNNER child
 * is a fresh process so it reloads correctly — but hub-main also imports the
 * module to read its static catalog (`customActions` Zod schemas, addon class)
 * for the `addons.custom` "validate on the way in" guard.
 *
 * The distinguishing key is {@link addonModuleCacheKey}; a plain import is the
 * fallback when the entry cannot be stat'd.
 */
async function importAddonModuleFresh(entryPath: string): Promise<unknown> {
  const bust = addonModuleCacheKey(entryPath)
  if (bust === null) return import(entryPath)
  return import(`${pathToFileURL(entryPath).href}?v=${encodeURIComponent(bust)}`)
}

/**
 * Package.json manifest boundary: the `camstack` field is authored by third-party
 * addon packages. We minimally validate that it looks like an AddonPackageManifest
 * (has an `addons` array whose entries carry string `id`s) and pass it through as
 * typed. This is one documented type-level bridge — the shape contract lives in
 * AddonPackageManifest + AddonDeclaration.
 */
function isAddonPackageManifest(value: unknown): value is AddonPackageManifest {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.addons)) return false
  return value.addons.every((a) => isRecord(a) && typeof a.id === 'string')
}

function toAddonPackageManifest(value: unknown): AddonPackageManifest | undefined {
  if (!isRecord(value)) return undefined
  if (!isAddonPackageManifest(value)) return undefined
  return value
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

export interface RegisteredAddon {
  readonly declaration: AddonDeclaration
  readonly packageName: string
  readonly packageVersion: string
  /** Human-readable package name from camstack.displayName in package.json */
  readonly packageDisplayName?: string
  /**
   * Optional bundle metadata when the npm package ships multiple addon
   * entries. Mirrors `AddonPackageManifest.bundle`. Drives the
   * collapsible bundle card in the Addons admin UI.
   */
  readonly bundle?: { displayName: string; description?: string; icon?: string }
  readonly addonClass: new () => ICamstackAddon
  /**
   * Full raw module namespace. Consumers can read additional named exports
   * (e.g. `customActions`) without instantiating the addon — lets the hub
   * register a forkable addon's custom-action catalog with real zod
   * schemas before the child process is up.
   */
  readonly module: Readonly<Record<string, unknown>>
}

/**
 * Per-package failure record. Surfaced via `listLoadFailures()` so the
 * AddonRegistry can hand the failures to the kernel's
 * `AddonHealthMonitor` after `loadFromDirectory()` completes — the
 * health monitor then schedules the retry loop and emits operator-
 * visible alerts post-grace.
 *
 * Two failure shapes are tracked:
 *   - **package-level**: package.json couldn't be read/parsed, or the
 *     manifest was malformed. `addonId` undefined.
 *   - **declaration-level**: per-addon load failure inside
 *     `loadDeclaration` (entry import threw, addon class resolution
 *     failed, etc). `addonId` set to `declaration.id`.
 */
export interface AddonLoadFailure {
  readonly packageName: string
  readonly addonDir: string
  readonly addonId?: string
  readonly error: Error
  readonly timestamp: number
}

/**
 * Pure extraction of per-addon storage-location declarations from a set of
 * registered addons. Each registered addon carries its manifest declaration
 * (`RegisteredAddon.declaration`), whose optional `storageLocations` array is
 * the `camstack.addons[].storageLocations` entry authored in package.json.
 *
 * Returns ONE inner array per addon that declared at least one location;
 * addons declaring nothing are omitted entirely (no empty arrays). The result
 * is the `perAddon` input shape consumed by
 * {@link buildStorageLocationRegistry}.
 */
export function extractStorageLocationDeclarations(
  addons: Iterable<RegisteredAddon>,
): StorageLocationDeclaration[][] {
  const result: StorageLocationDeclaration[][] = []
  for (const addon of addons) {
    const declared = addon.declaration.storageLocations
    if (declared !== undefined && declared.length > 0) {
      result.push([...declared])
    }
  }
  return result
}

export class AddonLoader {
  private addons = new Map<string, RegisteredAddon>()
  private readonly loadFailures: AddonLoadFailure[] = []
  private readonly logger: IScopedLogger

  constructor(logger: IScopedLogger = noopLogger) {
    this.logger = logger
  }

  /**
   * Failures encountered during the most recent `loadFromDirectory` /
   * `loadFromAddonDir` pass. Cleared (per-package) on a successful
   * subsequent reload so retries don't see stale entries. Cumulative
   * across multiple loads otherwise.
   */
  listLoadFailures(): readonly AddonLoadFailure[] {
    return [...this.loadFailures]
  }

  /** Forget any tracked failures for a given package — uninstall path. */
  clearLoadFailures(packageName: string): void {
    let i = 0
    while (i < this.loadFailures.length) {
      if (this.loadFailures[i]!.packageName === packageName) {
        this.loadFailures.splice(i, 1)
      } else {
        i++
      }
    }
  }

  /** Scan addons directory and load all addon packages.
   *  Supports scoped layout: addons/@scope/package-name/
   *
   *  `skipPackages` names scoped packages (e.g. `@camstack/system`) that the
   *  caller loads from elsewhere — the single-copy model loads the framework
   *  BUILTINS from the active closure, not the (now-inert) addons-dir copy, so
   *  the addons-dir `@camstack/system` must NOT be double-loaded here. */
  async loadFromDirectory(addonsDir: string, skipPackages: readonly string[] = []): Promise<void> {
    if (!fs.existsSync(addonsDir)) return
    const skip = new Set(skipPackages)

    const entries = fs.readdirSync(addonsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!isDirectoryEntry(entry, addonsDir)) continue

      // Scoped directory (e.g., @camstack/) — scan one level deeper
      if (entry.name.startsWith('@')) {
        const scopeDir = path.join(addonsDir, entry.name)
        const scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true })
        for (const scopeEntry of scopeEntries) {
          if (!isDirectoryEntry(scopeEntry, scopeDir)) continue
          if (skip.has(`${entry.name}/${scopeEntry.name}`)) continue
          await this.tryLoadAddon(path.join(scopeDir, scopeEntry.name))
        }
        continue
      }

      // Non-scoped (legacy or flat layout)
      if (skip.has(entry.name)) continue
      await this.tryLoadAddon(path.join(addonsDir, entry.name))
    }
  }

  private async tryLoadAddon(addonDir: string): Promise<void> {
    const pkgJsonPath = path.join(addonDir, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) return
    try {
      await this.loadFromAddonDir(addonDir)
    } catch (err) {
      // Pre-manifest failure (package.json unreadable / unparseable). The
      // per-addon try/catch inside `loadFromAddonDir` tags failures with
      // the offending `addonId`; this outer catch only fires before any
      // addon id is known, so we tag with the package directory.
      const error = err instanceof Error ? err : new Error(String(err))
      this.logger.warn(`Failed to load package from ${addonDir}`, {
        meta: { error: error.message },
      })
      // Track for the AddonHealthMonitor — surfacing alerts on
      // pre-manifest failures requires SOME packageName key. Use the
      // basename of `addonDir` as a stable identifier when the
      // package.json itself is unreadable.
      const packageName = path.basename(addonDir)
      this.loadFailures.push({
        packageName,
        addonDir,
        error,
        timestamp: Date.now(),
      })
    }
  }

  /** Load addon from a specific directory (package.json + dist/) */
  async loadFromAddonDir(addonDir: string): Promise<void> {
    const pkgJsonPath = path.join(addonDir, 'package.json')
    const pkgJson = asJsonObject(parseJsonUnknown(fs.readFileSync(pkgJsonPath, 'utf-8'))) ?? {}
    const packageNameRaw = pkgJson['name']
    const packageName = typeof packageNameRaw === 'string' ? packageNameRaw : ''
    const packageVersionRaw = pkgJson['version']
    const packageVersion = typeof packageVersionRaw === 'string' ? packageVersionRaw : '0.0.0'
    const manifest = toAddonPackageManifest(pkgJson['camstack'])

    if (!manifest?.addons?.length) return

    // Clear any prior failures for this package — a successful reload
    // should reset the streak in the health monitor.
    this.clearLoadFailures(packageName)

    for (const declaration of manifest.addons) {
      // Per-addon failures are tagged with `addonId` so the per-addon log
      // filter on the Addons page surfaces them — without this every
      // load failure would be invisible to the operator.
      try {
        await this.loadDeclaration(
          addonDir,
          declaration,
          packageName,
          packageVersion,
          manifest.displayName,
          manifest.bundle,
        )
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        this.logger.warn(`Failed to load addon "${declaration.id}"`, {
          tags: { addonId: declaration.id },
          meta: { error: error.message, packageName, addonDir },
        })
        this.loadFailures.push({
          packageName,
          addonDir,
          addonId: declaration.id,
          error,
          timestamp: Date.now(),
        })
      }
    }
  }

  private async loadDeclaration(
    addonDir: string,
    declaration: AddonDeclaration,
    packageName: string,
    packageVersion: string,
    packageDisplayName: string | undefined,
    bundle?: { displayName: string; description?: string; icon?: string },
  ): Promise<void> {
    if (!declaration.entry) {
      throw new Error(`Addon "${declaration.id}" has no entry point in package.json`)
    }

    // An addon id belongs to the first PACKAGE that registered it. The hub
    // loads the closure's builtins before the addons dir, so a package that was
    // later folded into the framework (`@camstack/addon-device-history` →
    // `@camstack/system`) would otherwise replace the builtin from its stale
    // on-disk copy — and did, on every node that had installed it. A reload of
    // the SAME package still replaces it.
    const owner = this.addons.get(declaration.id)
    if (owner !== undefined && owner.packageName !== packageName) {
      this.logger.warn(
        `Skipped addon "${declaration.id}" from ${packageName}: already provided by ${owner.packageName}`,
        {
          tags: { addonId: declaration.id },
          meta: {
            skippedPackage: packageName,
            skippedVersion: packageVersion,
            skippedDir: addonDir,
            ownerPackage: owner.packageName,
            ownerVersion: owner.packageVersion,
          },
        },
      )
      return
    }

    // Resolve entry: try dist/ first
    const entryFile = declaration.entry
      .replace(/^\.\//, '')
      .replace(/^src\//, 'dist/')
      .replace(/\.ts$/, '.js')

    let entryPath = path.resolve(addonDir, entryFile)

    // Fallback: try other locations and extensions
    if (!fs.existsSync(entryPath)) {
      const base = entryPath.replace(/\.(js|cjs|mjs)$/, '')
      const alternatives = [
        `${base}.cjs`,
        `${base}.mjs`,
        path.resolve(addonDir, 'dist', 'index.js'),
        path.resolve(addonDir, 'dist', 'index.cjs'),
        path.resolve(addonDir, 'dist', 'index.mjs'),
        path.resolve(addonDir, declaration.entry),
      ]
      entryPath = alternatives.find((p) => fs.existsSync(p)) ?? entryPath
    }

    if (!fs.existsSync(entryPath)) {
      throw new Error(`Entry not found: ${entryPath}`)
    }

    const modUnknown: unknown = await importAddonModuleFresh(entryPath)
    const mod = isRecord(modUnknown) ? modUnknown : {}
    const AddonClass = resolveAddonClass(mod)

    if (!AddonClass) {
      throw new Error(`No addon class in ${entryPath}`)
    }

    this.addons.set(declaration.id, {
      declaration,
      packageName,
      packageVersion,
      packageDisplayName,
      ...(bundle !== undefined ? { bundle } : {}),
      addonClass: AddonClass,
      module: mod,
    })
  }

  /** Load addon from a direct path (for development/testing) */
  async loadFromPath(
    addonId: string,
    modulePath: string,
    packageName: string,
    declaration?: Partial<AddonDeclaration>,
    packageVersion = '0.0.0',
  ): Promise<void> {
    const modUnknown: unknown = await importAddonModuleFresh(modulePath)
    const mod = isRecord(modUnknown) ? modUnknown : {}
    const AddonClass = resolveAddonClass(mod)

    if (!AddonClass) {
      throw new Error(`Module ${modulePath} has no default export`)
    }

    const defaultSlot: AddonDeclaration['slot'] = 'detector'
    this.addons.set(addonId, {
      module: mod,
      declaration: {
        id: addonId,
        entry: modulePath,
        slot: defaultSlot,
        ...declaration,
      },
      packageName,
      packageVersion,
      addonClass: AddonClass,
    })
  }

  /** Get a registered addon by ID */
  getAddon(addonId: string): RegisteredAddon | undefined {
    return this.addons.get(addonId)
  }

  /** List all registered addons */
  listAddons(): RegisteredAddon[] {
    return [...this.addons.values()]
  }

  /**
   * Per-addon storage-location declarations across every registered addon.
   *
   * Each registered addon's `declaration.storageLocations` (the
   * `camstack.addons[].storageLocations` array from package.json) is surfaced
   * as one inner array; addons declaring nothing are omitted. The result is
   * fed directly to `buildStorageLocationRegistry(perAddon)` so the
   * storage-orchestrator can aggregate declarations and seed `<id>:default`
   * instances.
   */
  listStorageLocationDeclarations(): StorageLocationDeclaration[][] {
    return extractStorageLocationDeclarations(this.addons.values())
  }

  /** Check if an addon is registered */
  hasAddon(addonId: string): boolean {
    return this.addons.has(addonId)
  }

  /**
   * Create a new instance of an addon (not yet initialized).
   * Injects the manifest from package.json (AddonDeclaration) so the
   * addon class doesn't need to declare it.
   */
  createInstance(addonId: string): ICamstackAddon {
    const registered = this.addons.get(addonId)
    if (!registered) {
      throw new Error(`Addon "${addonId}" is not registered`)
    }
    const addon = new registered.addonClass()

    // Inject manifest from package.json declaration if the class didn't declare one.
    // During migration some addons still have their own manifest; the package.json
    // declaration takes precedence since it's the single source of truth.
    const manifestFromPkg: AddonDeclaration = {
      ...registered.declaration,
      name: registered.declaration.name ?? addonId,
      version: registered.declaration.version ?? registered.packageVersion,
    }

    // If the addon class has no manifest or has a minimal one, inject from package.json
    if (!addon.manifest || !addon.manifest.id) {
      Object.defineProperty(addon, 'manifest', { value: manifestFromPkg, writable: false })
    }

    return addon
  }
}

/** Check if a Dirent is a directory (or a symlink pointing to a directory) */
function isDirectoryEntry(entry: fs.Dirent, parentDir: string): boolean {
  // A dot-prefixed directory is never an addon. npm never installs one (`.bin`,
  // `.package-lock.json`, `.cache` are all tooling), and the addons dir is also
  // where an operator parks a package they are RETIRING — the house convention
  // is to rename it `.quarantine-<name>-<date>`.
  //
  // That convention did nothing until this line existed. The scan below reads
  // EVERY subdirectory and loads anything with a `package.json`, so a
  // "quarantined" addon kept being loaded and kept showing up in `addons.list`
  // — through a full hub restart, which is how it was finally noticed. Worse,
  // the rename only ever removed the addon from the paths resolved BY NAME: the
  // runner spawn resolves `<addonsDir>/@camstack/addon-<id>`, so an addon still
  // listed in `manifest.json` whose directory had been renamed killed its
  // runner on every respawn — and with it every addon sharing that runner
  // (2026-08-09: `notification-output` lost all three providers for ~2h50m).
  // Quarantine now means what it says on both paths.
  if (entry.name.startsWith('.')) return false
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink()) {
    try {
      const resolved = fs.statSync(path.join(parentDir, entry.name))
      return resolved.isDirectory()
    } catch {
      return false
    }
  }
  return false
}
