/**
 * Single-copy framework layout — the ONE physical copy of a node's runtime
 * root closure. ZERO-DEP (node:fs/node:path only): loaded by the baked STARTER
 * before any node_modules resolution is trusted, so it must never import from
 * `@camstack/*` (runtime) or any npm package.
 *
 * Replaces the legacy multi-copy model (`versions/<X>` + an N-1 rollback copy +
 * a separate `/data/framework` copy + a `/data/addons/@camstack/system` copy).
 * There is now exactly ONE closure:
 *
 *   <dataDir>/server-root/current/                 the ONE canonical closure
 *     node_modules/<packageName>/<entry>           ← the loadable entry
 *   <dataDir>/server-root/.pending-root-swap.json  a staged update awaiting boot
 *   <dataDir>/server-root/.staging-*               transient npm-install dir
 *   <dataDir>/server-root/.trash-*                 transient old-copy graveyard
 *
 * hub-main, the forked addon-runners, and the framework BUILTINS all resolve
 * `@camstack/{system,types,sdk}` from `current/node_modules`; there is
 * no drift and no seed-vs-data-root divergence. `applyServerUpdate` stages a
 * new closure into `.staging-*`, writes the pending-root-swap marker and
 * restarts; the STARTER performs the atomic swap of `current` on the next boot
 * (nothing holds `current` open at that point) — mirroring the trusted
 * launcher-framework-swap pattern. NO auto-rollback: a bad update is recovered
 * manually (re-apply a known-good version, or reinstall the image seed).
 *
 * Spec: docs/superpowers/specs/2026-07-18-single-framework-copy-collapse-design.md
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RootPackageSpec } from './root-package-spec.js'
import {
  readServerRootState,
  rootEntryPath,
  rootPackageDir,
  stateFilePath,
  validateClosureDir,
  versionDir,
  versionsDir,
} from './root-state.js'
import { compareSemver } from './semver-compare.js'

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Name of the single canonical closure dir under `server-root/`. */
export const CURRENT_DIRNAME = 'current'
/** Marker written by `applyServerUpdate`, consumed by the starter's swap. */
export const PENDING_ROOT_SWAP_FILE = '.pending-root-swap.json'

/**
 * Legacy `/data/framework` swap markers (the retired per-package framework
 * mechanism). Cleared during migration so a stale marker can never swap a
 * package INTO the single copy on the first collapse boot. They live in the
 * DATA dir (one level up from `server-root/`), not in `rootDir`.
 */
const LEGACY_FRAMEWORK_MARKERS: readonly string[] = [
  '.pending-framework-swap.json',
  '.framework-swap-confirm.json',
]

/** The single canonical closure dir for `rootDir` (= `server-root/`). */
export function currentDir(rootDir: string): string {
  return path.join(rootDir, CURRENT_DIRNAME)
}

/** Absolute path of the loadable entry inside the single copy. */
export function currentEntryPath(rootDir: string, spec: RootPackageSpec): string {
  return rootEntryPath(currentDir(rootDir), spec)
}

/** A fresh, same-fs staging dir for an npm install (sibling of `current`). */
export function stagingDirPath(rootDir: string, target: string, pid: number, now: number): string {
  return path.join(rootDir, `.staging-${target}-${pid}-${now}`)
}

// ---------------------------------------------------------------------------
// Pending-root-swap marker (atomic, corruption-tolerant)
// ---------------------------------------------------------------------------

export interface PendingRootSwap {
  readonly schemaVersion: 1
  /** The staged version awaiting its atomic swap into `current` on next boot. */
  readonly version: string
  /** Absolute path of the validated `.staging-*` closure to swap in. */
  readonly stagingPath: string
  readonly requestedAtMs: number
}

export function pendingRootSwapPath(rootDir: string): string {
  return path.join(rootDir, PENDING_ROOT_SWAP_FILE)
}

function isPendingRootSwap(v: unknown): v is PendingRootSwap {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return (
    m['schemaVersion'] === 1 &&
    typeof m['version'] === 'string' &&
    typeof m['stagingPath'] === 'string' &&
    typeof m['requestedAtMs'] === 'number'
  )
}

