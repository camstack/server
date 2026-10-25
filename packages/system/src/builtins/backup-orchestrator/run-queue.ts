/**
 * Backup run queue + per-run tracking (D342).
 *
 * Why a GLOBAL queue (concurrency 1), not per-destination: every run
 * walks the same `<nodeDataDir>` source tree and stages its tar.gz on
 * the same disk. On 2026-09-04 two schedule ticks built two multi-GB
 * archives concurrently — staging went 5.1 GB → 18 GB in ~12 minutes
 * with host load 62, and each run archived the other's growing tar
 * (pre-D338 staging placement). A per-destination lock would still
 * allow two concurrent walks of the same tree and two staged archives;
 * the destination write is the CHEAP half. One run at a time bounds
 * peak staging disk to a single archive and the walk cost to one
 * traversal.
 *
 * This subsumes the earlier single-flight `buildLock`
 * (`LocationManifestLock.run('archive-build', …)`): that lock
 * serialised builds but was invisible (nothing reported a waiting
 * run), unjoinable and uncancellable. The queue is the one
 * serialisation authority for archive builds — do not reintroduce a
 * second lock around the executor.
 *
 * Every run is OBSERVABLE while it exists: id, state, phase, byte
 * counters, per-destination outcome. The registry keeps queued +
 * active + a bounded tail of finished runs so `backup.listRuns` can
 * answer "what is running, how far along, how big" without `du`.
 */
import { randomUUID } from 'node:crypto'
import type { DataStoreDatabase } from '@camstack/types'
import { BackupCancelledError } from '../system-backup/system-backup.service.js'

export type BackupRunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type BackupRunPhase = 'queued' | 'building' | 'uploading' | 'done'

/** What a trigger asks for — the queue keys joining on this. */
export interface BackupRunRequest {
  readonly destinations?: readonly string[]
  readonly locations?: readonly string[]
  readonly label?: string
  readonly retentionCount?: number
  /** Database files to carry; absent = settings only. */
  readonly databases?: readonly DataStoreDatabase[]
}

/** Immutable snapshot of one run — the wire shape of `backup.listRuns`. */
export interface BackupRunSnapshot {
  readonly id: string
  readonly state: BackupRunState
  readonly phase: BackupRunPhase
  readonly destinationIds: readonly string[]
  readonly label?: string
  readonly requestedAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly stagedBytes: number
  readonly archiveSizeBytes?: number
  readonly uploadedBytes: number
  readonly completedDestinationIds: readonly string[]
  readonly failedDestinationIds: readonly string[]
  readonly error?: string
  /**
   * 1-based place in the execution queue — 1 = runs next. Present only
   * while `state === 'queued'`, and derived from the queue's OWN
   * pending order at read time (never from timestamps), so a consumer
   * can only ever show the order the executor will actually honour.
   */
  readonly queuePosition?: number
}

/**
 * Progress sink handed to the executor. Every update replaces the
 * stored snapshot (no shared mutable state leaks out of the queue).
 */
export interface BackupRunProgress {
  setPhase(phase: BackupRunPhase): void
  /** Resolved destination targets — known only once the run starts. */
  setDestinations(ids: readonly string[]): void
  setStagedBytes(bytes: number): void
  setArchiveSize(bytes: number): void
  setUploadedBytes(bytes: number): void
  destinationCompleted(id: string): void
  destinationFailed(id: string): void
}

export interface SubmitResult<T> {
  readonly runId: string
  /** True when the run had to wait behind an in-flight run. */
  readonly queued: boolean
  /** True when this submit was coalesced onto an identical queued run. */
  readonly joined: boolean
  /** Settles when the run terminates. Rejects `BackupCancelledError` on cancel-before-any-result. */
  readonly result: Promise<T>
}

export type BackupRunExecutor<T> = (
  request: BackupRunRequest,
  signal: AbortSignal,
  progress: BackupRunProgress,
) => Promise<T>

interface RunRecord<T> {
  snapshot: BackupRunSnapshot
  readonly request: BackupRunRequest
  readonly signature: string
  readonly controller: AbortController
  readonly resultPromise: Promise<T>
  resolveResult: (value: T) => void
  rejectResult: (err: unknown) => void
}

/** Finished runs kept for `listRuns` history. Older ones are dropped. */
const DEFAULT_MAX_FINISHED = 20

export interface BackupRunQueueOptions {
  readonly maxFinished?: number
  readonly now?: () => number
}

