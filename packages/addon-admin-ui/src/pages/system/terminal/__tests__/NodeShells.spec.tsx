/**
 * Node shells (System → Terminal → "Node shells"):
 *
 * - one entry per node the registry ANSWERED runs a provider; pending is a
 *   loading state, never "no node" (D315);
 * - no shell is opened by the list — only by opening a node's section;
 * - a node that has not opted in shows the provider's refusal and opens nothing;
 * - leaving the section (Close, another node, unmount, a back/forward-cache
 *   restore) closes the session, and a close that fails is shown, not swallowed;
 * - every server shell a node runs — opened here or not — is counted in the row
 *   and listed in the open section with a Close;
 * - a node the registry answered without names that Terminal is not installed.
 */
/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

import type { CapabilityRegistryAnswer } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

interface ShellStatus {
  readonly nodeId: string
  readonly enabled: boolean
  readonly idleMinutes: number
  readonly refusal: { code: 'server-shell-disabled'; nodeId: string; message: string } | null
}

interface ListedSession {
  readonly sessionId: string
  readonly profileId: string
  readonly label: string
  readonly cols: number
  readonly rows: number
  readonly startedAt: number
  readonly openedBy?: string
  readonly lastActivityAt?: number
}

const mocks = vi.hoisted(() => {
  const registry: CapabilityRegistryAnswer = { status: 'success', data: null }
  const statusByNode: Record<string, ShellStatus> = {}
  const sessionsByNode: Record<string, readonly ListedSession[]> = {}
  return {
    registry,
    statusByNode,
    sessionsByNode,
    openSession: vi.fn(async (input: { nodeId: string }) => ({
      sessionId: `sh-${input.nodeId}`,
      profileId: 'server-shell',
      label: 'Server shell',
      cols: 120,
      rows: 32,
      startedAt: 0,
    })),
    closeSession: vi.fn(async (_input: { nodeId: string; sessionId: string }) => ({ ok: true })),
  }
})

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
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useCapabilityNodePresence: () => ({
      onNode: (nodeId: string) => actual.capabilityPresenceOnNode(mocks.registry, nodeId),
      providerNodes: actual.capabilityProviderNodes(mocks.registry),
    }),
    useUserManagementListUsers: () => ({ data: [{ id: 'admin-7', username: 'carla' }] }),
    useTerminalSessionListSessions: (input: { nodeId: string }) => ({
      data: mocks.sessionsByNode[input.nodeId] ?? [],
      isPending: false,
      isError: false,
      refetch: vi.fn(async () => undefined),
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

const registryWith = (nodeIds: readonly string[]): CapabilityRegistryAnswer => ({
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
    mocks.sessionsByNode = {}
    mocks.openSession.mockClear()
    mocks.closeSession.mockClear()
  })

  it('shows a loading state, never "no node", while the registry has not answered', () => {
    mocks.registry = { status: 'pending' }
    renderAt()
    expect(screen.getByLabelText(/checking which nodes run a terminal/i)).toBeInTheDocument()
    expect(screen.queryByText(/no node runs/i)).not.toBeInTheDocument()
  })

  it('says the registry did not answer when its read failed', () => {
    mocks.registry = { status: 'error' }
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

  it('counts and lists a server shell the page did not open, and Close closes it', async () => {
    mocks.sessionsByNode = {
      hub: [
        {
          sessionId: 'sh-left-behind',
          profileId: 'server-shell',
          label: 'Server shell',
          cols: 120,
          rows: 32,
          startedAt: Date.now() - 2 * 60 * 60_000,
          openedBy: 'admin-7',
          lastActivityAt: Date.now(),
        },
        {
          sessionId: 'tty-monitor',
          profileId: 'monitor',
          label: 'System monitor',
          cols: 80,
          rows: 24,
          startedAt: Date.now(),
        },
      ],
    }
    renderAt()
    const hubRow = screen.getByText('Hub').closest('tr')!
    expect(within(hubRow).getByText('1 running')).toBeInTheDocument()

    fireEvent.click(within(hubRow).getByRole('button', { name: /open shell/i }))
    const list = (await screen.findByText('carla')).closest('table')!
    expect(within(list).getAllByRole('row')).toHaveLength(2) // header + the server shell only
    fireEvent.click(within(list).getByRole('button', { name: /^close$/i }))
    await waitFor(() => {
      expect(mocks.closeSession).toHaveBeenCalledWith({
        nodeId: 'hub',
        sessionId: 'sh-left-behind',
      })
    })
  })

  it('shows a Close from the list that failed, instead of reporting success', async () => {
    mocks.sessionsByNode = {
      hub: [
        {
          sessionId: 'sh-other',
          profileId: 'server-shell',
          label: 'Server shell',
          cols: 120,
          rows: 32,
          startedAt: Date.now(),
          openedBy: 'admin-7',
        },
      ],
    }
    mocks.closeSession.mockRejectedValueOnce(new Error('node unreachable'))
    renderAt('/system/terminal?tab=shells&node=hub')
    const list = (await screen.findByText('carla')).closest('table')!
    fireEvent.click(within(list).getByRole('button', { name: /^close$/i }))
    expect(await screen.findByText(/shell was not closed: node unreachable/i)).toBeInTheDocument()
  })

  it('shows a close on leaving the section that failed', async () => {
    renderAt('/system/terminal?tab=shells&node=hub')
    await screen.findByTestId('terminal-panel')
    mocks.closeSession.mockRejectedValueOnce(new Error('node unreachable'))
    fireEvent.click(screen.getByRole('button', { name: /close shell/i }))
    expect(await screen.findByText(/a shell was not closed/i)).toBeInTheDocument()
    expect(screen.getByText('Hub: node unreachable')).toBeInTheDocument()
  })

  it('puts the node back to "Open shell" when the page is restored from the back/forward cache', async () => {
    renderAt('/system/terminal?tab=shells&node=hub')
    await screen.findByTestId('terminal-panel')
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    })
    expect(screen.getByTestId('search')).toHaveTextContent('node=hub')
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('search')).not.toHaveTextContent('node=')
    })
    expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument()
    expect(mocks.closeSession).toHaveBeenCalledWith({ nodeId: 'hub', sessionId: 'sh-hub' })
  })

  it('says Terminal is not installed on a node the registry answered without', async () => {
    renderAt('/system/terminal?tab=shells&node=edge-pi')
    expect(screen.getByText(/terminal is not installed on this node/i)).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    expect(mocks.openSession).not.toHaveBeenCalled()
  })

  it('keeps a node it has not heard about pending while the registry has not answered', () => {
    mocks.registry = { status: 'pending' }
    renderAt('/system/terminal?tab=shells&node=edge-pi')
    expect(screen.getByLabelText(/checking which nodes run a terminal/i)).toBeInTheDocument()
    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument()
  })
})
