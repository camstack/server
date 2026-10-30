/**
 * Which cluster nodes run a Terminal provider — asked of the capability
 * registry (`capabilities.getCapability`), never of `nodes.topology`.
 *
 * A node without a provider is a normal state, not an error: a per-node
 * `terminal-session` query against it fails, so the page never issues one.
 * The four answers are the ones `useCapabilityPresence` uses, per node:
 * not-yet-known never reads as not-installed.
 */
import type { CapabilityInfo } from '@camstack/types'
import { trpc } from '@camstack/ui-library'

export const TERMINAL_CAPABILITY = 'terminal-session'

export type TerminalNodeState = 'pending' | 'present' | 'absent' | 'unknown'

export interface TerminalRegistryAnswer {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: CapabilityInfo | null | undefined
}

/**
 * Classify one node from the registry's answer.
 *
 * `perNode` lists every node hosting at least one provider. A singleton row
 * without it cannot say which node, so a non-empty provider list is `unknown`
 * for a node rather than a guess.
 */
export function terminalNodeState(
  answer: TerminalRegistryAnswer,
  nodeId: string,
): TerminalNodeState {
  if (answer.status === 'pending') return 'pending'
  if (answer.status === 'error') return 'unknown'
  const row = answer.data ?? null
  if (row === null || row.providers.length === 0) return 'absent'
  if (row.perNode === undefined) return 'unknown'
  return row.perNode.some((entry) => entry.nodeId === nodeId && entry.providers.length > 0)
    ? 'present'
    : 'absent'
}

export interface TerminalNodePresence {
  readonly nodeState: (nodeId: string) => TerminalNodeState
  readonly refetch: () => void
}

export function useTerminalNodePresence(): TerminalNodePresence {
  const query = trpc.capabilities.getCapability.useQuery({ name: TERMINAL_CAPABILITY })
  const answer: TerminalRegistryAnswer = { status: query.status, data: query.data }
  return {
    nodeState: (nodeId) => terminalNodeState(answer, nodeId),
    refetch: () => void query.refetch(),
  }
}
