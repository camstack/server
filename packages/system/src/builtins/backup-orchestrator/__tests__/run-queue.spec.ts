/**
 * Backup run queue — the D342 invariants.
 *
 * Learned live on 2026-09-04: two schedules due on overlapping ticks
 * built two multi-GB archives CONCURRENTLY (staging 5.1 GB → 18 GB in
 * ~12 minutes, host load 62), there was no way to stop them short of
 * restarting the addon, and nothing reported the runs existed. This
 * suite pins:
 *
 *   1. Never two executors at once — a second submit waits.
 *   2. An identical queued request is JOINED, not queued twice.
 *   3. Cancel of a queued run removes it before it ever starts.
 *   4. Cancel of the running run fires its abort signal.
 *   5. Every run is observable while it runs (phase, bytes) and after
 *      (bounded history, outcome).
 */
import { describe, expect, it } from 'vitest'
import { BackupCancelledError } from '../../system-backup/system-backup.service.js'
import { type BackupRunProgress, BackupRunQueue, type BackupRunRequest } from '../run-queue.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(err: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Yield the microtask queue so the pump can advance. */
async function settle(): Promise<void> {
  await new Promise((res) => setImmediate(res))
}

interface ExecutorCall {
  readonly request: BackupRunRequest
  readonly signal: AbortSignal
  readonly progress: BackupRunProgress
  readonly gate: Deferred<readonly string[]>
}

/** Executor whose completion the test controls per-call. */
function gatedExecutor(): {
  calls: ExecutorCall[]
  activePeak: () => number
  executor: (
    request: BackupRunRequest,
    signal: AbortSignal,
    progress: BackupRunProgress,
  ) => Promise<readonly string[]>
} {
  const calls: ExecutorCall[] = []
  let active = 0
  let peak = 0
  return {
    calls,
    activePeak: () => peak,
    executor: async (request, signal, progress) => {
      active++
      peak = Math.max(peak, active)
      const gate = deferred<readonly string[]>()
      calls.push({ request, signal, progress, gate })
      try {
        return await gate.promise
      } finally {
        active--
      }
    },
  }
}

