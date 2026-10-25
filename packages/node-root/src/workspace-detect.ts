/**
 * Workspace-checkout detection for the starter — ZERO-DEP.
 *
 * The starter must defer to plain resolution in a dev checkout (`npm run
 * dev:full` / `npm start` from the monorepo): the data-dir server root is a
 * production mechanism and must never shadow freshly-built workspace code.
 * Detection = any ancestor package.json declaring `workspaces` (the monorepo
 * root has one; the baked image run-dir's `npm init -y` package.json and the
 * data-dir version closures never do).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Walk up from `fromDir` looking for a package.json with a `workspaces`
 * field. Returns the directory containing it, or null when none exists.
 */
export function detectWorkspaceRoot(fromDir: string): string | null {
  let dir = path.resolve(fromDir)
  for (;;) {
    const pkgPath = path.join(dir, 'package.json')
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      if (
        typeof raw === 'object' &&
        raw !== null &&
        (raw as Record<string, unknown>)['workspaces'] !== undefined
      ) {
        return dir
      }
    } catch {
      // missing / unreadable package.json — keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
