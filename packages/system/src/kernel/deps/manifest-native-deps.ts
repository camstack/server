import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { asJsonObject, asString, errMsg } from '@camstack/types/addon'
import type { IScopedLogger } from '@camstack/types'
import { runNpm } from './npm-command.js'

const execFileAsync = promisify(execFile)

/**
 * Fallback bootstrap-cache location when the caller doesn't thread one
 * through (the forked addon-runner's spawn-time install). tmpdir survives the
 * process; a reboot just re-bootstraps. Callers with a persistent root (the
 * installer) pass their own.
 */
function defaultNpmCacheDir(): string {
  return path.join(os.tmpdir(), 'camstack-npm-bootstrap')
}

/**
 * Native node modules an addon needs at runtime but cannot be bundled
 * (`.node` binary files require ABI-matched compilation). Mirror of the
 * Python `requirements.txt` pattern in `manifest-python-deps.ts` —
 * declared in the addon's `package.json` under `camstack.nativeDependencies`,
 * installed per-addon at install time so the host's regular `npm install`
 * doesn't pull in the union of every camera driver's native deps.
 *
 * Phase E of the bundles + builder modernization spec
 * (`docs/superpowers/specs/2026-05-09-bundles-and-builder-modernization-design.md`).
 *
 * Idempotent: hashes the `nativeDependencies` map and writes a marker
 * to `<addonDir>/.camstack-native-deps-installed`. Re-installing only
 * happens when the declared set changes.
 *
 * Failure modes:
 *   - manifest doesn't declare `nativeDependencies` (or declares empty) → no-op
 *   - `npm install` fails → throws (caller decides whether to abort install)
 *   - rebuild step fails → logs warning + continues (install may still
 *     work if prebuilt binaries shipped in the package cover the host
 *     ABI; surface a clear error at first `import` of the native module
 *     otherwise).
 */
export async function installManifestNativeDeps(
  addonDir: string,
  pkgRaw: Record<string, unknown>,
  logger: IScopedLogger,
  registry?: string,
  npmCacheDir?: string,
): Promise<void> {
  const native = readNativeDeps(pkgRaw)
  if (native == null || Object.keys(native).length === 0) return

  const markerFile = path.join(addonDir, '.camstack-native-deps-installed')
  const markerHash = hashDeclaration(native)
  if (markerMatches(markerFile, markerHash)) {
    logger.debug('Native deps already installed (marker matches)', {
      meta: { addonDir, count: Object.keys(native).length },
    })
    return
  }

  // 0) Prefer the host's already-built, ABI-matched native module. The agent
  //    image's `npm ci` compiles each native dep (e.g. better-sqlite3) and
  //    hoists it to `/repo/node_modules` (on NODE_PATH). Copying that prebuilt
  //    copy makes seeding work OFFLINE — the runtime `npm install` +
  //    `prebuild-install` download below is unreliable on flaky DNS and
  //    impossible in a slim runtime image with no build toolchain, which left
  //    the seeded better-sqlite3 source-only ("Could not locate the bindings
  //    file") and crash-looped the agent. Deps satisfied here skip the network.
  const pending = Object.entries(native).filter(
    ([name]) => !copyPrebuiltNativeDep(name, addonDir, logger),
  )
  if (pending.length === 0) {
    logger.info('Native deps satisfied from prebuilt host modules (offline)', {
      meta: { addonDir, count: Object.keys(native).length },
    })
    try {
      fs.writeFileSync(markerFile, markerHash)
    } catch (err) {
      logger.warn('Failed to write native deps marker', {
        meta: { markerFile, error: errMsg(err) },
      })
    }
    return
  }

  const specs = pending.map(([name, range]) => `${name}@${range}`)
  logger.info('Installing native dependencies', {
    meta: { addonDir, specs },
  })

  // 1) `npm install` each spec into the addon's own node_modules. Without
  //    `--no-save` npm would try to update package.json which we don't
  //    own here (the package.json is the addon's published manifest).
  //    `--no-package-lock` keeps the install lean — we don't need a
  //    lock file for runtime deps because the version is pinned by the
  //    declared range and the install is per-addon, never resolved
  //    against the host's tree.
  const args = [
    'install',
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    '--omit=dev',
    '--omit=peer',
    ...(registry ? ['--registry', registry] : []),
    ...specs,
  ]
  try {
    await runNpm(args, {
      cacheDir: npmCacheDir ?? defaultNpmCacheDir(),
      registry,
      logger,
      cwd: addonDir,
      timeout: 300_000,
    })
  } catch (err) {
    throw new Error(`npm install of native deps failed for ${addonDir}: ${errMsg(err)}`, {
      cause: err,
    })
  }

  // 2) Rebuild against the host's runtime ABI. Electron and plain Node
  //    differ (Electron 35 = ABI 127 vs Node 22 = ABI 133); installing
  //    against the wrong ABI loads but throws "wrong ELF class" /
  //    "module compiled against different Node.js version" at first use.
  await rebuildNativeDeps(
    addonDir,
    pending.map(([name]) => name),
    logger,
    npmCacheDir ?? defaultNpmCacheDir(),
    registry,
  )

  // 3) Persist the marker so subsequent boots skip the work.
  try {
    fs.writeFileSync(markerFile, markerHash)
  } catch (err) {
    logger.warn('Failed to write native deps marker', {
      meta: { markerFile, error: errMsg(err) },
    })
  }
}

