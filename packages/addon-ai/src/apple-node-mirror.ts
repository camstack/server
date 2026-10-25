/**
 * The hub's mirror of every node's Apple Foundation Models availability.
 *
 * Why it exists: the first version asked each Apple node LIVE, over nodePin,
 * inside every vision dispatch and every `listProfiles`. A nodePin to a node
 * that is offline waits for discovery (up to 30 s) before it rejects — so with
 * the Mac mid-upgrade every notification gate, summary and rule editor on the
 * hub stalled, including calls routed to a CLOUD profile. A gate must read a
 * mirror, never a fallible remote read on its path (D49, D224).
 *
 * So: `get` is synchronous and answers the slice. A stale slice starts ONE
 * background refresh, never awaited by the reader. The refresh asks the
 * registry which nodes have `llm-runtime` REGISTERED (a local registry read,
 * not the cluster-walking topology, under its own 3 s deadline) and asks only
 * those, each under a short deadline. A node missing from TWO answered reads
 * in a row is known offline and is never dialled — one absence is a blip (a
 * runner re-registering), and it is re-checked within seconds. A registry
 * read that fails or answers nothing changes nothing, and backs off a period.
 */
import type { AppleFmAvailability, IScopedLogger } from '@camstack/types'

const DEFAULT_STALE_MS = 30_000
const DEFAULT_ASK_TIMEOUT_MS = 5_000
/** A registry read is local; one that takes longer than this did not answer. */
const DEFAULT_REGISTRY_TIMEOUT_MS = 3_000
/** After a node first goes missing, confirm it this soon rather than a full period later. */
const DEFAULT_CONFIRM_ABSENCE_MS = 2_000
/** Consecutive answered registry reads a node must be missing from to be "offline". */
const ABSENCES_TO_OFFLINE = 2

export interface AppleNodeSource {
  /**
   * Nodes with an `llm-runtime` provider registered right now. `null` = the
   * registry gave no answer (no such capability entry yet) — NOT "no nodes".
   */
  listRegisteredRuntimeNodeIds(): Promise<readonly string[] | null>
  appleAvailability(nodeId: string): Promise<AppleFmAvailability>
}

export interface AppleNodeMirrorDeps {
  readonly source: AppleNodeSource
  readonly logger: IScopedLogger
  readonly staleMs?: number
  readonly askTimeoutMs?: number
  readonly registryTimeoutMs?: number
  readonly confirmAbsenceMs?: number
  readonly now?: () => number
}

type AskOutcome =
  | { readonly kind: 'answer'; readonly availability: AppleFmAvailability }
  | { readonly kind: 'failed'; readonly error: string }

type RegistryOutcome =
  | { readonly kind: 'answer'; readonly nodeIds: readonly string[] }
  | { readonly kind: 'failed'; readonly error: string }

/** Settles `work` or reports a failure after `ms`; never throws. */
function bounded<T>(
  work: Promise<T>,
  ms: number,
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }
> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: `no answer within ${String(ms)} ms` }),
      ms,
    )
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve({ ok: true, value })
      },
      (err: unknown) => {
        clearTimeout(timer)
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      },
    )
  })
}

export class AppleNodeMirror {
  private readonly slices = new Map<string, AppleFmAvailability>()
  /**
   * Answered registry reads in a row each node has been MISSING from. One
   * absence is a blip (a node re-registering after a runner respawn); only
   * `ABSENCES_TO_OFFLINE` in a row make it offline.
   */
  private readonly absences = new Map<string, number>()
  /** Nodes any answered registry read has listed — the ones absence is counted for. */
  private readonly everListed = new Set<string>()
  /** `false` until the registry has answered once: nobody is known offline before. */
  private registryAnswered = false
  private answeredReads = 0
  private fetchedAt: number | null = null
  /** Set when a node first goes missing: revalidate early to confirm or clear it. */
  private confirmBy: number | null = null
  private inFlight = false
  private readonly now: () => number

