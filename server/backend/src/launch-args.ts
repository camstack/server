/**
 * NODE LAUNCH ARGUMENTS — decided by the server closure, executed by the image.
 *
 * `node <closure>/dist/launch-args.js --role hub|agent [--allocator-env]` prints
 * what the launcher should add to the node's command line, so the Docker
 * entrypoint, the Electron shell and the Windows service supervisor carry NO copy
 * of the formula: changing it (or a node's override) needs a closure update and a
 * restart, never a new image or app.
 *
 * Zero dependencies (node built-ins only): it runs BEFORE the closure's own
 * `node_modules` resolution, from either the active closure or the baked seed.
 *
 * ## Output (stdout, one record per line, `\n` separated)
 *
 *     arg --max-old-space-size=2048      an extra node argv entry (flags only)
 *     env NAME=value                     an environment variable to export
 *     source override|legacy-env|computed|v8-default
 *     warn <free text>                   something the launcher should log
 *
 * Nothing else is printed. A launcher treats any line it does not recognise as
 * absent, and a non-zero exit, a timeout or empty output as "no extra args".
 *
 * ## The heap ceiling
 *
 *  - `override` — `<dataDir>/launch-overrides.json` `{ "heapMb": N }`, set from
 *    the hub (`serverManagement.setLaunchOverrides`) and persisted on the node.
 *  - `legacy-env` — `CAMSTACK_HUB_HEAP_MB` (hub) / `CAMSTACK_AGENT_HEAP_MB`
 *    (agent), still honoured when no override is set.
 *  - `computed` — AGENT only: clamp(min(RAM, cgroup limit) / 4, 1536, 4096) MB.
 *    V8's own quarter-of-RAM rule with a floor above every measured agent RSS
 *    (0.8-1.4 GB), so it bounds a runaway and never a healthy root.
 *  - `v8-default` — HUB only, nothing set: no flag. A hardcoded 1536 killed the
 *    hub four times in 15 h (see the history in the Dockerfile); V8's default
 *    here was 4288 MB and is still bounded.
 *
 * Set on argv, never NODE_OPTIONS: forked addon runners are sized separately.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type LaunchRole = 'hub' | 'agent'
export type CeilingSource = 'override' | 'legacy-env' | 'computed' | 'v8-default'

export const LAUNCH_OVERRIDES_FILE = 'launch-overrides.json'
/** Env var carrying {@link CeilingSource} to the node so its heartbeat can say who chose. */
export const HEAP_CEILING_SOURCE_ENV = 'CAMSTACK_HEAP_CEILING_SOURCE'

export const AGENT_HEAP_FLOOR_MB = 1536
export const AGENT_HEAP_CAP_MB = 4096
/** An override outside this range is ignored with a warning, never applied. */
export const OVERRIDE_MIN_MB = 512
export const OVERRIDE_MAX_MB = 65536

/**
 * The native allocator pair, welded: glibc reads MALLOC_ARENA_MAX once at malloc
 * init, so it must exist before `exec node`; sharp restores libvips concurrency
 * from 1 to `availableParallelism()` the moment it appears, so the pair travels
 * together or not at all. Defaults only: an operator value already in the
 * environment wins (the launcher applies them with `: "${NAME:=value}"` semantics).
 */
export const ALLOCATOR_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  MALLOC_ARENA_MAX: '2',
  VIPS_CONCURRENCY: '1',
}

const BYTES_PER_MB = 1024 * 1024
/** cgroup v1 reports "unlimited" as a value near 2^63. */
const CGROUP_UNLIMITED_BYTES = 2 ** 60

export interface LaunchHost {
  readonly totalMemBytes: number
  /** The container memory limit, or `null` when none / unreadable. */
  readonly cgroupLimitBytes: number | null
}

export interface LaunchInput {
  readonly role: LaunchRole
  readonly host: LaunchHost
  /** The persisted per-node override in MB, or `null`. */
  readonly overrideMb: number | null
  /** The legacy env value for this role, verbatim, or `undefined`. */
  readonly legacyEnv: string | undefined
  readonly allocatorEnv: boolean
}

export interface LaunchPlan {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly source: CeilingSource
  readonly warnings: readonly string[]
}

function validMb(value: number): boolean {
  return Number.isInteger(value) && value >= OVERRIDE_MIN_MB && value <= OVERRIDE_MAX_MB
}

/** The agent's computed ceiling for `host`, in MB. */
export function computedAgentHeapMb(host: LaunchHost): number {
  const limits = [host.totalMemBytes, host.cgroupLimitBytes ?? Number.POSITIVE_INFINITY].filter(
    (n) => Number.isFinite(n) && n > 0,
  )
  if (limits.length === 0) return AGENT_HEAP_FLOOR_MB
  const quarterMb = Math.floor(Math.min(...limits) / BYTES_PER_MB / 4)
  return Math.min(AGENT_HEAP_CAP_MB, Math.max(AGENT_HEAP_FLOOR_MB, quarterMb))
}

