import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { asJsonObject, parseJsonUnknown } from '@camstack/types'

const execFileAsync = promisify(execFile)

/**
 * Ensure a directory exists (recursive).
 * Single source of truth — replaces scattered mkdirSync calls.
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

/**
 * Copy a directory recursively — ASYNC so it never blocks the event loop.
 *
 * The hub installs addons into `/data/addons`, which on Unraid is a slow
 * shfs/FUSE mount. The former synchronous `fs.copyFileSync`-per-file loop
 * blocked the Node event loop for the whole copy of a large bundle (e.g.
 * `addon-pipeline`), which froze the hub's HTTP listener mid-`camstack deploy`
 * (accept backlog piling up, existing connections stuck in CLOSE_WAIT). Using
 * `fs.promises.cp` keeps the I/O off the event loop. (Node ≥18 stable.)
 */
export async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.promises.cp(src, dest, { recursive: true, force: true })
}

/**
 * Runtime deps a stripped addon package.json must KEEP so the installer still
 * `npm install`s them into the addon dir.
 *
 * Empty by design: every native an addon can import is now HOST-EXTERNAL
 * (node-av, sharp, node-pty — resolved from the framework closure via the
 * resolver hook, see host-externals.ts), and every pure-JS lib (ssh2, werift,
 * @simplewebauthn, mqtt, aws-sdk, …) is inlined by the self-contained vite
 * bundle. So a self-contained dist requires NOTHING from a local node_modules —
 * `addons/` stays node_modules-free, which is what lets the backup tar the whole
 * folder with no exclusion list (see ADR-0027). An addon that genuinely needs an
 * un-bundleable runtime dep declares it explicitly in
 * `camstack.runtimeDependencies`.
 *
 * (Historically this mirrored the build preset's COMMON_NATIVE_DEPS and
 * per-addon-installed node-av/sharp/onnxruntime-node/ssh2/werift/systeminformation
 * — 74k files / 1.34 GB of redundant node_modules on the live hub. That redundancy
 * is removed: the natives come from the framework, the pure-JS from the bundle.)
 */
export const RUNTIME_NATIVE_KEEP: readonly string[] = []

/** Read `camstack.runtimeDependencies` (extra non-native deps the dist
 *  requires at runtime — versions come from the manifest's own dep maps). */