/**
 * FIFO queue with concurrency 1. `submit` never starts a second
 * executor while one is in flight; an identical request already
 * WAITING (same destinations/locations/label/retention) is joined
 * instead of queued twice — two schedule ticks due on the same minute
 * produce one run, not two.
 */
export class BackupRunQueue<T> {
  private readonly runs = new Map<string, RunRecord<T>>()
  private readonly pending: string[] = []
  private readonly finished: string[] = []
  private activeId: string | null = null
  private readonly maxFinished: number
  private readonly now: () => number

  constructor(
    private readonly executor: BackupRunExecutor<T>,
    opts?: BackupRunQueueOptions,
  ) {
    this.maxFinished = opts?.maxFinished ?? DEFAULT_MAX_FINISHED
    this.now = opts?.now ?? Date.now
  }

  submit(request: BackupRunRequest): SubmitResult<T> {
    const signature = requestSignature(request)
    const busy = this.activeId !== null || this.pending.length > 0
    // Join an identical run that has not started yet — its execution
    // will observe the same policies and produce the same archive, so
    // a second queue slot would only double the work.
    for (const id of this.pending) {
      const existing = this.runs.get(id)
      if (existing && existing.signature === signature) {
        return { runId: id, queued: true, joined: true, result: existing.resultPromise }
      }
    }
    const record = this.createRecord(request, signature)
    this.runs.set(record.snapshot.id, record)
    this.pending.push(record.snapshot.id)
    this.pump()
    return {
      runId: record.snapshot.id,
      queued: busy,
      joined: false,
      result: record.resultPromise,
    }
  }

  /**
   * Cancel a run. Queued: removed before it ever starts (its result
   * rejects `BackupCancelledError`). Running: the abort signal fires —
   * the executor's tar/upload streams stop and its cleanup runs.
   * Unknown or already terminal: `false`.
   */
  cancel(runId: string): boolean {
    const record = this.runs.get(runId)
    if (!record) return false
    if (record.snapshot.state === 'queued') {
      const idx = this.pending.indexOf(runId)
      if (idx >= 0) this.pending.splice(idx, 1)
      this.finish(record, 'cancelled')
      record.rejectResult(new BackupCancelledError(`backup run ${runId} cancelled while queued`))
      return true
    }
    if (record.snapshot.state === 'running') {
      record.controller.abort()
      return true
    }
    return false
  }

  /**
   * EXECUTION order, not timestamp order: the running run first, then
   * every queued run in the exact order the pump will start them (each
   * stamped with `queuePosition`, 1 = next), then the bounded finished
   * history newest-first. The queued section is read straight off
   * `this.pending` — a consumer sorting by `requestedAt` descending
   * would put the run that starts NEXT at the BOTTOM, which is
   * backwards exactly when the queue matters (more than one waiter).
   */
  listRuns(): readonly BackupRunSnapshot[] {
    const running: BackupRunSnapshot[] = []
    const finished: BackupRunSnapshot[] = []
    for (const record of this.runs.values()) {
      const snap = record.snapshot
      if (snap.state === 'running') running.push(snap)
      else if (snap.state !== 'queued') finished.push(snap)
      // Queued runs are emitted from `this.pending` below — the queue's
      // own order is the only truthful source for them.
    }
    const queued: BackupRunSnapshot[] = []
    for (const [index, id] of this.pending.entries()) {
      const record = this.runs.get(id)
      if (record) queued.push({ ...record.snapshot, queuePosition: index + 1 })
    }
    finished.sort((a, b) => b.requestedAt - a.requestedAt)
    return [...running, ...queued, ...finished]
  }

  getRun(runId: string): BackupRunSnapshot | undefined {
    const record = this.runs.get(runId)
    if (!record) return undefined
    const pendingIndex = this.pending.indexOf(runId)
    return pendingIndex >= 0
      ? { ...record.snapshot, queuePosition: pendingIndex + 1 }
      : record.snapshot
  }

  // ─── internals ─────────────────────────────────────────────────────

  private createRecord(request: BackupRunRequest, signature: string): RunRecord<T> {
    let resolveResult!: (value: T) => void
    let rejectResult!: (err: unknown) => void
    const resultPromise = new Promise<T>((res, rej) => {
      resolveResult = res
      rejectResult = rej
    })
    // A joined/cancelled run's rejection may go unobserved by the
    // original submitter (e.g. the schedule tick already logged it) —
    // never let that surface as an unhandled rejection.
    resultPromise.catch(() => undefined)
    const snapshot: BackupRunSnapshot = {
      id: randomUUID(),
      state: 'queued',
      phase: 'queued',
      destinationIds: request.destinations ?? [],
      ...(request.label !== undefined ? { label: request.label } : {}),
      requestedAt: this.now(),
      stagedBytes: 0,
      uploadedBytes: 0,
      completedDestinationIds: [],
      failedDestinationIds: [],
    }
    return {
      snapshot,
      request,
      signature,
      controller: new AbortController(),
      resultPromise,
      resolveResult,
      rejectResult,
    }
  }

