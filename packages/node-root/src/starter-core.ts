/**
 * Shared STARTER core — the boot flow both node starters (hub + agent) run.
 * ZERO-DEP: bundled into each starter at build time; must never resolve
 * anything from node_modules at runtime.
 *
 * Single-copy boot sequence (2026-07-18 collapse — identical on both node
 * types; per-node names arrive via {@link NodeStarterOptions}):
 *   1. Workspace checkout? → defer to plain resolution (load the sibling seed
 *      entry; the dev loop never runs the built starter at all).
 *   2. Apply any staged root swap (`applyServerUpdate` left a pending marker),
 *      then run the one-time migration from the legacy multi-copy layout to the
 *      single `current/` copy. Both are idempotent + crash-safe.
 *   3. Is the ONE canonical `current/` closure valid? → register in-process
 *      resolver hooks so the node's MAIN process resolves the host-external
 *      packages (@camstack/server/system, …) from `current/node_modules`, point the
 *      forked-runner framework dir at the same copy, and load its entry.
 *   4. Otherwise → load the baked seed entry next to the starter.
 *
 * There is NO probation boot, NO auto-rollback, and NO baked-seed-adoption
 * semver compare — one copy, replaced in place, manual recovery only.
 *
 * Console usage is intentional: the starter runs before any logging exists.
 * Every line is prefixed `[starter]`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { type BootPlan, planBoot } from './boot-plan.js'
import type { RootPackageSpec } from './root-package-spec.js'
import { rootPackageDir, serverRootDir, validateClosureDir } from './root-state.js'
import {
  applyPendingRootSwap,
  currentDir,
  currentEntryPath,
  migrateToSingleCopy,
} from './root-single-copy.js'
import { compareSemver } from './semver-compare.js'
import { detectWorkspaceRoot } from './workspace-detect.js'

/**
 * Mirror of the host-external list in
 * `packages/system/src/kernel/moleculer/framework-resolver-hook.mjs` — kept
 * inline because the starter must stay zero-dep. Only these specifiers are
 * redirected to the active root; everything else resolves normally.
 */
export const HOST_EXTERNAL_SPECIFIERS: readonly string[] = [
  '@camstack/server/system',
  '@camstack/types',
  '@camstack/sdk',
  'zod',
  '@trpc/server',
  '@trpc/client',
  'sharp',
  'node-av',
  'node-pty',
  'ssh2',
]

/**
 * The oldest `@camstack/server` this starter can host (D989) — the first one
 * that ships its kernel as `@camstack/server/system`, because the host-external
 * list above resolves that specifier and an older server imports another.
 * Declared as `camstack.requires.server` in this package's `package.json`; a
 * spec keeps the two equal. Raise it by hand when a server needs a newer
 * starter than the one baked into an image.
 */
export const STARTER_HOSTS_SERVER_MIN = '1.2.718'

export function isHostExternal(specifier: string): boolean {
  return HOST_EXTERNAL_SPECIFIERS.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  )
}

type ResolveContext = { readonly parentURL?: string }
type NextResolve = (specifier: string, context?: ResolveContext) => unknown
type RegisterHooksFn = (hooks: {
  resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown
}) => void

/**
 * Register in-process resolver hooks (Node >= 22.15 `module.registerHooks`,
 * covers BOTH require and import) that anchor host-external resolution inside
 * the single copy's node_modules. Failure-tolerant: if the anchored resolve
 * fails (package absent from the closure), fall back to the default walk.
 */
export function registerActiveRootResolver(activeRootDir: string): void {
  // Documented type boundary: `module.registerHooks` is not yet in the
  // bundled @types/node — feature-detect it off the untyped module surface.
  const moduleApi: Record<string, unknown> = require('node:module')
  const registerHooks = moduleApi['registerHooks']
  if (typeof registerHooks !== 'function') {
    console.warn(
      '[starter] module.registerHooks unavailable (Node < 22.15) — host-external redirect skipped',
    )
    return
  }
  const anchorURL = pathToFileURL(
    path.join(activeRootDir, 'node_modules', '__camstack_starter_anchor__.js'),
  ).href
  const hooks: Parameters<RegisterHooksFn>[0] = {
    resolve: (specifier, context, nextResolve) => {
      if (isHostExternal(specifier)) {
        try {
          return nextResolve(specifier, { ...context, parentURL: anchorURL })
        } catch {
          // Not in the active root's closure — fall through to default.
        }
      }
      return nextResolve(specifier, context)
    },
  }
  ;(registerHooks as RegisterHooksFn)(hooks)
}

