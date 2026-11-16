/**
 * Node shells (System → Terminal → "Node shells"):
 *
 * - one entry per node the registry ANSWERED runs a provider; pending is a
 *   loading state, never "no node" (D315);
 * - no shell is opened by the list — only by opening a node's section;
 * - a node that has not opted in shows the provider's refusal and opens nothing;
 * - leaving the section (Close, another node, unmount) closes the session.
 */
/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

type Registry = { status: 'pending' | 'success' | 'error'; data: unknown }

interface ShellStatus {
  readonly nodeId: string
  readonly enabled: boolean
  readonly idleMinutes: number
  readonly refusal: { code: 'server-shell-disabled'; nodeId: string; message: string } | null
}

const mocks = vi.hoisted(() => ({
  registry: { status: 'success', data: null } as Registry,
  statusByNode: {} as Record<string, ShellStatus>,
  openSession: vi.fn(async (input: { nodeId: string }) => ({
    sessionId: `sh-${input.nodeId}`,
    profileId: 'server-shell',
    label: 'Server shell',
    cols: 120,
    rows: 32,
    startedAt: 0,
  })),
  closeSession: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../../../../components/TerminalPanel', () => ({
  TerminalPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-panel">panel:{sessionId}</div>
  ),
}))

vi.mock('../TerminalNodeSettings', () => ({
  TERMINAL_SESSION_CAP: 'terminal-session',
  TerminalNodeSettings: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="node-settings">settings:{nodeId}</div>
  ),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@camstack/ui-library')
  const nodesOf = actual['capabilityProviderNodes'] as (answer: unknown) => unknown
  const onNodeOf = actual['capabilityPresenceOnNode'] as (answer: unknown, id: string) => string
  return {
    ...actual,
    useCapabilityNodePresence: () => ({
      onNode: (nodeId: string) => onNodeOf(mocks.registry, nodeId),
      providerNodes: nodesOf(mocks.registry),
    }),
    useClusterNodes: () => ({
      nodes: [
        { id: 'hub', name: 'Hub' },
        { id: 'garage-nuc', name: 'garage-nuc' },
      ],
    }),
    useTerminalSessionServerShellStatus: (input: { nodeId: string }) => ({
      data: mocks.statusByNode[input.nodeId],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useTerminalSessionOpenSession: () => ({ mutateAsync: mocks.openSession, isPending: false }),
    useTerminalSessionClose: () => ({ mutateAsync: mocks.closeSession, isPending: false }),
  }
})

import { NodeShells } from '../NodeShells'

const registryWith = (nodeIds: readonly string[]): Registry => ({
  status: 'success',
  data: {
    name: 'terminal-session',
    mode: 'singleton',
    providers: ['terminal'],
    activeProvider: 'terminal',
    disabledProviders: [],
    perNode: nodeIds.map((nodeId) => ({
      nodeId,
      providers: ['terminal'],
      resolvedActive: 'terminal',
      hasOverride: false,
    })),
  },
})

const on = (nodeId: string): ShellStatus => ({
  nodeId,
  enabled: true,
  idleMinutes: 30,
  refusal: null,
})
const off = (nodeId: string): ShellStatus => ({
  nodeId,
  enabled: false,
  idleMinutes: 30,
  refusal: {
    code: 'server-shell-disabled',
    nodeId,
    message: `Server shell is off on node ${nodeId}.`,
  },
})

function Search() {
  return <div data-testid="search">{useLocation().search}</div>
}

function renderAt(path = '/system/terminal?tab=shells') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/system/terminal"
            element={
              <>
                <NodeShells />
                <Search />
              </>
            }
          />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('NodeShells', () => {
  beforeEach(() => {
    mocks.registry = registryWith(['hub', 'garage-nuc'])
    mocks.statusByNode = { hub: on('hub'), 'garage-nuc': off('garage-nuc') }
    mocks.openSession.mockClear()
    mocks.closeSession.mockClear()
  })

  it('shows a loading state, never "no node", while the registry has not answered', () => {
    mocks.registry = { status: 'pending', data: undefined }
    renderAt()
    expect(screen.getByLabelText(/checking which nodes run a terminal/i)).toBeInTheDocument()
    expect(screen.queryByText(/no node runs/i)).not.toBeInTheDocument()
  })

  it('says the registry did not answer when its read failed', () => {
    mocks.registry = { status: 'error', data: undefined }
    renderAt()
    expect(screen.getByText(/registry did not answer/i)).toBeInTheDocument()
    expect(screen.queryByText(/no node runs/i)).not.toBeInTheDocument()
  })

  it('lists one entry per provider node and opens no shell from the list', async () => {
    renderAt()
    expect(screen.getAllByRole('button', { name: /open shell/i })).toHaveLength(2)
    expect(screen.getByText('Hub')).toBeInTheDocument()
    expect(screen.getByText('garage-nuc')).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    expect(mocks.openSession).not.toHaveBeenCalled()
  })

  it('opens the server shell only when the node section is opened', async () => {
    renderAt()
    const hubRow = screen.getByText('Hub').closest('tr')!
    fireEvent.click(hubRow.querySelector('button')!)
    await waitFor(() => {
      expect(mocks.openSession).toHaveBeenCalledWith({
        nodeId: 'hub',
        profileId: 'server-shell',
        cols: 120,
        rows: 32,
      })
    })
    expect(await screen.findByTestId('terminal-panel')).toHaveTextContent('panel:sh-hub')
    expect(screen.getByTestId('search')).toHaveTextContent('node=hub')
    expect(mocks.openSession).toHaveBeenCalledTimes(1)
  })

  it('opens nothing on a node that has not opted in, and shows its refusal and settings', async () => {
    renderAt('/system/terminal?tab=shells&node=garage-nuc')
    expect(screen.getByText('Server shell is off on node garage-nuc.')).toBeInTheDocument()
    expect(screen.getByTestId('node-settings')).toHaveTextContent('settings:garage-nuc')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    expect(mocks.openSession).not.toHaveBeenCalled()
    expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument()
  })

  it('closes the session when the section is left', async () => {
    renderAt('/system/terminal?tab=shells&node=hub')
    await screen.findByTestId('terminal-panel')
    fireEvent.click(screen.getByRole('button', { name: /close shell/i }))
    await waitFor(() => {
      expect(mocks.closeSession).toHaveBeenCalledWith({ nodeId: 'hub', sessionId: 'sh-hub' })
    })
    expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('search')).not.toHaveTextContent('node=')
  })

  it('closes the session when the page unmounts', async () => {
    const view = renderAt('/system/terminal?tab=shells&node=hub')
    await screen.findByTestId('terminal-panel')
    view.unmount()
    expect(mocks.closeSession).toHaveBeenCalledWith({ nodeId: 'hub', sessionId: 'sh-hub' })
  })

  it('closes a shell that answers after the section was already left', async () => {
    let resolveOpen: (value: Awaited<ReturnType<typeof mocks.openSession>>) => void = () => {}
    mocks.openSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        }),
    )
    const view = renderAt('/system/terminal?tab=shells&node=hub')
    await waitFor(() => expect(mocks.openSession).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(mocks.closeSession).not.toHaveBeenCalled()
    await act(async () => {
      resolveOpen({
        sessionId: 'late',
        profileId: 'server-shell',
        label: 'Server shell',
        cols: 120,
        rows: 32,
        startedAt: 0,
      })
    })
    await waitFor(() => {
      expect(mocks.closeSession).toHaveBeenCalledWith({ nodeId: 'hub', sessionId: 'late' })
    })
  })
})