function readRuntimeDependencies(pkg: Record<string, unknown>): readonly string[] {
  const camstack = pkg.camstack
  if (camstack === null || typeof camstack !== 'object' || Array.isArray(camstack)) return []
  const raw = (camstack as Record<string, unknown>).runtimeDependencies // wire-boundary: manifest JSON
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Strip every dependency an addon's self-contained dist has already bundled,
 * keeping ONLY what must resolve from node_modules at runtime:
 *
 *   keep = RUNTIME_NATIVE_KEEP ∪ camstack.runtimeDependencies (minus @camstack/*)
 *
 * Addon dists are fully bundled (vite `externals: 'self-contained'`), yet the
 * blanket `npm install` of the manifest's dependencies re-installed the whole
 * tree the dist already contains — 98% of the deployed addons dir was
 * redundant node_modules (74k files / 1.34 GB on the live hub; it stalled the
 * backup walk and bloated every deploy). Kept PEER deps are folded into
 * `dependencies` so `--omit=peer` installs can't drop them (pipeline's
 * patched `werift`).
 *
 * Returns a new object (immutable).
 */
export function stripBundledDeps(pkg: Record<string, unknown>): Record<string, unknown> {
  // System packages (`camstack.system: true` — core, ui-library, …) are NOT
  // self-contained addon bundles; their declared deps are real. Legacy strip.
  const camstack = pkg.camstack
  const isSystem =
    camstack !== null &&
    typeof camstack === 'object' &&
    !Array.isArray(camstack) &&
    (camstack as Record<string, unknown>).system === true // wire-boundary: manifest JSON
  if (isSystem) return stripCamstackDeps(pkg)

  const keep = new Set<string>([...RUNTIME_NATIVE_KEEP, ...readRuntimeDependencies(pkg)])
  const kept: Record<string, string> = {}
  for (const depType of ['dependencies', 'peerDependencies'] as const) {
    const rawDeps = pkg[depType]
    if (rawDeps === null || typeof rawDeps !== 'object' || Array.isArray(rawDeps)) continue
    for (const [name, version] of Object.entries(rawDeps)) {
      if (name.startsWith('@camstack/')) continue
      if (!keep.has(name) || typeof version !== 'string') continue
      // First declaration wins (dependencies iterate before peerDependencies).
      if (!(name in kept)) kept[name] = version
    }
  }

  const result = { ...pkg }
  result.dependencies = Object.keys(kept).length > 0 ? kept : undefined
  result.peerDependencies = undefined
  delete result.devDependencies
  return result
}

/**
 * Strip @camstack/* dependencies and devDependencies from a package.json object.
 * Used when installing addons into the addons directory — @camstack packages
 * are provided by the host runtime, not installed per-addon.
 *
 * Returns a new object (immutable).
 */
export function stripCamstackDeps(pkg: Record<string, unknown>): Record<string, unknown> {
  const result = { ...pkg }

  for (const depType of ['dependencies', 'peerDependencies', 'devDependencies']) {
    const rawDeps = result[depType]
    if (rawDeps === null || typeof rawDeps !== 'object' || Array.isArray(rawDeps)) continue
    const filtered: Record<string, string> = {}
    for (const [name, version] of Object.entries(rawDeps)) {
      if (!name.startsWith('@camstack/') && typeof version === 'string') {
        filtered[name] = version
      }
    }
    result[depType] = Object.keys(filtered).length > 0 ? filtered : undefined
  }

  // Always strip devDependencies — addons don't need them at runtime
  delete result.devDependencies

  return result
}

/**
 * Copy extra file directories declared in package.json "files" field.
 * Copies directories (not individual files) from source to destination.
 * Skips "dist" (already handled) and glob patterns.
 */
export async function copyExtraFileDirs(
  pkgJson: Record<string, unknown>,
  sourceDir: string,
  destDir: string,
): Promise<void> {
  const rawFiles = pkgJson.files
  if (!Array.isArray(rawFiles)) return

  for (const fileEntry of rawFiles) {
    if (typeof fileEntry !== 'string') continue
    if (fileEntry === 'dist' || fileEntry.includes('*')) continue
    const srcPath = path.join(sourceDir, fileEntry)
    if (!fs.existsSync(srcPath)) continue

    const destPath = path.join(destDir, fileEntry)
    const stat = await fs.promises.stat(srcPath)
    if (stat.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else if (stat.isFile()) {
      ensureDir(path.dirname(destPath))
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
}

/**
 * Check if any file in src/ is newer than dist/.
 * Returns true if rebuild is needed.
 */
export function isSourceNewer(packageDir: string): boolean {
  const srcDir = path.join(packageDir, 'src')
  const distDir = path.join(packageDir, 'dist')
  if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return true
  try {
    const distMtime = fs.statSync(distDir).mtimeMs
    const entries = fs.readdirSync(srcDir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const parentDir = entry.parentPath ?? String(Reflect.get(entry, 'path') ?? '')
      const filePath = path.join(parentDir, entry.name)
      if (fs.statSync(filePath).mtimeMs > distMtime) return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * Ensure a library dependency (not an addon) has a dist/ directory.
 * Does NOT rebuild — in dev mode, `npm run build` should be run separately.
 * Only checks that dist/ exists and has an index file.
 */
export function ensureLibraryBuilt(packageName: string, packagesDir: string): void {
  const dirName = packageName.replace('@camstack/', '')
  const sourceDir = path.join(packagesDir, dirName)
  if (!fs.existsSync(sourceDir)) return

  const distDir = path.join(sourceDir, 'dist')
  const hasIndex =
    fs.existsSync(path.join(distDir, 'index.js')) || fs.existsSync(path.join(distDir, 'index.mjs'))
  if (hasIndex) return

  // Deliberate, documented residual: this is a stateless boot-time
  // filesystem check that runs before `LogManager` / the Moleculer broker
  // exist, so there is no `IScopedLogger` or `$hub.log` transport to route
  // through. Threading a logger through is out of scope for D8.
  console.warn(`[ensureLibraryBuilt] ${packageName} has no dist/ — run 'npm run build' first`)
}

/**
 * Install a single npm package into a target directory (package.json + dist/).
 * No validation on camstack.addons -- works for any @camstack/* package.
 *
 * ASYNC: uses `execFile`/`fs.promises` throughout so a package install on a
 * live node never blocks the event loop (the `npm pack` + tar extract + copy to
 * the slow shfs/FUSE `/data` would otherwise freeze the HTTP listener). See
 * `copyDirRecursive` for the wedge this prevents.
 */
export async function installPackageFromNpm(packageName: string, targetDir: string): Promise<void> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'camstack-install-'))

  try {
    // npm pack downloads the tgz without installing
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', packageName, '--pack-destination', tmpDir],
      { timeout: 120_000, encoding: 'utf-8' },
    )

    const tgzFilename = stdout.trim().split('\n').pop()?.trim()
    if (!tgzFilename) throw new Error('npm pack produced no output')

    const tgzPath = path.join(tmpDir, tgzFilename)

    // Extract tgz
    const extractDir = path.join(tmpDir, 'extracted')
    ensureDir(extractDir)
    await execFileAsync('tar', ['-xzf', tgzPath, '-C', extractDir], { timeout: 30_000 })

    // npm pack creates a package/ subdirectory
    const packageSubDir = path.join(extractDir, 'package')
    const srcPkgJsonDir = fs.existsSync(path.join(packageSubDir, 'package.json'))
      ? packageSubDir
      : extractDir

    // Copy package.json + dist/ to target
    await fs.promises.rm(targetDir, { recursive: true, force: true })
    ensureDir(targetDir)
    await fs.promises.copyFile(
      path.join(srcPkgJsonDir, 'package.json'),
      path.join(targetDir, 'package.json'),
    )

    const distSrc = path.join(srcPkgJsonDir, 'dist')
    if (fs.existsSync(distSrc)) {
      await copyDirRecursive(distSrc, path.join(targetDir, 'dist'))
    }

    // Copy extra directories from "files" in package.json (e.g., python/)
    try {
      const npmPkg = asJsonObject(
        parseJsonUnknown(
          await fs.promises.readFile(path.join(srcPkgJsonDir, 'package.json'), 'utf-8'),
        ),
      )
      if (npmPkg) await copyExtraFileDirs(npmPkg, srcPkgJsonDir, targetDir)
    } catch {
      /* non-critical */
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
}
