/**
 * `buildSystemExecNpm` — the runNpm-backed `execNpm` the shared
 * `RootUpdateService` uses to shell out to npm when staging a root-package
 * closure (`@camstack/server` — the single root package for every node role).
 *
 * The engine's built-in default is a raw `execFile('npm', ...)`: on a host with
 * NO system npm on PATH — a packaged desktop app shipping a bare bundled Node —
 * that dies with ENOENT and a root update can never stage. Routing through
 * `@camstack/system`'s `runNpm` solves it uniformly: resolve a working npm
 * (system → previously-bootstrapped copy under `cacheDir` → bootstrap from the
 * registry) and run the SAME args with it. The `cacheDir` mirrors the value
 * `AddonInstaller` uses for its own npm bootstrap (`<dataDir>/addons/.npm-bootstrap`)
 * so both share one bootstrapped npm per host.
 *
 * `runNpmFn` is a module-level DI seam (defaults to the real `runNpm`) so the
 * arg/cwd/timeout mapping is unit-testable without touching the network.
 */
import { runNpm, type RunNpmOptions } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import type { NpmExecFn } from '../../server-root/index.js'

type RunNpmFn = (
  args: readonly string[],
  options: RunNpmOptions,
) => Promise<{ stdout: string; stderr: string }>

export interface SystemExecNpmOptions {
  readonly cacheDir: string
  readonly logger: IScopedLogger
  readonly registry?: string | undefined
}

/**
 * The adapter's exact shape MUST match `RootUpdateServiceOptions.execNpm`
 * (`NpmExecFn`) so it is assignable at the construction sites with no cast —
 * in particular `opts.cwd` is optional there (the `npm view` check passes none).
 */
export type ExecNpmFn = NpmExecFn

export function buildSystemExecNpm(
  options: SystemExecNpmOptions,
  runNpmFn: RunNpmFn = runNpm,
): ExecNpmFn {
  return async (args, opts) => {
    const { stdout } = await runNpmFn(args, {
      cacheDir: options.cacheDir,
      registry: options.registry,
      logger: options.logger,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      timeout: opts.timeoutMs,
    })
    return { stdout }
  }
}