  private pump(): void {
    if (this.activeId !== null) return
    const nextId = this.pending.shift()
    if (nextId === undefined) return
    const record = this.runs.get(nextId)
    if (!record) {
      this.pump()
      return
    }
    this.activeId = nextId
    this.patch(record, { state: 'running', phase: 'building', startedAt: this.now() })
    void this.execute(record)
  }

  private async execute(record: RunRecord<T>): Promise<void> {
    const progress = this.progressFor(record)
    try {
      const value = await this.executor(record.request, record.controller.signal, progress)
      // An executor that stops early on abort and RETURNS its partial
      // result is still a cancelled run — the outcome must never read
      // as a clean success.
      if (record.controller.signal.aborted) {
        this.finish(record, 'cancelled')
      } else {
        // D384: a run that selected destinations and landed the archive at
        // NONE of them is a failure, whatever the executor returned. The
        // executor swallows per-destination errors on purpose (one bad sink
        // must not kill the others), so `succeeded` here reported a run that
        // wrote zero bytes as a clean nightly backup for three days.
        const { destinationIds, completedDestinationIds, failedDestinationIds } = record.snapshot
        const deliveredNothing = destinationIds.length > 0 && completedDestinationIds.length === 0
        if (deliveredNothing) {
          this.finish(
            record,
            'failed',
            `no destination accepted the archive (${(
              failedDestinationIds.length > 0 ? failedDestinationIds : destinationIds
            ).join(', ')})`,
          )
        } else {
          this.finish(record, 'succeeded')
        }
      }
      record.resolveResult(value)
    } catch (err) {
      if (err instanceof BackupCancelledError || record.controller.signal.aborted) {
        this.finish(record, 'cancelled')
        record.rejectResult(err instanceof BackupCancelledError ? err : new BackupCancelledError())
      } else {
        this.finish(record, 'failed', err instanceof Error ? err.message : String(err))
        record.rejectResult(err)
      }
    } finally {
      this.activeId = null
      this.pump()
    }
  }

  private progressFor(record: RunRecord<T>): BackupRunProgress {
    return {
      setPhase: (phase) => this.patch(record, { phase }),
      setDestinations: (ids) => this.patch(record, { destinationIds: [...ids] }),
      setStagedBytes: (bytes) => this.patch(record, { stagedBytes: bytes }),
      setArchiveSize: (bytes) => this.patch(record, { archiveSizeBytes: bytes }),
      setUploadedBytes: (bytes) => this.patch(record, { uploadedBytes: bytes }),
      destinationCompleted: (id) =>
        this.patch(record, {
          completedDestinationIds: [...record.snapshot.completedDestinationIds, id],
          uploadedBytes: 0,
        }),
      destinationFailed: (id) =>
        this.patch(record, {
          failedDestinationIds: [...record.snapshot.failedDestinationIds, id],
          uploadedBytes: 0,
        }),
    }
  }

  private patch(record: RunRecord<T>, patch: Partial<BackupRunSnapshot>): void {
    record.snapshot = { ...record.snapshot, ...patch }
  }

  private finish(record: RunRecord<T>, state: BackupRunState, error?: string): void {
    this.patch(record, {
      state,
      phase: 'done',
      finishedAt: this.now(),
      ...(error !== undefined ? { error } : {}),
    })
    this.finished.push(record.snapshot.id)
    while (this.finished.length > this.maxFinished) {
      const evicted = this.finished.shift()
      if (evicted !== undefined) this.runs.delete(evicted)
    }
  }
}

/**
 * Canonical signature for join-detection. Order-normalised so
 * `{ destinations: [a, b] }` and `{ destinations: [b, a] }` — the same
 * fan-out set — coalesce.
 */
function requestSignature(request: BackupRunRequest): string {
  return JSON.stringify({
    destinations: [...(request.destinations ?? [])].toSorted(),
    locations: [...(request.locations ?? [])].toSorted(),
    label: request.label ?? null,
    retentionCount: request.retentionCount ?? null,
    databases: [...(request.databases ?? [])].toSorted(),
  })
}
