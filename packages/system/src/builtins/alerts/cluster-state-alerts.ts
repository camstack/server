/**
 * `agent.offline` and `system.restarting` close from the node list, not from
 * a one-shot online or restart-completed event (D8, D49). The list is the
 * authority: a node it does not name stays as it is — absence is not "back".
 * A restart completion this process heard dismisses the matching restarting
 * alert even while the list still says offline. A completion older than the
 * alert does not.
 */
import type { AlertStatus } from '@camstack/types'

/** How often the centre re-reads the node list. An online event only hints. */
export const CLUSTER_STATE_RECONCILE_MS = 30_000

export interface ClusterNodeRow {
  readonly id: string
  readonly isOnline: boolean
}

export interface RestartCompletion {
  readonly nodeId: string
  readonly requestedAt: number
}

export interface ClusterAlertView {
  readonly id: string
  readonly status: AlertStatus
  readonly category: string
  readonly createdAt: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface ClusterStateReconcileInput {
  readonly alerts: readonly ClusterAlertView[]
  readonly nodes: readonly ClusterNodeRow[]
  readonly completions: readonly RestartCompletion[]
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The node an alert is about. `agent.offline` is keyed by `agentId` (older cards used `nodeId`). */
function subjectNodeId(alert: ClusterAlertView): string | null {
  const meta = alert.metadata ?? {}
  if (alert.category === 'agent.offline') return text(meta['agentId']) ?? text(meta['nodeId'])
  if (alert.category === 'system.restarting') return text(meta['nodeId'])
  return null
}

function requestedAtOf(alert: ClusterAlertView): number {
  const raw = alert.metadata?.['requestedAt']
  return typeof raw === 'number' ? raw : alert.createdAt
}

function restartCompleted(
  alert: ClusterAlertView,
  nodeId: string,
  completions: readonly RestartCompletion[],
): boolean {
  const requestedAt = requestedAtOf(alert)
  return completions.some(
    (completion) => completion.nodeId === nodeId && completion.requestedAt >= requestedAt,
  )
}

function resolved(
  alert: ClusterAlertView,
  online: ReadonlySet<string>,
  completions: readonly RestartCompletion[],
): boolean {
  const nodeId = subjectNodeId(alert)
  if (nodeId === null) return false
  if (alert.category === 'agent.offline') return online.has(nodeId)
  if (alert.category === 'system.restarting') {
    return online.has(nodeId) || restartCompleted(alert, nodeId, completions)
  }
  return false
}

export function planClusterStateDismissals(input: ClusterStateReconcileInput): readonly string[] {
  const online = new Set(input.nodes.filter((node) => node.isOnline).map((node) => node.id))
  return input.alerts
    .filter((alert) => alert.status === 'active' && resolved(alert, online, input.completions))
    .map((alert) => alert.id)
}
