/**
 * Background adoption job engine.
 *
 * `device-adoption.adopt({childNativeIds: [...]})` materialises one CamStack
 * device per candidate PLUS every accessory child, and the whole array shares
 * ONE UDS request deadline (60s). The deadline is correct and is not the thing
 * to raise — `SocketChannel.request` once had no timeout at all and a mute peer
 * hung forever. The work simply does not fit inside it:
 *
 * Measured on the live hub (Home Assistant, 491 candidates):
 *   - `listCandidates` for the whole inventory: ~200 ms. Not the cost.
 *   - Each device the kernel creates: ~450 ms, because `devices.create`
 *     pre-seeds meta with up to eleven SEQUENTIAL round trips before the class
 *     is constructed. An accessory child costs exactly what its parent costs.
 *   - 25 candidates × ~6 children → ~150 devices → timed out at 60,346 ms with
 *     9 of 25 landed; the provider kept going and finished all 25 at ~130 s.
 *   - ONE candidate with 217 children → timed out at 61,829 ms.
 *
 * That last line is the whole argument for a job. The count that blows the
 * budget is the SOURCE SYSTEM's accessory fan-out — the operator neither picks
 * it nor sees it — so no chunk size, no bounded concurrency over candidates and
 * no per-call tuning fixes a shape where N=1 already fails.
 *
 * ## Why serial, and not bounded-concurrent
 *
 * Every one of those ~450 ms is round trips into the single-threaded hub, not
 * work this process could overlap. Running candidates concurrently would
 * multiply pressure on the same event loop that the live pipeline shares, and
 * would race two `allocateDeviceId` calls for the same stableId when a source
 * system exposes one entity under two candidates. The concurrency here is
 * deliberately ONE; the fix for wall-clock is collapsing the eleven-RPC
 * pre-seed in `devices.create`, which is a separate, framework-wide change.
 *
 * ## Cheap question first
 *
 * A candidate that is already adopted is skipped BEFORE any provider call, from
 * one `listCandidates` snapshot taken at job start. That makes a retry after a
 * timeout a no-op for everything that already landed, instead of the current
 * behaviour — the provider throws on a duplicate stableId, and when EVERY
 * resubmitted candidate was already adopted the whole call fails with
 * "all N adopt(s) failed", which reads as "nothing worked" when in truth
 * everything did.
 */

import type {
  AdoptionCandidateResult,
  AdoptionJob,
  AdoptionOutcome,
  IScopedLogger,
} from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { RemovalFence } from './removal-fence.js'

/**
 * The slice of a `device-adoption` provider this engine drives. Structural on
 * purpose: the real provider satisfies it, and a spec can exercise the whole
 * loop without standing up a registry.
 */
export interface AdoptionJobProvider {
  listCandidates(input: {
    integrationId: string
    page: number
    pageSize: number
    filter?: string
  }): Promise<{
    readonly candidates: readonly {
      readonly childNativeId: string
      readonly alreadyAdopted?: boolean
    }[]
  }>
  adopt(input: {
    integrationId: string
    childNativeIds: readonly string[]
    filter?: string
    importLocations?: boolean
    perCandidate?: Record<string, { name?: string; hiddenChildIds?: string[] }>
  }): Promise<AdoptResult>
}

/** What one `adopt` call answers. Named so the per-candidate suspension in
 *  {@link AdoptionJobEngine} has a return type to state. */
export interface AdoptResult {
  readonly adopted: readonly {
    readonly childNativeId: string
    readonly parentDeviceId: number
    readonly accessoryDeviceIds: readonly number[]
  }[]
}

