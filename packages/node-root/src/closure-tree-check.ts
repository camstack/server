/**
 * A seeded `node_modules` can keep the previous release's transitive
 * packages. The root package version matching the target is not enough:
 * `npm ls --omit=dev --all` must exit clean, and the lockfile's root
 * dependency plus `node_modules/<package>` must both name the target.
 * A package that is on disk at a different version than the lockfile is
 * the stale transitive a seed copy leaves behind.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { NpmExecFn } from './root-update-service.js'

const NPM_LS_TIMEOUT_MS = 60_000

/** A seeded tree that `npm ls` could not prove. Not an install timeout. */
export const VALIDATION_FAILED_KIND = 'validation-failed' as const

export class ClosureValidationError extends Error {
  readonly kind: typeof VALIDATION_FAILED_KIND = VALIDATION_FAILED_KIND

  constructor(message: string) {
    super(message)
    this.name = 'ClosureValidationError'
  }
}

const NPM_LS_ARGS: readonly string[] = ['ls', '--omit=dev', '--all']

/** npm ls names a broken edge with one of these words. */
const LS_PROBLEM_RE = /\b(?:invalid|missing|extraneous)\b/i

interface LockPackageEntry {
  readonly version: string | null
  readonly dependencies: Readonly<Record<string, string>> | null
}

type LockPackageMap = Readonly<Record<string, LockPackageEntry>>

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readDependencies(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null
  const deps: { [key: string]: string } = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') deps[key] = raw
  }
  return deps
}

function readLockEntry(value: unknown): LockPackageEntry | null {
  if (!isRecord(value)) return null
  const version = value['version']
  return {
    version: typeof version === 'string' ? version : null,
    dependencies: readDependencies(value['dependencies']),
  }
}

function lockfilePath(stagingDir: string): string | null {
  for (const name of ['npm-shrinkwrap.json', 'package-lock.json']) {
    const full = path.join(stagingDir, name)
    if (fs.existsSync(full)) return full
  }
  return null
}

function readLockPackages(stagingDir: string): LockPackageMap | null {
  const file = lockfilePath(stagingDir)
  if (file === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!isRecord(raw) || !isRecord(raw['packages'])) return null
  const map: { [key: string]: LockPackageEntry } = {}
  for (const [key, value] of Object.entries(raw['packages'])) {
    const entry = readLockEntry(value)
    if (entry !== null) map[key] = entry
  }
  return map
}

function readInstalledVersion(pkgJsonPath: string): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    if (!isRecord(raw)) return null
    const version = raw['version']
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

function targetRecordMismatch(
  stagingDir: string,
  packages: LockPackageMap,
  packageName: string,
  target: string,
): string | null {
  const rootDep = packages['']?.dependencies?.[packageName] ?? null
  if (rootDep !== target) {
    return `lockfile packages[""] dependency ${packageName} is ${rootDep ?? 'absent'}, target is ${target}`
  }
  const lockedKey = `node_modules/${packageName}`
  const locked = packages[lockedKey]?.version ?? null
  if (locked !== target) {
    return `lockfile ${lockedKey} version is ${locked ?? 'absent'}, target is ${target}`
  }
  const installed = readInstalledVersion(
    path.join(stagingDir, 'node_modules', ...packageName.split('/'), 'package.json'),
  )
  if (installed !== target) {
    return `installed ${packageName} version is ${installed ?? 'absent'}, target is ${target}`
  }
  return null
}

/**
 * A lockfile entry whose package.json is present at a different version.
 * Absent entries are left to `npm ls` — an optional package for another
 * platform is not a stale copy.
 */
function staleLockedPackage(stagingDir: string, packages: LockPackageMap): string | null {
  for (const [key, entry] of Object.entries(packages)) {
    if (key.length === 0 || entry.version === null) continue
    const pkgJson = path.join(stagingDir, key, 'package.json')
    if (!fs.existsSync(pkgJson)) continue
    const installed = readInstalledVersion(pkgJson)
    if (installed !== entry.version) {
      return `stale ${key}: installed ${installed ?? 'unreadable'}, lockfile ${entry.version}`
    }
  }
  return null
}

export function closureLockMismatch(
  stagingDir: string,
  packageName: string,
  target: string,
): string | null {
  const packages = readLockPackages(stagingDir)
  if (packages === null) return `lockfile missing or has no packages map in ${stagingDir}`
  return (
    targetRecordMismatch(stagingDir, packages, packageName, target) ??
    staleLockedPackage(stagingDir, packages)
  )
}

/**
 * Throw when the staged tree is not the target closure. `npm ls` exiting
 * non-zero throws on its own (the exec rejects); a zero exit that still
 * prints invalid, missing or extraneous is the same failure.
 */
function validationFailed(message: string): ClosureValidationError {
  return new ClosureValidationError(message)
}

export async function assertInstalledClosureTree(
  stagingDir: string,
  packageName: string,
  target: string,
  execNpm: NpmExecFn,
): Promise<void> {
  let listed: { readonly stdout: string }
  try {
    listed = await execNpm(NPM_LS_ARGS, { cwd: stagingDir, timeoutMs: NPM_LS_TIMEOUT_MS })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw validationFailed(`npm ls failed in ${stagingDir}: ${message}`)
  }
  if (LS_PROBLEM_RE.test(listed.stdout)) {
    throw validationFailed(`npm ls reported a broken tree in ${stagingDir}`)
  }
  const mismatch = closureLockMismatch(stagingDir, packageName, target)
  if (mismatch !== null) throw validationFailed(mismatch)
}
