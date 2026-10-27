/**
 * The workspace packages the documentation scripts walk: every directory under
 * `packages/` and `server/` that holds a `package.json`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface WorkspacePackage {
  /** Repo-relative directory, forward slashes (`packages/addon-ai`). */
  readonly dir: string
  readonly name: string
  readonly version: string
  readonly isPrivate: boolean
  readonly description: string
  readonly manifest: Readonly<Record<string, unknown>>
}

const ROOTS = ['packages', 'server'] as const

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function readWorkspacePackages(root: string): readonly WorkspacePackage[] {
  const found: WorkspacePackage[] = []
  for (const base of ROOTS) {
    const baseDir = path.join(root, base)
    if (!fs.existsSync(baseDir)) continue
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkgPath = path.join(baseDir, entry.name, 'package.json')
      if (!fs.existsSync(pkgPath)) continue
      const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const manifest = asRecord(parsed)
      found.push({
        dir: `${base}/${entry.name}`,
        name: str(manifest['name']) || entry.name,
        version: str(manifest['version']),
        isPrivate: manifest['private'] === true,
        description: str(manifest['description']),
        manifest,
      })
    }
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir))
}

/** Packages that reach npm: not private. */
export function publishedPackages(root: string): readonly WorkspacePackage[] {
  return readWorkspacePackages(root).filter((pkg) => !pkg.isPrivate)
}

/** Resolve `addon-ai`, `@camstack/addon-ai`, `camstack`, or a directory. */
export function resolvePackage(
  packages: readonly WorkspacePackage[],
  query: string,
): WorkspacePackage | null {
  const wanted = query.replace(/\/+$/, '')
  return (
    packages.find(
      (pkg) =>
        pkg.name === wanted ||
        pkg.dir === wanted ||
        pkg.dir.endsWith(`/${wanted}`) ||
        pkg.name === `@camstack/${wanted}`,
    ) ?? null
  )
}