export interface AdoptionJobEngineDeps {
  /** Resolve the integration's adoption provider for an `addonId` pin. */
  resolveProvider(addonId: string): Promise<AdoptionJobProvider>
  readonly logger: IScopedLogger
  /**
   * The device-manager's removal fence, so an operator re-adopting hardware
   * they just deleted is not refused for their OWN action.
   *
   * `removal-fence.ts` says a deliberate re-add lifts the fence, and
   * `adoptDevice` does exactly that — but a job never went near it, so every
   * integration driven through this engine refused a re-add for the whole
   * 5-minute TTL. Reported on a Dreame vacuum, 2026-09-16.
   *
   * It has to be suspended HERE and not by the caller: `runUnfenced` is a
   * counter held for the length of an awaited call, while `start()` hands back
   * a jobId immediately and adopts on a detached promise. Wrapping the caller
   * would lower the fence for the microseconds it takes to mint an id.
   *
   * Optional: absent means exactly the previous behaviour.
   */
  readonly removalFence?: RemovalFence
  readonly now?: () => number
  readonly newId?: () => string
}

export interface StartAdoptionJobInput {
  readonly addonId: string
  readonly integrationId: string
  readonly childNativeIds: readonly string[]
  readonly filter?: string
  readonly importLocations?: boolean
  readonly perCandidate?: Record<string, { name?: string; hiddenChildIds?: string[] }>
}

/** How many finished jobs are kept per (addonId, integrationId). */
const JOB_HISTORY = 20

interface MutableResult {
  childNativeId: string
  outcome: AdoptionOutcome
  parentDeviceId: number | null
  accessoryCount: number
  error: string | null
}

interface MutableJob {
  jobId: string
  addonId: string
  integrationId: string
  state: AdoptionJob['state']
  total: number
  currentChildNativeId: string | null
  results: MutableResult[]
  startedAt: number
  finishedAt: number | null
  error: string | null
  cancelRequested: boolean
  /** Resolves when the detached loop has settled. Test-only handle. */
  done: Promise<void>
}

function snapshot(j: MutableJob): AdoptionJob {
  let adopted = 0
  let alreadyAdopted = 0
  let failed = 0
  let processed = 0
  let accessoriesCreated = 0
  for (const r of j.results) {
    if (r.outcome === 'cancelled') continue
    processed += 1
    accessoriesCreated += r.accessoryCount
    if (r.outcome === 'adopted') adopted += 1
    else if (r.outcome === 'already-adopted') alreadyAdopted += 1
    else if (r.outcome === 'failed') failed += 1
  }
  return {
    jobId: j.jobId,
    addonId: j.addonId,
    integrationId: j.integrationId,
    state: j.state,
    total: j.total,
    processed,
    adopted,
    alreadyAdopted,
    failed,
    accessoriesCreated,
    currentChildNativeId: j.currentChildNativeId,
    results: j.results.map(
      (r): AdoptionCandidateResult => ({
        childNativeId: r.childNativeId,
        outcome: r.outcome,
        parentDeviceId: r.parentDeviceId,
        accessoryCount: r.accessoryCount,
        error: r.error,
      }),
    ),
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
  }
}

export class AdoptionJobEngine {
  private readonly jobs = new Map<string, MutableJob>()
  private seq = 0

