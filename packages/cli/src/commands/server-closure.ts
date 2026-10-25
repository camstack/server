/**
 * `camstack deploy-server` — closure-set discovery + dev-version packing.
 *
 * Graph-driven (NOT a hardcoded list): the closure is discovered by walking
 * the dependency graph from `server/backend/package.json` (`@camstack/server`)
 * across the workspace. Two sets fall out of the walk:
 *
 *   - **packSet** — the transitive INSTALL closure (`dependencies` +
 *     `optionalDependencies` + `peerDependencies`) restricted to `@camstack/*`
 *     packages that exist in the workspace. These are packed at the uniform
 *     dev version and uploaded — they are exactly what the hub's staged
 *     `npm install` must resolve to the uploaded copies.
 *   - **buildSet** — packSet plus build-only workspace dev-deps (e.g.
 *     `@camstack/node-root`, which the server BUNDLES at build time). These
 *     must be BUILT in dependency order so every bundle embeds fresh code,
 *     but they never appear in the installed tree, so they are not uploaded.
 *
 * The dev-version rewrite is temp-only: the original `package.json` bytes are
 * restored after `npm pack`, even on failure — the workspace is never left
 * dirty.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const CAMSTACK_SCOPE_PREFIX = '@camstack/'

export interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly version: string
}

export interface ServerClosure {
  /** The workspace `@camstack/server` version — the dev-version base. */
  readonly serverVersion: string
  /** Install closure, dependency order (root package last). Pack + upload these. */
  readonly packSet: readonly WorkspacePackage[]
  /** packSet + build-only workspace dev-deps, dependency order. Build these. */
  readonly buildSet: readonly WorkspacePackage[]
}

export function computeDevVersion(base: string, epochSeconds: number): string {
  return `${base}-dev.${epochSeconds}`
}

interface PackageManifest {
  readonly name: string
  readonly version: string
  readonly raw: Record<string, unknown>
}

function readPackageManifest(dir: string): PackageManifest | null {
  const pkgJsonPath = path.join(dir, 'package.json')
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const raw = parsed as Record<string, unknown>
    if (typeof raw['name'] !== 'string') return null
    return {
      name: raw['name'],
      version: typeof raw['version'] === 'string' ? raw['version'] : '0.0.0',
      raw,
    }
  } catch {
    return null
  }
}

/**
 * Expand the root package.json `workspaces` globs into a name → dir map.
 * Only the npm-workspaces subset actually used here is supported: literal
 * paths and single trailing-`*` segments (`packages/*`, `server/*`).
 */
function loadWorkspacePackages(workspaceRoot: string): ReadonlyMap<string, WorkspacePackage> {
  const root = readPackageManifest(workspaceRoot)
  if (root === null) {
    throw new Error(`No parseable package.json at workspace root: ${workspaceRoot}`)
  }
  const workspaces = root.raw['workspaces']
  const patterns = Array.isArray(workspaces)
    ? workspaces.filter((w): w is string => typeof w === 'string')
    : []
  const dirs: string[] = []
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = path.join(workspaceRoot, pattern.slice(0, -2))
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(base, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) dirs.push(path.join(base, entry.name))
      }
    } else {
      dirs.push(path.join(workspaceRoot, pattern))
    }
  }
  const byName = new Map<string, WorkspacePackage>()
  for (const dir of dirs) {
    const manifest = readPackageManifest(dir)
    if (manifest === null) continue
    byName.set(manifest.name, { name: manifest.name, dir, version: manifest.version })
  }
  return byName
}

type DepField = 'dependencies' | 'optionalDependencies' | 'peerDependencies' | 'devDependencies'

const INSTALL_DEP_FIELDS: readonly DepField[] = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]
const BUILD_DEP_FIELDS: readonly DepField[] = [...INSTALL_DEP_FIELDS, 'devDependencies']

function depNames(
  manifest: Record<string, unknown>,
  fields: readonly DepField[],
): readonly string[] {
  const names = new Set<string>()
  for (const field of fields) {
    const deps = manifest[field]
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue
    for (const name of Object.keys(deps)) names.add(name)
  }
  return [...names]
}

/**
 * DFS post-order walk from `rootName` over the workspace-`@camstack/*` edges
 * of `fields`. Post-order = dependencies before dependents; the root package
 * lands last. Cycles are broken at the back-edge (post-order still yields
 * every member exactly once).
 */
function walkClosure(
  rootName: string,
  workspace: ReadonlyMap<string, WorkspacePackage>,
  fields: readonly DepField[],
): readonly WorkspacePackage[] {
  const ordered: WorkspacePackage[] = []
  const visited = new Set<string>()
  const visit = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    const pkg = workspace.get(name)
    if (pkg === undefined) return
    const manifest = readPackageManifest(pkg.dir)
    if (manifest !== null) {
      for (const dep of depNames(manifest.raw, fields)) {
        if (dep.startsWith(CAMSTACK_SCOPE_PREFIX) && workspace.has(dep)) visit(dep)
      }
    }
    ordered.push(pkg)
  }
  visit(rootName)
  return ordered
}

/**
 * Discover the `@camstack/server` workspace closure by reading the graph.
 * Throws with a precise message when the workspace shape is unexpected —
 * the command must fail loudly rather than upload a partial closure.
 */
export function discoverServerClosure(workspaceRoot: string): ServerClosure {
  const serverDir = path.join(workspaceRoot, 'server', 'backend')
  const serverManifest = readPackageManifest(serverDir)
  if (serverManifest === null) {
    throw new Error(
      `No parseable package.json at ${path.join('server/backend', 'package.json')} — ` +
        'run `camstack deploy-server` from the camstack-server workspace root.',
    )
  }
  const workspace = loadWorkspacePackages(workspaceRoot)
  const serverEntry = workspace.get(serverManifest.name)
  if (serverEntry === undefined || path.resolve(serverEntry.dir) !== path.resolve(serverDir)) {
    throw new Error(
      `${serverManifest.name} at server/backend is not listed in the root workspaces globs.`,
    )
  }
  const packSet = walkClosure(serverManifest.name, workspace, INSTALL_DEP_FIELDS)
  const buildSet = walkClosure(serverManifest.name, workspace, BUILD_DEP_FIELDS)
  return { serverVersion: serverManifest.version, packSet, buildSet }
}

/**
 * Run `fn` while the package's `package.json` carries the uniform dev
 * version (its `version` plus every intra-set `@camstack/*` range across all
 * dependency fields). The ORIGINAL bytes are restored afterwards — success
 * or failure — so the workspace file is never left dirty. Used to wrap
 * `npm pack` so the tarball self-describes as the dev version.
 */
export function withDevVersionPackageJson<T>(
  pkgDir: string,
  devVersion: string,
  intraSetNames: ReadonlySet<string>,
  fn: () => T,
): T {
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  const originalBytes = fs.readFileSync(pkgJsonPath)
  const parsed: unknown = JSON.parse(originalBytes.toString('utf-8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed package.json: ${pkgJsonPath}`)
  }
  const manifest: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
    version: devVersion,
  }
  for (const field of BUILD_DEP_FIELDS) {
    const deps = manifest[field]
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue
    const rewritten: Record<string, unknown> = {}
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      rewritten[name] = intraSetNames.has(name) ? devVersion : range
    }
    manifest[field] = rewritten
  }
  fs.writeFileSync(pkgJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  try {
    return fn()
  } finally {
    fs.writeFileSync(pkgJsonPath, originalBytes)
  }
}
