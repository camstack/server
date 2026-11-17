/**
 * Tests for System → Terminal.
 *
 *  1. `parseSseBuffer` — the hand-rolled SSE frame parser that feeds xterm:
 *     decodes `data:` frames, skips `: keepalive` comments, and keeps a partial
 *     tail for the next chunk.
 *  2. `TerminalPage` — two sub-sections: "Terminal devices" (the default) and
 *     "Node shells"; a node shell never shows among the instance sessions and
 *     the node list opens nothing. The devices tab is ONE table of every
 *     instance across nodes: no per-node card (with `<TerminalPanel>` stubbed). The node picker's "not installed"
 *     reason is the library field's (`node-select-field-capability.spec`).
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

import type { CapabilityRegistryAnswer } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { parseSseBuffer } from '../../../lib/terminal-io'

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
// 2. Page render
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

const mocks = vi.hoisted(() => {
  const hubRegistry = (): CapabilityRegistryAnswer => ({
    status: 'success',
    data: {
      name: 'terminal-session',
      mode: 'singleton',
      providers: ['terminal'],
      activeProvider: 'terminal',
      disabledProviders: [],
      perNode: [
        { nodeId: 'hub', providers: ['terminal'], resolvedActive: 'terminal', hasOverride: false },
      ],
    },
  })
  return {
    hubRegistry,
    openSession: vi.fn(async () => ({ sessionId: 's-1' })),
    profileCalls: [] as string[],
    compositions: undefined as unknown,
    sessions: [] as readonly {
      sessionId: string
      profileId: string
      label: string
      cols: number
      rows: number
      startedAt: number
    }[],
    registry: hubRegistry(),
  }
})

const INSTANCES = [
  {
    id: 'i-1',
    name: 'BTM Hub',
    enabled: true,
    formValues: {
      nodeId: 'hub',
      profileId: 'monitor',
      profileLabel: 'BTM',
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
    deleteNote?: (row: unknown) => string | null
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
              <td data-testid={`delete-note-${instance.id}`}>{props.deleteNote?.(row) ?? ''}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  ),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const query = <T,>(data: T) => ({ data, isLoading: false, isError: false, refetch: vi.fn() })
  return {
    ...actual,
    hubPath: (p: string) => p,
    useCapabilityNodePresence: () => {
      const answer = mocks.registry
      return {
        onNode: (nodeId: string) => actual.capabilityPresenceOnNode(answer, nodeId),
        providerNodes: actual.capabilityProviderNodes(answer),
      }
    },
    // The library picker asks the registry itself; its behaviour is its own spec's.
    NodePicker: () => null,
    useClusterNodes: () => ({
      nodes: [
        { id: 'hub', name: 'Hub' },
        { id: 'edge', name: 'edge-proxmox' },
      ],
    }),
    useCoreBlocksListCompositions: () => ({
      data: mocks.compositions,
      isError: false,
      isLoading: mocks.compositions === undefined,
    }),
    useInstancesOfCap: () => query(INSTANCES),
    useTerminalSessionListProfiles: (input: { nodeId: string }) => {
      mocks.profileCalls.push(input.nodeId)
      return query([{ profileId: 'monitor', label: 'BTM', description: 'btm' }])
    },
    useTerminalSessionListSessions: () => query(mocks.sessions),
    useTerminalSessionServerShellStatus: () => query(undefined),
    useTerminalSessionOpenSession: () => ({ mutateAsync: mocks.openSession, isPending: false }),
    useTerminalSessionClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

import { MemoryRouter } from 'react-router-dom'
import { TerminalPage } from '../Terminal'

function renderPage(path = '/system/terminal') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <TerminalPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// The camera of a Terminal is the block that names it (planning#580).
const HUB_MONITOR_BLOCK = {
  id: 'b-1',
  name: 'Hub monitor',
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 2,
  createdBy: 'test',
  status: 'running',
  lastChangedAt: 1,
  source: {
    kind: 'composition',
    composition: {
      target: { kind: 'new', type: 'camera' },
      features: [],
      helper: { kind: 'terminal', terminalId: 'i-1' },
    },
  },
}

function loadedCompositions(): unknown {
  return {
    state: 'loaded',
    views: [
      {
        block: HUB_MONITOR_BLOCK,
        state: {
          kind: 'answered',
          state: { blockId: 'b-1', deviceId: 4101, status: 'running', fields: [] },
        },
      },
    ],
  }
}

describe('TerminalPage', () => {
  beforeEach(() => {
    mocks.openSession.mockClear()
    mocks.profileCalls.length = 0
    mocks.compositions = loadedCompositions()
    mocks.sessions = []
    mocks.registry = mocks.hubRegistry()
  })

  it('shows each terminal with its node, profile and the camera block that shows it', () => {
    renderPage()
    const table = screen.getByRole('table')
    expect(within(table).getByText('BTM Hub')).toBeInTheDocument()
    expect(within(table).getByText('Hub')).toBeInTheDocument()
    const link = within(table).getByRole('link', { name: /hub monitor/i })
    expect(link).toHaveAttribute('href', '/devices/4101')
    expect(within(table).getAllByText('None')).toHaveLength(1)
  })

  it('a terminal with no camera links to Build-your-self on the Terminal camera template', () => {
    renderPage()
    const link = screen.getByRole('link', { name: /add a camera/i })
    expect(link).toHaveAttribute(
      'href',
      '/build?tab=custom-device&new=helper&template=terminal&terminalId=i-2',
    )
  })

  it('a camera read that has not answered is never "None"', () => {
    mocks.compositions = undefined
    renderPage()
    expect(screen.queryByText('None')).not.toBeInTheDocument()
  })

  it('the delete confirmation names the camera block that goes with the terminal', () => {
    renderPage()
    expect(screen.getByTestId('delete-note-i-1').textContent).toMatch(/Hub monitor/)
    expect(screen.getByTestId('delete-note-i-2').textContent).toBe('')
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

  it('renders one table and no per-node card; a node without a provider is not queried', () => {
    renderPage()
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(screen.queryByText('Nodes')).not.toBeInTheDocument()
    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument()
    expect(mocks.profileCalls).not.toContain('edge')
  })

  it('splits terminal devices and node shells into two sub-sections, devices first', () => {
    renderPage()
    expect(screen.getByRole('tab', { name: /terminal devices/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: /node shells/i })).toBeInTheDocument()
    // The node list belongs to the other tab and is not mounted here.
    expect(screen.queryByRole('button', { name: /open shell/i })).not.toBeInTheDocument()
  })

  it('never lists a node shell among the live terminal sessions', () => {
    mocks.sessions = [
      { sessionId: 'tty-1', profileId: 'monitor', label: 'BTM', cols: 80, rows: 24, startedAt: 0 },
      {
        sessionId: 'sh-1',
        profileId: 'server-shell',
        label: 'Server shell',
        cols: 80,
        rows: 24,
        startedAt: 0,
      },
    ]
    renderPage()
    expect(screen.getByText(/tty-1/)).toBeInTheDocument()
    expect(screen.queryByText(/sh-1/)).not.toBeInTheDocument()
  })

  it('opens no session when the Node shells tab shows the node list', () => {
    renderPage('/system/terminal?tab=shells')
    expect(screen.getByRole('button', { name: /open shell/i })).toBeInTheDocument()
    expect(mocks.openSession).not.toHaveBeenCalled()
  })
})