describe('BackupRunQueue', () => {
  it('never runs two executors concurrently — the second submit waits (the incident)', async () => {
    const { calls, activePeak, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)

    const first = queue.submit({ label: 'nightly' })
    await settle()
    const second = queue.submit({ label: 'manual' })
    await settle()

    // Only ONE executor started; the second run is queued, and says so.
    expect(calls).toHaveLength(1)
    expect(first.queued).toBe(false)
    expect(second.queued).toBe(true)
    expect(second.joined).toBe(false)
    expect(queue.getRun(second.runId)?.state).toBe('queued')

    calls[0]!.gate.resolve(['a'])
    await settle()
    expect(calls).toHaveLength(2)
    calls[1]!.gate.resolve(['b'])
    await expect(second.result).resolves.toEqual(['b'])
    expect(activePeak()).toBe(1)
  })

  it('runs queued submissions in FIFO order', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    queue.submit({ label: 'one' })
    await settle()
    queue.submit({ label: 'two' })
    queue.submit({ label: 'three' })
    await settle()
    calls[0]!.gate.resolve([])
    await settle()
    calls[1]!.gate.resolve([])
    await settle()
    expect(calls.map((c) => c.request.label)).toEqual(['one', 'two', 'three'])
    calls[2]!.gate.resolve([])
  })

  it('listRuns answers in EXECUTION order: running, then the queue as it WILL run, then finished — with positions', async () => {
    const { calls, executor } = gatedExecutor()
    // Strictly increasing clock: under a newest-first timestamp sort
    // the run that starts NEXT would land at the BOTTOM — the exact
    // confusion this contract forbids.
    let tick = 0
    const queue = new BackupRunQueue(executor, { now: () => ++tick })
    const old = queue.submit({ label: 'old' })
    await settle()
    calls[0]!.gate.resolve([])
    await old.result
    queue.submit({ label: 'running' })
    await settle()
    const first = queue.submit({ label: 'first-in-line' })
    const second = queue.submit({ label: 'second-in-line' })

    const runs = queue.listRuns()
    expect(runs.map((r) => r.label)).toEqual(['running', 'first-in-line', 'second-in-line', 'old'])
    // Positions come from the pending array itself, 1 = next; the
    // running and finished runs carry none.
    expect(runs.map((r) => r.queuePosition)).toEqual([undefined, 1, 2, undefined])

    // Cancelling the head of the line promotes the next waiter to 1.
    queue.cancel(first.runId)
    expect(queue.getRun(second.runId)?.queuePosition).toBe(1)
    calls[1]!.gate.resolve([])
    await settle()
    calls[2]!.gate.resolve([])
    await second.result
  })

  it('joins an identical request that is still queued — one run, same id', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    queue.submit({ label: 'running' })
    await settle()
    const a = queue.submit({ destinations: ['x', 'y'], label: 'nightly', retentionCount: 7 })
    const b = queue.submit({ destinations: ['y', 'x'], label: 'nightly', retentionCount: 7 })
    expect(b.joined).toBe(true)
    expect(b.runId).toBe(a.runId)
    // Still exactly one executor call (the first run) — the joined
    // request added no queue slot.
    expect(calls).toHaveLength(1)
    calls[0]!.gate.resolve([])
    await settle()
    expect(calls).toHaveLength(2)
    calls[1]!.gate.resolve(['shared'])
    await expect(a.result).resolves.toEqual(['shared'])
    await expect(b.result).resolves.toEqual(['shared'])
  })

  it('does NOT join a request that differs, or one that is already running', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    const running = queue.submit({ label: 'same' })
    await settle()
    // Identical to the RUNNING run — must queue, not join: its data
    // would be a snapshot from before this trigger.
    const afterStart = queue.submit({ label: 'same' })
    expect(afterStart.joined).toBe(false)
    expect(afterStart.runId).not.toBe(running.runId)
    const different = queue.submit({ label: 'different' })
    expect(different.joined).toBe(false)
    for (const c of calls) c.gate.resolve([])
    await settle()
    for (const c of calls) c.gate.resolve([])
  })

  it('cancels a queued run before it starts: removed, cancelled, executor never called', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    queue.submit({ label: 'running' })
    await settle()
    const waiting = queue.submit({ label: 'doomed' })
    expect(queue.cancel(waiting.runId)).toBe(true)
    await expect(waiting.result).rejects.toBeInstanceOf(BackupCancelledError)
    expect(queue.getRun(waiting.runId)?.state).toBe('cancelled')
    calls[0]!.gate.resolve([])
    await settle()
    // The cancelled run never reached the executor.
    expect(calls).toHaveLength(1)
  })

  it('cancels the RUNNING run: its abort signal fires and the outcome is cancelled', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    const run = queue.submit({ label: 'live' })
    await settle()
    expect(calls[0]!.signal.aborted).toBe(false)
    expect(queue.cancel(run.runId)).toBe(true)
    expect(calls[0]!.signal.aborted).toBe(true)
    // Executor observes the abort and rejects with the cancel error.
    calls[0]!.gate.reject(new BackupCancelledError())
    await expect(run.result).rejects.toBeInstanceOf(BackupCancelledError)
    expect(queue.getRun(run.runId)?.state).toBe('cancelled')
  })

  it('an executor that stops early on abort and RETURNS partial work is still a cancelled run', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    const run = queue.submit({ label: 'partial' })
    await settle()
    queue.cancel(run.runId)
    calls[0]!.gate.resolve(['landed-before-cancel'])
    await expect(run.result).resolves.toEqual(['landed-before-cancel'])
    expect(queue.getRun(run.runId)?.state).toBe('cancelled')
  })

  it('a cancelled run does not block the queue — the next run starts', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    const doomed = queue.submit({ label: 'doomed' })
    await settle()
    const next = queue.submit({ label: 'next' })
    queue.cancel(doomed.runId)
    calls[0]!.gate.reject(new BackupCancelledError())
    await settle()
    expect(calls).toHaveLength(2)
    calls[1]!.gate.resolve([])
    await expect(next.result).resolves.toEqual([])
  })

  it('a failed run records its error and the queue continues', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    const bad = queue.submit({ label: 'bad' })
    await settle()
    const good = queue.submit({ label: 'good' })
    calls[0]!.gate.reject(new Error('disk on fire'))
    await expect(bad.result).rejects.toThrow('disk on fire')
    await settle()
    expect(queue.getRun(bad.runId)?.state).toBe('failed')
    expect(queue.getRun(bad.runId)?.error).toBe('disk on fire')
    calls[1]!.gate.resolve([])
    await expect(good.result).resolves.toEqual([])
  })

  it('exposes live phase + byte counters WHILE a run executes', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    const run = queue.submit({ label: 'watched' })
    await settle()
    const { progress } = calls[0]!
    progress.setDestinations(['backups:default'])
    progress.setStagedBytes(1024)
    let snap = queue.getRun(run.runId)!
    expect(snap.state).toBe('running')
    expect(snap.phase).toBe('building')
    expect(snap.stagedBytes).toBe(1024)
    expect(snap.destinationIds).toEqual(['backups:default'])

    progress.setArchiveSize(4096)
    progress.setPhase('uploading')
    progress.setUploadedBytes(2048)
    snap = queue.getRun(run.runId)!
    expect(snap.phase).toBe('uploading')
    expect(snap.archiveSizeBytes).toBe(4096)
    expect(snap.uploadedBytes).toBe(2048)

    progress.destinationCompleted('backups:default')
    snap = queue.getRun(run.runId)!
    expect(snap.completedDestinationIds).toEqual(['backups:default'])

    calls[0]!.gate.resolve([])
    await settle()
    snap = queue.getRun(run.runId)!
    expect(snap.state).toBe('succeeded')
    expect(snap.phase).toBe('done')
    expect(snap.finishedAt).toBeTypeOf('number')
  })

  it('cancel of an unknown or already-finished run returns false', async () => {
    const { calls, executor } = gatedExecutor()
    const queue = new BackupRunQueue(executor)
    expect(queue.cancel('nope')).toBe(false)
    const run = queue.submit({})
    await settle()
    calls[0]!.gate.resolve([])
    await run.result
    expect(queue.cancel(run.runId)).toBe(false)
  })

  it('keeps a bounded finished history, newest first', async () => {
    const { calls, executor } = gatedExecutor()
    let tick = 0
    const queue = new BackupRunQueue(executor, { maxFinished: 2, now: () => ++tick })
    for (let i = 0; i < 4; i++) {
      const run = queue.submit({ label: `run-${i}` })
      await settle()
      calls[calls.length - 1]!.gate.resolve([])
      await run.result
    }
    const runs = queue.listRuns()
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.label)).toEqual(['run-3', 'run-2'])
  })
})
