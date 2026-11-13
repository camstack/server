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
 * the postinstall prints progress on stdout. Any of those is progress, including
 * a file that shrinks when a postinstall deletes its zip.
 *
 * Only `npm install` into an explicit staging directory is walked. `npm view`,
 * `npm ls`, and a cwd of `process.cwd()` (a Finder-launched app's `/`) get the
 * hard ceiling only. The walk itself is bounded: a poll that cannot finish is
 * progress unknown, not a stall.
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
import {
  type ProgressMark,
  type ProgressSample,
  type ProgressUnknown,
  measureInstallProgress,
} from './npm-install-progress.js'

/** No growth in the staging directory for this long cuts the install. */
export const NPM_INSTALL_STALL_MS: number = 5 * 60_000

/**
 * Hard ceiling, independent of progress. A download that keeps writing must
 * be allowed to finish past the old 15-minute wall clock; this only bounds a
 * process that never exits.
 */
export const NPM_INSTALL_CEILING_MS: number = 3 * 60 * 60_000

/**
 * How often progress is measured. Each poll reads a few directory inodes and,
 * only when those are unchanged, a byte walk that stops after a fixed entry
 * and time budget. Polling less often keeps the slow box from thrashing disk.
 */
export const NPM_INSTALL_POLL_MS: number = 60_000

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
  debug?(message: string, context?: { readonly meta?: Record<string, unknown> }): void
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
  /**
   * Walk the staging tree and cut a stall. Set only for `npm install` into
   * an explicit directory. Omitted: npm subcommands other than `install` are
   * ceiling-only, and `process.cwd()` is never walked.
   */
  readonly watchProgress?: boolean
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

/** Stall detection applies only to `npm install` in a directory the caller named. */
export function npmCommandWatchesProgress(
  args: readonly string[],
  cwd: string | undefined,
): boolean {
  return args[0] === 'install' && cwd !== undefined
}

/** Log and error text name the npm subcommand (`npm view`, `npm ls`, `npm install`). */
export function watchedCommandLabel(command: string, args: readonly string[]): string {
  if (command !== 'npm' && command !== 'npm.cmd') return 'npm install'
  const sub = args[0]
  if (sub === undefined || sub.length === 0) return 'npm'
  return `npm ${sub}`
}

function shouldWatchProgress(options: RunWatchedCommandOptions): boolean {
  if (path.resolve(options.cwd) === path.resolve(process.cwd())) return false
  if (options.watchProgress === false) return false
  if (options.watchProgress === true) return true
  if (options.command === 'npm' || options.command === 'npm.cmd') {
    return options.args[0] === 'install'
  }
  return true
}

function cutMessage(
  label: string,
  cut: CutKind,
  options: RunWatchedCommandOptions,
  cwd: string,
): string {
  if (cut === 'timeout-stall') {
    return `${label} stalled: no progress for ${options.stallMs}ms in ${cwd}`
  }
  if (label === 'npm install') {
    return `${label} hit the hard ceiling (${options.ceilingMs}ms) in ${cwd}`
  }
  return `${label} timed out after ${options.ceilingMs}ms in ${cwd}`
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
 * or the hard ceiling. The staging directory is `cwd`. A non-zero exit also
 * signals the group, so a grandchild does not outlive npm.
 */
export async function runWatchedCommand(
  options: RunWatchedCommandOptions,
): Promise<{ stdout: string }> {
  const opened = await openWatchedChild(options)
  const cut = await pollUntilCut(options, opened.exitPromise, opened.readExit, opened.watch)
  if (cut !== null) return failCut(options, opened, cut)
  const exit = opened.readExit()
  if (exitFailed(exit)) await killOpenedGroup(options, opened)
  return finishExit(exit, options.cwd, opened.stdout(), opened.stderr(), options.log, opened.label)
}

interface DiskBaseline {
  readonly cheap: string | null
  readonly bytes: number | null
}

interface PollWatch {
  readonly enabled: boolean
  readonly startedAt: number
  baseline: DiskBaseline
  lastOutput: number
  lastGrowthAt: number
  readOutput(): number
  measure(): Promise<ProgressSample>
  noteUnknown(sample: ProgressUnknown): void
}

interface OpenedCommand {
  readonly pid: number
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly spawnProcess: WatchedSpawner
  readonly label: string
  readonly exitPromise: Promise<void>
  readonly watch: PollWatch
  readExit(): CommandExit | null
  stdout(): string
  stderr(): string
}

function exitFailed(exit: CommandExit | null): boolean {
  return exit !== null && (exit.error !== null || exit.code !== 0)
}

function progressReader(
  options: RunWatchedCommandOptions,
  previousCheap: () => string | null,
  aborted: () => boolean,
): () => Promise<ProgressSample> {
  return () =>
    measureInstallProgress({
      stagingDir: options.cwd,
      progressDirs: options.progressDirs ?? [],
      env: options.env ?? {},
      previousCheap: previousCheap(),
      aborted,
    })
}

async function seedBaseline(watch: PollWatch): Promise<void> {
  if (!watch.enabled) return
  const initial = await watch.measure()
  if (initial.kind === 'unknown') watch.noteUnknown(initial)
  if (initial.kind === 'mark') {
    watch.baseline = { cheap: initial.cheap, bytes: initial.bytes }
  }
}

function budgetLogger(options: RunWatchedCommandOptions): (sample: ProgressUnknown) => void {
  let logged = false
  return (sample) => {
    if (logged) return
    logged = true
    options.log.debug?.('install progress walk hit its budget', {
      meta: { stagingDir: options.cwd, entries: sample.entries, elapsedMs: sample.elapsedMs },
    })
  }
}

interface CapturedOutput {
  bytes: number
  stdout: string
  stderr: string
}

async function prepareWatch(
  options: RunWatchedCommandOptions,
  readOutput: () => number,
): Promise<PollWatch> {
  const startedAt = options.now()
  const watch: PollWatch = {
    enabled: shouldWatchProgress(options),
    startedAt,
    baseline: { cheap: null, bytes: null },
    lastOutput: 0,
    lastGrowthAt: startedAt,
    readOutput,
    measure: () => Promise.resolve({ kind: 'aborted', entries: 0 }),
    noteUnknown: budgetLogger(options),
  }
  watch.measure = progressReader(
    options,
    () => watch.baseline.cheap,
    () => false,
  )
  await seedBaseline(watch)
  return watch
}

function bindAbortableMeasure(
  options: RunWatchedCommandOptions,
  watch: PollWatch,
  aborted: () => boolean,
): void {
  watch.measure = progressReader(options, () => watch.baseline.cheap, aborted)
}

function noteChildOutput(output: CapturedOutput, chunk: string, sink: 'out' | 'err'): void {
  output.bytes += chunk.length
  if (sink === 'out') output.stdout = tail(output.stdout + chunk)
  else output.stderr = tail(output.stderr + chunk)
}

interface ChildExit {
  readonly promise: Promise<void>
  read(): CommandExit | null
}

function listenForExit(child: WatchedChild): ChildExit {
  let exit: CommandExit | null = null
  const promise = new Promise<void>((resolve) => {
    child.onError((error) => {
      exit = { code: null, signal: null, error }
      resolve()
    })
    child.onExit((code, signal) => {
      exit = { code, signal, error: null }
      resolve()
    })
  })
  return { promise, read: () => exit }
}

function requirePid(child: WatchedChild, cwd: string, command: string): number {
  const pid = child.pid
  if (pid !== undefined) return pid
  throw new NpmInstallError('nonzero-exit', cwd, null, `failed to spawn ${command}: no pid`)
}

async function openWatchedChild(options: RunWatchedCommandOptions): Promise<OpenedCommand> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const spawnProcess = options.spawnProcess ?? defaultSpawn
  const launch = resolveLaunch(options)
  const output: CapturedOutput = { bytes: 0, stdout: '', stderr: '' }
  const watch = await prepareWatch(options, () => output.bytes)
  const child = spawnProcess(launch.command, launch.args, {
    cwd: options.cwd,
    detached: true,
    windowsHide: true,
    stdio: PIPED_STDIO,
    env,
    shell: launch.shell,
  })
  const pid = requirePid(child, options.cwd, launch.command)
  attachOutput(child, (chunk, sink) => noteChildOutput(output, chunk, sink))
  const exit = listenForExit(child)
  bindAbortableMeasure(options, watch, () => exit.read() !== null)
  return {
    pid,
    platform,
    env,
    spawnProcess,
    label: watchedCommandLabel(options.command, options.args),
    exitPromise: exit.promise,
    watch,
    readExit: exit.read,
    stdout: () => output.stdout,
    stderr: () => output.stderr,
  }
}

async function killOpenedGroup(
  options: RunWatchedCommandOptions,
  opened: OpenedCommand,
): Promise<void> {
  await killProcessGroup(
    opened.pid,
    opened.platform,
    options.graceMs,
    options.sleep,
    opened.spawnProcess,
    opened.env,
  )
}

async function failCut(
  options: RunWatchedCommandOptions,
  opened: OpenedCommand,
  cut: CutKind,
): Promise<never> {
  await killOpenedGroup(options, opened)
  const exited = await waitForExit(opened.exitPromise, options.sleep, NPM_INSTALL_EXIT_WAIT_MS)
  const message = cutMessage(opened.label, cut, options, options.cwd)
  if (!exited) {
    options.log.error(`${opened.label} did not exit after the cut`, {
      meta: { stagingDir: options.cwd, kind: cut, pid: opened.pid, error: message },
    })
  }
  options.log.error(`${opened.label} cut`, {
    meta: { stagingDir: options.cwd, kind: cut, pid: opened.pid, error: message },
  })
  throw new NpmInstallError(cut, options.cwd, null, message)
}

function noteSample(watch: PollWatch, sample: ProgressMark, output: number, now: number): void {
  const first = watch.baseline.cheap === null && watch.baseline.bytes === null
  const cheapChanged = !first && sample.cheap !== watch.baseline.cheap
  const bytesChanged =
    sample.bytes !== null && watch.baseline.bytes !== null && sample.bytes !== watch.baseline.bytes
  const changed = cheapChanged || bytesChanged || output !== watch.lastOutput
  watch.baseline = {
    cheap: sample.cheap,
    bytes: sample.bytes === null ? watch.baseline.bytes : sample.bytes,
  }
  watch.lastOutput = output
  if (changed || first) watch.lastGrowthAt = now
}

async function pollUntilCut(
  options: RunWatchedCommandOptions,
  exitPromise: Promise<void>,
  readExit: () => CommandExit | null,
  watch: PollWatch,
): Promise<CutKind | null> {
  while (readExit() === null) {
    await Promise.race([options.sleep(options.pollMs), exitPromise])
    if (readExit() !== null) return null
    const now = options.now()
    if (watch.enabled) {
      const sample = await watch.measure()
      // The child can exit while the walk is in progress. The walk stops on
      // abort; the exit is the result, not a stall and not the ceiling.
      if (readExit() !== null || sample.kind === 'aborted') return null
      if (sample.kind === 'unknown') watch.noteUnknown(sample)
      else {
        noteSample(watch, sample, watch.readOutput(), now)
        if (now - watch.lastGrowthAt >= options.stallMs) return 'timeout-stall'
      }
    }
    if (now - watch.startedAt >= options.ceilingMs) return 'timeout-ceiling'
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
  label: string,
): { stdout: string } {
  const finished: CommandExit = exit ?? { code: null, signal: null, error: null }
  const code = finished.code
  const spawnError = finished.error
  const detail = spawnError === null ? stderr.trim() : spawnError.message
  log.info(`${label} exited`, {
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
      detail.length > 0 ? detail : `${label} exited ${code ?? 'null'} in ${cwd}`,
    )
  }
  return { stdout }
}
