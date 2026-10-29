/**
 * Thin launcher for the node's launch arguments (ADR 0970).
 *
 * The decision — heap ceiling, per-node override — is made by the server
 * closure's `dist/launch-args.js`; this file only finds that module, runs it and
 * validates what it printed. It carries NO formula, so changing one needs a
 * closure update and a restart, never a new app.
 *
 * FAIL OPEN: a missing module, a non-zero exit, a timeout or garbage output
 * yields no extra args and ONE log line. The active closure's module wins over
 * the seed shipped beside the starter.
 *
 * Output format: see the header of `server/backend/src/launch-args.ts`.
 * Node built-ins only: the Windows service supervisor bundles this file.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LaunchArgsResult {
  /** Extra node argv entries, in order. */
  readonly args: readonly string[]
  /** Environment to add (the heap-ceiling source). Never the loader or the shell. */
  readonly env: Readonly<Record<string, string>>
  /** Who chose the ceiling, or `null` when no plan was usable. */
  readonly source: string | null
  /** One line per thing worth logging; empty on a clean run. */
  readonly notes: readonly string[]
}

const NO_PLAN: LaunchArgsResult = { args: [], env: {}, source: null, notes: [] }

const ARG_PATTERN = /^--[A-Za-z0-9._-]+(=[A-Za-z0-9._-]+)?$/
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/
const ENV_VALUE_PATTERN = /^[A-Za-z0-9._-]*$/
const ENV_REFUSED = /^(LD_|DYLD_|NODE_)|^(PATH|HOME|SHELL|IFS|USER)$/

/** Parse the module's stdout; unknown or malformed lines are dropped. */
export function parseLaunchOutput(stdout: string): LaunchArgsResult {
  const args: string[] = []
  const env: Record<string, string> = {}
  const notes: string[] = []
  let source: string | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('arg ')) {
      const value = line.slice(4)
      if (ARG_PATTERN.test(value)) args.push(value)
    } else if (line.startsWith('env ')) {
      const kv = line.slice(4)
      const eq = kv.indexOf('=')
      if (eq <= 0) continue
      const name = kv.slice(0, eq)
      const value = kv.slice(eq + 1)
      if (ENV_NAME_PATTERN.test(name) && !ENV_REFUSED.test(name) && ENV_VALUE_PATTERN.test(value)) {
        env[name] = value
      }
    } else if (line.startsWith('source ')) {
      source = line.slice(7)
    } else if (line.startsWith('warn ')) {
      notes.push(`launch-args: ${line.slice(5)}`)
    }
  }
  if (source === null) {
    return {
      ...NO_PLAN,
      notes: [...notes, 'launch-args printed no usable plan — no extra node args'],
    }
  }
  return { args, env, source, notes }
}

/** Where the module may live, in preference order: the active closure, then the seed. */
export function launchArgsCandidates(dataDir: string, starterPath: string): readonly string[] {
  return [
    join(
      dataDir,
      'server-root',
      'current',
      'node_modules',
      '@camstack',
      'server',
      'dist',
      'launch-args.js',
    ),
    join(dirname(starterPath), 'launch-args.js'),
  ]
}

export interface ResolveLaunchArgsOptions {
  readonly role: 'hub' | 'agent'
  readonly dataDir: string
  readonly starterPath: string
  /** The node binary that will run the module (the bundled one, else Electron-as-Node). */
  readonly nodeExecPath: string
  readonly runAsElectron: boolean
  readonly env: NodeJS.ProcessEnv
  /** Test seams. */
  readonly fileExists?: (file: string) => boolean
  readonly run?: (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => string
}

const MODULE_TIMEOUT_MS = 10_000

function runModule(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(bin, [...args], {
    env,
    encoding: 'utf8',
    timeout: MODULE_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

export function resolveLaunchArgs(options: ResolveLaunchArgsOptions): LaunchArgsResult {
  const exists = options.fileExists ?? existsSync
  const run = options.run ?? runModule
  const moduleJs = launchArgsCandidates(options.dataDir, options.starterPath).find((f) => exists(f))
  if (moduleJs === undefined) {
    return { ...NO_PLAN, notes: ['launch-args module not found — no extra node args'] }
  }
  try {
    const env: NodeJS.ProcessEnv = {
      ...options.env,
      CAMSTACK_DATA: options.dataDir,
      ...(options.runAsElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    }
    return parseLaunchOutput(run(options.nodeExecPath, [moduleJs, '--role', options.role], env))
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return { ...NO_PLAN, notes: [`launch-args failed (${reason}) — no extra node args`] }
  }
}