  constructor(private readonly deps: AdoptionJobEngineDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private newId(): string {
    if (this.deps.newId) return this.deps.newId()
    this.seq += 1
    return `adopt-${Date.now().toString(36)}-${this.seq}`
  }

  /**
   * Accept the batch and return immediately. The provider is resolved BEFORE
   * returning so an unroutable `addonId` is refused at the call the operator
   * made, not buried in a job they have to go looking for.
   */
  async start(input: StartAdoptionJobInput): Promise<{ jobId: string }> {
    const provider = await this.deps.resolveProvider(input.addonId)
    const job: MutableJob = {
      jobId: this.newId(),
      addonId: input.addonId,
      integrationId: input.integrationId,
      state: 'running',
      total: input.childNativeIds.length,
      currentChildNativeId: null,
      results: [],
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      cancelRequested: false,
      done: Promise.resolve(),
    }
    this.jobs.set(job.jobId, job)
    this.prune(input.addonId, input.integrationId)
    this.deps.logger.info('adoption job started', {
      tags: { addonId: input.addonId },
      meta: { jobId: job.jobId, integrationId: input.integrationId, total: job.total },
    })
    // Detached on purpose — this is the whole point of the job.
    job.done = this.run(job, provider, input)
    return { jobId: job.jobId }
  }

  get(jobId: string): AdoptionJob | null {
    const j = this.jobs.get(jobId)
    return j ? snapshot(j) : null
  }

  list(filter: { addonId?: string; integrationId?: string }): readonly AdoptionJob[] {
    return [...this.jobs.values()]
      .filter(
        (j) =>
          (filter.addonId === undefined || j.addonId === filter.addonId) &&
          (filter.integrationId === undefined || j.integrationId === filter.integrationId),
      )
      .sort((a, b) => b.startedAt - a.startedAt || b.jobId.localeCompare(a.jobId))
      .map(snapshot)
  }

  /** Cooperative cancel — the in-flight candidate finishes, the rest do not start. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'running') return false
    job.cancelRequested = true
    this.deps.logger.info('adoption job cancel requested', {
      tags: { addonId: job.addonId },
      meta: { jobId, integrationId: job.integrationId },
    })
    return true
  }

  /** Test-only: await the detached loop. Never called by production code. */
  async waitForTest(jobId: string): Promise<void> {
    await this.jobs.get(jobId)?.done
  }

  private prune(addonId: string, integrationId: string): void {
    const finished = [...this.jobs.values()]
      .filter(
        (j) => j.addonId === addonId && j.integrationId === integrationId && j.state !== 'running',
      )
      .sort((a, b) => b.startedAt - a.startedAt)
    for (const j of finished.slice(JOB_HISTORY)) this.jobs.delete(j.jobId)
  }

  private async run(
    job: MutableJob,
    provider: AdoptionJobProvider,
    input: StartAdoptionJobInput,
  ): Promise<void> {
    try {
      const already = await this.alreadyAdopted(provider, input, job)
      for (const childNativeId of input.childNativeIds) {
        if (job.cancelRequested) {
          job.results.push({
            childNativeId,
            outcome: 'cancelled',
            parentDeviceId: null,
            accessoryCount: 0,
            error: null,
          })
          continue
        }
        if (already.has(childNativeId)) {
          // The cheap question first: never pay a provider round trip — nor a
          // duplicate-stableId throw — for work that is already done.
          job.results.push({
            childNativeId,
            outcome: 'already-adopted',
            parentDeviceId: null,
            accessoryCount: 0,
            error: null,
          })
          this.deps.logger.info('adoption job: candidate already adopted, skipped', {
            tags: { addonId: job.addonId },
            meta: { jobId: job.jobId, integrationId: job.integrationId, childNativeId },
          })
          continue
        }
        job.currentChildNativeId = childNativeId
        await this.adoptOne(job, provider, input, childNativeId)
        job.currentChildNativeId = null
      }
      job.state = job.cancelRequested ? 'cancelled' : 'done'
    } catch (err) {
      // The job itself broke (not one candidate) — say so rather than leaving
      // it 'running' forever.
      job.state = 'failed'
      job.error = errMsg(err)
      this.deps.logger.error('adoption job failed', {
        tags: { addonId: job.addonId },
        meta: { jobId: job.jobId, integrationId: job.integrationId, error: job.error },
      })
    } finally {
      job.currentChildNativeId = null
      job.finishedAt = this.now()
      const s = snapshot(job)
      this.deps.logger.info('adoption job finished', {
        tags: { addonId: job.addonId },
        meta: {
          jobId: job.jobId,
          integrationId: job.integrationId,
          state: s.state,
          total: s.total,
          adopted: s.adopted,
          alreadyAdopted: s.alreadyAdopted,
          failed: s.failed,
          accessoriesCreated: s.accessoriesCreated,
          durationMs: (s.finishedAt ?? 0) - s.startedAt,
        },
      })
    }
  }

  /**
   * One `listCandidates` snapshot at job start. A read that FAILS must not be
   * read as "nothing is adopted" — that would send every candidate to the
   * provider and turn a safe retry back into a wall of duplicate-stableId
   * errors — so a failure yields an empty set AND a warning, and the
   * per-candidate failure path stays the backstop.
   */
  private async alreadyAdopted(
    provider: AdoptionJobProvider,
    input: StartAdoptionJobInput,
    job: MutableJob,
  ): Promise<ReadonlySet<string>> {
    try {
      const page = await provider.listCandidates({
        integrationId: input.integrationId,
        page: 1,
        pageSize: 20000,
        ...(input.filter !== undefined ? { filter: input.filter } : {}),
      })
      const out = new Set<string>()
      for (const c of page.candidates) {
        if (c.alreadyAdopted === true) out.add(c.childNativeId)
      }
      return out
    } catch (err) {
      this.deps.logger.warn(
        'adoption job: pre-flight listCandidates failed — every candidate will be attempted',
        {
          tags: { addonId: job.addonId },
          meta: { jobId: job.jobId, integrationId: job.integrationId, error: errMsg(err) },
        },
      )
      return new Set<string>()
    }
  }

  private async adoptOne(
    job: MutableJob,
    provider: AdoptionJobProvider,
    input: StartAdoptionJobInput,
    childNativeId: string,
  ): Promise<void> {
    const startedAt = this.now()
    try {
      const per = input.perCandidate?.[childNativeId]
      // ONE candidate wide, and no wider: the fence is a global suspension, so
      // holding it down for the length of a whole job would re-open the race
      // D376 records — a teardown still in flight putting a deleted row back
      // as a config-less shell. `runUnfenced` restores it in a `finally`, so a
      // provider that throws does not leave it down either.
      const adoptCandidate = async (): Promise<AdoptResult> =>
        await provider.adopt({
          integrationId: input.integrationId,
          childNativeIds: [childNativeId],
          ...(input.filter !== undefined ? { filter: input.filter } : {}),
          ...(input.importLocations !== undefined
            ? { importLocations: input.importLocations }
            : {}),
          ...(per !== undefined ? { perCandidate: { [childNativeId]: per } } : {}),
        })
      const fence = this.deps.removalFence
      const res =
        fence === undefined ? await adoptCandidate() : await fence.runUnfenced(adoptCandidate)
      const entry = res.adopted[0]
      if (!entry) {
        // The provider returned success with nothing adopted. A branch that
        // drops work silently is exactly what makes a gap undiagnosable.
        job.results.push({
          childNativeId,
          outcome: 'failed',
          parentDeviceId: null,
          accessoryCount: 0,
          error: 'provider returned no adopted entry',
        })
        this.deps.logger.warn('adoption job: provider adopted nothing for candidate', {
          tags: { addonId: job.addonId },
          meta: { jobId: job.jobId, integrationId: job.integrationId, childNativeId },
        })
        return
      }
      job.results.push({
        childNativeId,
        outcome: 'adopted',
        parentDeviceId: entry.parentDeviceId,
        accessoryCount: entry.accessoryDeviceIds.length,
        error: null,
      })
      this.deps.logger.info('adoption job: candidate adopted', {
        tags: { deviceId: entry.parentDeviceId, addonId: job.addonId },
        meta: {
          jobId: job.jobId,
          integrationId: job.integrationId,
          childNativeId,
          accessories: entry.accessoryDeviceIds.length,
          durationMs: this.now() - startedAt,
        },
      })
    } catch (err) {
      job.results.push({
        childNativeId,
        outcome: 'failed',
        parentDeviceId: null,
        accessoryCount: 0,
        error: errMsg(err),
      })
      // One bad candidate never aborts the batch — the other 24 still land.
      this.deps.logger.warn('adoption job: candidate failed', {
        tags: { addonId: job.addonId },
        meta: {
          jobId: job.jobId,
          integrationId: job.integrationId,
          childNativeId,
          durationMs: this.now() - startedAt,
          error: errMsg(err),
        },
      })
    }
  }
}
