/**
 * buildHubHealth — `/health` must name the offline agent nodes
 * (`agents.offlineIds`) so hub-only health consumers (admin-ui
 * connection banner) can say WHICH node is degraded, not only how
 * many. `/health` reads ONLY the in-memory Moleculer node registry
 * (`listNodeLiveness`) — it NEVER fans out to agent nodes, which is
 * exactly why the admin UI uses it as its 4s hub-liveness probe (#26).
 */

import type { NodeLiveness } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  buildHubHealth,
  type HealthAgentRegistry,
  type HubHealthDeps,
} from '../api/health/health.routes'

function depsWithNodes(nodes: readonly NodeLiveness[]): HubHealthDeps {
  return {
    agentRegistry: { listNodeLiveness: () => nodes },
    hubVersion: '0.0.0-test',
    isReady: () => true,
  }
}

describe('buildHubHealth agents.offlineIds', () => {
  it('names offline agent nodes and keeps counts consistent', async () => {
    const health = await buildHubHealth(
      depsWithNodes([
        { id: 'hub', isHub: true, isOnline: true },
        { id: 'big-unraid', isHub: false, isOnline: true },
        { id: 'agent-a', isHub: false, isOnline: false },
      ]),
    )
    expect(health.agents).toEqual({
      total: 2,
      online: 1,
      offline: 1,
      offlineIds: ['agent-a'],
    })
  })

  it('returns an empty offlineIds array when every agent is online', async () => {
    const health = await buildHubHealth(
      depsWithNodes([
        { id: 'hub', isHub: true, isOnline: true },
        { id: 'big-unraid', isHub: false, isOnline: true },
        { id: 'mac-mini', isHub: false, isOnline: true },
      ]),
    )
    expect(health.agents).toEqual({ total: 2, online: 2, offline: 0, offlineIds: [] })
  })

  it('never counts the hub itself among agents', async () => {
    const health = await buildHubHealth(depsWithNodes([{ id: 'hub', isHub: true, isOnline: true }]))
    expect(health.agents).toEqual({ total: 0, online: 0, offline: 0, offlineIds: [] })
    expect(health.ok).toBe(true)
  })

  it('never touches the heavyweight listNodes fan-out — a frozen node cannot slow /health', async () => {
    // If buildHubHealth regressed to awaiting listNodes(), this hanging promise
    // would deadlock the test forever — a timeout-free structural guarantee.
    const hangingListNodes = vi.fn(() => new Promise<never>(() => {}))
    const agentRegistry: HealthAgentRegistry & { listNodes: () => Promise<never> } = {
      listNodeLiveness: () => [
        { id: 'hub', isHub: true, isOnline: true },
        { id: 'agent-a', isHub: false, isOnline: false },
      ],
      listNodes: hangingListNodes,
    }
    const health = await buildHubHealth({
      agentRegistry,
      hubVersion: '0.0.0-test',
      isReady: () => true,
    })
    expect(hangingListNodes).not.toHaveBeenCalled()
    expect(health.agents.offlineIds).toEqual(['agent-a'])
  })
})
