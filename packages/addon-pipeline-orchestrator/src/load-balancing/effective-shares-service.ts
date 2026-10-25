/**
 * The node and device shares share placement reads (D750, D755).
 *
 * Under an automatic source (`hardware` or `benchmark`) the shares are the
 * cluster's capacity (`AutoTuneService.suggestShares` for that source — ONE
 * computation, so the tab's suggestion and the shares placement holds cannot
 * disagree), held in memory and recomputed:
 *  - at once, when a caller reports what changed (a node joined or left, a
 *    device or a node's detection was switched on or off, Auto tune changed a
 *    model, the source was switched back to automatic);
 *  - and on a periodic reconcile that compares a cheap topology signature and
 *    the age of the answer — the trigger is telemetry and may be lost (D8/D49),
 *    so the reconcile is what guarantees a stale answer cannot outlive a
 *    change;
 *  - and on the very next reconcile when the answer is INCOMPLETE: a node was
 *    present but not readable yet (catalog or hardware not answered — it is
 *    skipped as `node-offline` / `no-hardware-facts`). That state is not in
 *    the topology signature, so before this an answer computed the instant a
 *    node rejoined (N100: share null → weight 1, 1 %) was held for up to
 *    15 min while a fresh suggestion said 6 %.
 * Until the first answer the stored sliders are used, and the Load balancing
 * tab says the automatic shares are pending.
 *
 * In `manual` the stored sliders apply as they are; nothing is computed.
 * Either way a node or device that cannot take sessions is simply not a
 * candidate in the election, which splits its share among the others — the
 * stored values are never rewritten for that.
 */
import type {
  CapacityFallback,
  CapacitySource,
  IScopedLogger,
  ShareSource,
  ShareWeights,
  SuggestSharesResult,
} from '@camstack/types'
import { errMsg, isAutomaticShareSource } from '@camstack/types'

export interface EffectiveSharesServiceDeps {
  readonly readSource: () => ShareSource
  /** The operator's sliders: node `detectWeight` and device `weight`. */
  readonly readStored: () => Promise<ShareWeights>
  /** The capacity suggestion for an automatic source (one pass, no load input). */
  readonly suggest: (source: CapacitySource) => Promise<SuggestSharesResult>
  /**
   * A cheap string that changes whenever the inputs of the suggestion do:
   * the online nodes, each node's detect capability, enabled devices and
   * their models.
   */
  readonly topologySignature: () => Promise<string>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

/** Per node: what its automatic share was computed from. */
export type AutoCapacityByNode = Readonly<
  Record<string, { readonly source: CapacitySource; readonly fallback: CapacityFallback | null }>
>

interface AutoAnswer {
  readonly weights: ShareWeights
  readonly capacity: AutoCapacityByNode
  readonly source: CapacitySource
  readonly computedAt: number
  readonly trigger: string
  readonly signature: string
  /** Nodes skipped because they could not be read YET; the next reconcile recomputes. */
  readonly notReady: readonly string[]
}

/** Skips that mean "not readable yet", never "cannot take sessions". */
const NOT_READY_REASONS: ReadonlySet<string> = new Set(['node-offline', 'no-hardware-facts'])

function capacityFrom(result: SuggestSharesResult): AutoCapacityByNode {
  const out: Record<string, { source: CapacitySource; fallback: CapacityFallback | null }> = {}
  for (const node of result.nodes) {
    if (node.capacitySource !== null) {
      out[node.nodeId] = { source: node.capacitySource, fallback: node.capacityFallback }
    }
  }
  return out
}

function weightsFrom(result: SuggestSharesResult): ShareWeights {
  const nodes: Record<string, number> = {}
  const devices: Record<string, Record<string, number>> = {}
  for (const node of result.nodes) {
    if (node.share !== null && node.share > 0) nodes[node.nodeId] = node.share
    const perDevice: Record<string, number> = {}
    for (const d of node.devices) if (d.share > 0) perDevice[d.deviceKey] = d.share
    if (Object.keys(perDevice).length > 0) devices[node.nodeId] = perDevice
  }
  return { nodes, devices }
}

export class EffectiveSharesService {
  /** An automatic answer older than this is recomputed by the reconcile. */
  static readonly MAX_AGE_MS = 15 * 60_000
  /** Reconcile cadence. */
  static readonly RECONCILE_MS = 60_000

  private answer: AutoAnswer | null = null
  private inFlight: Promise<void> | null = null
  private pendingTrigger: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: EffectiveSharesServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The last automatic answer for the CURRENT source; null = none yet. */
  current(): {
    readonly weights: ShareWeights
    readonly capacity: AutoCapacityByNode
    readonly computedAt: number
    readonly trigger: string
  } | null {
    return this.usable()
  }

  /** The answer, when the source is automatic and the answer was computed for it. */
  private usable(): AutoAnswer | null {
    const source = this.deps.readSource()
    if (!isAutomaticShareSource(source)) return null
    return this.answer !== null && this.answer.source === source ? this.answer : null
  }

