/**
 * Run `npm install` in its own process group and stop it when nothing it
 * writes is growing — not when a wall clock expires.
 *
 * Observed 2026-11-12 on little-unraid: `execFile`'s `timeout` killed `npm`
 * at 15 minutes while `node-av`'s postinstall (`node dist/ffmpeg/install.js`)
 * kept downloading ffmpeg. The install had no stall detection, so a slow
 * fetch was cut and the grandchild was left running. The staging state
 * stayed `staging`.
 *
 * node-av writes the zip to `<package>/binary/ffmpeg-*-<platform>.zip` and
 * extracts it to `<package>/binary/ffmpeg` (next to `dist/ffmpeg/install.js`).
 * Once the package sits under the staging `node_modules`, that directory is
 * the staging tree. npm's own tarball fetch writes the cache outside it, and
 * the postinstall prints progress on stdout. Any of those is progress.
 *
 * The child is spawned `detached` so it is a process-group leader. A stall
 * or the hard ceiling signals the GROUP (`SIGTERM`, then `SIGKILL`), which
 * is the only way the grandchild dies too. Windows uses `taskkill /PID /T /F`.
 * `spawn('npm.cmd')` without a shell throws EINVAL on Node ≥ 20.12, so npm
 * is started as `node npm-cli.js` (beside the node binary, or `npm_execpath`).
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** No growth in the staging directory for this long cuts the install. */
export const NPM_INSTALL_STALL_MS: number = 5 * 60_000

/**
 * Hard ceiling, independent of progress. A download that keeps writing must
 * be allowed to finish past the old 15-minute wall clock; this only bounds a
 * process that never exits.
 */
export const NPM_INSTALL_CEILING_MS: number = 3 * 60 * 60_000

/**
 * How often progress is measured. A full walk of `node_modules` and the npm
 * cache on the slow box was the cost; this period plus a top-level mark
 * (not a recursive byte walk) is the bound.
 */
export const NPM_INSTALL_POLL_MS = 30_000

/** After SIGTERM, how long the group has to exit before SIGKILL. */
export const NPM_INSTALL_KILL_GRACE_MS = 5_000

/**
 * After the kill, how long to wait for the leader's `exit` before reporting
 * the cut anyway. A child that never exits must not leave the update in
 * `staging`.
 */
export const NPM_INSTALL_EXIT_WAIT_MS = 10_000

/** `npm config get cache` is a lookup, not an install. */
const NPM_CONFIG_CACHE_TIMEOUT_MS = 10_000

const NPM_CACHE_INDEX = path.join('_cacache', 'index-v5')

const OUTPUT_CAP_CHARS = 64 * 1024

const PIPED_STDIO = ['ignore', 'pipe', 'pipe'] as const

export type NpmInstallFailureKind = 'timeout-stall' | 'timeout-ceiling' | 'nonzero-exit'

export class NpmInstallError extends Error {
  readonly kind: NpmInstallFailureKind
  readonly stagingDir: string
  readonly code: number | null

  constructor(
    kind: NpmInstallFailureKind,
    stagingDir: string,
    code: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'NpmInstallError'
    this.kind = kind
    this.stagingDir = stagingDir
    this.code = code
  }
}

export interface NpmInstallLogger {
  info(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  warn(message: string, context?: { readonly meta?: Record<string, unknown> }): void
  error(message: string, context?: { readonly meta?: Record<string, unknown> }): void
}

export interface WatchedByteStream {
  setEncoding(encoding: 'utf8'): void
  on(event: 'data', listener: (chunk: string) => void): void
}

export interface WatchedChild {
  readonly pid: number | undefined
  readonly stdout: WatchedByteStream | null
  readonly stderr: WatchedByteStream | null
  onError(listener: (error: Error) => void): void
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

export interface WatchedSpawnOptions {
  readonly cwd?: string
  readonly detached: boolean
  readonly windowsHide: boolean
  readonly stdio: 'ignore' | readonly ['ignore', 'pipe', 'pipe']
  readonly env: NodeJS.ProcessEnv
  readonly shell: boolean
}

export type WatchedSpawner = (
  command: string,
  args: readonly string[],
  options: WatchedSpawnOptions,
) => WatchedChild

export interface RunWatchedCommandOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly stallMs: number
  readonly ceilingMs: number
  readonly pollMs: number
  readonly graceMs: number
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly log: NpmInstallLogger
  /** Directories outside `cwd` whose growth is also progress (npm cache). */
  readonly progressDirs?: readonly string[]
  readonly platform?: NodeJS.Platform
  readonly execPath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly spawnProcess?: WatchedSpawner
}

export interface NpmLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly shell: boolean
}