/** Read + validate the pending-root-swap marker. Null when missing/corrupt. */
export function readPendingRootSwap(rootDir: string): PendingRootSwap | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pendingRootSwapPath(rootDir), 'utf-8'))
    return isPendingRootSwap(raw) ? raw : null
  } catch {
    return null
  }
}

/** Write the marker atomically (tmp sibling + rename). Creates rootDir. */
export function writePendingRootSwap(rootDir: string, marker: PendingRootSwap): void {
  fs.mkdirSync(rootDir, { recursive: true })
  const target = pendingRootSwapPath(rootDir)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}

/** Delete the marker if present (idempotent). */
export function clearPendingRootSwap(rootDir: string): void {
  try {
    fs.rmSync(pendingRootSwapPath(rootDir), { force: true })
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Native prebuild assertion
// ---------------------------------------------------------------------------

/**
 * Native packages whose prebuilt `.node` bindings MUST resolve from the single
 * copy — a runner that can't load them breaks decode / snapshot / the SQLite
 * store. The closure carries them as transitive deps of the root package.
 */
export const REQUIRED_NATIVE_PACKAGES: readonly string[] = ['better-sqlite3', 'sharp', 'node-av']

/**
 * Where each native package's `.node` binding lives inside `node_modules`. The
 * prebuild often sits in a platform-suffixed SIBLING scope (sharp → `@img/…`,
 * node-av → `@seydx/…`), so we search the package dir AND its scope root.
 */
const NATIVE_SEARCH_DIRS: Readonly<Record<string, readonly string[]>> = {
  'better-sqlite3': ['better-sqlite3'],
  sharp: ['sharp', '@img'],
  'node-av': ['node-av', '@seydx'],
}

/** Bounded recursive scan for ANY `*.node` file under `dir`. */
function hasDotNode(dir: string, maxDepth: number): boolean {
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

/**
 * Return the required native packages whose `.node` binding could NOT be found
 * under `<closureDir>/node_modules`. Empty ⇒ the closure carries every
 * required native prebuild. Used to ABORT a swap into a closure that would
 * brick the forked runners.
 */
export function findMissingNativePrebuilds(closureDir: string): string[] {
  const nm = path.join(closureDir, 'node_modules')
  const missing: string[] = []
  for (const pkg of REQUIRED_NATIVE_PACKAGES) {
    const searchDirs = NATIVE_SEARCH_DIRS[pkg] ?? [pkg]
    const found = searchDirs.some((rel) => hasDotNode(path.join(nm, ...rel.split('/')), 4))
    if (!found) missing.push(pkg)
  }
  return missing
}

// ---------------------------------------------------------------------------
// Closure-patch assertion (D478)
// ---------------------------------------------------------------------------

/**
 * Where `@camstack/server` ships the patches it applies from its own
 * `postinstall`, and the manifest that says which files carry which marker.
 * Written by `server/backend/scripts/copy-closure-patches.mjs` at build time.
 */
const CLOSURE_PATCH_PAYLOAD: readonly string[] = [
  'node_modules',
  '@camstack',
  'server',
  'dist',
  'closure-patches',
]
const CLOSURE_PATCH_MANIFEST = 'patch-reach.json'

interface ClosurePatchEntry {
  readonly patch?: unknown
  readonly package?: unknown
  readonly version?: unknown
  readonly reach?: unknown
  readonly markers?: unknown
}

/** Grep for `marker` in `file`, tolerating a large file without loading twice. */
function fileContains(file: string, marker: string): boolean {
  try {
    return fs.readFileSync(file, 'utf-8').includes(marker)
  } catch {
    return false
  }
}

/**
 * Return the `closure-postinstall` patches whose markers are NOT present in the
 * closure's installed packages. Empty ⇒ every patch this release claims to
 * apply in the closure actually landed.
 *
 * This is the FAIL-CLOSED half of D478, and the split is the point.
 * `@camstack/server`'s `postinstall` is best-effort — it cannot fail an install,
 * and an `ignore-scripts` npmrc, a hoisting surprise or a version that drifted
 * off the pinned one all make it exit 0 having done nothing. Before D478 that
 * exact silence WAS the production state for `werift`: three nodes ran an
 * unpatched copy for eight weeks while three code comments and an ADR asserted
 * the patch was in effect.
 *
 * So the closure is not trusted to be patched, it is CHECKED — here, in the
 * same place and the same shape as `findMissingNativePrebuilds`, against the
 * markers the NEW release ships rather than anything this (older) starter
 * knows. A closure that is not patched is not a valid closure, and an update
 * that cannot be patched is refused with the marker named rather than applied
 * quietly.
 *
 * A closure with no payload at all reports NOTHING missing: that is a release
 * from before this mechanism existed, and refusing to boot it would make an
 * older version unreachable — the opposite of a recovery path.
 */
export function findUnappliedClosurePatches(closureDir: string): string[] {
  const payloadDir = path.join(closureDir, ...CLOSURE_PATCH_PAYLOAD)
  let manifest: { readonly patches?: unknown }
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(payloadDir, CLOSURE_PATCH_MANIFEST), 'utf-8'),
    )
    if (typeof raw !== 'object' || raw === null) return []
    manifest = raw as { readonly patches?: unknown }
  } catch {
    // No payload (pre-D478 release) or unreadable — see the doc comment.
    return []
  }
  if (!Array.isArray(manifest.patches)) return []

  const nm = path.join(closureDir, 'node_modules')
  const missing: string[] = []
  for (const raw of manifest.patches as readonly ClosurePatchEntry[]) {
    if (raw.reach !== 'closure-postinstall') continue
    const pkg = raw.package
    const markers = raw.markers
    if (typeof pkg !== 'string' || typeof markers !== 'object' || markers === null) continue
    const pkgDir = path.join(nm, pkg)
    if (!fs.existsSync(pkgDir)) {
      // The closure does not carry the package at all. Not a failed patch —
      // nothing resolves it here, so there is nothing to be wrong.
      continue
    }
    for (const [rel, list] of Object.entries(markers as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const target = path.join(pkgDir, ...rel.split('/'))
      for (const marker of list as readonly unknown[]) {
        if (typeof marker !== 'string') continue
        if (!fileContains(target, marker)) {
          missing.push(`${pkg}/${rel}: ${marker}`)
        }
      }
    }
  }
  return missing
}

// ---------------------------------------------------------------------------
// Swap + migration
// ---------------------------------------------------------------------------

type LogFn = (message: string) => void

function rmrf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface ApplyRootSwapResult {
  readonly applied: boolean
  readonly version: string | null
  readonly reason: string
}

/**
 * Perform a staged root swap if a pending-root-swap marker is present. Runs in
 * the STARTER, BEFORE the closure is loaded, so nothing holds `current` open.
 *
 * Fail-CLOSED + crash-safe:
 *   1. Validate the staged closure (entry + version + native prebuilds). Any
 *      failure discards the staging dir + the marker and leaves `current`
 *      untouched (the operator's manual-recovery net) — never a partial swap.
 *   2. Swap: rename `current` aside to `.trash-*`, then rename `staging` →
 *      `current`. If the second rename fails, restore `current` from the trash.
 *      No N-1 retention — the trash is deleted immediately.
 *
 * Idempotent: a no-marker call is a no-op; a crash mid-swap self-heals on the
 * next boot (staging still present → retried; already-swapped → marker's
 * staging path is gone → the marker is discarded and the new `current` stands).
 */
export function applyPendingRootSwap(
  rootDir: string,
  spec: RootPackageSpec,
  nodeMajor: number,
  now: () => number,
  log: LogFn,
): ApplyRootSwapResult {
  const marker = readPendingRootSwap(rootDir)
  if (marker === null) return { applied: false, version: null, reason: 'no pending swap' }

  const staging = marker.stagingPath
  const dest = currentDir(rootDir)

  const invalid = validateClosureDir(staging, nodeMajor, spec, marker.version)
  if (invalid !== null) {
    // Staging gone but `current` is already the target ⇒ a prior swap
    // completed and only the marker survived a crash. Accept + clear.
    if (
      !fs.existsSync(staging) &&
      validateClosureDir(dest, nodeMajor, spec, marker.version) === null
    ) {
      clearPendingRootSwap(rootDir)
      log(`[single-copy] pending swap ${marker.version} already applied — cleared marker`)
      return { applied: true, version: marker.version, reason: 'already applied' }
    }
    log(`[single-copy] staged swap ${marker.version} invalid — discarding (${invalid})`)
    rmrf(staging)
    clearPendingRootSwap(rootDir)
    return { applied: false, version: null, reason: invalid }
  }

  const missing = findMissingNativePrebuilds(staging)
  if (missing.length > 0) {
    log(
      `[single-copy] staged swap ${marker.version} missing native prebuilds: ${missing.join(', ')} — discarding`,
    )
    rmrf(staging)
    clearPendingRootSwap(rootDir)
    return {
      applied: false,
      version: null,
      reason: `missing native prebuilds: ${missing.join(', ')}`,
    }
  }

  let trash: string | null = null
  try {
    if (fs.existsSync(dest)) {
      trash = path.join(rootDir, `.trash-${now()}-${process.pid}`)
      fs.renameSync(dest, trash)
    }
    try {
      fs.renameSync(staging, dest)
    } catch (err) {
      if (trash !== null && !fs.existsSync(dest)) {
        try {
          fs.renameSync(trash, dest)
        } catch {
          /* leave it for the confirm-boot sweep */
        }
      }
      throw err
    }
  } catch (err) {
    log(`[single-copy] swap of ${marker.version} FAILED — current preserved (${errMsg(err)})`)
    return { applied: false, version: null, reason: errMsg(err) }
  }

  if (trash !== null) rmrf(trash)
  clearPendingRootSwap(rootDir)
  log(`[single-copy] applied staged root swap → ${marker.version}`)
  return { applied: true, version: marker.version, reason: 'applied' }
}

export interface MigrateResult {
  readonly migrated: boolean
  readonly version: string | null
  readonly reason: string
}

/** Read a package.json `version` string from a closure dir, or null. */
function readClosureVersion(closureDir: string, spec: RootPackageSpec): string | null {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(rootPackageDir(closureDir, spec), 'package.json'), 'utf-8'),
    )
    if (typeof raw === 'object' && raw !== null) {
      const version = (raw as Record<string, unknown>)['version']
      if (typeof version === 'string') return version
    }
  } catch {
    /* unreadable — unknown */
  }
  return null
}

