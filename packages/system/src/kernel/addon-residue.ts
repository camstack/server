/**
 * Residue quarantine for the ONE addon root.
 *
 * ── The bug class this closes ──────────────────────────────────────────────
 * `<dataDir>/addons/@camstack/<pkg>` is the only directory a node loads addons
 * from. Renaming a package inside it does NOT archive it — the directory name
 * is decoration, and three independent consumers key on the `package.json`
 * they find inside:
 *
 *   - `AddonLoader.loadFromDirectory` walks `@scope/*` and loads anything with
 *     a `package.json`; its skip list is keyed on the PACKAGE name, so
 *     `@camstack/system.bak-pre-unshadow` was never skipped;
 *   - the agent's `resolveAddonPackageDirs` scans on the same rule;
 *   - `AddonManifest.reconcileFromDisk` does `onDisk.set(pkgJson.name, …)`,
 *     so the backup's version becomes the version the manifest — and every
 *     surface reading it — REPORTS.
 *
 * Measured 2026-08-07/08 on the live cluster:
 *
 *   agent-a  `@camstack/system.bak-pre-unshadow` — no package.json left,
 *                  so not loadable, but the agent main process held five live
 *                  mappings of `better_sqlite3.node` out of it (D87).
 *   macmini        `@camstack/system.bak-pre-1272-1786129145` — still declares
 *                  `@camstack/system@1.2.3` (17 days old, 97 MB). The data root
 *                  has NO `addons/@camstack/system` directory at all, yet the
 *                  manifest reports `@camstack/system 1.2.3` — read straight
 *                  out of the backup. The live process still had the backup's
 *                  `better_sqlite3.node` mapped `txt` against a 1.2.61 closure.
 *
 * ── Why quarantine and not delete ─────────────────────────────────────────
 * The same evening, a cleanup that DELETED what it judged to be a shadow copy
 * removed the only builtins an agent had and gutted the node. So this never
 * deletes: it renames out of the scanned root into `.quarantine/`, logs every
 * move by name, reason and both paths, and leaves the bytes recoverable. A
 * silent sweep reads as "nothing was here", which is the failure mode that
 * made the original one unobservable.
 *
 * `.quarantine` sits beside `.staging` / `.backups` / `.evicting` under the
 * addon root: dot-prefixed, carrying no `package.json` at its top level, so no
 * scanner descends into it.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Where residue is moved to, relative to the addon root. */
export const QUARANTINE_DIRNAME = '.quarantine'

export type ResidueReason =
  /** The directory name carries a backup marker — `.bak…`, `.old…`, `.orig…`. */
  | 'backup-residue'
  /** The directory declares a package whose name is not this directory. */
  | 'name-mismatch'

export interface AddonDirCandidate {
  /** Directory basename under the addon root (or under its `@scope`). */
  readonly dirName: string
  /** `name` from the directory's `package.json`; null when absent/unreadable. */
  readonly declaredName: string | null
}

export interface ResidueVerdict extends AddonDirCandidate {
  readonly reason: ResidueReason
}

/**
 * A backup marker: a `.bak` / `.old` / `.orig` segment, not merely those
 * letters. `.backups` — the installer's own rollback store — must NOT match,
 * and it is also excluded by the dot rule below; the pattern stays tight
 * anyway so the two guards are independent.
 */
const BACKUP_MARKER = /\.(bak|old|orig)(?![a-z])/i

/** Installer-owned stores and node's own tree. Never candidates. */
function isReservedDir(dirName: string): boolean {
  return dirName.startsWith('.') || dirName === 'node_modules'
}

/** `@camstack/system` → `system`; `foo` → `foo`. */
function packageDirName(declaredName: string): string {
  const slash = declaredName.lastIndexOf('/')
  return slash === -1 ? declaredName : declaredName.slice(slash + 1)
}

/**
 * Is this directory residue? Returns the verdict, or null to keep it.
 *
 * A directory with no `package.json` is NOT residue on that ground alone —
 * `models/`, a half-finished copy, a scratch dir are all absence, not a
 * rename. Only a backup marker condemns one.
 */