interface CommandExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error: Error | null
}

type CutKind = 'timeout-stall' | 'timeout-ceiling'

export type NpmCacheReader = (env: NodeJS.ProcessEnv) => Promise<string>

function configuredNpmCache(env: NodeJS.ProcessEnv): string | null {
  const configured = env['npm_config_cache'] ?? env['NPM_CONFIG_CACHE']
  if (typeof configured === 'string' && configured.length > 0) return configured
  return null
}

function parseNpmCacheDir(stdout: string): string | null {
  const line = stdout.trim()
  if (line.length === 0 || line === 'undefined' || line === 'null') return null
  return line
}

function readNpmConfigCache(env: NodeJS.ProcessEnv): Promise<string> {
  const launch = npmProcessLaunch(process.platform, process.execPath, env, [
    'config',
    'get',
    'cache',
  ])
  return new Promise((resolve, reject) => {
    execFile(
      launch.command,
      [...launch.args],
      {
        env,
        timeout: NPM_CONFIG_CACHE_TIMEOUT_MS,
        windowsHide: true,
        shell: launch.shell,
      },
      (err, stdout) => {
        if (err !== null) reject(err)
        else resolve(stdout)
      },
    )
  })
}

/**
 * Where npm stores tarballs while it downloads them. Outside the staging
 * directory, so a slow registry fetch does not look like a stall. The
 * directory is `npm config get cache` (or `npm_config_cache`), read by the
 * caller once per update — not `~/.npm`, and not on each poll.
 */
export async function npmInstallProgressDirs(
  env: NodeJS.ProcessEnv,
  readCache: NpmCacheReader = readNpmConfigCache,
): Promise<readonly string[]> {
  const configured = configuredNpmCache(env)
  if (configured !== null) return [configured]
  try {
    const dir = parseNpmCacheDir(await readCache(env))
    return dir === null ? [] : [dir]
  } catch {
    return []
  }
}

/** `npm_execpath`, else `npm-cli.js` next to the node binary (Windows and Unix layouts). */
export function resolveNpmCliJs(execPath: string, env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env['npm_execpath']
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && fs.existsSync(fromEnv)) return fromEnv
  const nodeDir = path.dirname(execPath)
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function quoteCmdArg(arg: string): string {
  if (!/[\s"&|<>^%]/.test(arg)) return arg
  return `"${arg.replaceAll('"', '""')}"`
}

/**
 * Argv that does not `spawn('npm.cmd')` without a shell. Node ≥ 20.12 throws
 * EINVAL for that. Prefer `node npm-cli.js`; on Windows with no cli, `npm.cmd`
 * runs with `shell: true` and quoted arguments.
 */
export function npmProcessLaunch(
  platform: NodeJS.Platform,
  execPath: string,
  env: NodeJS.ProcessEnv,
  npmArgs: readonly string[],
): NpmLaunch {
  const cli = resolveNpmCliJs(execPath, env)
  if (cli !== null) return { command: execPath, args: [cli, ...npmArgs], shell: false }
  if (platform === 'win32') {
    return { command: 'npm.cmd', args: npmArgs.map(quoteCmdArg), shell: true }
  }
  return { command: 'npm', args: [...npmArgs], shell: false }
}

/**
 * A number that grows when the install is moving, without walking
 * `node_modules` or the npm cache.
 *
 * Counted: the directory's own entries (count, mtime, and file size) and
 * one level of children — enough to see a new package appear — plus the
 * byte size of `<cache>/_cacache/index-v5`. A zip that only grows under a
 * package's nested `binary/` does not move this mark; stdout and the cache
 * index still do. A path that disappears mid-read is skipped.
 */
async function progressMark(dir: string): Promise<number> {
  const index = await cacheIndexMark(path.join(dir, NPM_CACHE_INDEX))
  return index + (await levelMark(dir))
}

async function cacheIndexMark(indexPath: string): Promise<number> {
  let st: fs.Stats
  try {
    st = await fs.promises.lstat(indexPath)
  } catch {
    return 0
  }
  if (st.isSymbolicLink()) return st.mtimeMs
  if (st.isFile()) return st.size + st.mtimeMs
  if (!st.isDirectory()) return st.mtimeMs
  let names: fs.Dirent[]
  try {
    names = await fs.promises.readdir(indexPath, { withFileTypes: true })
  } catch {
    return st.mtimeMs
  }
  let mark = names.length + st.mtimeMs
  for (const entry of names) {
    if (!entry.isFile()) continue
    try {
      const child = await fs.promises.stat(path.join(indexPath, entry.name))
      mark += child.size
    } catch {
      // Vanished between readdir and stat — the install is still moving.
    }
  }
  return mark
}

async function statMark(full: string): Promise<number> {
  try {
    const st = await fs.promises.lstat(full)
    if (st.isSymbolicLink()) return st.mtimeMs
    if (st.isFile()) return st.size + st.mtimeMs
    return st.mtimeMs
  } catch {
    return 0
  }
}

/** The directory itself, plus one level of children. `_cacache` is the index only. */
async function levelMark(dir: string): Promise<number> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let mark = entries.length
  for (const entry of entries) {
    if (entry.name === '_cacache') continue
    const full = path.join(dir, entry.name)
    mark += await statMark(full)
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    mark += await childMark(full)
  }
  return mark
}

async function childMark(dir: string): Promise<number> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let mark = entries.length
  for (const entry of entries) {
    mark += await statMark(path.join(dir, entry.name))
  }
  return mark
}

