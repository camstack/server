/**
 * "Camera placement can be rebalanced" — the alert that closes the gap between
 * the auto sweep and a manual rebalance.
 *
 * The 60 s sweep migrates under a hysteresis margin, so a skew smaller than the
 * margin persists forever (churning live streams to chase it would be worse).
 * After a node joins, leaves or changes what it may run, ONE debounced
 * evaluation plans a manual rebalance (margin 0) next to the sweep's own plan
 * (margin 1.5). If the manual plan moves cameras the sweep never will, an alert
 * offers `rebalanceNow`; an empty plan closes it. A second alert tells the
 * operator about a runner node that joined but is not detect-enabled.
 *
 * Only in-memory state is read and a failed plan changes nothing (D49).
 */
import type { Alert, IScopedLogger } from '@camstack/types'
import { AUTO_REBALANCE_MIN_IMPROVEMENT } from './orchestrator-types.js'

export const REBALANCE_SUGGESTED_ALERT_ID = 'pipeline-orchestrator:rebalance-suggested'
export const NODE_NOT_USED_ALERT_PREFIX = 'pipeline-orchestrator:node-not-used:'
/** The alert category the Alert Center files both alerts under. */
const ALERT_CATEGORY = 'system'
export const DEFAULT_SUGGESTION_DEBOUNCE_MS = 90_000

export type NodeEventKind = 'joined' | 'left' | 'capabilities'

export interface NodeEventNote {
  readonly kind: NodeEventKind
  readonly nodeId: string
}

/** What the evaluation needs from a plan: which cameras would move. */
export interface PlannedMoves {
  readonly moves: readonly { readonly deviceId: number }[]
}

type SuggestionLogger = Pick<IScopedLogger, 'info' | 'warn' | 'debug' | 'error'>

export interface RebalanceSuggestionDeps {
  readonly addonId: string
  readonly logger: SuggestionLogger
  readonly debounceMs: number
  readonly now: () => number
  /** Plan a rebalance at this margin without migrating anything. */
  readonly plan: (minImprovement: number) => Promise<PlannedMoves>
  readonly enabledNodes: () => readonly string[]
  readonly runnerNodes: () => readonly string[]
  readonly alerts: {
    readonly emit: (alert: Alert) => Promise<void>
    readonly complete: (alertId: string) => Promise<void>
  }
}

const VERB: Record<NodeEventKind, string> = {
  joined: 'joined',
  left: 'left',
  capabilities: 'changed its pipeline roles',
}

export class RebalanceSuggestion {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastNote: NodeEventNote | null = null
  private readonly notUsedRaised = new Set<string>()
  private disposed = false

  constructor(private readonly deps: RebalanceSuggestionDeps) {}

  /** A node event: (re)arm the single evaluation. Forked-process ids are not nodes. */
  noteNodeEvent(note: NodeEventNote): void {
    if (this.disposed || note.nodeId.includes('/')) return
    this.lastNote = note
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.evaluate()
    }, this.deps.debounceMs)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  async evaluate(): Promise<void> {
    await this.evaluateSuggestion()
    await this.evaluateUnusedNodes()
  }

  private async evaluateSuggestion(): Promise<void> {
    const { logger } = this.deps
    let manual: PlannedMoves
    let sweep: PlannedMoves
    try {
      manual = await this.deps.plan(0)
      sweep = await this.deps.plan(AUTO_REBALANCE_MIN_IMPROVEMENT)
    } catch (err: unknown) {
      logger.warn('rebalance suggestion: plan failed — alert left as it is', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    const sweepIds = new Set(sweep.moves.map((m) => m.deviceId))
    const onlyManual = manual.moves.filter((m) => !sweepIds.has(m.deviceId))
    if (onlyManual.length === 0) {
      logger.debug('rebalance suggestion: nothing beyond the auto sweep — closing the alert', {
        meta: {
          manualMoves: manual.moves.length,
          sweepMoves: sweep.moves.length,
        },
      })
      await this.complete(REBALANCE_SUGGESTED_ALERT_ID)
      return
    }
    const note = this.lastNote
    const cause = note === null ? 'The cluster changed' : `Node ${note.nodeId} ${VERB[note.kind]}`
    const count = manual.moves.length
    const now = this.deps.now()
    logger.info('rebalance suggestion: raising the alert', {
      meta: { manualMoves: count, beyondSweep: onlyManual.length },
    })
    await this.emit({
      id: REBALANCE_SUGGESTED_ALERT_ID,
      category: ALERT_CATEGORY,
      severity: 'warning',
      title: 'Camera placement can be rebalanced',
      message: `${cause}. ${String(count)} ${count === 1 ? 'camera' : 'cameras'} would move to even out the load; the automatic balancing will not do it on its own.`,
      action: {
        label: 'Rebalance now',
        invoke: { addonId: this.deps.addonId, action: 'rebalanceNow' },
      },
      status: 'active',
      read: false,
      createdAt: now,
      updatedAt: now,
      source: { type: 'addon', id: this.deps.addonId },
    })
  }

  private async evaluateUnusedNodes(): Promise<void> {
    const enabled = new Set(this.deps.enabledNodes())
    const unused = new Set(this.deps.runnerNodes().filter((id) => !enabled.has(id)))
    for (const nodeId of unused) {
      const id = `${NODE_NOT_USED_ALERT_PREFIX}${nodeId}`
      if (this.notUsedRaised.has(id)) continue
      this.notUsedRaised.add(id)
      this.deps.logger.info('rebalance suggestion: node online but not used for detection', {
        tags: { nodeId },
      })
      const now = this.deps.now()
      await this.emit({
        id,
        category: ALERT_CATEGORY,
        severity: 'info',
        title: 'Node is not used for detection',
        message: `Node ${nodeId} is online but detection is not enabled on it, so no camera will be placed there.`,
        action: {
          label: 'Open node',
          href: `/system/pipeline?view=nodes&node=${encodeURIComponent(nodeId)}`,
          navigation: 'app',
        },
        status: 'active',
        read: false,
        createdAt: now,
        updatedAt: now,
        source: { type: 'node', id: nodeId },
      })
    }
    for (const id of [...this.notUsedRaised]) {
      const nodeId = id.slice(NODE_NOT_USED_ALERT_PREFIX.length)
      if (unused.has(nodeId)) continue
      this.notUsedRaised.delete(id)
      await this.complete(id)
    }
  }

  private async emit(alert: Alert): Promise<void> {
    await this.deps.alerts.emit(alert).catch((err: unknown) => {
      this.deps.logger.warn('rebalance suggestion: could not raise an alert', {
        meta: {
          alertId: alert.id,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    })
  }

  private async complete(alertId: string): Promise<void> {
    await this.deps.alerts.complete(alertId).catch((err: unknown) => {
      this.deps.logger.debug('rebalance suggestion: close failed (alert may not exist)', {
        meta: {
          alertId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    })
  }
}
