/**
 * Filesystem walk that surfaces addon candidates near the operator's
 * cwd. Used by the unified `deploy` / `watch` / `dev` entrypoints when
 * the operator runs them without a positional path argument — the CLI
 * doesn't ask "where is the addon?" if it can find it locally.
 *
 * Heuristics for "is this a camstack addon":
 *   • `package.json` declares `camstack.addons` (the canonical manifest
 *     for shipped + dev addons).
 *   • `package.json.name` starts with `@camstack/addon-` or `camstack-addon-`.
 *   • `package.json.keywords` contains both `camstack` and `addon`.
 * Any one of those is sufficient. We DO NOT crawl into `node_modules`,
 * `dist`, `build`, `.git`, or any dotted dir — the search is for source
 * trees the operator is editing, not vendored deps.
 *
 * Default depth: 5. Tuned against the camstack monorepo layout
 * (`monorepo/packages/addon-X/` is depth 2; a project two repos deep
 * still gets caught) without burning forever in giant filesystem trees.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface AddonCandidate {
  /** Absolute path to the addon directory (contains package.json). */
  readonly path: string
  /** Display name from package.json (`name` field). */
  readonly name: string
  /** Optional human label from camstack manifest (first addon's `name`). */
  readonly displayName?: string
  /** Distance from the search root, in `path.sep` count. */
  readonly depth: number
  /** Which heuristic matched first — useful for the operator to verify. */
  readonly matchedBy: 'manifest' | 'name-prefix' | 'keywords'
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  'coverage',
  '__tests__',
  '__snapshots__',
])

interface CamstackManifest {
  addons?: ReadonlyArray<{ name?: string }>
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function classifyAddon(pkg: Record<string, unknown>): AddonCandidate['matchedBy'] | null {
  const camstack = pkg['camstack']
  if (camstack !== null && typeof camstack === 'object') {
    const manifest = camstack as CamstackManifest
    if (Array.isArray(manifest.addons) && manifest.addons.length > 0) return 'manifest'
  }
  const name = pkg['name']
  if (
    typeof name === 'string' &&
    (name.startsWith('@camstack/addon-') || name.startsWith('camstack-addon-'))
  ) {
    return 'name-prefix'
  }
  const keywords = pkg['keywords']
  if (Array.isArray(keywords) && keywords.includes('camstack') && keywords.includes('addon')) {
    return 'keywords'
  }
  return null
}

function manifestDisplayName(pkg: Record<string, unknown>): string | undefined {
  const camstack = pkg['camstack']
  if (camstack === null || typeof camstack !== 'object') return undefined
  const manifest = camstack as CamstackManifest
  const first = Array.isArray(manifest.addons) ? manifest.addons[0] : undefined
  return first && typeof first.name === 'string' ? first.name : undefined
}

/**
 * Walk `root` recursively up to `maxDepth` directories deep and collect
 * every directory whose package.json identifies it as an addon.
 *
 * Returns the candidates in deterministic order: closest-first
 * (shallower depth wins ties), then alphabetical by name. That matches
 * how the operator usually thinks — "the thing in front of me first".
 */
export function discoverAddonsInCwd(
  root: string = process.cwd(),
  maxDepth = 5,
): readonly AddonCandidate[] {
  const out: AddonCandidate[] = []
  const stack: { dir: string; depth: number }[] = [{ dir: path.resolve(root), depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!
    // Test the directory itself, then descend.
    const pkg = readPackageJson(dir)
    if (pkg) {
      const matchedBy = classifyAddon(pkg)
      if (matchedBy) {
        const name = typeof pkg['name'] === 'string' ? pkg['name'] : path.basename(dir)
        const displayName = manifestDisplayName(pkg)
        out.push({
          path: dir,
          name,
          ...(displayName ? { displayName } : {}),
          depth,
          matchedBy,
        })
        // If THIS directory is an addon, we don't descend into it —
        // sub-packages of an addon aren't independent deploy targets.
        continue
      }
    }
    if (depth >= maxDepth) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      if (SKIP_DIRS.has(entry.name)) continue
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
    }
  }
  return out.toSorted((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))
}
