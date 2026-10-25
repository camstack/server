// =============================================================================
// AddonManifest — centralised state file for the runtime overlay.
//
// Single source-of-truth file: `{dataDir}/addons/manifest.json`.
// Tracks every installed addon: name, version, source, install + update
// timestamps, last backup snapshot path. Replaces the per-addon
// `.install-source` markers with one atomic file the UI + AddonInstaller
// can read/write transactionally.
//
// Atomicity: writes go through a tmpfile + `fs.renameSync` so the file
// is never partially overwritten if the process is killed mid-write.
// Reads are tolerant of missing/corrupt files (returns empty manifest).
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * `closure` — re-aligned from the running `@camstack/server` closure at boot.
 *
 * Distinct from `bundled`, which is the copy an Electron app shipped with and
 * seeds ONCE. A `closure` install is a refresh of a copy that was already
 * there, and naming it separately is what lets an operator tell "I deployed
 * this" from "the server update brought it" — the distinction the six stale
 * copies of 2026-09-17 had no way to express, all of them reading `upload`
 * because each HAD been a deliberate deploy, once. See D518.
 */
export type AddonInstallSource = 'npm' | 'local' | 'upload' | 'bundled' | 'seed' | 'closure'

export interface AddonManifestEntry {
  /** Full pkg name, e.g. `@camstack/addon-pipeline`. */
  name: string
  /** Semver currently installed. */
  version: string
  /** Where this version came from. */
  source: AddonInstallSource
  /** ISO 8601 of first install. */
  installedAt: string
  /** ISO 8601 of last update (== installedAt for first install). */
  updatedAt: string
  /**
   * Path (absolute) of the most recent pre-update backup, if any.
   * Used by `applyUpdate` rollback when an upgrade fails its post-restart
   * health check. Cleared once the new version is confirmed healthy.
   */
  lastBackupDir?: string
  /**
   * Free-form, addon-specific metadata. Currently unused but reserved so
   * future fields (e.g. integrity hash, peer-dep checks) don't require a
   * manifest schema bump.
   */
  meta?: Record<string, unknown>
}

/** One correction `reconcileFromDisk` made to bring the manifest back to disk truth. */
export interface ManifestReconcileChange {
  readonly kind: 'added' | 'version-corrected' | 'pruned'
  readonly name: string
  /** Version the manifest claimed before the change. Absent for `added`. */
  readonly from?: string
  /** Version now recorded. Absent for `pruned`. */
  readonly to?: string
}

export interface AddonManifestFile {
  /**
   * Schema version. Increment whenever the on-disk shape changes
   * incompatibly so older readers can refuse to load.
   */
  version: 1
  /** Per-package state, keyed by full pkg name. */
  addons: Record<string, AddonManifestEntry>
  /** ISO 8601 of last manifest write. */
  updatedAt: string
}

const MANIFEST_FILENAME = 'manifest.json'
const MANIFEST_VERSION = 1 as const

/**
 * Is `p` a directory, FOLLOWING symlinks?
 *
 * `Dirent.isDirectory()` answers false for a symlink, and dev installs
 * (`installSymlink`) point `addonsDir/@camstack/<pkg>` straight at the
 * workspace source. Trusting the dirent there finds zero addons on disk, which
 * with pruning would empty a developer's manifest on the next boot.
 */
/** `@camstack/system` → `system`: the directory a package must live in. */
function packageDirName(declaredName: string): string {
  const slash = declaredName.lastIndexOf('/')
  return slash === -1 ? declaredName : declaredName.slice(slash + 1)
}

