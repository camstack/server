/**
 * Full-page server shell: pending is not "not installed", a node that has the
 * shell off shows the provider's reason, and an opted-in node opens `server-shell`
 * with no caller-supplied environment.
 */
/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

type Presence = 'pending' | 'present' | 'absent' | 'unknown'

const mocks = vi.hoisted(() => ({
  presence: 'present' as Presence,
  onNode: 'present' as Presence,
  openSession: vi.fn(async () => ({
    sessionId: 's-new',
    profileId: 'server-shell',
    label: 'Server shell',
    cols: 120,
    rows: 32,
    startedAt: 0,
  })),
  statusPending: false,
  status: {
    nodeId: 'hub',
    enabled: false,
    idleMinutes: 30,
    refusal: {
      code: 'server-shell-disabled' as const,
      nodeId: 'hub',
      message: 'Server shell is off on node hub.',
    },
  } as
    | {
        nodeId: string
        enabled: boolean
        idleMinutes: number
        refusal: { code: 'server-shell-disabled'; nodeId: string; message: string } | null
      }
    | undefined,
  sessions: [] as readonly { sessionId: string; profileId: string }[],
}))

vi.mock('../../../components/TerminalPanel', () => ({
  TerminalPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-panel">panel:{sessionId}</div>
  ),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@camstack/ui-library')
  const query = <T,>(data: T, isPending: boolean) => ({
    data,
    isPending,
    isLoading: isPending,
    isError: false,
    refetch: vi.fn(),
  })
  return {
    ...actual,
    useCapabilityPresence: () => mocks.presence,
    useCapabilityNodePresence: () => ({ onNode: () => mocks.onNode }),
    NodePicker: ({ selectedNodeId }: { selectedNodeId: string }) => (
      <div data-testid="node-picker">{selectedNodeId}</div>
    ),
    useTerminalSessionServerShellStatus: () => query(mocks.status, mocks.statusPending),
    useTerminalSessionListSessions: () => query(mocks.sessions, false),
    useTerminalSessionOpenSession: () => ({ mutateAsync: mocks.openSession, isPending: false }),
    useTerminalSessionClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

import { ServerShellPage } from '../ServerShell'

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/system/terminal/:nodeId/:sessionId?" element={<ServerShellPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ServerShellPage', () => {
  beforeEach(() => {
    mocks.presence = 'present'
    mocks.onNode = 'present'
    mocks.statusPending = false
    mocks.openSession.mockClear()
    mocks.sessions = []
    mocks.status = {
      nodeId: 'hub',
      enabled: false,
      idleMinutes: 30,
      refusal: {
        code: 'server-shell-disabled',
        nodeId: 'hub',
        message: 'Server shell is off on node hub.',
      },
    }
  })

  it('does not call a node absent while the registry has not answered', () => {
    mocks.presence = 'pending'
    mocks.onNode = 'pending'
    renderAt('/system/terminal/hub')
    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/checking which nodes run a terminal/i)).toBeInTheDocument()
  })

  it('shows the refusal that names the node and does not open a shell', () => {
    renderAt('/system/terminal/hub')
    expect(screen.getByText('Server shell is off on node hub.')).toBeInTheDocument()
    expect(mocks.openSession).not.toHaveBeenCalled()
    expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument()
  })

  it('opens a server shell with no caller environment once the node has opted in', async () => {
    mocks.status = { nodeId: 'hub', enabled: true, idleMinutes: 30, refusal: null }
    renderAt('/system/terminal/hub')
    await waitFor(() => {
      expect(mocks.openSession).toHaveBeenCalledWith({
        nodeId: 'hub',
        profileId: 'server-shell',
        cols: 120,
        rows: 32,
      })
    })
  })

  it('reattaches a session id already in the route', () => {
    mocks.status = { nodeId: 'hub', enabled: true, idleMinutes: 30, refusal: null }
    renderAt('/system/terminal/hub/sess-9')
    expect(screen.getByTestId('terminal-panel')).toHaveTextContent('panel:sess-9')
    expect(mocks.openSession).not.toHaveBeenCalled()
  })
})
