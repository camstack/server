/**
 * D4 — pure detector: scan addon package.json manifests for behavioural
 * capability metadata (`kind`, `defaultActive`, `mode`) that must live ONLY
 * on the `.cap.ts` definition. Imported by the codegen guard and its test.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** One manifest cap entry that illegally carries behavioural metadata. */
export interface ManifestDriftEntry {
  readonly file: string
  readonly addonId: string
  readonly capName: string
  readonly offendingKeys: readonly string[]
}

/**
 * Return every `packages/<name>/package.json` under `repoRoot` that exists.
 * Flat one-level scan of `packages/` only — deliberate (does not recurse
 * into nested workspaces).
 */
export function findAddonPackageJsonFiles(repoRoot: string): string[] {
  const pkgDir = path.join(repoRoot, 'packages')
  const files: string[] = []
  for (const entry of fs.readdirSync(pkgDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const p = path.join(pkgDir, entry.name, 'package.json')
    if (fs.existsSync(p)) files.push(p)
  }
  return files
}

/** Keys that must never appear on a manifest capability entry. */
const BEHAVIOURAL_KEYS = ['kind', 'defaultActive', 'mode'] as const

/**
 * Inspect each `package.json` path; return one entry per manifest cap
 * declaration that still carries `kind`, `defaultActive`, or `mode`.
 */
export function findManifestMetadataDrift(
  packageJsonPaths: readonly string[],
): ManifestDriftEntry[] {
  const drift: ManifestDriftEntry[] = []

  for (const file of packageJsonPaths) {
    let pkg: unknown
    try {
      pkg = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      continue
    }

    const addons = (pkg as { camstack?: { addons?: unknown } })?.camstack?.addons
    if (!Array.isArray(addons)) continue

    for (const addon of addons) {
      const caps = (addon as { capabilities?: unknown })?.capabilities
      if (!Array.isArray(caps)) continue
      const addonId =
        typeof (addon as { id?: unknown })?.id === 'string'
          ? (addon as { id: string }).id
          : '(unknown)'

      for (const cap of caps) {
        if (cap === null || typeof cap !== 'object') continue
        const offendingKeys = BEHAVIOURAL_KEYS.filter((k) => k in (cap as Record<string, unknown>))
        if (offendingKeys.length === 0) continue
        const capName =
          typeof (cap as { name?: unknown }).name === 'string'
            ? (cap as { name: string }).name
            : '(unknown)'
        drift.push({ file, addonId, capName, offendingKeys })
      }
    }
  }

  return drift
}