/**
 * True when `versions/<version>` is a fully loadable closure that ALSO carries
 * every required native prebuild — the bar an in-flight OLD-format pending
 * update must clear before it may be adopted as the single copy. A half-staged
 * pending (bad entry, or missing `sharp`/`node-av`/`better-sqlite3`) must never
 * be promoted, or it would brick the forked runners with no rollback net.
 */
function isAdoptablePendingClosure(
  rootDir: string,
  version: string,
  nodeMajor: number,
  spec: RootPackageSpec,
): boolean {
  const dir = versionDir(rootDir, version)
  return (
    validateClosureDir(dir, nodeMajor, spec, version) === null &&
    findMissingNativePrebuilds(dir).length === 0
  )
}

/**
 * One-time migration from the legacy multi-copy layout to the single copy.
 * Idempotent + safe to run on every boot: when a valid `current` already
 * exists it is a no-op (unless superseded by an in-flight pending — below).
 *
 * On a hub that predates the collapse, `current` is absent but
 * `versions/<active>` exists (recorded by the legacy `state.json`, or
 * discoverable by scanning `versions/`). Migration ADOPTS a legacy version's
 * closure as the single copy (`versions/<X>` → `current`), then removes the
 * legacy `versions/` tree, the legacy `state.json`, and the legacy
 * `/data/framework` swap markers — leaving non-framework addons in
 * `/data/addons` untouched. When no valid legacy closure exists (fresh
 * install) it is a no-op and the caller boots the baked seed.
 *
 * IN-FLIGHT PENDING (#17). A PRE-collapse `root-update-service` staged an
 * update as `versions/<pendingBoot.version>` + `state.json.pendingBoot` but
 * restarted before promoting it (the OLD mechanism had no single copy to swap
 * into). The AGENTS still run that mechanism, so the collapse migration MUST
 * recognise an in-flight pending: an adoptable `versions/<pendingBoot.version>`
 * (valid closure WITH native prebuilds) is preferred over the recorded active
 * version, and it even supersedes an already-present but STRICTLY OLDER
 * `current` (the edge where a seed placed an older copy beside the staged
 * pending). Without this the update strands on the old version — the live-hub
 * "stuck on current, promote manually" symptom the agents would otherwise hit
 * on rollout. Idempotent: once adopted, `state.json`/`versions/` are gone and
 * the next boot is a plain no-op.
 */
