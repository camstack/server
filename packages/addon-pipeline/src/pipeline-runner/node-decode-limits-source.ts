/**
 * This node's decode limits from the orchestrator's agent-settings entry
 * (`decodeBudgetMb`, `maxLiveDecodeWorkers` — D365), read on the lease-knob
 * cadence. The runner never keeps a warm copy (D224): every refresh past the
 * TTL asks the hub; a failed read keeps the last known value and says so.
 */
import type { IScopedLogger } from '@camstack/types'
import type { NodeDecodeLimitsOverride } from '../session-decode/node-decode-budget.js'

export const NODE_DECODE_LIMITS_TTL_MS = 30_000

interface AgentSettingsLike {
  readonly decodeBudgetMb?: number | null
  readonly maxLiveDecodeWorkers?: number | null
}

export interface NodeDecodeLimitsApi {
  readonly pipelineOrchestrator: {
    readonly getAgentSettings: {
      query(input: { agentNodeId: string }): Promise<AgentSettingsLike | null>
    }
  }
}

export interface NodeDecodeLimitsSourceOptions {
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  readonly nodeId: string
  readonly now?: () => number
  readonly ttlMs?: number
}

function pickLimits(settings: AgentSettingsLike | null): NodeDecodeLimitsOverride {
  if (settings === null) return {}
  const budget = settings.decodeBudgetMb
  const workers = settings.maxLiveDecodeWorkers
  return {
    ...(typeof budget === 'number' && Number.isFinite(budget) ? { decodeBudgetMb: budget } : {}),
    ...(typeof workers === 'number' && Number.isFinite(workers)
      ? { maxLiveDecodeWorkers: workers }
      : {}),
  }
}

function sameLimits(a: NodeDecodeLimitsOverride, b: NodeDecodeLimitsOverride): boolean {
  return a.decodeBudgetMb === b.decodeBudgetMb && a.maxLiveDecodeWorkers === b.maxLiveDecodeWorkers
}

export class NodeDecodeLimitsSource {
  private limits: NodeDecodeLimitsOverride = {}
  private lastReadAtMs = Number.NEGATIVE_INFINITY
  private inFlight: Promise<void> | null = null
  private readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  private readonly nodeId: string
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(options: NodeDecodeLimitsSourceOptions) {
    this.logger = options.logger
    this.nodeId = options.nodeId
    this.now = options.now ?? ((): number => Date.now())
    this.ttlMs = options.ttlMs ?? NODE_DECODE_LIMITS_TTL_MS
  }

  current(): NodeDecodeLimitsOverride {
    return this.limits
  }

  async refresh(api: NodeDecodeLimitsApi | undefined): Promise<NodeDecodeLimitsOverride> {
    if (api === undefined) return this.limits
    if (this.now() - this.lastReadAtMs < this.ttlMs) return this.limits
    this.inFlight ??= this.read(api).finally(() => {
      this.inFlight = null
    })
    await this.inFlight
    return this.limits
  }

  private async read(api: NodeDecodeLimitsApi): Promise<void> {
    try {
      const entry = await api.pipelineOrchestrator.getAgentSettings.query({
        agentNodeId: this.nodeId,
      })
      const next = pickLimits(entry)
      this.lastReadAtMs = this.now()
      if (sameLimits(next, this.limits)) return
      this.logger.info('node decode limits changed — the admission resizes on the next dial', {
        meta: { nodeId: this.nodeId, from: { ...this.limits }, to: { ...next } },
      })
      this.limits = next
    } catch (err: unknown) {
      this.logger.warn('node decode limits read failed — keeping the last known value', {
        meta: {
          nodeId: this.nodeId,
          inUse: { ...this.limits },
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }
}
