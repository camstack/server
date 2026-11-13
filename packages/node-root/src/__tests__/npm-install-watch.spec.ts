/**
 * The install watcher owns the process group.
 *
 * On 2026-11-12 little-unraid's `npm install` was killed at 15 minutes by
 * `execFile`'s `timeout` while node-av's postinstall kept downloading ffmpeg.
 * A grandchild must die with npm, and a download that is still writing must
 * outlive that old wall clock.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import {
  type NpmExecFn,
  type RootUpdateEnvNames,
  type RootUpdateLogger,
  RootUpdateService,
  STAGING_ATTEMPTS,
  STAGING_FAILED_REASON,
} from '../root-update-service.js'
import {
  type NpmInstallLogger,
  NpmInstallError,
  type RunWatchedCommandOptions,
  type WatchedChild,
  type WatchedSpawner,
  runWatchedCommand,
} from '../npm-install-watch.js'

const ENV_NAMES: RootUpdateEnvNames = {
  bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
  activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
  seedDir: 'CAMSTACK_SEED_SERVER_DIR',
}

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return !pidAlive(pid)
}

describe('npm install process group', () => {
  const leftovers: number[] = []

  afterEach(() => {
    for (const pid of leftovers) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // Already gone, or not a group leader.
      }
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    leftovers.length = 0
  })

  it('kills a grandchild that sleeps forever when the install stalls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-'))
    const pidFile = path.join(dir, 'pids')
    const script = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
      fs.writeFileSync(process.argv[1], process.pid + '\\n' + child.pid + '\\n')
      setInterval(() => {}, 1e9)
    `
    const outcome = runWatchedCommand({
      command: process.execPath,
      args: ['-e', script, pidFile],
      cwd: dir,
      stallMs: 300,
      ceilingMs: 60_000,
      pollMs: 40,
      graceMs: 100,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: silentLog,
    })
    await expect(outcome).rejects.toBeInstanceOf(NpmInstallError)
    const text = fs.readFileSync(pidFile, 'utf8')
    const [parentRaw, childRaw] = text.trim().split('\n')
    const parentPid = Number(parentRaw)
    const childPid = Number(childRaw)
    leftovers.push(parentPid)
    expect(parentPid).toBeGreaterThan(0)
    expect(childPid).toBeGreaterThan(0)
    expect(await waitUntilDead(parentPid)).toBe(true)
    expect(await waitUntilDead(childPid)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not cut a child that keeps writing past the old 15 minute wall clock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-slow-'))
    const bytes = path.join(dir, 'bytes')
    const stop = path.join(dir, 'stop')
    const script = `
      const fs = require('node:fs')
      const timer = setInterval(() => {
        fs.appendFileSync(process.argv[1], 'x')
        if (fs.existsSync(process.argv[2])) {
          clearInterval(timer)
          process.exit(0)
        }
      }, 10)
    `
    const oldWallMs = 15 * 60_000
    let clock = 0
    const now = (): number => clock
    let settled = false
    const outcome = runWatchedCommand({
      command: process.execPath,
      args: ['-e', script, bytes, stop],
      cwd: dir,
      stallMs: 10 * 60_000,
      ceilingMs: 90 * 60_000,
      pollMs: 60_000,
      graceMs: 50,
      now,
      sleep: async (ms) => {
        clock += ms
        await new Promise((resolve) => setTimeout(resolve, 30))
      },
      log: silentLog,
    }).then(
      (value) => {
        settled = true
        return value
      },
      (err: unknown) => {
        settled = true
        throw err
      },
    )
    const deadline = Date.now() + 5_000
    while (clock - 0 <= oldWallMs) {
      if (settled) break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(settled).toBe(false)
    expect(clock).toBeGreaterThan(oldWallMs)
    fs.writeFileSync(stop, '1')
    await expect(outcome).resolves.toEqual({ stdout: '' })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('a stalled install returns the node to idle', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-svc-'))
  const dataDir = path.join(tmp, 'data')
  const runningPkgPath = path.join(tmp, 'running-package.json')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    runningPkgPath,
    JSON.stringify({ name: '@camstack/server', version: '1.1.50' }),
    'utf-8',
  )

  function service(execNpm: NpmExecFn, sleep?: (ms: number) => Promise<void>): RootUpdateService {
    const logger: RootUpdateLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }
    return new RootUpdateService({
      spec: HUB_ROOT_SPEC,
      envNames: ENV_NAMES,
      logger,
      restartServer: () => undefined,
      dataDir,
      runningPackageJsonPath: runningPkgPath,
      workspaceProbeDir: tmp,
      execNpm,
      env: { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
      now: () => 1_700_000_000_000,
      ...(sleep !== undefined ? { sleep } : {}),
    })
  }

  it('reports timeout-stall and idle, not a stuck staging state', async () => {
    const svc = service(async () => {
      throw new NpmInstallError('timeout-stall', path.join(dataDir, 'staging'), null, 'stalled')
    })
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res).toMatchObject({
      accepted: false,
      outcome: 'failed',
      reason: 'timeout-stall',
    })
    expect(res.reason).not.toBe(STAGING_FAILED_REASON)
    const status = await svc.getServerPackageStatus()
    expect(status.updateState).toBe('idle')
  })

  it('reports timeout-ceiling the same way', async () => {
    const svc = service(async () => {
      throw new NpmInstallError('timeout-ceiling', path.join(dataDir, 'staging'), null, 'ceiling')
    })
    const res = await svc.applyServerUpdate({ version: '1.1.61' })
    expect(res.reason).toBe('timeout-ceiling')
    expect((await svc.getServerPackageStatus()).updateState).toBe('idle')
  })
})

const NETWORK_STALL_MESSAGE = 'npm install stalled\nnpm error code ETIMEDOUT\nnpm error network'

describe('stall and ceiling are not retried', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-retry-'))
  const dataDir = path.join(tmp, 'data')
  const runningPkgPath = path.join(tmp, 'running-package.json')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    runningPkgPath,
    JSON.stringify({ name: '@camstack/server', version: '1.1.50' }),
    'utf-8',
  )

  function service(execNpm: NpmExecFn): RootUpdateService {
    const logger: RootUpdateLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }
    return new RootUpdateService({
      spec: HUB_ROOT_SPEC,
      envNames: ENV_NAMES,
      logger,
      restartServer: () => undefined,
      dataDir,
      runningPackageJsonPath: runningPkgPath,
      workspaceProbeDir: tmp,
      execNpm,
      env: { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
    })
  }

  async function attempts(execNpm: NpmExecFn, version: string): Promise<number> {
    let calls = 0
    const wrapped: NpmExecFn = async (args, opts) => {
      calls += 1
      return execNpm(args, opts)
    }
    await service(wrapped).applyServerUpdate({ version })
    return calls
  }

  it('does not retry a stall whose message also names a network error', async () => {
    const calls = await attempts(async () => {
      throw new NpmInstallError('timeout-stall', dataDir, null, NETWORK_STALL_MESSAGE)
    }, '1.1.70')
    expect(calls).toBe(1)
  })

  it('does not retry a hard ceiling', async () => {
    const calls = await attempts(async () => {
      throw new NpmInstallError('timeout-ceiling', dataDir, null, NETWORK_STALL_MESSAGE)
    }, '1.1.71')
    expect(calls).toBe(1)
  })

  it('still retries a transient registry error', async () => {
    const calls = await attempts(async () => {
      throw new Error('npm error code ECONNRESET\nnpm error network')
    }, '1.1.72')
    expect(calls).toBe(STAGING_ATTEMPTS)
  })
})

interface RecordedSpawn {
  readonly command: string
  readonly args: readonly string[]
  readonly shell: boolean
}

function deferredChild(pid: number): {
  readonly child: WatchedChild
  exit(code: number | null): void
} {
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null
  let pending: number | null | undefined
  const child: WatchedChild = {
    pid,
    stdout: { setEncoding: () => undefined, on: () => undefined },
    stderr: { setEncoding: () => undefined, on: () => undefined },
    onError: () => undefined,
    onExit: (listener) => {
      onExit = listener
      if (pending !== undefined) listener(pending, null)
    },
  }
  return {
    child,
    exit(code) {
      if (onExit === null) {
        pending = code
        return
      }
      onExit(code, null)
    },
  }
}

function windowsWatchOptions(
  dir: string,
  spawnProcess: WatchedSpawner,
  execPath: string,
  command: string,
  stallMs: number,
): RunWatchedCommandOptions {
  let clock = 0
  const log: NpmInstallLogger = silentLog
  return {
    command,
    args: ['install', '--omit=dev'],
    cwd: dir,
    stallMs,
    ceilingMs: 120_000,
    pollMs: 5_000,
    graceMs: 10,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    log,
    platform: 'win32',
    execPath,
    env: {},
    spawnProcess,
  }
}

describe('windows npm launch', () => {
  it('spawns node with npm-cli.js and kills the group with taskkill', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-win-'))
    const nodeDir = path.join(dir, 'node')
    const cli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const nodeExe = path.join(nodeDir, 'node.exe')
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(cli, '// npm\n')
    fs.writeFileSync(nodeExe, '')
    const recorded: RecordedSpawn[] = []
    let npmExit: ((code: number | null) => void) | null = null
    const spawnProcess: WatchedSpawner = (command, args, options) => {
      recorded.push({ command, args: [...args], shell: options.shell })
      if (command === 'taskkill') {
        const killer = deferredChild(1)
        queueMicrotask(() => {
          npmExit?.(null)
          killer.exit(0)
        })
        return killer.child
      }
      const npm = deferredChild(5151)
      npmExit = npm.exit
      return npm.child
    }
    await expect(
      runWatchedCommand(windowsWatchOptions(dir, spawnProcess, nodeExe, 'npm.cmd', 1_000)),
    ).rejects.toBeInstanceOf(NpmInstallError)
    expect(recorded[0]).toEqual({
      command: nodeExe,
      args: [cli, 'install', '--omit=dev'],
      shell: false,
    })
    expect(recorded[1]).toEqual({
      command: 'taskkill',
      args: ['/PID', '5151', '/T', '/F'],
      shell: false,
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to npm.cmd with a shell when npm-cli.js is absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-win-shell-'))
    const nodeExe = path.join(dir, 'node.exe')
    fs.writeFileSync(nodeExe, '')
    const recorded: RecordedSpawn[] = []
    const spawnProcess: WatchedSpawner = (command, args, options) => {
      recorded.push({ command, args: [...args], shell: options.shell })
      const child = deferredChild(9)
      queueMicrotask(() => child.exit(0))
      return child.child
    }
    await runWatchedCommand(windowsWatchOptions(dir, spawnProcess, nodeExe, 'npm.cmd', 120_000))
    expect(recorded[0]).toEqual({
      command: 'npm.cmd',
      args: ['install', '--omit=dev'],
      shell: true,
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('progress outside the staging directory', () => {
  function slowWriter(target: string, stop: string): string {
    return `
      const fs = require('node:fs')
      const timer = setInterval(() => {
        fs.appendFileSync(${JSON.stringify(target)}, 'x')
        if (fs.existsSync(${JSON.stringify(stop)})) {
          clearInterval(timer)
          process.exit(0)
        }
      }, 10)
    `
  }

  it('does not cut a slow writer outside cwd', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-out-cwd-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-out-dir-'))
    const bytes = path.join(outside, 'bytes')
    const stop = path.join(outside, 'stop')
    const oldWallMs = 15 * 60_000
    let clock = 0
    let settled = false
    const outcome = runWatchedCommand({
      command: process.execPath,
      args: ['-e', slowWriter(bytes, stop)],
      cwd,
      progressDirs: [outside],
      stallMs: 10 * 60_000,
      ceilingMs: 90 * 60_000,
      pollMs: 60_000,
      graceMs: 50,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        await new Promise((resolve) => setTimeout(resolve, 30))
      },
      log: silentLog,
    }).then(
      (value) => {
        settled = true
        return value
      },
      (err: unknown) => {
        settled = true
        throw err
      },
    )
    const deadline = Date.now() + 5_000
    while (clock <= oldWallMs) {
      if (settled) break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(settled).toBe(false)
    expect(clock).toBeGreaterThan(oldWallMs)
    fs.writeFileSync(stop, '1')
    await expect(outcome).resolves.toEqual({ stdout: '' })
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('does not cut a child that only prints and writes nothing', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-stdout-'))
    const stop = path.join(cwd, 'stop')
    const script = `
      const fs = require('node:fs')
      process.stdout.write('x')
      const timer = setInterval(() => {
        process.stdout.write('x')
        if (fs.existsSync(process.argv[1])) {
          clearInterval(timer)
          process.exit(0)
        }
      }, 10)
    `
    let clock = 0
    let settled = false
    const outcome = runWatchedCommand({
      command: process.execPath,
      args: ['-e', script, stop],
      cwd,
      stallMs: 1_000,
      ceilingMs: 60_000,
      pollMs: 5_000,
      graceMs: 50,
      now: () => clock,
      sleep: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        clock += ms
      },
      log: silentLog,
    }).then(
      (value) => {
        settled = true
        return value
      },
      (err: unknown) => {
        settled = true
        throw err
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settled).toBe(false)
    expect(clock).toBeGreaterThanOrEqual(5_000)
    fs.writeFileSync(stop, '1')
    await expect(outcome).resolves.toMatchObject({ stdout: expect.stringContaining('x') })
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})