async function treeProgress(dirs: readonly string[]): Promise<number> {
  let total = 0
  for (const dir of dirs) total += await progressMark(dir)
  return total
}

function tail(text: string): string {
  return text.length > OUTPUT_CAP_CHARS ? text.slice(text.length - OUTPUT_CAP_CHARS) : text
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function asStream(stream: NodeJS.ReadableStream | null): WatchedByteStream | null {
  if (stream === null) return null
  return {
    setEncoding(encoding) {
      stream.setEncoding(encoding)
    },
    on(_event, listener) {
      stream.on('data', (chunk: string | Buffer) => {
        listener(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      })
    },
  }
}

function adoptChild(child: ChildProcess): WatchedChild {
  return {
    pid: child.pid,
    stdout: asStream(child.stdout),
    stderr: asStream(child.stderr),
    onError(listener) {
      child.once('error', listener)
    },
    onExit(listener) {
      child.once('exit', listener)
    },
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: WatchedSpawnOptions,
): WatchedChild {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    detached: options.detached,
    windowsHide: options.windowsHide,
    stdio: options.stdio === 'ignore' ? 'ignore' : [...PIPED_STDIO],
    env: options.env,
    ...(options.shell ? { shell: true } : {}),
  })
  return adoptChild(child)
}

function resolveLaunch(options: RunWatchedCommandOptions): NpmLaunch {
  const env = options.env ?? process.env
  if (options.command !== 'npm' && options.command !== 'npm.cmd') {
    return { command: options.command, args: [...options.args], shell: false }
  }
  return npmProcessLaunch(
    options.platform ?? process.platform,
    options.execPath ?? process.execPath,
    env,
    options.args,
  )
}

async function killProcessGroup(
  pid: number,
  platform: NodeJS.Platform,
  graceMs: number,
  sleep: (ms: number) => Promise<void>,
  spawnProcess: WatchedSpawner,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
        detached: false,
        windowsHide: true,
        stdio: 'ignore',
        env,
        shell: false,
      })
      killer.onExit(() => resolve())
      killer.onError(() => resolve())
    })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // The group is already gone.
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // The leader is already gone.
  }
  await sleep(graceMs)
  // The leader often dies on SIGTERM while a grandchild that traps it stays
  // in the group. SIGKILL the group whenever it still exists.
  if (!groupExists(pid)) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Already reaped.
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already reaped.
  }
}

function attachOutput(
  child: WatchedChild,
  note: (chunk: string, sink: 'out' | 'err') => void,
): void {
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => note(chunk, 'out'))
  child.stderr?.on('data', (chunk) => note(chunk, 'err'))
}

/**
 * Spawn `command` detached (its own process group) and resolve when it
 * exits. Rejects with {@link NpmInstallError} on a non-zero exit, a stall,
 * or the hard ceiling. The staging directory is `cwd`.
 */