/** Per-node env-var names the starter writes / reads. */
export interface StarterEnvNames {
  /** Boot-mode marker read by the node's update service (`workspace`/`baked`/`data-root`). */
  readonly bootMode: string
  /** Absolute path of the active single-copy dir (data-root boots only). */
  readonly activeRoot: string
  /** Active data-root version (data-root boots only). */
  readonly activeVersion: string
  /** Kill switch: `<killSwitch>=off` forces the baked seed closure. */
  readonly killSwitch: string
}

export interface NodeStarterOptions {
  readonly spec: RootPackageSpec
  readonly envNames: StarterEnvNames
  /** The node's resolved data dir (owner-specific env/argv resolution). */
  readonly dataDir: string
  /** Absolute path of the baked seed entry sibling to the starter. */
  readonly seedEntry: string
  /** The starter's own dir (`__dirname`) — anchors workspace detection. */
  readonly starterDir: string
  /** Load an entry file (a plain CJS `require` in the real starters). */
  readonly loadEntry: (entryPath: string) => void
  /** Test seams. Defaults: `process.env`, `Date.now`, running node major. */
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly nodeMajor?: number
  readonly registerResolver?: (activeRootDir: string) => void
}

/** Read a package.json `version` string, or null on any failure. */
function readClosureVersion(closureDir: string, spec: RootPackageSpec): string | null {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(rootPackageDir(closureDir, spec), 'package.json'), 'utf-8'),
    )
    if (typeof raw === 'object' && raw !== null) {
      const version = (raw as Record<string, unknown>)['version']
      if (typeof version === 'string') return version
    }
  } catch {
    /* unreadable — unknown */
  }
  return null
}

/** Newest server version this data root has ever booted (`<rootDir>/last-booted.json`). */
export const LAST_BOOTED_FILE = 'last-booted.json'

export function readLastBooted(rootDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(rootDir, LAST_BOOTED_FILE), 'utf-8'))
    if (typeof raw === 'object' && raw !== null) {
      const version = (raw as Record<string, unknown>)['version']
      if (typeof version === 'string') return version
    }
  } catch {
    /* missing or corrupt — nothing recorded */
  }
  return null
}

/** Record a booted version, never lowering the high-water mark. Best effort. */
function recordLastBooted(rootDir: string, version: string): void {
  const previous = readLastBooted(rootDir)
  if (previous !== null && compareSemver(previous, version) >= 0) return
  try {
    const target = path.join(rootDir, LAST_BOOTED_FILE)
    const tmp = `${target}.tmp`
    fs.mkdirSync(rootDir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ version }), 'utf-8')
    fs.renameSync(tmp, target)
  } catch (err) {
    console.warn(`[starter] could not record the booted version: ${String(err)}`)
  }
}

/** Version of the baked seed, found by walking up from its entry; null when unknown. */
function readSeedVersion(seedEntry: string, spec: RootPackageSpec): string | null {
  let dir = path.dirname(seedEntry)
  for (let i = 0; i < 5; i++) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
      if (typeof raw === 'object' && raw !== null) {
        const rec = raw as Record<string, unknown>
        if (rec['name'] === spec.packageName && typeof rec['version'] === 'string')
          return rec['version']
      }
    } catch {
      /* keep walking */
    }
    dir = path.dirname(dir)
  }
  return null
}

/**
 * A container started with `TZ=` (set, EMPTY) makes ICU answer `Etc/Unknown`,
 * a zone `Intl.DateTimeFormat` then throws on. Drop the empty value so this
 * process and every child it forks fall back to the system zone; a non-empty
 * `TZ` is kept as is.
 */
export function dropEmptyTimeZone(env: NodeJS.ProcessEnv): void {
  if (env['TZ'] === '') delete env['TZ']
}

/**
 * Run the shared starter flow. Never throws for boot-plan reasons — every
 * failure path degrades to the baked seed. (A `loadEntry` throw propagates:
 * that is the caller's fatal handler's job.)
 */