  constructor(private readonly deps: AppleNodeMirrorDeps) {
    this.now = deps.now ?? Date.now
  }

  /** The node's last known state; `undefined` = unknown. Never waits. */
  get(nodeId: string): AppleFmAvailability | undefined {
    this.revalidateIfStale()
    return this.slices.get(nodeId)
  }

  /** Missing from the last `ABSENCES_TO_OFFLINE` ANSWERED registry reads. */
  isKnownOffline(nodeId: string): boolean {
    this.revalidateIfStale()
    if (!this.registryAnswered) return false
    const listedBefore = this.everListed.has(nodeId)
    const missing = this.absences.get(nodeId) ?? 0
    // A node never listed since boot has been absent from every answered read.
    return listedBefore ? missing >= ABSENCES_TO_OFFLINE : this.answeredReads >= ABSENCES_TO_OFFLINE
  }

  /** An answer obtained elsewhere (the runtimes page asks every node anyway). */
  observe(nodeId: string, availability: AppleFmAvailability): void {
    this.slices.set(nodeId, availability)
  }

  async refresh(): Promise<void> {
    this.inFlight = true
    try {
      const registry = await this.readRegistry()
      // Any outcome stamps the time: a failed read backs off for a period
      // instead of being retried by every reader on the event path.
      this.fetchedAt = this.now()
      if (registry.kind === 'failed') {
        this.deps.logger.info(
          'apple node mirror: registry gave no answer; keeping the last slice',
          {
            meta: { error: registry.error },
          },
        )
        return
      }
      this.applyRegistry(registry.nodeIds)
      const answers = await Promise.all(
        registry.nodeIds.map(async (nodeId) => [nodeId, await this.ask(nodeId)] as const),
      )
      for (const [nodeId, outcome] of answers) {
        this.slices.set(
          nodeId,
          outcome.kind === 'answer'
            ? outcome.availability
            : { state: 'unknown', error: outcome.error },
        )
      }
    } finally {
      this.inFlight = false
    }
  }

  private async readRegistry(): Promise<RegistryOutcome> {
    const result = await bounded(
      this.deps.source.listRegisteredRuntimeNodeIds(),
      this.deps.registryTimeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS,
    )
    if (!result.ok) return { kind: 'failed', error: result.error }
    if (result.value === null)
      return { kind: 'failed', error: 'the registry has no llm-runtime entry' }
    return { kind: 'answer', nodeIds: result.value }
  }

  private applyRegistry(nodeIds: readonly string[]): void {
    this.registryAnswered = true
    this.answeredReads += 1
    const listed = new Set(nodeIds)
    let newlyMissing = false
    for (const nodeId of listed) {
      this.everListed.add(nodeId)
      this.absences.delete(nodeId)
    }
    for (const nodeId of this.everListed) {
      if (listed.has(nodeId)) continue
      const missing = (this.absences.get(nodeId) ?? 0) + 1
      this.absences.set(nodeId, missing)
      if (missing === 1) newlyMissing = true
      // The slice is dropped only once the node is CONFIRMED gone.
      if (missing >= ABSENCES_TO_OFFLINE) this.slices.delete(nodeId)
    }
    this.confirmBy = newlyMissing
      ? this.now() + (this.deps.confirmAbsenceMs ?? DEFAULT_CONFIRM_ABSENCE_MS)
      : null
  }

  private revalidateIfStale(): void {
    if (this.inFlight) return
    const now = this.now()
    const stale =
      this.fetchedAt === null ||
      now - this.fetchedAt >= (this.deps.staleMs ?? DEFAULT_STALE_MS) ||
      (this.confirmBy !== null && now >= this.confirmBy)
    if (stale) {
      this.confirmBy = null
      void this.refresh()
    }
  }

  private async ask(nodeId: string): Promise<AskOutcome> {
    const result = await bounded(
      this.deps.source.appleAvailability(nodeId),
      this.deps.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
    )
    return result.ok
      ? { kind: 'answer', availability: result.value }
      : { kind: 'failed', error: result.error }
  }
}