export function planLaunch(input: LaunchInput): LaunchPlan {
  const warnings: string[] = []
  let source: CeilingSource = input.role === 'agent' ? 'computed' : 'v8-default'
  let heapMb: number | null = input.role === 'agent' ? computedAgentHeapMb(input.host) : null

  const legacy = input.legacyEnv
  if (legacy !== undefined && legacy !== '') {
    const mb = /^[1-9][0-9]*$/.test(legacy) ? Number(legacy) : Number.NaN
    if (validMb(mb)) {
      source = 'legacy-env'
      heapMb = mb
    } else {
      warnings.push(
        `ignoring the legacy heap env "${legacy}": not an integer in ${OVERRIDE_MIN_MB}-${OVERRIDE_MAX_MB} MB`,
      )
    }
  }
  if (input.overrideMb !== null) {
    if (validMb(input.overrideMb)) {
      source = 'override'
      heapMb = input.overrideMb
    } else {
      warnings.push(
        `ignoring the heap override ${input.overrideMb}: not an integer in ${OVERRIDE_MIN_MB}-${OVERRIDE_MAX_MB} MB`,
      )
    }
  }

  return {
    args: heapMb === null ? [] : [`--max-old-space-size=${heapMb}`],
    env: {
      [HEAP_CEILING_SOURCE_ENV]: source,
      ...(input.allocatorEnv ? ALLOCATOR_ENV_DEFAULTS : {}),
    },
    source,
    warnings,
  }
}

export function renderLaunchPlan(plan: LaunchPlan): string {
  const lines = [
    ...plan.args.map((a) => `arg ${a}`),
    ...Object.entries(plan.env).map(([k, v]) => `env ${k}=${v}`),
    `source ${plan.source}`,
    ...plan.warnings.map((w) => `warn ${w.replace(/[\r\n]+/g, ' ')}`),
  ]
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Reading the node: the override file and the host
// ---------------------------------------------------------------------------

export interface LaunchFs {
  readFile(file: string): string | null
}

const realFs: LaunchFs = {
  readFile(file) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
}

export function overridesPath(dataDir: string): string {
  return path.join(dataDir, LAUNCH_OVERRIDES_FILE)
}

/** The persisted heap override in MB; `null` when absent, unreadable or not a number. */
export function readHeapOverrideMb(dataDir: string, io: LaunchFs = realFs): number | null {
  const raw = io.readFile(overridesPath(dataDir))
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('heapMb' in parsed)) return null
    const value = parsed.heapMb
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

export function readCgroupLimitBytes(
  io: LaunchFs = realFs,
  files?: readonly string[],
): number | null {
  for (const file of files ?? [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ]) {
    const raw = io.readFile(file)?.trim()
    if (raw === undefined || !/^[0-9]+$/.test(raw)) continue
    const bytes = Number(raw)
    if (bytes > 0 && bytes < CGROUP_UNLIMITED_BYTES) return bytes
  }
  return null
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface LaunchCliDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly io: LaunchFs
  readonly totalMemBytes: number
  readonly cgroupFiles?: readonly string[]
}

function parseRole(argv: readonly string[]): LaunchRole | null {
  const i = argv.indexOf('--role')
  const value = i >= 0 ? argv[i + 1] : undefined
  return value === 'hub' || value === 'agent' ? value : null
}

/** Run the CLI; returns the stdout text and the exit code. Never throws. */
export function runLaunchCli(
  argv: readonly string[],
  deps: LaunchCliDeps,
): { readonly stdout: string; readonly code: number } {
  const role = parseRole(argv)
  if (role === null) return { stdout: '', code: 2 }
  const dataDir = path.resolve(deps.env['CAMSTACK_DATA'] ?? 'camstack-data')
  const legacyName = role === 'hub' ? 'CAMSTACK_HUB_HEAP_MB' : 'CAMSTACK_AGENT_HEAP_MB'
  const plan = planLaunch({
    role,
    host: {
      totalMemBytes: deps.totalMemBytes,
      cgroupLimitBytes: readCgroupLimitBytes(deps.io, deps.cgroupFiles),
    },
    overrideMb: readHeapOverrideMb(dataDir, deps.io),
    legacyEnv: deps.env[legacyName],
    allocatorEnv: argv.includes('--allocator-env'),
  })
  return { stdout: renderLaunchPlan(plan), code: 0 }
}

if (require.main === module) {
  const result = runLaunchCli(process.argv.slice(2), {
    env: process.env,
    io: realFs,
    totalMemBytes: os.totalmem(),
  })
  process.stdout.write(result.stdout)
  process.exitCode = result.code
}
