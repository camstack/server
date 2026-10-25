/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

type ClusterNodeRow = {
  readonly id: string
  readonly name: string
  readonly shortName: string
  readonly isHub: boolean
  readonly isOnline: boolean
  readonly localIps: readonly string[]
  readonly addons: readonly { readonly addonId: string; readonly capabilities: readonly string[] }[]
}

const { ALERT_WITH_NODE, MATCHING_NODES, state } = vi.hoisted(() => {
  const alert = {
    id: 'alert-1',
    category: 'agent.offline',
    severity: 'warning' as const,
    title: 'Agent offline',
    message: 'Agent disconnected',
    status: 'active' as const,
    read: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: { nodeId: 'agent-b' },
  }
  const matchingNodes: ClusterNodeRow[] = [
    {
      id: 'agent-b',
      name: 'AMD Proxmox',
      shortName: 'AMD Proxmox',
      isHub: false,
      isOnline: true,
      localIps: [],
      addons: [],
    },
  ]
  return {
    ALERT_WITH_NODE: alert,
    MATCHING_NODES: matchingNodes,
    state: { nodes: matchingNodes as readonly ClusterNodeRow[] },
  }
})

vi.mock('@camstack/ui-library', () => ({
  useClusterNodes: () => ({ nodes: state.nodes, isLoading: false, isError: false }),
  useAlertsGetUnreadCount: () => ({ data: 1 }),
  useAlertsList: () => ({ data: [ALERT_WITH_NODE], isLoading: false }),
  useAlertsMarkRead: () => ({ mutate: vi.fn() }),
  useAlertsMarkAllRead: () => ({ mutate: vi.fn() }),
  useAlertsDismiss: () => ({ mutate: vi.fn() }),
  useLiveEvent: () => undefined,
}))

import { AlertBell, alertNodeId } from '../AlertBell'

function renderBell(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AlertBell />
    </QueryClientProvider>,
  )
}

function openAlertsPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Alerts' }))
}

beforeEach(() => {
  state.nodes = MATCHING_NODES
})

describe('AlertBell node label', () => {
  it('alertNodeId reads metadata.nodeId', () => {
    expect(alertNodeId({ metadata: { nodeId: 'agent-b' } })).toBe('agent-b')
  })

  it('shows the cluster node name under the alert title', () => {
    renderBell()
    openAlertsPanel()
    expect(screen.getByText('AMD Proxmox')).toBeInTheDocument()
  })

  it('falls back to the raw node id when the cluster has no match', () => {
    state.nodes = []
    renderBell()
    openAlertsPanel()
    expect(screen.getByText('agent-b')).toBeInTheDocument()
    expect(screen.queryByText('AMD Proxmox')).not.toBeInTheDocument()
  })
})