export function migrateToSingleCopy(
  rootDir: string,
  spec: RootPackageSpec,
  nodeMajor: number,
  now: () => number,
  log: LogFn,
): MigrateResult {
  const dest = currentDir(rootDir)
  const legacyState = readServerRootState(rootDir)

  // An in-flight OLD-format pending update must win over the recorded active
  // version (and over a strictly-older existing `current`).
  const pendingVersion = legacyState?.pendingBoot?.version ?? null
  const pendingAdoptable =
    pendingVersion !== null && isAdoptablePendingClosure(rootDir, pendingVersion, nodeMajor, spec)

  const currentValid = fs.existsSync(dest) && validateClosureDir(dest, nodeMajor, spec) === null
  if (currentValid) {
    // A valid `current` stands UNLESS an adoptable pending update is strictly
    // newer than it. Steady state (no pending, or pending ≤ current) is a no-op.
    const currentVersion = readClosureVersion(dest, spec)
    const pendingSupersedes =
      pendingAdoptable &&
      pendingVersion !== null &&
      (currentVersion === null || compareSemver(pendingVersion, currentVersion) > 0)
    if (!pendingSupersedes) {
      return { migrated: false, version: null, reason: 'current already present' }
    }
    log(
      `[single-copy] in-flight pending ${pendingVersion} supersedes older current ${currentVersion ?? '?'}`,
    )
  }

  // Candidate legacy versions in PRIORITY order:
  //   1. an adoptable in-flight pending update (must win — see #17 above),
  //   2. what state.json recorded as active, then N-1,
  //   3. whatever else is on disk under versions/ (state missing/corrupt).
  const candidates: string[] = []
  if (pendingAdoptable && pendingVersion !== null) candidates.push(pendingVersion)
  if (legacyState !== null) {
    for (const v of [
      legacyState.currentVersion,
      legacyState.pendingBoot?.version ?? null,
      legacyState.previousVersion,
    ]) {
      if (typeof v === 'string' && !candidates.includes(v)) candidates.push(v)
    }
  }
  try {
    for (const entry of fs.readdirSync(versionsDir(rootDir))) {
      if (!entry.startsWith('.') && !candidates.includes(entry)) candidates.push(entry)
    }
  } catch {
    /* no versions dir */
  }

  const source = candidates.find(
    (v) => validateClosureDir(versionDir(rootDir, v), nodeMajor, spec, v) === null,
  )
  if (source === undefined) {
    return { migrated: false, version: null, reason: 'no valid legacy versions/<X> to adopt' }
  }

  // An invalid leftover `current` (partial migration) must not block the rename.
  if (fs.existsSync(dest)) {
    const aside = path.join(rootDir, `.trash-${now()}-${process.pid}-stale-current`)
    try {
      fs.renameSync(dest, aside)
    } catch {
      rmrf(dest)
    }
  }

  try {
    fs.renameSync(versionDir(rootDir, source), dest)
  } catch (err) {
    log(`[single-copy] migration rename of versions/${source} failed (${errMsg(err)})`)
    return { migrated: false, version: null, reason: errMsg(err) }
  }

  // Retire the legacy machinery (best-effort — none of these can brick boot).
  rmrf(versionsDir(rootDir))
  rmrf(stateFilePath(rootDir))
  const dataDir = path.dirname(rootDir)
  for (const marker of LEGACY_FRAMEWORK_MARKERS) rmrf(path.join(dataDir, marker))
  log(`[single-copy] migrated legacy versions/${source} → current`)
  return { migrated: true, version: source, reason: 'adopted legacy version' }
}

/**
 * Best-effort sweep of orphaned transient dirs (`.staging-*` / `.trash-*`)
 * older than `staleMs`. Called post-boot once the node is confirmed healthy —
 * a concurrent `applyServerUpdate` may be mid-install into a FRESH `.staging-*`
 * dir, so only dirs whose mtime is older than the window are collected.
 */
export function sweepTransientRootDirs(rootDir: string, now: number, staleMs: number): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(rootDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith('.staging-') && !entry.startsWith('.trash-')) continue
    const full = path.join(rootDir, entry)
    try {
      if (now - fs.statSync(full).mtimeMs < staleMs) continue
    } catch {
      continue
    }
    rmrf(full)
  }
}
