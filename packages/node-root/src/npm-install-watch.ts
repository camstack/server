/**
 * Run `npm install` in its own process group and stop it when the staging
 * directory stops growing — not when a wall clock expires.
 *
 * Observed 2026-11-12 on little-unraid: `execFile`'s `timeout` killed `npm`
 * at 15 minutes while `node-av`'s postinstall (`node dist/ffmpeg/install.js`)
 * kept downloading ffmpeg. The install had no stall detection, so a slow
 * fetch was cut and the grandchild was left running. The staging state
 * stayed `staging`.
 *
 * The child is spawned `detached` so it is a process-group leader. A stall
 * or the hard ceiling signals the GROUP (`SIGTERM`, then `SIGKILL`), which
 * is the only way the grandchild dies too. Windows uses `taskkill /T /F`.
 */
import { spawn } from 'node:child_process'
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

/** How often the staging directory is measured. */
export const NPM_INSTALL_POLL_MS = 5_000

/** After SIGTERM, how long the group has to exit before SIGKILL. */
export const NPM_INSTALL_KILL_GRACE_MS = 5_000

const OUTPUT_CAP_CHARS = 64 * 1024

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
}

interface CommandExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error: Error | null
}

type CutKind = 'timeout-stall' | 'timeout-ceiling'

/**
 * Byte size of regular files under `root`. Symlinks are skipped so a link
 * that points outside the staging directory is not counted and is not
 * followed. A file that disappears mid-walk is skipped: an install renaming
 * a temp file is progress, not a failure of the measurement.
 */
export async function directoryByteSize(root: string): Promise<number> {
  let total = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = await fs.promises.stat(full)
        total += st.size
      } catch {
        // Vanished between readdir and stat — the install is still moving.
      }
    }
  }
  return total
}

function tail(text: string): string {
  return text.length > OUTPUT_CAP_CHARS ? text.slice(text.length - OUTPUT_CAP_CHARS) : text
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function killProcessGroup(
  pid: number,
  graceMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
      killer.on('exit', () => resolve())
      killer.on('error', () => resolve())
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
  if (!pidAlive(pid)) return
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

/**
 * Spawn `command` detached (its own process group) and resolve when it
 * exits. Rejects with {@link NpmInstallError} on a non-zero exit, a stall,
 * or the hard ceiling. The staging directory is `cwd`.
 */
export async function runWatchedCommand(
  options: RunWatchedCommandOptions,
): Promise<{ stdout: string }> {
  const { cwd, log } = options
  const startedAt = options.now()
  let lastGrowthAt = startedAt
  let lastSize = await directoryByteSize(cwd)
  let stdout = ''
  let stderr = ''

  const child = spawn(options.command, [...options.args], {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  const pid = child.pid
  if (pid === undefined) {
    throw new NpmInstallError(
      'nonzero-exit',
      cwd,
      null,
      `failed to spawn ${options.command}: no pid`,
    )
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout = tail(stdout + chunk)
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr = tail(stderr + chunk)
  })

  let exit: CommandExit | null = null
  const exitPromise = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      exit = { code: null, signal: null, error }
      resolve()
    })
    child.once('exit', (code, signal) => {
      exit = { code, signal, error: null }
      resolve()
    })
  })

  let cut: CutKind | null = null
  while (exit === null) {
    await Promise.race([options.sleep(options.pollMs), exitPromise])
    if (exit !== null) break
    const size = await directoryByteSize(cwd)
    const now = options.now()
    if (size > lastSize) {
      lastSize = size
      lastGrowthAt = now
    }
    if (now - lastGrowthAt >= options.stallMs) {
      cut = 'timeout-stall'
      break
    }
    if (now - startedAt >= options.ceilingMs) {
      cut = 'timeout-ceiling'
      break
    }
  }

  if (cut !== null) {
    await killProcessGroup(pid, options.graceMs, options.sleep)
    await exitPromise
    const message =
      cut === 'timeout-stall'
        ? `npm install stalled: ${cwd} has not grown for ${options.stallMs}ms`
        : `npm install hit the hard ceiling (${options.ceilingMs}ms) in ${cwd}`
    log.error('npm install cut', {
      meta: { stagingDir: cwd, kind: cut, pid, error: message },
    })
    throw new NpmInstallError(cut, cwd, null, message)
  }

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