  /** Node weights the election reads. */
  async nodeWeights(): Promise<Record<string, number>> {
    const answer = this.usable()
    if (answer !== null) return { ...answer.weights.nodes }
    return { ...(await this.deps.readStored()).nodes }
  }

  /** The weights of a node's ELIGIBLE devices (`eligible` carries their stored weights). */
  deviceWeights(
    nodeId: string,
    eligible: Readonly<Record<string, number>>,
  ): Record<string, number> {
    const answer = this.usable()
    if (answer === null) return { ...eligible }
    const auto = answer.weights.devices[nodeId] ?? {}
    const out: Record<string, number> = {}
    for (const [key, stored] of Object.entries(eligible)) {
      const share = auto[key]
      out[key] = share !== undefined && share > 0 ? share : stored
    }
    return out
  }

  /** Both maps, as the Auto tune recommender charges load by them. */
  async effectiveWeights(): Promise<ShareWeights> {
    return this.usable()?.weights ?? this.deps.readStored()
  }

  /**
   * Recompute now (automatic sources only). Concurrent calls coalesce: one
   * runs, and one trailing run picks up whatever was reported meanwhile.
   */
  async recompute(trigger: string): Promise<void> {
    if (!isAutomaticShareSource(this.deps.readSource())) return
    if (this.inFlight !== null) {
      this.pendingTrigger = trigger
      return this.inFlight
    }
    this.inFlight = this.run(trigger).finally(() => {
      this.inFlight = null
    })
    await this.inFlight
    const trailing = this.pendingTrigger
    if (trailing !== null) {
      this.pendingTrigger = null
      await this.recompute(trailing)
    }
  }

  private async run(trigger: string): Promise<void> {
    const source = this.deps.readSource()
    if (!isAutomaticShareSource(source)) return
    let signature: string
    let result: SuggestSharesResult
    try {
      signature = await this.deps.topologySignature()
      result = await this.deps.suggest(source)
    } catch (err: unknown) {
      this.deps.logger.warn('load balancing: automatic shares not recomputed — last answer kept', {
        meta: { trigger, error: errMsg(err), hasAnswer: this.answer !== null },
      })
      return
    }
    const before = this.answer?.weights ?? null
    const after = weightsFrom(result)
    const notReady = result.nodes
      .filter((n) => n.share === null && NOT_READY_REASONS.has(n.skippedReason ?? ''))
      .map((n) => n.nodeId)
      .toSorted()
    const capacity = capacityFrom(result)
    this.answer = {
      weights: after,
      capacity,
      source,
      computedAt: this.now(),
      trigger,
      signature,
      notReady,
    }
    const nodeIds = [
      ...new Set([...Object.keys(before?.nodes ?? {}), ...result.nodes.map((n) => n.nodeId)]),
    ]
    // A retry while a node stays unreadable changes nothing most minutes: it
    // logs at debug then, so the minute-by-minute retry is not a log flood.
    const unchanged = before !== null && JSON.stringify(before) === JSON.stringify(after)
    const log =
      unchanged && trigger.startsWith('reconcile:not-ready')
        ? this.deps.logger.debug.bind(this.deps.logger)
        : this.deps.logger.info.bind(this.deps.logger)
    for (const nodeId of nodeIds.toSorted()) {
      log('load balancing: automatic shares recomputed', {
        tags: { nodeId },
        meta: {
          trigger,
          source,
          capacitySource: capacity[nodeId]?.source ?? null,
          capacityFallback: capacity[nodeId]?.fallback ?? null,
          notReady: notReady.includes(nodeId),
          before: before?.nodes[nodeId] ?? null,
          after: after.nodes[nodeId] ?? null,
          devicesBefore: JSON.stringify(before?.devices[nodeId] ?? {}),
          devicesAfter: JSON.stringify(after.devices[nodeId] ?? {}),
        },
      })
    }
  }

  /**
   * Recompute if there is no answer for the current source, a node was not
   * readable yet, the topology changed or the answer has grown old
   * (automatic sources only).
   */
  async reconcile(): Promise<void> {
    const source = this.deps.readSource()
    if (!isAutomaticShareSource(source)) return
    if (this.answer === null) return this.recompute('reconcile:first')
    if (this.answer.source !== source) return this.recompute(`reconcile:source:${source}`)
    if (this.answer.notReady.length > 0) {
      return this.recompute(`reconcile:not-ready:${this.answer.notReady.join(',')}`)
    }
    if (this.now() - this.answer.computedAt > EffectiveSharesService.MAX_AGE_MS) {
      return this.recompute('reconcile:age')
    }
    let signature: string
    try {
      signature = await this.deps.topologySignature()
    } catch (err: unknown) {
      this.deps.logger.debug('load balancing: topology signature unreadable — reconcile skipped', {
        meta: { error: errMsg(err) },
      })
      return
    }
    if (signature !== this.answer.signature) return this.recompute('reconcile:topology')
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.reconcile()
    }, EffectiveSharesService.RECONCILE_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}
