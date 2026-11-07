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
  openSession: vi.fn(async () => ({ sessionId: 's-1' })),
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
    id: 'i-1',
    name: 'BTM Hub',
    enabled: true,
    formValues: {
      nodeId: 'hub',
      profileId: 'monitor',
      profileLabel: 'BTM',
      cameraStableId: 'cam-1',
      executable: '/bin/btm',
      args: ['-b'],
      cwd: '',
      environment: [],
    },
  },
  {
    id: 'i-2',
    name: 'BTM old-mac',
    enabled: true,
    formValues: { nodeId: 'old-mac', profileId: 'monitor', profileLabel: 'BTM', args: [] },
  },
]

// The shared table is covered by its own spec; here it renders the page's columns and actions.
vi.mock('../../../components/instances/InstancesTable', () => ({
  InstancesTable: (props: {
    extraColumns: readonly {
      key: string
      render: (row: unknown) => unknown
    }[]
    rowActions: (row: unknown) => unknown
  }) => (
    <table>
      <tbody>
        {INSTANCES.map((instance) => {
          const row = {
            kind: 'instance',
            id: instance.id,
            addonId: 'terminal',
            name: instance.name,
            enabled: instance.enabled,
            configured: true,
          }
          return (
            <tr key={instance.id}>
              <td>{instance.name}</td>
              {props.extraColumns.map((column) => (
                <td key={column.key}>{column.render(row) as never}</td>
              ))}
              <td>{props.rowActions(row) as never}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  ),
}))

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
    useDeviceManagerListAll: () => query([{ id: 4101, stableId: 'cam-1' }]),
    useInstancesOfCap: () => query(INSTANCES),
    useTerminalSessionListLegacyCameras: () => query([]),
    useTerminalSessionListProfiles: (input: { nodeId: string }) => {
      mocks.profileCalls.push(input.nodeId)
      return query([{ profileId: 'monitor', label: 'BTM', description: 'btm' }])
    },
    useTerminalSessionListSessions: () => query([]),
    useTerminalSessionOpenSession: () => ({ mutateAsync: mocks.openSession, isPending: false }),
    useTerminalSessionClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useTerminalSessionAdoptLegacyMonitor: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    mocks.openSession.mockClear()
    mocks.profileCalls.length = 0
    mocks.registry.status = 'success'
    mocks.registry.data = {
      name: 'terminal-session',
      providers: ['terminal'],
      perNode: [{ nodeId: 'hub', providers: ['terminal'] }],
    }
  })

  it('shows each terminal with its node, profile and camera link', () => {
    renderPage()
    const table = screen.getByRole('table')
    expect(within(table).getByText('BTM Hub')).toBeInTheDocument()
    expect(within(table).getByText('Hub')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: /camera 4101/i })).toBeInTheDocument()
    expect(within(table).getAllByText('None')).toHaveLength(1)
  })

  it('attaches with the spawn values read from the record', async () => {
    renderPage()
    const row = screen.getByText('BTM Hub').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: /attach/i }))
    await waitFor(() => {
      expect(mocks.openSession).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'hub',
          profileId: 'monitor',
          executable: '/bin/btm',
          args: ['-b'],
        }),
      )
    })
  })

  it('a node without a terminal provider reads "not installed" and is not queried', () => {
    renderPage()
    expect(screen.getByText('Terminal not installed on this node')).toBeInTheDocument()
    expect(screen.queryByTestId('error-box')).not.toBeInTheDocument()
    expect(mocks.profileCalls).not.toContain('edge')
  })

  it('does not call a pending registry answer "not installed"', () => {
    mocks.registry.status = 'pending'
    renderPage()
    expect(screen.queryByText('Terminal not installed on this node')).not.toBeInTheDocument()
  })
})
