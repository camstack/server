/**
 * Data-dir server-root layout + state file — ZERO-DEP (node:fs/node:path only).
 *
 * Loaded by each node's baked STARTER before any node_modules resolution is
 * trusted, so this module must never import from `@camstack/*` (runtime) or
 * any npm package. The hub's `ServerUpdateService` and the agent's update
 * service consume the same module — one source of truth for the layout and
 * the state shape. The layout is IDENTICAL on both node types (the dir is
 * named `server-root/` everywhere); only the root package name + entry differ
 * and arrive via {@link RootPackageSpec}.
 *
 * Layout (`<dataDir>/server-root/`):
 *   versions/<semver>/              npm-installed closure for one version
 *     node_modules/<pkg>/<entry>    ← the loadable entry (spec-defined)
 *   state.json                      pointer file (ServerRootState, atomic)
 *
 * A POINTER FILE (state.json) is used instead of `current`/`previous`
 * symlinks: atomic via tmp+rename, works on every fs, and carries the
 * probation/rollback bookkeeping in the same durable record.
 *
 * Spec: docs/superpowers/specs/2026-07-12-runtime-updatable-node-packages-design.md
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RootPackageSpec } from './root-package-spec.js'

export const SERVER_ROOT_DIRNAME = 'server-root'
export const SERVER_ROOT_STATE_FILE = 'state.json'
/**
 * Restart-intent marker filename. Written by the update service moments before
 * a graceful self-restart (apply/rollback), then read + consumed by an
 * external process supervisor so it can tell an INTENTIONAL restart-for-update
 * apart from a crash — a crash-backoff policy must never penalise an update
 * restart. Lives in the server-root dir next to `state.json`.
 *
 * (Phase 3 — the Electron shell supervisor reads it; the docker restart policy
 * relaunches unconditionally so the marker is a harmless no-op there.)
 */
export const RESTART_INTENT_FILE = '.restart-intent'

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface ServerRootPendingBoot {
  /** The freshly-staged version awaiting its probation boot. */
  readonly version: string
  /** The version that was current when the update was requested (null = baked). */
  readonly fromVersion: string | null
  readonly requestedAtMs: number
  /** 0 = not yet booted; >=1 = a probation boot started and never confirmed. */
  readonly bootAttempts: number
}

export interface ServerRootRollbackInfo {
  readonly fromVersion: string
  /** null = rolled back all the way to the baked seed. */
  readonly toVersion: string | null
  readonly atMs: number
  readonly reason: string
}

export interface ServerRootState {
  readonly schemaVersion: 1
  /** The confirmed-healthy active version (null = boot from the baked seed). */
  readonly currentVersion: string | null
  /** N-1 kept for rollback (its versions/ dir is retained). */
  readonly previousVersion: string | null
  readonly pendingBoot: ServerRootPendingBoot | null
  /** Set when the most recent update attempt was rolled back. */
  readonly rolledBack: ServerRootRollbackInfo | null
}

export function emptyServerRootState(): ServerRootState {
  return {
    schemaVersion: 1,
    currentVersion: null,
    previousVersion: null,
    pendingBoot: null,
    rolledBack: null,
  }
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function serverRootDir(dataDir: string): string {
  return path.join(dataDir, SERVER_ROOT_DIRNAME)
}

export function versionsDir(rootDir: string): string {
  return path.join(rootDir, 'versions')
}

export function versionDir(rootDir: string, version: string): string {
  return path.join(versionsDir(rootDir), version)
}

/** `versions/<v>/node_modules/<packageName>` — the installed root package dir. */
export function rootPackageDir(versionDirPath: string, spec: RootPackageSpec): string {
  return path.join(versionDirPath, 'node_modules', ...spec.packageName.split('/'))
}

/** The loadable entry inside the installed root package dir. */
export function rootEntryPath(versionDirPath: string, spec: RootPackageSpec): string {
  return path.join(rootPackageDir(versionDirPath, spec), ...spec.entryRelPath)
}

export function stateFilePath(rootDir: string): string {
  return path.join(rootDir, SERVER_ROOT_STATE_FILE)
}

// ---------------------------------------------------------------------------
// State IO (atomic, corruption-tolerant)
// ---------------------------------------------------------------------------

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

function isPendingBoot(v: unknown): v is ServerRootPendingBoot {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p['version'] === 'string' &&
    isNullableString(p['fromVersion']) &&
    typeof p['requestedAtMs'] === 'number' &&
    typeof p['bootAttempts'] === 'number'
  )
}

function isRollbackInfo(v: unknown): v is ServerRootRollbackInfo {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r['fromVersion'] === 'string' &&
    isNullableString(r['toVersion']) &&
    typeof r['atMs'] === 'number' &&
    typeof r['reason'] === 'string'
  )
}

export function isServerRootState(v: unknown): v is ServerRootState {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  if (s['schemaVersion'] !== 1) return false
  if (!isNullableString(s['currentVersion'])) return false
  if (!isNullableString(s['previousVersion'])) return false
  if (s['pendingBoot'] !== null && !isPendingBoot(s['pendingBoot'])) return false
  if (s['rolledBack'] !== null && !isRollbackInfo(s['rolledBack'])) return false
  return true
}

/** Read + validate the state file. Returns null when missing/corrupt/mismatched. */
export function readServerRootState(rootDir: string): ServerRootState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(stateFilePath(rootDir), 'utf-8'))
    return isServerRootState(raw) ? raw : null
  } catch {
    return null
  }
}

