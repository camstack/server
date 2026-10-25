/**
 * Agent-readiness snapshot pull — the D8 REVERSE leg of the readiness
 * snapshot-reconcile.
 *
 * Forward leg (pre-existing): workers/agents hydrate from the hub's
 * `$readiness.getSnapshot`. Reverse leg (this module + the wiring in
 * `moleculer.service.ts`): the hub pulls `$agent-readiness.getSnapshot`
 * from each agent on `$node.connected` and periodically, then hydrates
 * its authoritative registry with the records the agent is AUTHORITATIVE
 * for. Without it the hub learns agent readiness only from lossy
 * cross-node `system.ready-state` broadcasts — the 2026-07-17 incident
 * left the hub's registry stuck on a synthesized `down` for
 * `pipeline-executor@agent-a` forever after the agent's post-update
 * `ready` broadcast was lost.
 *
 * The filter is load-bearing: an agent's snapshot also carries records it
 * hydrated FROM the hub earlier (hub-origin, possibly stale). Applying
 * those back would let a stale copy fight the hub's own truth, so only
 * agent-authoritative records pass:
 *   - node-scoped records whose `scope.nodeId` is the agent itself;
 *   - device/global-scoped records the agent emitted (`sourceNodeId`).
 * (`ReadinessRegistry.hydrate` has its own self-origin + forward-only
 * guards — this filter is the first line, at the trust boundary.)
 */
import type { IReadinessRegistryRecord } from '@camstack/types'

const VALID_STATES: ReadonlySet<string> = new Set(['starting', 'ready', 'down'])
const VALID_SCOPE_TYPES: ReadonlySet<string> = new Set(['global', 'node', 'device'])

/** Structural validation for a record received from a remote node. */
function isWellFormedRecord(value: unknown): value is IReadinessRegistryRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<IReadinessRegistryRecord>
  if (typeof record.capName !== 'string' || record.capName.length === 0) return false
  if (typeof record.state !== 'string' || !VALID_STATES.has(record.state)) return false
  if (typeof record.generation !== 'string') return false
  if (typeof record.sourceNodeId !== 'string') return false
  const scope = record.scope
  if (typeof scope !== 'object' || scope === null) return false
  if (!VALID_SCOPE_TYPES.has(scope.type)) return false
  return true
}

/**
 * Keep only the records `agentNodeId` is authoritative for, dropping
 * malformed entries. See module doc for why this filter must exist.
 */
export function filterAgentAuthoritativeRecords(
  records: readonly IReadinessRegistryRecord[],
  agentNodeId: string,
): IReadinessRegistryRecord[] {
  if (!Array.isArray(records)) return []
  return records.filter((record): record is IReadinessRegistryRecord => {
    if (!isWellFormedRecord(record)) return false
    if (record.scope.type === 'node') return record.scope.nodeId === agentNodeId
    return record.sourceNodeId === agentNodeId
  })
}
