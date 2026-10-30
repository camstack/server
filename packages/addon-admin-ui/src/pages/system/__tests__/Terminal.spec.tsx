/**
 * Tests for System → Terminal.
 *
 *  1. `parseSseBuffer` — the hand-rolled SSE frame parser that feeds xterm:
 *     decodes `data:` frames, skips `: keepalive` comments, and keeps a partial
 *     tail for the next chunk.
 *  2. `terminalNodeState` — a node without a Terminal provider is `absent`,
 *     never an error; not-yet-known is `pending`, never `absent`.
 *  3. `TerminalPage` — one table of every instance across nodes, the New
 *     terminal dialog, delete through the library confirm, and the per-node
 *     presence rows (with `<TerminalPanel>` stubbed).
 */
/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The root `setupFiles` import of `@testing-library/jest-dom/vitest` does not
// reach this file — `toBeInTheDocument` resolved as a plain Chai property and
// threw. Registering the matchers explicitly is the pattern the specs under
// `components/pipeline/__tests__/` already use.
expect.extend(jestDomMatchers)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { parseSseBuffer } from '../../../lib/terminal-io'
import { terminalNodeState } from '../terminal/terminal-node-presence'

// ---------------------------------------------------------------------------
// 1. SSE frame parser
// ---------------------------------------------------------------------------
describe('parseSseBuffer', () => {
  it('decodes a data frame', () => {
    const { events, rest } = parseSseBuffer('data: {"kind":"data","data":"hi"}\n\n')
    expect(events).toEqual([{ kind: 'data', data: 'hi' }])
    expect(rest).toBe('')
  })

  it('skips keepalive comment frames', () => {
    const { events } = parseSseBuffer(': keepalive\n\ndata: {"kind":"data","data":"x"}\n\n')
    expect(events).toEqual([{ kind: 'data', data: 'x' }])
  })

  it('decodes an exit frame with a signal', () => {
    const { events } = parseSseBuffer('data: {"kind":"exit","exitCode":0,"signal":15}\n\n')
    expect(events).toEqual([{ kind: 'exit', exitCode: 0, signal: 15 }])
  })

  it('retains an incomplete trailing frame as rest', () => {
    const { events, rest } = parseSseBuffer('data: {"kind":"data","data":"a"}\n\ndata: {"kind":"da')
    expect(events).toEqual([{ kind: 'data', data: 'a' }])
    expect(rest).toBe('data: {"kind":"da')
  })

  it('ignores unrecognised event shapes', () => {
    const { events } = parseSseBuffer('data: {"kind":"nope"}\n\n')
    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Per-node presence (D315)
// ---------------------------------------------------------------------------
describe('terminalNodeState', () => {
  const answer = (perNode: { nodeId: string; providers: string[] }[]) =>
    ({
      status: 'success',
      data: { name: 'terminal-session', providers: ['terminal'], perNode },
    }) as never

  it('is pending while the registry has not answered — never absent', () => {
    expect(terminalNodeState({ status: 'pending' }, 'hub')).toBe('pending')
  })

  it('is unknown when the query failed — never absent', () => {
    expect(terminalNodeState({ status: 'error' }, 'hub')).toBe('unknown')
  })

  it('is absent for a node with no provider and present for one that has it', () => {
    const data = answer([{ nodeId: 'hub', providers: ['terminal'] }])
    expect(terminalNodeState(data, 'hub')).toBe('present')
    expect(terminalNodeState(data, 'edge')).toBe('absent')
  })

  it('is absent when the capability has no provider anywhere', () => {
    expect(
      terminalNodeState(
        { status: 'success', data: { name: 'terminal-session', providers: [] } as never },
        'hub',
      ),
    ).toBe('absent')
  })
})

// ---------------------------------------------------------------------------
// 3. Page render
// ---------------------------------------------------------------------------
vi.mock('../../../components/TerminalPanel', () => ({
  TerminalPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-panel">panel:{sessionId}</div>
  ),
}))

vi.mock('../../../components/settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: ({ nodeId }: { nodeId: string | null }) => (
    <div data-testid="addon-settings-panel" data-node-id={nodeId ?? ''} />
  ),
}))

const mocks = vi.hoisted(() => ({
  createInstance: vi.fn(async () => ({})),
  deleteInstance: vi.fn(async () => {}),
  confirm: vi.fn(async () => true),
  profileCalls: [] as string[],
  registry: {
    status: 'success' as 'pending' | 'success' | 'error',
    data: {
      name: 'terminal-session',
      providers: ['terminal'],
      perNode: [{ nodeId: 'hub', providers: ['terminal'] }],
    } as unknown,
  },
}))

