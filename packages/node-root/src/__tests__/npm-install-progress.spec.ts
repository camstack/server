/**
 * Bounds on install progress: only an explicit npm install is walked, a
 * shrink counts, a tree over the budget does not stall by itself, and a
 * walk stops when the child has already exited.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { measureInstallProgress } from '../npm-install-progress.js'
import {
  type NpmInstallLogger,
  type WatchedChild,
  type WatchedSpawner,
  runWatchedCommand,
} from '../npm-install-watch.js'

const silentLog: NpmInstallLogger = {
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

interface DeferredChild {
  readonly child: WatchedChild
  exit(code: number | null): void
}

function deferredChild(pid: number): DeferredChild {
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

function capturingLog(lines: string[]): NpmInstallLogger {
  return {
    info: (message) => {
      lines.push(message)
    },
    warn: (message) => {
      lines.push(message)
    },
    error: (message) => {
      lines.push(message)
    },
    debug: (message) => {
      lines.push(`debug:${message}`)
    },
  }
}

function fillFiles(dir: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(dir, String(index)), 'x')
  }
}

describe('progress walks only an npm install staging directory', () => {
  it('logs npm view exited and does not stall a view of the process directory', async () => {
    const lines: string[] = []
    let clock = 0
    const started = Date.now()
    const spawnProcess: WatchedSpawner = () => {
      const child = deferredChild(7101)
      queueMicrotask(() => child.exit(0))
      return child.child
    }
    await runWatchedCommand({
      command: 'npm',
      args: ['view', '@camstack/server@latest', 'version'],
      cwd: process.cwd(),
      stallMs: 1,
      ceilingMs: 60_000,
      pollMs: 1,
      graceMs: 0,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      log: capturingLog(lines),
      spawnProcess,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(lines).toContain('npm view exited')
    expect(lines.join('\n')).not.toContain('npm install exited')
    expect(lines.join('\n')).not.toContain('hard ceiling')
    expect(clock).toBeLessThan(60_000)
  })

  it('does not stall npm install when the cwd is only the process directory', async () => {
    const lines: string[] = []
    let clock = 0
    const spawnProcess: WatchedSpawner = () => deferredChild(7102).child
    const outcome = runWatchedCommand({
      command: 'npm',
      args: ['install', '--omit=dev'],
      cwd: process.cwd(),
      stallMs: 1,
      ceilingMs: 5_000,
      pollMs: 1_000,
      graceMs: 0,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      log: capturingLog(lines),
      spawnProcess,
    })
    await expect(outcome).rejects.toMatchObject({ kind: 'timeout-ceiling' })
    expect(clock).toBeGreaterThanOrEqual(5_000)
    expect(lines.join('\n')).not.toContain('stalled')
  })

  it('does not call an npm ls timeout a hard ceiling', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-ls-'))
    const lines: string[] = []
    let clock = 0
    const spawnProcess: WatchedSpawner = () => deferredChild(7103).child
    const outcome = runWatchedCommand({
      command: 'npm',
      args: ['ls', '--omit=dev', '--all'],
      cwd: dir,
      stallMs: 1,
      ceilingMs: 5_000,
      pollMs: 1_000,
      graceMs: 0,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      log: capturingLog(lines),
      spawnProcess,
    })
    await expect(outcome).rejects.toMatchObject({ kind: 'timeout-ceiling' })
    await expect(outcome).rejects.toThrow(/npm ls/)
    await expect(outcome).rejects.not.toThrow(/hard ceiling/)
    expect(lines.join('\n')).toContain('npm ls')
    expect(lines.join('\n')).not.toContain('hard ceiling')
    expect(lines.join('\n')).not.toContain('stalled')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('logs npm ls exited when npm ls fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-ls-fail-'))
    const lines: string[] = []
    const spawnProcess: WatchedSpawner = () => {
      const child = deferredChild(7104)
      queueMicrotask(() => child.exit(1))
      return child.child
    }
    const outcome = runWatchedCommand({
      command: 'npm',
      args: ['ls', '--omit=dev', '--all'],
      cwd: dir,
      stallMs: 60_000,
      ceilingMs: 60_000,
      pollMs: 1_000,
      graceMs: 0,
      now: () => 0,
      sleep: async () => undefined,
      log: capturingLog(lines),
      spawnProcess,
    })
    await expect(outcome).rejects.toMatchObject({ kind: 'nonzero-exit', code: 1 })
    expect(lines).toContain('npm ls exited')
    expect(lines.join('\n')).not.toContain('hard ceiling')
    expect(lines.join('\n')).not.toContain('npm install exited')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('bounded install progress', () => {
  it('treats a deleted postinstall zip as progress', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-shrink-'))
    const zip = path.join(dir, 'node_modules', 'node-av', 'binary', 'vendor', 'ffmpeg.zip')
    fs.mkdirSync(path.dirname(zip), { recursive: true })
    fs.writeFileSync(zip, 'z'.repeat(4_096))
    const stallMs = 120_000
    let clock = 0
    let polls = 0
    const handle = deferredChild(7107)
    const outcome = runWatchedCommand({
      command: process.execPath,
      args: ['-e', ''],
      cwd: dir,
      stallMs,
      ceilingMs: 30 * 60_000,
      pollMs: 60_000,
      graceMs: 0,
      now: () => clock,
      sleep: async (ms) => {
        polls += 1
        if (polls === 1) fs.rmSync(zip, { force: true })
        if (polls === 3) handle.exit(0)
        clock += ms
      },
      log: silentLog,
      spawnProcess: () => handle.child,
    })
    await expect(outcome).resolves.toEqual({ stdout: '' })
    expect(clock).toBeGreaterThanOrEqual(stallMs)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not stall a tree over the walk budget on its own', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-budget-'))
    fillFiles(dir, 20_001)
    const lines: string[] = []
    let clock = 0
    const spawnProcess: WatchedSpawner = () => deferredChild(7105).child
    const outcome = runWatchedCommand({
      command: process.execPath,
      args: ['-e', ''],
      cwd: dir,
      stallMs: 1_000,
      ceilingMs: 1_000,
      pollMs: 1_000,
      graceMs: 0,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      log: capturingLog(lines),
      spawnProcess,
    })
    await expect(outcome).rejects.toMatchObject({ kind: 'timeout-ceiling' })
    expect(clock).toBeGreaterThanOrEqual(1_000)
    const budgetLogs = lines.filter((line) => line.startsWith('debug:'))
    expect(budgetLogs).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it('kills the process group when npm exits non-zero', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-nz-'))
    const pidFile = path.join(dir, 'pids')
    const script = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
      fs.writeFileSync(process.argv[1], String(child.pid))
      process.exit(1)
    `
    const outcome = runWatchedCommand({
      command: process.execPath,
      args: ['-e', script, pidFile],
      cwd: dir,
      stallMs: 60_000,
      ceilingMs: 60_000,
      pollMs: 30_000,
      graceMs: 100,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: silentLog,
    })
    await expect(outcome).rejects.toMatchObject({ kind: 'nonzero-exit', code: 1 })
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'))
    expect(childPid).toBeGreaterThan(0)
    expect(await waitUntilDead(childPid)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stops the walk when aborted so a child exit is not stuck behind it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-watch-abort-'))
    fillFiles(dir, 400)
    let checks = 0
    const sample = await measureInstallProgress({
      stagingDir: dir,
      progressDirs: [],
      env: {},
      previousCheap: null,
      aborted: () => {
        checks += 1
        return checks > 8
      },
    })
    expect(sample.kind).toBe('aborted')
    if (sample.kind === 'aborted') expect(sample.entries).toBeLessThan(80)
    expect(checks).toBeLessThan(80)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
