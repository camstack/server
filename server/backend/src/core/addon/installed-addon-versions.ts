/**
 * `package name -> version` of every addon package installed under an addons
 * dir (D988) — the input to "which addons does the staged server want updated
 * with it". Read from the package.json on disk, scoped (`@camstack/<name>`) or
 * flat (`<name>`); a package whose version cannot be read is `null`, never
 * absent and never `'0.0.0'`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

function versionOf(packageJsonPath: string): { name: string; version: string | null } | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    if (typeof raw !== 'object' || raw === null) return null
    const name = (raw as { name?: unknown }).name
    const version = (raw as { version?: unknown }).version
    if (typeof name !== 'string') return null
    return { name, version: typeof version === 'string' && version.length > 0 ? version : null }
  } catch {
    return null
  }
}

export function readInstalledAddonVersions(
  addonsDir: string,
): Readonly<Record<string, string | null>> {
  const found: Record<string, string | null> = {}
  const scan = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const pkg = versionOf(path.join(dir, entry.name, 'package.json'))
      if (pkg !== null && pkg.name.startsWith('@camstack/')) found[pkg.name] = pkg.version
    }
  }
  scan(addonsDir)
  scan(path.join(addonsDir, '@camstack'))
  return found
}
