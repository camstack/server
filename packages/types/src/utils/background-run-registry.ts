/**
 * Start-then-poll for work that outlives one request.
 *
 * An addon's custom action rides the UDS addon-call plane, whose request
 * timeout is 60 s (`DEFAULT_UDS_REQUEST_TIMEOUT_MS`) and which a custom action
 * cannot raise. A run longer than that used to be ABANDONED by its caller
 * while it kept running — the capacity ramp moved to fire-and-poll for exactly
 * that reason, and every other long benchmark run had to follow (D646). This is
 * the one shape they share: `start` validates nothing about the work itself, it
 * registers it, answers at once with a `running` receipt, and the caller polls
 * `status` for progress and, eventually, the result or the named failure.
 *
 * In RAM on purpose. A run belongs to the process that runs it; a restart ends
 * it, and a finished run's result is the caller's to persist if it matters.
 * The registry keeps a BOUNDED number of finished runs so a page reopened after
 * the run ended can still read it, and it never drops a run that is still
 * going.
 */

/** Where a run is. `aborted` keeps whatever result the work returned after the signal. */
export type BackgroundRunState = 'running' | 'done' | 'failed' | 'aborted'

export interface BackgroundRunStatus<TProgress, TResult> {
  readonly runId: string
  readonly state: BackgroundRunState
  readonly startedAtMs: number
  /** `null` while running. */
  readonly finishedAtMs: number | null
  /** The last progress the work reported; `null` until it reports any. */
  readonly progress: TProgress | null
  /** Present once the work resolved (`done`, or `aborted` with what it had). */
  readonly result: TResult | null
  /** The failure, verbatim — present iff `state === 'failed'`. */
  readonly error: string | null
}

/** What the work receives: how to be told to stop, and how to say how far it got. */
export interface BackgroundRunContext<TProgress> {
  readonly signal: AbortSignal
  report(progress: TProgress): void
}

export interface BackgroundRunRegistryOptions<TProgress, TResult> {
  /** Runs allowed at once. A start beyond it is REFUSED, never queued. */
  readonly maxConcurrent: number
  /** Finished runs remembered for a late poll. */
  readonly keepFinished: number
  readonly now?: () => number
  /** Called once per run when it leaves `running` — the caller's hook to log or persist. */
  readonly onSettled?: (status: BackgroundRunStatus<TProgress, TResult>) => void
}

interface MutableRun<TProgress, TResult> {
  runId: string
  state: BackgroundRunState
  startedAtMs: number
  finishedAtMs: number | null
  progress: TProgress | null
  result: TResult | null
  error: string | null
  readonly controller: AbortController
}

function snapshot<TProgress, TResult>(
  run: MutableRun<TProgress, TResult>,
): BackgroundRunStatus<TProgress, TResult> {
  return {
    runId: run.runId,
    state: run.state,
    startedAtMs: run.startedAtMs,
    finishedAtMs: run.finishedAtMs,
    progress: run.progress,
    result: run.result,
    error: run.error,
  }
}

export class BackgroundRunRegistry<TProgress, TResult> {
  private readonly runs = new Map<string, MutableRun<TProgress, TResult>>()
  private readonly now: () => number

  constructor(private readonly opts: BackgroundRunRegistryOptions<TProgress, TResult>) {
    this.now = opts.now ?? Date.now
  }

  /** Runs still going. */
  get runningCount(): number {
    let n = 0
    for (const run of this.runs.values()) if (run.state === 'running') n += 1
    return n
  }

  /**
   * Register and start `work`. Returns the `running` receipt immediately.
   * Throws only for a refusal the caller must see (duplicate id, busy) — a
   * failure of the work itself lands in `status`, never here.
   */
  start(
    runId: string,
    work: (ctx: BackgroundRunContext<TProgress>) => Promise<TResult>,
  ): BackgroundRunStatus<TProgress, TResult> {
    const existing = this.runs.get(runId)
    if (existing !== undefined && existing.state === 'running') {
      throw new Error(`run '${runId}' is already running`)
    }
    if (this.runningCount >= this.opts.maxConcurrent) {
      throw new Error(
        `busy: ${this.runningCount}/${this.opts.maxConcurrent} run(s) already in progress — wait for one to finish or abort it`,
      )
    }
    const run: MutableRun<TProgress, TResult> = {
      runId,
      state: 'running',
      startedAtMs: this.now(),
      finishedAtMs: null,
      progress: null,
      result: null,
      error: null,
      controller: new AbortController(),
    }
    this.runs.delete(runId)
    this.runs.set(runId, run)
    const ctx: BackgroundRunContext<TProgress> = {
      signal: run.controller.signal,
      report: (progress) => {
        run.progress = progress
      },
    }
    const settle = (patch: { readonly result?: TResult; readonly error?: string }): void => {
      if (patch.error !== undefined) {
        run.state = 'failed'
        run.error = patch.error
      } else {
        run.state = run.controller.signal.aborted ? 'aborted' : 'done'
        run.result = patch.result ?? null
      }
      run.finishedAtMs = this.now()
      this.prune()
      this.opts.onSettled?.(snapshot(run))
    }
    let pending: Promise<TResult>
    try {
      pending = work(ctx)
    } catch (err: unknown) {
      pending = Promise.reject(err)
    }
    pending.then(
      (result) => settle({ result }),
      (err: unknown) => settle({ error: err instanceof Error ? err.message : String(err) }),
    )
    return snapshot(run)
  }

  status(runId: string): BackgroundRunStatus<TProgress, TResult> | null {
    const run = this.runs.get(runId)
    return run === undefined ? null : snapshot(run)
  }

  /** Running runs first (newest start first), then finished ones (newest finish first). */
  list(): readonly BackgroundRunStatus<TProgress, TResult>[] {
    const all = [...this.runs.values()]
    const running = all
      .filter((r) => r.state === 'running')
      .toSorted((a, b) => b.startedAtMs - a.startedAtMs)
    const finished = all
      .filter((r) => r.state !== 'running')
      .toSorted((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0))
    return [...running, ...finished].map(snapshot)
  }

  /** Signal a running run to stop. `false` for an unknown or already finished run. */
  abort(runId: string): boolean {
    const run = this.runs.get(runId)
    if (run === undefined || run.state !== 'running') return false
    run.controller.abort()
    return true
  }

  /** Abort every running run (shutdown). */
  abortAll(): void {
    for (const run of this.runs.values()) if (run.state === 'running') run.controller.abort()
  }

  private prune(): void {
    const finished = [...this.runs.values()]
      .filter((r) => r.state !== 'running')
      .toSorted((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0))
    const excess = finished.length - this.opts.keepFinished
    for (let i = 0; i < excess; i++) {
      const victim = finished[i]
      if (victim !== undefined) this.runs.delete(victim.runId)
    }
  }
}