/**
 * Satisfy a native dep from an already-built copy on the host instead of a
 * runtime `npm install`. Searches NODE_PATH and the node_modules dirs above
 * `addonDir` for `<name>` carrying a compiled binary, and copies the whole
 * package into `<addonDir>/node_modules/<name>`. Safe: returns false on any
 * miss/error so the caller falls back to the network install.
 */
function copyPrebuiltNativeDep(name: string, addonDir: string, logger: IScopedLogger): boolean {
  const target = path.join(addonDir, 'node_modules', name)
  if (hasBuiltBinary(target)) return true

  for (const source of candidateHoistedDirs(name, addonDir)) {
    if (source === target) continue
    if (!hasBuiltBinary(source)) continue
    try {
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.cpSync(source, target, { recursive: true, dereference: true })
      logger.info('Native dep copied from prebuilt host module (offline)', {
        meta: { name, source, target },
      })
      return true
    } catch (err) {
      logger.warn('Prebuilt native dep copy failed — will try npm install', {
        meta: { name, source, error: errMsg(err) },
      })
    }
  }
  return false
}

/**
 * Native packages the packaged desktop ships PREBUILT inside each bundled addon
 * copy (`scripts/stage-deps.mjs` plants them), keyed to the platform SIBLING
 * scopes that hold the N-API binary. The traditional `better-sqlite3` carries
 * its `.node` in its own dir; `sharp`/`node-av` carry it in a `@img`/`@seydx`
 * sibling.
 */
const BUNDLED_NATIVE_SIBLING_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'better-sqlite3': [],
  sharp: ['@img'],
  'node-av': ['@seydx'],
}

/** Bounded recursive scan for ANY `*.node` under `dir`. */
function hasAnyDotNode(dir: string, maxDepth: number): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.node')) return true
  }
  if (maxDepth <= 0) return false
  for (const entry of entries) {
    if (entry.isDirectory() && hasAnyDotNode(path.join(dir, entry.name), maxDepth - 1)) return true
  }
  return false
}