/** Write the state file atomically (tmp sibling + rename). Creates rootDir. */
export function writeServerRootState(rootDir: string, state: ServerRootState): void {
  fs.mkdirSync(rootDir, { recursive: true })
  const target = stateFilePath(rootDir)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}

// ---------------------------------------------------------------------------
// Restart-intent marker (supervisor: update-restart vs crash discrimination)
// ---------------------------------------------------------------------------

/**
 * Payload of the restart-intent marker. `requestedAtMs` lets a reader ignore a
 * STALE marker (e.g. one left behind by a hard kill between write and
 * relaunch) via a freshness window instead of mis-classifying a much-later
 * crash as an update restart. `reason` carries the human `requestedBy` string.
 */
export interface RestartIntentMarker {
  readonly requestedAtMs: number
  readonly reason: string
}

export function restartIntentMarkerPath(rootDir: string): string {
  return path.join(rootDir, RESTART_INTENT_FILE)
}

function isRestartIntentMarker(v: unknown): v is RestartIntentMarker {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return typeof m['requestedAtMs'] === 'number' && typeof m['reason'] === 'string'
}

/** Write the marker atomically (tmp sibling + rename). Creates rootDir. */
export function writeRestartIntentMarker(rootDir: string, marker: RestartIntentMarker): void {
  fs.mkdirSync(rootDir, { recursive: true })
  const target = restartIntentMarkerPath(rootDir)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2), 'utf-8')
  fs.renameSync(tmp, target)
}

/** Read + validate the marker. Returns null when missing/corrupt. */
export function readRestartIntentMarker(rootDir: string): RestartIntentMarker | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(restartIntentMarkerPath(rootDir), 'utf-8'))
    return isRestartIntentMarker(raw) ? raw : null
  } catch {
    return null
  }
}

/** Delete the marker if present (idempotent — a missing file is not an error). */
export function clearRestartIntentMarker(rootDir: string): void {
  try {
    fs.rmSync(restartIntentMarkerPath(rootDir), { force: true })
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Version-dir validation
// ---------------------------------------------------------------------------

/**
 * Extract the minimum required Node major from an `engines.node` range like
 * `>=22`, `>= 22.12`, `^24.0.0`, `22.x`. Returns null when unparseable
 * (validation is then permissive — a bogus range must not brick boot).
 */
export function minNodeMajorOf(enginesNode: string): number | null {
  const match = /(\d+)/.exec(enginesNode)
  if (match === null) return null
  const major = Number.parseInt(match[1] ?? '', 10)
  return Number.isNaN(major) ? null : major
}

/**
 * Validate that `closureDir` holds a loadable root-package closure for `spec`
 * (its installed package lives at `closureDir/node_modules/<packageName>`).
 * Returns null when valid, else a human-readable reason. Checks:
 *   1. the entry file exists,
 *   2. the package.json parses with the right `name` (and `version` when
 *      `expectedVersion` is given),
 *   3. `engines.node` (when parseable) is satisfied by the running runtime —
 *      the starter refuses a native-ABI mismatch with a clear error instead
 *      of segfaulting (design risk: node bump vs native prebuilds).
 *
 * Shared by the single-copy `current/` model (`expectedVersion` omitted — the
 * version is whatever the closure carries) and the legacy `versions/<v>/`
 * model (`expectedVersion` set — the dir name must match the package.json).
 */
export function validateClosureDir(
  closureDir: string,
  nodeMajor: number,
  spec: RootPackageSpec,
  expectedVersion?: string,
): string | null {
  const entry = rootEntryPath(closureDir, spec)
  if (!fs.existsSync(entry)) {
    return `root entry missing: ${entry}`
  }

  const pkgJsonPath = path.join(rootPackageDir(closureDir, spec), 'package.json')
  let pkg: Record<string, unknown>
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return `package.json malformed: ${pkgJsonPath}`
    }
    pkg = raw as Record<string, unknown>
  } catch {
    return `package.json unreadable: ${pkgJsonPath}`
  }

  if (pkg['name'] !== spec.packageName) {
    return `package name mismatch: expected ${spec.packageName}, got ${String(pkg['name'])}`
  }
  if (expectedVersion !== undefined && pkg['version'] !== expectedVersion) {
    return `package version mismatch: expected ${expectedVersion}, package.json says ${String(pkg['version'])}`
  }

  const engines = pkg['engines']
  if (typeof engines === 'object' && engines !== null) {
    const enginesNode = (engines as Record<string, unknown>)['node']
    if (typeof enginesNode === 'string') {
      const minMajor = minNodeMajorOf(enginesNode)
      if (minMajor !== null && nodeMajor < minMajor) {
        return `engines.node "${enginesNode}" requires Node >= ${minMajor}, runtime is ${nodeMajor}`
      }
    }
  }

  return null
}

/**
 * Validate that `versions/<version>` holds a loadable root-package closure for
 * `spec` (legacy multi-copy model — the dir name must match the package
 * version). Thin wrapper over {@link validateClosureDir}. Returns null when
 * valid, else a human-readable reason.
 */
export function validateVersionDir(
  rootDir: string,
  version: string,
  nodeMajor: number,
  spec: RootPackageSpec,
): string | null {
  return validateClosureDir(versionDir(rootDir, version), nodeMajor, spec, version)
}
