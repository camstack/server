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
 *      packages (@camstack/system, …) from `current/node_modules`, point the
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
import { planBoot } from './boot-plan.js'
import type { RootPackageSpec } from './root-package-spec.js'
import { rootPackageDir, serverRootDir, validateClosureDir } from './root-state.js'
import {
  applyPendingRootSwap,
  currentDir,
  currentEntryPath,
  migrateToSingleCopy,
} from './root-single-copy.js'
import { detectWorkspaceRoot } from './workspace-detect.js'

/**
 * Mirror of the host-external list in
 * `packages/system/src/kernel/moleculer/framework-resolver-hook.mjs` — kept
 * inline because the starter must stay zero-dep. Only these specifiers are
 * redirected to the active root; everything else resolves normally.
 */
export const HOST_EXTERNAL_SPECIFIERS: readonly string[] = [
  '@camstack/system',
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

/**
 * Run the shared starter flow. Never throws for boot-plan reasons — every
 * failure path degrades to the baked seed. (A `loadEntry` throw propagates:
 * that is the caller's fatal handler's job.)
 */
export function runNodeStarter(options: NodeStarterOptions): void {
  const env = options.env ?? process.env
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
  const swap = applyPendingRootSwap(rootDir, options.spec, nodeMajor, now, (m) => console.log(m))
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
  const plan = planBoot(invalid === null)

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
    if (version !== null) env[options.envNames.activeVersion] = version
    registerResolver(activeRootDir)
    options.loadEntry(entry)
    return
  }

  console.log(`[starter] booting baked seed closure (${plan.reason})`)
  env[options.envNames.bootMode] = 'baked'
  options.loadEntry(options.seedEntry)
}