/** Copy `<src>` → `<dst>` when `<src>` carries a `.node`. Best-effort. */
function copyPrebuiltModuleDir(
  src: string,
  dst: string,
  label: string,
  logger: IScopedLogger,
): void {
  if (!hasAnyDotNode(src, 5)) return
  if (hasAnyDotNode(dst, 5)) return // target already has a built binary — keep it
  try {
    fs.rmSync(dst, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.cpSync(src, dst, { recursive: true, dereference: true })
    logger.info('Prebuilt native module propagated from bundled addon copy', {
      meta: { module: label, src, dst },
    })
  } catch (err) {
    logger.warn('Prebuilt native module propagation failed (npm install will retry)', {
      meta: { module: label, src, error: errMsg(err) },
    })
  }
}

/**
 * Propagate PREBUILT native modules from a bundled addon copy's own
 * `node_modules` (the packaged-desktop 'local' source at
 * `<resources>/addons/<addon>`) into the freshly-copied target
 * (`<data>/addons/@camstack/<addon>`), BEFORE the target's `npm install` runs.
 *
 * Why (Mac desktop first-boot FATAL, 2026-07-21): `installCopy` copies only
 * `dist/` then `npm install`s the addon's runtime deps. On a toolchain-less Mac
 * that install leaves the traditional native `better-sqlite3` SOURCE-ONLY in
 * `<addon>/node_modules` — a broken copy that then SHADOWS the good hoisted
 * `.node` NODE_PATH would otherwise resolve, crashing the runner with "Could
 * not locate the bindings file". Seeding the prebuilt copy here makes the npm
 * install treat the native as satisfied (no re-run of `prebuild-install`), so
 * the good `.node` stays in place. A no-op in dev / docker where the source
 * carries no bundled natives.
 */
export function copyBundledNativeModules(
  sourceDir: string,
  targetDir: string,
  logger: IScopedLogger,
): void {
  const srcNm = path.join(sourceDir, 'node_modules')
  if (!fs.existsSync(srcNm)) return
  const dstNm = path.join(targetDir, 'node_modules')

  for (const [name, scopes] of Object.entries(BUNDLED_NATIVE_SIBLING_SCOPES)) {
    copyPrebuiltModuleDir(path.join(srcNm, name), path.join(dstNm, name), name, logger)
    for (const scope of scopes) {
      const scopeSrc = path.join(srcNm, scope)
      let siblings: string[]
      try {
        siblings = fs.readdirSync(scopeSrc)
      } catch {
        continue
      }
      for (const sibling of siblings) {
        copyPrebuiltModuleDir(
          path.join(scopeSrc, sibling),
          path.join(dstNm, scope, sibling),
          `${scope}/${sibling}`,
          logger,
        )
      }
    }
  }
}

/** A package dir is "built" when it carries a compiled `.node` or a prebuilds tree. */
function hasBuiltBinary(pkgDir: string): boolean {
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) return false
  const releaseDir = path.join(pkgDir, 'build', 'Release')
  try {
    if (fs.existsSync(releaseDir) && fs.readdirSync(releaseDir).some((f) => f.endsWith('.node'))) {
      return true
    }
  } catch {
    /* unreadable — treat as not built */
  }
  return fs.existsSync(path.join(pkgDir, 'prebuilds'))
}

/** Candidate hoisted locations for `<name>`: NODE_PATH entries + ancestors of `addonDir`. */
function candidateHoistedDirs(name: string, addonDir: string): string[] {
  const dirs: string[] = []
  const nodePath = process.env['NODE_PATH']
  if (nodePath) {
    for (const p of nodePath.split(path.delimiter)) {
      if (p) dirs.push(path.join(p, name))
    }
  }
  let cur = addonDir
  for (let i = 0; i < 10; i++) {
    dirs.push(path.join(cur, 'node_modules', name))
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return dirs
}

/** Read & validate `camstack.nativeDependencies`. Returns null when absent. */
function readNativeDeps(pkgRaw: Record<string, unknown>): Record<string, string> | null {
  const camstack = asJsonObject(pkgRaw['camstack'])
  if (!camstack) return null
  const native = asJsonObject(camstack['nativeDependencies'])
  if (!native) return null
  // Accept only string values — invalid entries get silently dropped
  // rather than aborting the whole install (the addon may still load if
  // the malformed entry is for an optional dep).
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(native)) {
    const range = asString(v)
    if (range) out[k] = range
  }
  return Object.keys(out).length > 0 ? out : null
}