export async function runWatchedCommand(
  options: RunWatchedCommandOptions,
): Promise<{ stdout: string }> {
  const { cwd, log } = options
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const spawnProcess = options.spawnProcess ?? defaultSpawn
  const launch = resolveLaunch(options)
  const startedAt = options.now()
  let lastGrowthAt = startedAt
  const watchedDirs = [cwd, ...(options.progressDirs ?? [])]
  let lastSize = await treeProgress(watchedDirs)
  let lastOutput = 0
  let outputBytes = 0
  let stdout = ''
  let stderr = ''

  const child = spawnProcess(launch.command, launch.args, {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: PIPED_STDIO,
    env,
    shell: launch.shell,
  })
  const pid = child.pid
  if (pid === undefined) {
    throw new NpmInstallError(
      'nonzero-exit',
      cwd,
      null,
      `failed to spawn ${launch.command}: no pid`,
    )
  }

  attachOutput(child, (chunk, sink) => {
    outputBytes += chunk.length
    if (sink === 'out') stdout = tail(stdout + chunk)
    else stderr = tail(stderr + chunk)
  })

  let exit: CommandExit | null = null
  const exitPromise = new Promise<void>((resolve) => {
    child.onError((error) => {
      exit = { code: null, signal: null, error }
      resolve()
    })
    child.onExit((code, signal) => {
      exit = { code, signal, error: null }
      resolve()
    })
  })

  const cut = await pollUntilCut(options, exitPromise, () => exit, {
    watchedDirs,
    readOutput: () => outputBytes,
    startedAt,
    lastGrowthAt: () => lastGrowthAt,
    lastSize: () => lastSize,
    lastOutput: () => lastOutput,
    mark(size, output, at) {
      lastSize = size
      lastOutput = output
      lastGrowthAt = at
    },
  })

  if (cut !== null) {
    await killProcessGroup(pid, platform, options.graceMs, options.sleep, spawnProcess, env)
    const exited = await waitForExit(exitPromise, options.sleep, NPM_INSTALL_EXIT_WAIT_MS)
    const message =
      cut === 'timeout-stall'
        ? `npm install stalled: no progress for ${options.stallMs}ms in ${cwd}`
        : `npm install hit the hard ceiling (${options.ceilingMs}ms) in ${cwd}`
    if (!exited) {
      log.error('npm install did not exit after the cut', {
        meta: { stagingDir: cwd, kind: cut, pid, error: message },
      })
    }
    log.error('npm install cut', {
      meta: { stagingDir: cwd, kind: cut, pid, error: message },
    })
    throw new NpmInstallError(cut, cwd, null, message)
  }

  return finishExit(exit, cwd, stdout, stderr, log)
}

interface ProgressCursor {
  readonly watchedDirs: readonly string[]
  readOutput(): number
  readonly startedAt: number
  lastGrowthAt(): number
  lastSize(): number
  lastOutput(): number
  mark(size: number, output: number, at: number): void
}

async function pollUntilCut(
  options: RunWatchedCommandOptions,
  exitPromise: Promise<void>,
  readExit: () => CommandExit | null,
  cursor: ProgressCursor,
): Promise<CutKind | null> {
  while (readExit() === null) {
    await Promise.race([options.sleep(options.pollMs), exitPromise])
    if (readExit() !== null) return null
    const size = await treeProgress(cursor.watchedDirs)
    const output = cursor.readOutput()
    const now = options.now()
    const grew = size > cursor.lastSize() || output > cursor.lastOutput()
    if (grew) cursor.mark(size, output, now)
    if (now - cursor.lastGrowthAt() >= options.stallMs) return 'timeout-stall'
    if (now - cursor.startedAt >= options.ceilingMs) return 'timeout-ceiling'
  }
  return null
}

async function waitForExit(
  exitPromise: Promise<void>,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let exited = false
  const finished = exitPromise.then(() => {
    exited = true
  })
  await Promise.race([finished, sleep(timeoutMs)])
  return exited
}

function finishExit(
  exit: CommandExit | null,
  cwd: string,
  stdout: string,
  stderr: string,
  log: NpmInstallLogger,
): { stdout: string } {
  const finished: CommandExit = exit ?? { code: null, signal: null, error: null }
  const code = finished.code
  const spawnError = finished.error
  const detail = spawnError === null ? stderr.trim() : spawnError.message
  log.info('npm install exited', {
    meta: {
      stagingDir: cwd,
      kind: 'exit',
      code,
      signal: finished.signal,
      ...(detail.length > 0 ? { error: detail } : {}),
    },
  })
  if (finished.error !== null || code !== 0) {
    throw new NpmInstallError(
      'nonzero-exit',
      cwd,
      code,
      detail.length > 0 ? detail : `npm install exited ${code ?? 'null'} in ${cwd}`,
    )
  }
  return { stdout }
}