export function runNodeStarter(options: NodeStarterOptions): void {
  const env = options.env ?? process.env
  dropEmptyTimeZone(env)
  const now = options.now ?? Date.now
  const registerResolver = options.registerResolver ?? registerActiveRootResolver
  const nodeMajor =
    options.nodeMajor ?? Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)

  // ── 1. Workspace checkout → plain resolution, dev loop untouched ────────
  const disabled = env[options.envNames.killSwitch] === 'off'
  const workspaceRoot = detectWorkspaceRoot(options.starterDir)
  if (workspaceRoot !== null) {
    console.log(
      `[starter] workspace checkout detected at ${workspaceRoot} — using plain resolution`,
    )
    env[options.envNames.bootMode] = 'workspace'
    options.loadEntry(options.seedEntry)
    return
  }
  if (disabled) {
    console.log(`[starter] ${options.envNames.killSwitch}=off — booting the baked seed closure`)
    env[options.envNames.bootMode] = 'baked'
    options.loadEntry(options.seedEntry)
    return
  }

  const rootDir = serverRootDir(options.dataDir)

  // ── 2. Apply a staged swap, then migrate the legacy layout (idempotent) ──
  const swap = applyPendingRootSwap(
    rootDir,
    options.spec,
    nodeMajor,
    now,
    (m) => console.log(m),
    STARTER_HOSTS_SERVER_MIN,
  )
  if (swap.applied) console.log(`[starter] applied staged update → ${swap.version ?? '?'}`)
  else if (swap.reason !== 'no pending swap')
    console.warn(`[starter] staged update NOT applied: ${swap.reason}`)

  const migration = migrateToSingleCopy(rootDir, options.spec, nodeMajor, now, (m) =>
    console.log(m),
  )
  if (migration.migrated)
    console.log(`[starter] migrated legacy layout → single copy (${migration.version ?? '?'})`)

  // ── 3. Boot the single copy when valid, else the baked seed ─────────────
  const activeRootDir = currentDir(rootDir)
  const invalid = validateClosureDir(activeRootDir, nodeMajor, options.spec)
  if (invalid !== null && fs.existsSync(activeRootDir)) {
    console.warn(`[starter] single copy invalid: ${invalid}`)
  }
  // D989 at BOOT: the range this starter hosts is judged for a closure already on
  // disk too, not only for a staged one. There is no N-1 copy, so the previous
  // server a refusal can fall back to is the baked seed; the closure stays on disk
  // for an app update that raises the range. An unreadable version cannot be shown
  // to be in range.
  const activeVersion = invalid === null ? readClosureVersion(activeRootDir, options.spec) : null
  const outOfRange =
    invalid === null &&
    (activeVersion === null || compareSemver(activeVersion, STARTER_HOSTS_SERVER_MIN) < 0)
  if (outOfRange) {
    console.warn(
      `[starter] single copy ${activeVersion ?? 'with an unreadable version'} is below the ` +
        `${STARTER_HOSTS_SERVER_MIN} this starter hosts — booting the baked seed; update the app or the container image`,
    )
  }
  // The baked seed is the only thing left to boot, and it can be OLDER than a
  // server this data root already ran (its database and settings were migrated by
  // that one). Booting it silently is a downgrade nobody chose: refuse, loudly.
  if (outOfRange) {
    const lastBooted = readLastBooted(rootDir)
    const seedVersion = readSeedVersion(options.seedEntry, options.spec)
    if (
      lastBooted !== null &&
      (seedVersion === null || compareSemver(seedVersion, lastBooted) < 0)
    ) {
      const message =
        `[starter] REFUSING to boot the baked seed ${seedVersion ?? '(version unknown)'}: this data ` +
        `root last ran ${lastBooted} and the single copy on disk is ${activeVersion ?? 'unreadable'}. ` +
        `Restore the ${lastBooted} closure, or update the app / container image to ${lastBooted} or newer. ` +
        `${options.envNames.killSwitch}=off boots the baked seed anyway.`
      console.error(message)
      throw new Error(message)
    }
  }
  const plan: BootPlan = outOfRange
    ? { kind: 'baked', reason: 'the single copy is outside the range this starter hosts' }
    : planBoot(invalid === null)

  if (plan.kind === 'current') {
    const version = readClosureVersion(activeRootDir, options.spec)
    const entry = currentEntryPath(rootDir, options.spec)
    console.log(
      `[starter] booting ${options.spec.packageName}@${version ?? '?'} from ${activeRootDir}`,
    )
    env[options.envNames.bootMode] = 'data-root'
    // `activeRoot` IS the single copy — both node entries (hub launcher / agent
    // cli) derive `CAMSTACK_FRAMEWORK_DIR` (forked-runner resolver + NODE_PATH)
    // from it, so the runners resolve `@camstack/{system,types,…}` + native
    // prebuilds from the SAME copy hub-main loaded (no separate /data/framework).
    env[options.envNames.activeRoot] = activeRootDir
    if (version !== null) {
      env[options.envNames.activeVersion] = version
      recordLastBooted(rootDir, version)
    }
    registerResolver(activeRootDir)
    options.loadEntry(entry)
    return
  }

  console.log(`[starter] booting baked seed closure (${plan.reason})`)
  env[options.envNames.bootMode] = 'baked'
  options.loadEntry(options.seedEntry)
}