/** SHA-256 of the canonical-keyed declaration — drives marker idempotency. */
function hashDeclaration(deps: Record<string, string>): string {
  const canonical = Object.keys(deps)
    .toSorted()
    .map((k) => `${k}@${deps[k]!}`)
    .join('\n')
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function markerMatches(markerFile: string, expected: string): boolean {
  try {
    return fs.readFileSync(markerFile, 'utf-8').trim() === expected
  } catch {
    return false
  }
}

/**
 * Rebuild native modules against the host's runtime ABI.
 *
 * Detection: `process.versions.electron` is set when running inside
 * Electron's main/renderer process (set even when `ELECTRON_RUN_AS_NODE`
 * isn't), giving us a reliable signal. Plain Node leaves it undefined.
 *
 * Electron path: tries `@electron/rebuild` programmatically, falling
 * back to `npx electron-rebuild` if the package isn't directly available.
 * Node path: `npm rebuild --prefix <addonDir>` re-runs the install
 * scripts of every package under that directory.
 *
 * Failures here are non-fatal: many native packages ship prebuilt
 * binaries that cover both ABIs, so the rebuild may be unnecessary.
 * The first `import` of an actually-mismatched binary throws a clear
 * error that points the operator at this rebuild step.
 */
async function rebuildNativeDeps(
  addonDir: string,
  packageNames: readonly string[],
  logger: IScopedLogger,
  npmCacheDir: string,
  registry?: string,
): Promise<void> {
  const isElectron = typeof process.versions.electron === 'string'

  if (isElectron) {
    const electronVersion = process.versions.electron
    logger.info('Rebuilding native deps for Electron', {
      meta: { addonDir, electronVersion, packages: packageNames },
    })
    try {
      // Try the programmatic API first — works without a separate npm
      // round-trip and respects the host's electron version exactly.
      //
      // `@electron/rebuild` is an OPTIONAL, electron-only dependency: it is
      // declared by the electron packages but absent from the hub/agent install
      // (and skipped by npm on non-electron platforms). The `string`-typed
      // specifier keeps tsc from statically resolving the module (TS2307) while
      // the runtime dynamic import still resolves it inside electron;
      // `.catch(() => null)` handles its absence everywhere else.
      const rebuildSpecifier: string = '@electron/rebuild'
      const rebuildModule = (await import(rebuildSpecifier).catch(() => null)) as {
        rebuild?: (opts: {
          buildPath: string
          electronVersion: string
          onlyModules?: readonly string[]
        }) => Promise<void>
      } | null
      if (rebuildModule?.rebuild) {
        await rebuildModule.rebuild({
          buildPath: addonDir,
          electronVersion: electronVersion!,
          onlyModules: packageNames,
        })
        return
      }
      logger.warn('@electron/rebuild not available — falling back to npx', {
        meta: { addonDir },
      })
      await execFileAsync(
        'npx',
        ['--yes', 'electron-rebuild', '-m', addonDir, '-v', electronVersion!],
        { cwd: addonDir, timeout: 600_000 },
      )
    } catch (err) {
      logger.warn('Electron rebuild failed (continuing — prebuilt binary may be present)', {
        meta: { addonDir, error: errMsg(err) },
      })
    }
    return
  }

  // Plain Node host — re-run install scripts so node-gyp rebuilds the
  // C++ sources against `process.versions.modules`. Most packages with
  // prebuilds skip this entirely (prebuild-install detects ABI match
  // and returns early), so it's cheap when binaries are already correct.
  logger.info('Rebuilding native deps for Node', {
    meta: { addonDir, nodeAbi: process.versions.modules, packages: packageNames },
  })
  try {
    await runNpm(['rebuild', ...packageNames], {
      cacheDir: npmCacheDir,
      registry,
      logger,
      cwd: addonDir,
      timeout: 600_000,
    })
  } catch (err) {
    logger.warn('npm rebuild failed (continuing — prebuilt binary may be present)', {
      meta: { addonDir, error: errMsg(err) },
    })
  }
}
