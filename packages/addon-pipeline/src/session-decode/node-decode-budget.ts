/**
 * The decode RAM budget and worker cap THIS node runs under.
 *
 * `nodeDecodeBudgetMb` and `maxLiveDecodeWorkers` are cluster settings — one
 * number for a 64 GB hub and a 16 GB Mac alike. Until 2026-09-05 the shipped
 * 8192 MB was the hub's number applied everywhere; with the footprint fixed
 * (D361) that admits 8 workers on the Mac, whose workers measure RSS p90
 * 952 MB on a machine already at 80% — 7.6 GB of decode on 16 GB is a swap
 * away from a stall — while the hub leaves 56 GB idle.
 *
 * Three sources, in order, and the winner is NAMED so a log line can say why:
 *  1. the node's own agent setting (`decodeBudgetMb` / `maxLiveDecodeWorkers`
 *     in `AgentPipelineSettings`) — the operator sized this node;
 *  2. the cluster setting when the operator MOVED it off the shipped default
 *     (a value equal to the default reads as "nobody chose", the same rule the
 *     native-lease knobs use, `readKnob`);
 *  3. otherwise a share of the node's RAM, clamped — the shipped default
 *     becomes a per-node derivation instead of the hub's number.
 */

export const DECODE_BUDGET_RAM_SHARE = 0.5
export const DECODE_BUDGET_MIN_MB = 2048
export const DECODE_BUDGET_MAX_MB = 16384

export type NodeDecodeBudgetSource = 'node' | 'cluster' | 'derived'

export interface NodeDecodeLimitsOverride {
  readonly decodeBudgetMb?: number
  readonly maxLiveDecodeWorkers?: number
}

export interface NodeDecodeLimitsInput {
  readonly clusterBudgetMb: number
  readonly clusterMaxWorkers: number
  readonly defaultBudgetMb: number
  readonly defaultMaxWorkers: number
  readonly node: NodeDecodeLimitsOverride
  /** `os.totalmem()` in MB. */
  readonly totalMemMb: number
}

export interface NodeDecodeLimits {
  readonly budgetMb: number
  readonly budgetSource: NodeDecodeBudgetSource
  readonly maxWorkers: number
  readonly maxWorkersSource: 'node' | 'cluster'
}

export function derivedDecodeBudgetMb(totalMemMb: number): number {
  const share = Math.round(totalMemMb * DECODE_BUDGET_RAM_SHARE)
  return Math.max(DECODE_BUDGET_MIN_MB, Math.min(DECODE_BUDGET_MAX_MB, share))
}

export function resolveNodeDecodeLimits(input: NodeDecodeLimitsInput): NodeDecodeLimits {
  const budget =
    input.node.decodeBudgetMb !== undefined
      ? { budgetMb: input.node.decodeBudgetMb, budgetSource: 'node' as const }
      : input.clusterBudgetMb !== input.defaultBudgetMb
        ? { budgetMb: input.clusterBudgetMb, budgetSource: 'cluster' as const }
        : { budgetMb: derivedDecodeBudgetMb(input.totalMemMb), budgetSource: 'derived' as const }
  const workers =
    input.node.maxLiveDecodeWorkers !== undefined
      ? { maxWorkers: input.node.maxLiveDecodeWorkers, maxWorkersSource: 'node' as const }
      : { maxWorkers: input.clusterMaxWorkers, maxWorkersSource: 'cluster' as const }
  return { ...budget, ...workers }
}
