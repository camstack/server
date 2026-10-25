/**
 * Package-dir introspection helpers for the hub's OWN framework closure.
 *
 * Extracted from the deleted `framework-live-sync.ts` (the dist-mirror
 * machinery was superseded by the runtime-updatable root package — see
 * docs/superpowers/specs/2026-07-12-runtime-updatable-node-packages-design.md);
 * these two read-only helpers remain in use by `AddonPackageService`'s
 * framework-package status surface.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

// Resolve framework packages the same way the running hub does — from THIS
// module's location, whose walk-up lands on the hub's own `node_modules`
// closure (identical to the hub main's `@camstack/system` resolution).
const requireFromHere = createRequire(__filename)

function readJsonObjectSafe(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...parsed }
    }
  } catch {
    /* missing / malformed — treat as absent */
  }
  return null
}

function packageNameOf(pkgJsonPath: string): string | null {
  const obj = readJsonObjectSafe(pkgJsonPath)
  const name = obj?.['name']
  return typeof name === 'string' ? name : null
}

/**
 * The package directory the HUB MAIN process loads `<packageName>` from — its
 * own `node_modules` closure. `require.resolve('<pkg>/package.json')` is the
 * happy path; packages whose `exports` map omits that subpath fall back to
 * resolving the main entry and walking up to the matching `package.json`.
 * Returns null when the package is not resolvable.
 */
export function resolveHubClosurePackageDir(packageName: string): string | null {
  try {
    return path.dirname(requireFromHere.resolve(`${packageName}/package.json`))
  } catch {
    // `exports` map blocks the package.json subpath — fall through.
  }
  try {
    let dir = path.dirname(requireFromHere.resolve(packageName))
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json')
      if (fs.existsSync(candidate) && packageNameOf(candidate) === packageName) {
        return dir
      }
      dir = path.dirname(dir)
    }
  } catch {
    // package itself not resolvable — treat as not installed.
  }
  return null
}

function collectJsFiles(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectJsFiles(root, full, out)
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      out.push(path.relative(root, full))
    }
  }
}

/**
 * Content build-id of a `dist/` tree — md5 over every `.js`/`.mjs` file's
 * relative path + bytes (sorted for determinism). Analogous to the Docker
 * image's `seed-version` fingerprint. Returns null when the dir is missing or
 * empty. Used to surface "same semver, new code" instead of trusting `version`.
 */
export function computeDistBuildId(distDir: string): string | null {
  if (!fs.existsSync(distDir)) return null
  const files: string[] = []
  collectJsFiles(distDir, distDir, files)
  if (files.length === 0) return null
  files.sort()
  const hash = createHash('md5')
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    hash.update(fs.readFileSync(path.join(distDir, rel)))
  }
  return hash.digest('hex')
}