export function classifyAddonDir(candidate: AddonDirCandidate): ResidueVerdict | null {
  const { dirName, declaredName } = candidate
  if (isReservedDir(dirName)) return null
  if (BACKUP_MARKER.test(dirName)) return { dirName, declaredName, reason: 'backup-residue' }
  if (declaredName !== null && packageDirName(declaredName) !== dirName) {
    return { dirName, declaredName, reason: 'name-mismatch' }
  }
  return null
}

export function selectAddonResidue(
  candidates: readonly AddonDirCandidate[],
): readonly ResidueVerdict[] {
  const out: ResidueVerdict[] = []
  for (const candidate of candidates) {
    const verdict = classifyAddonDir(candidate)
    if (verdict !== null) out.push(verdict)
  }
  return out
}

export interface QuarantinedEntry extends ResidueVerdict {
  /** Absolute path the residue occupied under the addon root. */
  readonly from: string
  /** Absolute path it now occupies under `.quarantine/`. */
  readonly to: string
}

export interface ResidueQuarantineFailure extends ResidueVerdict {
  readonly from: string
  readonly error: string
}

export interface ResidueQuarantineResult {
  readonly quarantined: readonly QuarantinedEntry[]
  /** Residue that could not be moved. Reported, never fatal. */
  readonly failed: readonly ResidueQuarantineFailure[]
}

function readDeclaredName(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const name = (parsed as { name?: unknown }).name
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

function readDeclaredVersion(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

function isDirLike(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** `<scope>__<dir>`, suffixed until free — two sweeps must not overwrite. */
function freeQuarantineTarget(store: string, scope: string | null, dirName: string): string {
  const base = scope === null ? dirName : `${scope.replace('@', '')}__${dirName}`
  let candidate = path.join(store, base)
  let n = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(store, `${base}-${n}`)
    n += 1
  }
  return candidate
}

/**
 * Move every residue directory under `addonsDir` into `addonsDir/.quarantine`.
 *
 * Runs at boot, BEFORE anything scans the root or seeds into it — a residue
 * that is still present when the loader walks has already been installed.
 * Never throws, never deletes; a move that fails is reported and left in
 * place, which is strictly better than a half-moved package.
 */
export function quarantineAddonResidue(
  addonsDir: string,
  log: (message: string) => void,
): ResidueQuarantineResult {
  const quarantined: QuarantinedEntry[] = []
  const failed: ResidueQuarantineFailure[] = []
  if (!fs.existsSync(addonsDir)) return { quarantined, failed }

  const store = path.join(addonsDir, QUARANTINE_DIRNAME)

  const scan = (parent: string, scope: string | null): void => {
    let names: string[]
    try {
      names = fs.readdirSync(parent)
    } catch {
      return
    }
    for (const dirName of names) {
      const full = path.join(parent, dirName)
      if (!isDirLike(full)) continue
      if (scope === null && dirName.startsWith('@')) {
        scan(full, dirName)
        continue
      }
      const verdict = classifyAddonDir({ dirName, declaredName: readDeclaredName(full) })
      if (verdict === null) continue

      const version = readDeclaredVersion(full)
      const to = freeQuarantineTarget(store, scope, dirName)
      try {
        fs.mkdirSync(store, { recursive: true })
        fs.renameSync(full, to)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        failed.push({ ...verdict, from: full, error })
        log(
          `[addons] residue quarantine FAILED for ${full} (${verdict.reason}) — ${error}. ` +
            'It stays on the addon root and will be loaded, scanned and reported as an install.',
        )
        continue
      }
      quarantined.push({ ...verdict, from: full, to })
      log(
        `[addons] quarantined ${verdict.reason} ${full} → ${to} ` +
          `(declares ${verdict.declaredName ?? 'no package name'}` +
          `${version === null ? '' : `@${version}`}). ` +
          'A renamed package dir is INSTALLED, not archived — nothing was deleted.',
      )
    }
  }

  scan(addonsDir, null)
  return { quarantined, failed }
}
