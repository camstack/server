/**
 * One writer per staging directory (D667) — against the REAL process table of
 * the platform this runs on (`/proc` on Linux, `ps` on macOS).
 *
 * The fake-table spec proves the policy; this proves the platform half: that
 * a live process whose executable and argv identify a writer is actually
 * FOUND by the lister and actually GONE after the reap — including one that
 * ignores SIGTERM, which is what an ffmpeg blocked in an RTSP read does. The
 * stand-in is a node process rather than ffmpeg, so the injected executable
 * marker names this test's Node binary.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProcessLister, nodeProcessSignaller } from '../process-table.js'
import { StagingWriterReaper } from '../staging-writer-guard.js'
import { specRoot } from './spec-root.js'

const lister = createProcessLister()
const ROOT = specRoot('staging-guard-real')
const children: ChildProcess[] = []

/** A process that looks like a writer of `outDir` and does nothing. */
function spawnFakeWriter(outDir: string, opts: { ignoreTerm: boolean }): ChildProcess {
  const script = opts.ignoreTerm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('up')"
    : "setInterval(() => {}, 1000); process.stdout.write('up')"
  const child = spawn(
    process.execPath,
    ['-e', script, '--', '-segment_list', `${outDir}/live.m3u8`, '%s.m4s'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  children.push(child)
  return child
}

/** Resolve once the child is running its script (so a SIGTERM handler is armed). */
function whenUp(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.stdout?.once('data', () => resolve()))
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.signalCode)
      return
    }
    child.once('exit', (_code, signal) => resolve(signal))
  })
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

describe.skipIf(lister === null)('StagingWriterReaper — a real foreign writer', () => {
  const reaper = (): StagingWriterReaper => {
    if (lister === null) throw new Error('no process table on this platform')
    return new StagingWriterReaper({
      lister,
      signaller: nodeProcessSignaller,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      selfPid: process.pid,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      executableMarker: path.basename(process.execPath),
    })
  }

  it('finds a live writer of this directory and reaps it with SIGTERM', async () => {
    const outDir = path.join(ROOT, '.rec-tmp', '101', 'high')
    const writer = spawnFakeWriter(outDir, { ignoreTerm: false })
    await whenUp(writer)
    const bystander = spawnFakeWriter(path.join(ROOT, '.rec-tmp', '101', 'low'), {
      ignoreTerm: false,
    })
    await whenUp(bystander)

    const result = await reaper().claim({
      deviceId: 101,
      profile: 'high',
      root: ROOT,
      outDir,
      ownPids: new Set(),
    })

    expect(result.outcome).toBe('clear')
    expect(result.outcome === 'clear' ? result.reaped.map((r) => r.pid) : []).toEqual([writer.pid])
    expect(await exited(writer)).toBe('SIGTERM')
    // The writer of ANOTHER directory is still running.
    expect(bystander.exitCode).toBeNull()
    expect(bystander.signalCode).toBeNull()
  }, 15_000)

  it('escalates to SIGKILL for a writer that ignores SIGTERM', async () => {
    const outDir = path.join(ROOT, '.rec-tmp', '616', 'high')
    const writer = spawnFakeWriter(outDir, { ignoreTerm: true })
    await whenUp(writer)

    const result = await reaper().claim({
      deviceId: 616,
      profile: 'high',
      root: ROOT,
      outDir,
      ownPids: new Set(),
    })

    expect(result.outcome).toBe('clear')
    expect(await exited(writer)).toBe('SIGKILL')
  }, 15_000)
})