function isDirLike(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export class AddonManifest {
  private readonly manifestPath: string
  private cache: AddonManifestFile | null = null

  constructor(addonsDir: string) {
    this.manifestPath = path.join(addonsDir, MANIFEST_FILENAME)
  }

  /**
   * Read the manifest from disk. Returns an empty manifest if the file is
   * missing or corrupted (logs a warning to stderr in the corrupted case).
   * Cached per instance — call `invalidate()` to force a re-read.
   */
  read(): AddonManifestFile {
    if (this.cache != null) return this.cache
    if (!fs.existsSync(this.manifestPath)) {
      this.cache = this.empty()
      return this.cache
    }
    try {
      const raw = fs.readFileSync(this.manifestPath, 'utf-8')
      const parsed = JSON.parse(raw) as AddonManifestFile
      if (parsed.version !== MANIFEST_VERSION) {
        // Future: migration path. For now refuse to load and start fresh —
        // safer than partially understanding a future shape.
        process.stderr.write(
          `[AddonManifest] schema mismatch (file=${parsed.version} vs runtime=${MANIFEST_VERSION}); starting empty\n`,
        )
        this.cache = this.empty()
        return this.cache
      }
      this.cache = parsed
      return this.cache
    } catch (err) {
      process.stderr.write(
        `[AddonManifest] failed to parse ${this.manifestPath}: ${
          err instanceof Error ? err.message : String(err)
        }; starting empty\n`,
      )
      this.cache = this.empty()
      return this.cache
    }
  }

  /**
   * Atomic write — writes to a tmpfile in the same directory, then renames.
   * Rename is atomic on the same filesystem, so readers can never observe
   * a half-written file.
   */
  write(manifest: AddonManifestFile): void {
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true })
    const tmp = `${this.manifestPath}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    fs.renameSync(tmp, this.manifestPath)
    this.cache = manifest
  }

  /** Lookup a single addon's manifest entry, or `null` if not tracked. */
  get(name: string): AddonManifestEntry | null {
    return this.read().addons[name] ?? null
  }

  /** List every tracked entry. */
  list(): AddonManifestEntry[] {
    return Object.values(this.read().addons)
  }

  /**
   * Insert or replace an addon entry. `installedAt` is preserved if the
   * entry already exists; only `updatedAt` advances on subsequent writes.
   */
  upsert(
    name: string,
    fields: Omit<AddonManifestEntry, 'name' | 'installedAt' | 'updatedAt'>,
  ): void {
    const now = new Date().toISOString()
    const m = this.read()
    const prev = m.addons[name]
    m.addons[name] = {
      name,
      ...fields,
      installedAt: prev?.installedAt ?? now,
      updatedAt: now,
    }
    m.updatedAt = now
    this.write(m)
  }

  /** Remove an addon from tracking (e.g. uninstall). */
  remove(name: string): void {
    const m = this.read()
    if (!(name in m.addons)) return
    delete m.addons[name]
    m.updatedAt = new Date().toISOString()
    this.write(m)
  }

  /**
   * Drop the in-memory cache so the next `read()` re-loads from disk.
   * Useful when an external process may have written the manifest.
   */
  invalidate(): void {
    this.cache = null
  }

  /**
   * Reconcile the manifest against what is actually present on disk.
   *
   * **The directory is the truth.** It is what `AddonLoader` runs; a manifest
   * that disagrees with it is a lie the update flow and the admin UI then
   * repeat. Three corrections, all idempotent and safe on every boot:
   *
   *  - **added** — an on-disk addon with no entry gets one, source `'seed'`.
   *    Addons baked into the Docker/Electron image are copied straight into
   *    `addonsDir` by the container entrypoint (`ensureRequiredPackages` then
   *    sees `package.json` present and skips, never calling `upsert`), so they
   *    would otherwise stay untracked and `applyUpdate` would reject them with
   *    "not currently tracked in manifest" — what broke "Update all" on a
   *    fresh image.
   *  - **version-corrected** — an entry whose version disagrees with the
   *    installed `package.json` adopts the DISK version. Provenance (`source`,
   *    `installedAt`) is NOT derivable from disk and stays authoritative here;
   *    `updatedAt` is left alone because the correction is not an update, and
   *    stamping `now` would claim an install that never happened.
   *  - **pruned** — an entry naming a directory that does not exist. The live
   *    hub carried three (`@camstack/system 1.2.29`, `addon-viewer-ui 1.1.39`,
   *    `addon-agent-ui 1.2.4`); `@camstack/system` in particular is
   *    host-provided and deliberately NOT seeded under `addonsDir`
   *    ([D45]), so its entry advertised a copy that must not exist.
   *    An entry holding a `lastBackupDir` is NEVER pruned: that pointer is the
   *    only reference to a pre-update backup, and the launcher's backup sweep
   *    reclaims anything the manifest does not point at.
   *
   * `onChange` receives one record per correction, so the caller can log
   * exactly what moved. Returns the total number of changes.
   */
  reconcileFromDisk(
    addonsDir: string,
    onChange?: (change: ManifestReconcileChange) => void,
  ): number {
    if (!fs.existsSync(addonsDir)) return 0

    const m = this.read()
    let changes = 0
    const now = new Date().toISOString()
    /** Package name → version, for every ADDON package actually installed. */
    const onDisk = new Map<string, string>()

    for (const scope of fs.readdirSync(addonsDir, { withFileTypes: true })) {
      if (!scope.name.startsWith('@') || !isDirLike(path.join(addonsDir, scope.name))) continue
      const scopeDir = path.join(addonsDir, scope.name)
      for (const pkg of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!isDirLike(path.join(scopeDir, pkg.name))) continue
        const pkgJsonPath = path.join(scopeDir, pkg.name, 'package.json')
        if (!fs.existsSync(pkgJsonPath)) continue
        let pkgJson: {
          name?: string
          version?: string
          camstack?: { addons?: unknown }
        }
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
          if (typeof parsed !== 'object' || parsed == null) continue
          pkgJson = parsed as { name?: string; version?: string; camstack?: { addons?: unknown } }
        } catch {
          continue
        }
        if (!pkgJson.name || !pkgJson.version) continue
        // Identify an installable addon the SAME way `AddonLoader` does:
        // a `camstack.addons[]` block with at least one entry. There is no
        // dedicated addons folder anymore — addons, framework system
        // packages and every hoisted third-party dep (@trpc, @fastify, …)
        // share one flat node_modules, so the manifest marker is the only
        // reliable discriminator. Skips pure framework libs (types/sdk —
        // `camstack.system` but no addons) and all third-party deps.
        const addons = pkgJson.camstack?.addons
        if (!Array.isArray(addons) || addons.length === 0) continue
        // The DIRECTORY has to be the package, not merely contain it. A
        // renamed copy is residue — `addon-residue.ts` quarantines it — and
        // until it is moved it must not become the version this manifest
        // reports. Measured on macmini 2026-08-08: `addons/@camstack/system`
        // did not exist at all, yet the manifest carried `@camstack/system
        // 1.2.3` with this boot's timestamp, read out of
        // `system.bak-pre-1272-1786129145` against a 1.2.61 closure. Every
        // reader of the manifest was answering with a 17-day-old backup.
        if (packageDirName(pkgJson.name) !== pkg.name) continue
        onDisk.set(pkgJson.name, pkgJson.version)
      }
    }

    for (const [name, version] of onDisk) {
      const prev = m.addons[name]
      if (prev == null) {
        m.addons[name] = {
          name,
          version,
          source: 'seed',
          installedAt: now,
          updatedAt: now,
        }
        changes++
        onChange?.({ kind: 'added', name, to: version })
        continue
      }
      if (prev.version !== version) {
        m.addons[name] = { ...prev, version }
        changes++
        onChange?.({ kind: 'version-corrected', name, from: prev.version, to: version })
      }
    }

    for (const [name, entry] of Object.entries(m.addons)) {
      if (onDisk.has(name)) continue
      // A pending rollback pointer outranks the phantom rule — see above.
      if (entry.lastBackupDir) continue
      delete m.addons[name]
      changes++
      onChange?.({ kind: 'pruned', name, from: entry.version })
    }

    if (changes > 0) {
      m.updatedAt = now
      this.write(m)
    }
    return changes
  }

  /**
   * Migration helper: if the manifest is empty but the addons directory
   * has packages with `.install-source` markers (the legacy per-addon
   * tracking), seed the manifest from those markers. Runs once at boot.
   * Returns the number of entries migrated.
   */
  migrateFromInstallSourceMarkers(addonsDir: string): number {
    const m = this.read()
    if (Object.keys(m.addons).length > 0) return 0
    if (!fs.existsSync(addonsDir)) return 0

    let migrated = 0
    const now = new Date().toISOString()
    for (const scope of fs.readdirSync(addonsDir, { withFileTypes: true })) {
      if (!scope.isDirectory() || !scope.name.startsWith('@')) continue
      const scopeDir = path.join(addonsDir, scope.name)
      for (const pkg of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue
        const pkgDir = path.join(scopeDir, pkg.name)
        const markerPath = path.join(pkgDir, '.install-source')
        const pkgJsonPath = path.join(pkgDir, 'package.json')
        if (!fs.existsSync(pkgJsonPath)) continue
        let pkgJson: { name?: string; version?: string }
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
          if (typeof parsed !== 'object' || parsed == null) continue
          pkgJson = parsed as { name?: string; version?: string }
        } catch {
          continue
        }
        if (!pkgJson.name || !pkgJson.version) continue
        const source = (
          fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf-8').trim() : 'bundled'
        ) as AddonInstallSource
        m.addons[pkgJson.name] = {
          name: pkgJson.name,
          version: pkgJson.version,
          source,
          installedAt: now,
          updatedAt: now,
        }
        migrated++
      }
    }
    if (migrated > 0) {
      m.updatedAt = now
      this.write(m)
    }
    return migrated
  }

  private empty(): AddonManifestFile {
    return {
      version: MANIFEST_VERSION,
      addons: {},
      updatedAt: new Date().toISOString(),
    }
  }
}
