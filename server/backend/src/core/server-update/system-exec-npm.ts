/**
 * `buildSystemExecNpm` — the `execNpm` the shared `RootUpdateService` uses to
 * shell out to npm when staging a root-package closure (`@camstack/server` —
 * the single root package for every node role).
 *
 * Two jobs:
 *
 * 1. Resolve a working npm. On a host with NO system npm on PATH — a packaged
 *    desktop app shipping a bare bundled Node — a raw `npm` dies with ENOENT.
 *    `@camstack/server/system`'s `resolveNpmInvocation` answers system →
 *    previously-bootstrapped copy under `cacheDir` → bootstrap from the
 *    registry. The `cacheDir` mirrors `AddonInstaller`'s
 *    (`<dataDir>/addons/.npm-bootstrap`) so both share one bootstrapped npm.
 * 2. Run it under the install watcher (`runWatchedCommand`): its own process
 *    group, the 5-minute stall cut for an `npm install` into a staging
 *    directory, and the caller's timeout as the hard ceiling. This adapter used
 *    to call `execFile` with only that ceiling (3 h). On 2026-11-15 the prod
 *    hub sat 28 minutes in node-av's ffmpeg postinstall and nothing cut it;
 *    `execFile`'s kill would also have left the postinstall grandchild alive.
 *
 * `deps` is the DI seam so the mapping is unit-testable without npm or disk.
 */
import * as path from 'node:path'
import { type NpmInvocation, buildNpmChildEnv, resolveNpmInvocation } from '@camstack/server/system'
import type { IScopedLogger } from '@camstack/types'
import {
  NPM_INSTALL_KILL_GRACE_MS,
  NPM_INSTALL_POLL_MS,
  NPM_INSTALL_STALL_MS,
  type NpmExecFn,
  type NpmInstallLogger,
  type RunWatchedCommandOptions,
  npmCommandWatchesProgress,
  npmInstallProgressDirs,
  runWatchedCommand,
} from '../../server-root/index.js'

export interface SystemExecNpmOptions {
  readonly cacheDir: string
  readonly logger: IScopedLogger
  readonly registry?: string | undefined
}

export interface SystemExecNpmDeps {
  readonly resolveInvocation: typeof resolveNpmInvocation
  readonly runWatched: (options: RunWatchedCommandOptions) => Promise<{ stdout: string }>
  /** Directories outside the staging dir whose growth is progress (npm cache). */
  readonly progressDirs: (env: NodeJS.ProcessEnv) => Promise<readonly string[]>
}

/**
 * The adapter's exact shape MUST match `RootUpdateServiceOptions.execNpm`
 * (`NpmExecFn`) so it is assignable at the construction sites with no cast —
 * in particular `opts.cwd` is optional there (the `npm view` check passes none).
 */
export type ExecNpmFn = NpmExecFn

const DEFAULT_DEPS: SystemExecNpmDeps = {
  resolveInvocation: resolveNpmInvocation,
  runWatched: runWatchedCommand,
  progressDirs: npmInstallProgressDirs,
}

function installLogger(logger: IScopedLogger): NpmInstallLogger {
  return {
    debug: (message, context) => logger.debug(message, context),
    info: (message, context) => logger.info(message, context),
    warn: (message, context) => logger.warn(message, context),
    error: (message, context) => logger.error(message, context),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function buildSystemExecNpm(
  options: SystemExecNpmOptions,
  deps: Partial<SystemExecNpmDeps> = {},
): ExecNpmFn {
  const resolved: SystemExecNpmDeps = { ...DEFAULT_DEPS, ...deps }
  const log = installLogger(options.logger)
  let progressDirsPromise: Promise<readonly string[]> | null = null
  return async (args, opts) => {
    const invocation: NpmInvocation = await resolved.resolveInvocation({
      cacheDir: options.cacheDir,
      registry: options.registry,
      logger: options.logger,
    })
    const env = buildNpmChildEnv(process.env, process.execPath)
    const watchProgress = npmCommandWatchesProgress(args, opts.cwd)
    progressDirsPromise ??= watchProgress ? resolved.progressDirs(env) : null
    const progressDirs =
      watchProgress && progressDirsPromise !== null ? await progressDirsPromise : undefined
    return resolved.runWatched({
      command: invocation.command,
      args: [...invocation.argsPrefix, ...args],
      cwd: opts.cwd ?? path.resolve(process.cwd()),
      stallMs: NPM_INSTALL_STALL_MS,
      ceilingMs: opts.timeoutMs,
      pollMs: NPM_INSTALL_POLL_MS,
      graceMs: NPM_INSTALL_KILL_GRACE_MS,
      now: Date.now,
      sleep,
      env,
      watchProgress,
      ...(progressDirs !== undefined ? { progressDirs } : {}),
      log,
    })
  }
}