const INSTANCES = [
  {
    instanceId: 'i-1',
    name: 'BTM Hub',
    nodeId: 'hub',
    nodeInCluster: true,
    profileId: 'monitor',
    profileLabel: 'BTM',
    enabled: true,
    cameraStableId: 'cam-1',
    args: [],
    environment: [],
    profileSettings: {},
  },
  {
    instanceId: 'i-2',
    name: 'BTM old-mac',
    nodeId: 'old-mac',
    nodeInCluster: false,
    profileId: 'monitor',
    profileLabel: 'BTM',
    enabled: true,
    cameraStableId: 'cam-2',
    args: [],
    environment: [],
    profileSettings: {},
  },
]

vi.mock('@camstack/ui-library', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@camstack/ui-library')
  const query = <T,>(data: T) => ({ data, isLoading: false, isError: false, refetch: vi.fn() })
  return {
    ...actual,
    hubPath: (p: string) => p,
    trpc: {
      capabilities: {
        getCapability: {
          useQuery: () => ({
            status: mocks.registry.status,
            data: mocks.registry.data,
            refetch: vi.fn(),
          }),
        },
      },
    },
    useClusterNodes: () => ({
      nodes: [
        { id: 'hub', name: 'Hub' },
        { id: 'edge', name: 'edge-proxmox' },
      ],
    }),
    useConfirm: () => mocks.confirm,
    useDeviceManagerListAll: () => query([{ id: 4101, stableId: 'cam-1' }]),
    useTerminalSessionListInstances: () => query(INSTANCES),
    useTerminalSessionListLegacyCameras: () => query([]),
    useTerminalSessionListProfiles: (input: { nodeId: string }) => {
      mocks.profileCalls.push(input.nodeId)
      return query([{ profileId: 'monitor', label: 'BTM', description: 'btm' }])
    },
    useTerminalSessionListSessions: () => query([]),
    useTerminalSessionOpenSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useTerminalSessionClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useTerminalSessionAdoptLegacyMonitor: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useTerminalSessionSetInstanceEnabled: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useTerminalSessionUpdateInstance: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useTerminalSessionCreateInstance: () => ({
      mutateAsync: mocks.createInstance,
      isPending: false,
    }),
    useTerminalSessionDeleteInstance: () => ({
      mutateAsync: mocks.deleteInstance,
      isPending: false,
    }),
  }
})

import { MemoryRouter } from 'react-router-dom'
import { TerminalPage } from '../Terminal'

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TerminalPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('TerminalPage', () => {
  beforeEach(() => {
    mocks.createInstance.mockClear()
    mocks.deleteInstance.mockClear()
    mocks.confirm.mockClear()
    mocks.confirm.mockResolvedValue(true)
    mocks.profileCalls.length = 0
    mocks.registry.status = 'success'
    mocks.registry.data = {
      name: 'terminal-session',
      providers: ['terminal'],
      perNode: [{ nodeId: 'hub', providers: ['terminal'] }],
    }
  })

  it('lists every instance of every node in one table, flagging a node not in the cluster', () => {
    renderPage()
    const table = screen.getByRole('table')
    expect(within(table).getByText('BTM Hub')).toBeInTheDocument()
    expect(within(table).getByText('BTM old-mac')).toBeInTheDocument()
    expect(within(table).getAllByText('Not in cluster')).toHaveLength(1)
    expect(within(table).getByRole('link', { name: /camera 4101/i })).toBeInTheDocument()
  })

  it('a node without a terminal provider reads "not installed", is not queried and not offered', () => {
    renderPage()
    expect(screen.getByText('Terminal not installed on this node')).toBeInTheDocument()
    expect(screen.queryByTestId('error-box')).not.toBeInTheDocument()
    expect(mocks.profileCalls).not.toContain('edge')

    fireEvent.click(screen.getByRole('button', { name: /new terminal/i }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('option', { name: 'edge-proxmox' })).not.toBeInTheDocument()
  })

  it('does not call a pending registry answer "not installed"', () => {
    mocks.registry.status = 'pending'
    renderPage()
    expect(screen.queryByText('Terminal not installed on this node')).not.toBeInTheDocument()
  })

  it('creates a terminal from the dialog with its prefilled name', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /new terminal/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^create/i }))
    await waitFor(() => {
      expect(mocks.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'hub',
          targetNodeId: 'hub',
          profileId: 'monitor',
          name: 'BTM Hub',
        }),
      )
    })
  })

  it('deletes through the library confirm, also for a node not in the cluster', async () => {
    renderPage()
    const row = screen.getByText('BTM old-mac').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: /delete/i }))
    await waitFor(() => {
      expect(mocks.deleteInstance).toHaveBeenCalledWith({ nodeId: 'hub', instanceId: 'i-2' })
    })
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
  })

  it('does not delete when the confirm is declined', async () => {
    mocks.confirm.mockResolvedValue(false)
    renderPage()
    const row = screen.getByText('BTM old-mac').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(mocks.deleteInstance).not.toHaveBeenCalled()
  })
})
