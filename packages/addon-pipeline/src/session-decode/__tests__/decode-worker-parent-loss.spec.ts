/**
 * D666 — a decode worker whose parent (or whose stdio) is gone EXITS.
 *
 * A real process running the real wiring (`wireDecodeWorkerProcess`), because
 * the failure lived in the event loop, which no fake reaches: with its stderr
 * reader dead, the worker's next write raised EPIPE; with no `'error'`
 * listener that became an uncaughtException; reporting it wrote to stderr
 * again. The loop never left the check phase, so neither the 250 ms exit timer
 * nor SIGTERM was ever serviced. On the Mac agent 17 workers spun like that at
 * PPID 1, 641 % CPU between them, until someone ran `kill -9`.
 */
import { type ChildProcess, fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * A `tsx` fork takes seconds to start on a loaded CI runner: the wait for the
 * first line is generous, and the test timeout covers it. Every exit bound
 * below is measured from the event that should cause it, not from the start.
 */
const STARTUP_BOUND_MS = 30_000
const PROCESS_TEST_TIMEOUT_MS = 40_000

const ENTRY = fileURLToPath(new URL('./fixtures/parent-loss-worker-entry.ts', import.meta.url))

const children: ChildProcess[] = []

type ExitOutcome =
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'alive' }

function start(): ChildProcess {
  const child = fork(ENTRY, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
  })
  children.push(child)
  return child
}

function exitWithin(child: ChildProcess, ms: number): Promise<ExitOutcome> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ kind: 'exited', code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'alive' }), ms)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ kind: 'exited', code, signal })
    })
  })
}

/** The worker is up and writing: its first raw stderr line arrived. */
function firstStderr(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('worker never wrote to stderr')),
      STARTUP_BOUND_MS,
    )
    child.stderr?.once('data', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function logLines(child: ChildProcess): string[] {
  const lines: string[] = []
  child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    if (!('kind' in message) || message.kind !== 'log') return
    if ('message' in message && typeof message.message === 'string') lines.push(message.message)
  })
  return lines
}

/** The fixture's own count of raw stderr write attempts, as last reported. */
interface StderrWriteCounts {
  readonly latest: () => number
}

function stderrWriteCounts(child: ChildProcess): StderrWriteCounts {
  let latest = 0
  child.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    if (!('kind' in message) || message.kind !== 'fixture-stderr-writes') return
    if ('count' in message && typeof message.count === 'number') latest = message.count
  })
  return { latest: () => latest }
}

/** Cut the worker's stdio from the reader's side — its next write is EPIPE. */
function loseStdio(child: ChildProcess): void {
  child.stdout?.destroy()
  child.stderr?.destroy()
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The fixture reports its write count on a 50 ms tick. On a loaded runner
 *  that tick lands late; wait for it, bounded, instead of a fixed sleep. */
async function countAtLeast(
  counts: StderrWriteCounts,
  min: number,
  boundMs: number,
): Promise<number> {
  const deadline = Date.now() + boundMs
  let latest = counts.latest()
  while (latest < min && Date.now() < deadline) {
    await settle(20)
    latest = counts.latest()
  }
  return latest
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

describe('a decode worker exits when its parent or its stdio is lost (D666)', {
  timeout: PROCESS_TEST_TIMEOUT_MS,
}, () => {
  it('stdio lost, then the channel: exits 0 within 3 s (the Mac orphan spun forever)', async () => {
    const child = start()
    await firstStderr(child)
    loseStdio(child)
    // Let the worker's periodic write hit the dead pipe BEFORE the channel
    // goes: that is the order in which the Mac's workers lost their parent.
    await settle(150)
    if (child.connected) child.disconnect()
    const outcome = await exitWithin(child, 3000)
    // When it did not exit, say whether it even honours SIGTERM — the live
    // orphans did not.
    let sigterm: ExitOutcome | null = null
    if (outcome.kind === 'alive') {
      child.kill('SIGTERM')
      sigterm = await exitWithin(child, 1000)
    }
    expect({ outcome, sigterm }).toEqual({
      outcome: { kind: 'exited', code: 0, signal: null },
      sigterm: null,
    })
  })

  it('stdio lost with the channel still up: keeps running, says so ONCE, stops raw writes, exits when the channel goes', async () => {
    const child = start()
    const lines = logLines(child)
    const stderrWrites = stderrWriteCounts(child)
    await firstStderr(child)
    loseStdio(child)
    // The loss write is reported on the fixture tick. Sample only after that
    // tick has landed, then require the count to stay put.
    const seen = await countAtLeast(stderrWrites, 1, 2_000)
    expect(seen).toBeGreaterThanOrEqual(1)
    await settle(400)
    const writesAtLoss = stderrWrites.latest()
    await settle(400)

    // Alive and not spinning: the raw stderr is the SECONDARY log path, the
    // IPC copy is what reaches the runner (D666, review M3).
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    const lost = lines.filter((line) => line.includes('stdio lost'))
    expect(lost).toHaveLength(1)
    expect(lost[0]).toContain('EPIPE')
    expect(lines.some((line) => line.includes('uncaught'))).toBe(false)
    // Still logging over IPC at its own pace — bounded, not a loop.
    const metrics = lines.filter((line) => line.includes('metrics')).length
    expect(metrics).toBeGreaterThan(5)
    expect(metrics).toBeLessThan(100)
    // Raw writes stopped at the loss: the dead pipe is not hit on every tick.
    expect(writesAtLoss).toBeGreaterThanOrEqual(1)
    expect(stderrWrites.latest()).toBe(writesAtLoss)

    child.disconnect()
    expect(await exitWithin(child, 1000)).toEqual({ kind: 'exited', code: 0, signal: null })
  })

  it('channel lost with stdio intact: exits 0 at once', async () => {
    const child = start()
    await firstStderr(child)
    child.disconnect()
    expect(await exitWithin(child, 3000)).toEqual({ kind: 'exited', code: 0, signal: null })
  })

  it('SIGTERM ends it within 1 s', async () => {
    const child = start()
    await firstStderr(child)
    child.kill('SIGTERM')
    const outcome = await exitWithin(child, 1000)
    expect(outcome.kind).toBe('exited')
    if (outcome.kind !== 'exited') return
    // Node may report SIGTERM as `{ code: 0 }` or `{ code: null, signal: 'SIGTERM' }`.
    if (outcome.code === 0) expect(outcome.signal).toBeNull()
    else expect(outcome).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' })
  })
})
