import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Detect whether we're running inside the monorepo workspace.
 * Returns the absolute path to the packages/ directory if found, otherwise null.
 *
 * Single source of truth — replaces identical implementations in:
 * - first-boot-installer.ts
 * - addon-bridge.service.ts
 */
export function detectWorkspacePackagesDir(startDir: string): string | null {
  let current = path.resolve(startDir)
  for (let i = 0; i < 6; i++) {
    current = path.dirname(current)
    const packagesDir = path.join(current, 'packages')
    const rootPkgJson = path.join(current, 'package.json')
    if (fs.existsSync(packagesDir) && fs.existsSync(rootPkgJson)) {
      try {
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgJson, 'utf-8')) as Record<string, unknown>
        if (
          rootPkg.workspaces ||
          rootPkg.name === 'camstack-server' ||
          rootPkg.name === 'camstack'
        ) {
          return packagesDir
        }
      } catch {
        // Ignore parse errors
      }
    }
  }
  return null
}
