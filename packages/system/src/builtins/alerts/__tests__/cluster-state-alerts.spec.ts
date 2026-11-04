/**
 * agent.offline and system.restarting close from the node list (D49, D8).
 * An online event is only a hint: the plan never sees it.
 */
import { describe, expect, it } from 'vitest'
import {
  planClusterStateDismissals,
  type ClusterAlertView,
  type ClusterNodeRow,
  type RestartCompletion,
} from '../cluster-state-alerts.js'

function alert(
  id: string,
  category: string,
  metadata: Record<string, unknown>,
  status: ClusterAlertView['status'] = 'active',
): ClusterAlertView {
  return { id, category, status, createdAt: 1_000, metadata }
}

function node(id: string, isOnline: boolean): ClusterNodeRow {
  return { id, isOnline }
}

function plan(
  alerts: readonly ClusterAlertView[],
  nodes: readonly ClusterNodeRow[],
  completions: readonly RestartCompletion[] = [],
): readonly string[] {
  return planClusterStateDismissals({ alerts, nodes, completions })
}

describe('planClusterStateDismissals', () => {
  it('resolves an agent.offline alert when that node is online', () => {
    const ids = plan(
      [alert('a1', 'agent.offline', { agentId: 'little-unraid' })],
      [node('little-unraid', true), node('mac-mini', false)],
    )
    expect(ids).toEqual(['a1'])
  })

  it('resolves a system.restarting alert when that node is back online', () => {
    const ids = plan(
      [alert('r1', 'system.restarting', { nodeId: 'mac-mini', requestedAt: 1_000 })],
      [node('mac-mini', true)],
    )
    expect(ids).toEqual(['r1'])
  })

  it('keeps both alerts while the node is still offline', () => {
    const ids = plan(
      [
        alert('a1', 'agent.offline', { agentId: 'amd-proxmox' }),
        alert('r1', 'system.restarting', { nodeId: 'amd-proxmox', requestedAt: 1_000 }),
      ],
      [node('amd-proxmox', false)],
    )
    expect(ids).toEqual([])
  })

  it('resolves a restarting alert from a matching completion while the node is still listed offline', () => {
    const ids = plan(
      [alert('r1', 'system.restarting', { nodeId: 'hub', requestedAt: 2_000 })],
      [node('hub', false)],
      [{ nodeId: 'hub', requestedAt: 2_000 }],
    )
    expect(ids).toEqual(['r1'])
  })

  it('does not let an older completion close a later restart', () => {
    const ids = plan(
      [alert('r2', 'system.restarting', { nodeId: 'hub', requestedAt: 4_000 })],
      [node('hub', false)],
      [{ nodeId: 'hub', requestedAt: 2_000 }],
    )
    expect(ids).toEqual([])
  })

  it('keeps an alert whose node the list does not name', () => {
    const ids = plan([alert('a1', 'agent.offline', { nodeId: 'gone' })], [node('hub', true)])
    expect(ids).toEqual([])
  })

  it('leaves a dismissed alert and an unrelated category alone', () => {
    const ids = plan(
      [
        alert('a1', 'agent.offline', { agentId: 'hub' }, 'dismissed'),
        alert('u1', 'update.available', { nodeId: 'hub' }),
      ],
      [node('hub', true)],
    )
    expect(ids).toEqual([])
  })

  it('resolves every stale active for a node the list says is online', () => {
    const ids = plan(
      [
        alert('old-off', 'agent.offline', { agentId: 'little-unraid' }),
        alert('old-restart', 'system.restarting', { nodeId: 'little-unraid' }),
        alert('still', 'agent.offline', { agentId: 'amd-proxmox' }),
      ],
      [node('little-unraid', true), node('amd-proxmox', false), node('hub', true)],
    )
    expect(ids).toEqual(['old-off', 'old-restart'])
  })
})
