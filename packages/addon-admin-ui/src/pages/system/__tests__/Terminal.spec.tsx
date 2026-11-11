/**
 * Tests for System → Terminal.
 *
 *  1. `parseSseBuffer` — the hand-rolled SSE frame parser that feeds xterm:
 *     decodes `data:` frames, skips `: keepalive` comments, and keeps a partial
 *     tail for the next chunk.
 *  2. `TerminalPage` — ONE table of every instance across nodes and nothing
 *     beside it: no per-node card, no legacy-camera list. Legacy cameras are
 *     one header action, shown only when the hub answered that some exist
 *     (with `<TerminalPanel>` stubbed). The node picker's "not installed"
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

const mocks = vi.hoisted(() => ({
  openSession: vi.fn(async () => ({ sessionId: 's-1' })),
  profileCalls: [] as string[],
  legacy: undefined as readonly { stableId: string }[] | undefined,
  custom: vi.fn(async () => ({ adopted: 1, cameras: [] })),
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
    pageActions?: (rows: readonly unknown[]) => unknown
  }) => (
    <table>
      <caption>{props.pageActions?.([]) as never}</caption>
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
    useCapabilityNodePresence: () => {
      const onNodeOf = actual['capabilityPresenceOnNode'] as (
        answer: unknown,
        nodeId: string,
      ) => string
      return {
        onNode: (nodeId: string) =>
          onNodeOf({ status: mocks.registry.status, data: mocks.registry.data }, nodeId),
      }
    },
    useAddonsCustom: () => ({ mutateAsync: mocks.custom, isPending: false }),
    // The library picker asks the registry itself; its behaviour is its own spec's.
    NodePicker: () => null,
    useClusterNodes: () => ({
      nodes: [
        { id: 'hub', name: 'Hub' },
        { id: 'edge', name: 'edge-proxmox' },
      ],
    }),
    useDeviceManagerListAll: () => query([{ id: 4101, stableId: 'cam-1' }]),
    useInstancesOfCap: () => query(INSTANCES),
    useTerminalSessionListLegacyCameras: () => query(mocks.legacy),
    useTerminalSessionListProfiles: (input: { nodeId: string }) => {
      mocks.profileCalls.push(input.nodeId)
      return query([{ profileId: 'monitor', label: 'BTM', description: 'btm' }])
    },
    useTerminalSessionListSessions: () => query([]),
    useTerminalSessionOpenSession: () => ({ mutateAsync: mocks.openSession, isPending: false }),
    useTerminalSessionClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    mocks.legacy = []
    mocks.custom.mockClear()
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

  it('renders one table and no per-node card; a node without a provider is not queried', () => {
    renderPage()
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(screen.queryByText('Nodes')).not.toBeInTheDocument()
    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument()
    expect(mocks.profileCalls).not.toContain('edge')
  })

  it('shows no legacy action while the legacy read has not answered, or answered none', () => {
    mocks.legacy = undefined
    const { unmount } = renderPage()
    expect(screen.queryByRole('button', { name: /legacy/i })).not.toBeInTheDocument()
    unmount()
    mocks.legacy = []
    renderPage()
    expect(screen.queryByRole('button', { name: /legacy/i })).not.toBeInTheDocument()
  })

  it('offers ONE action that adopts every legacy camera, with no list of them', async () => {
    mocks.legacy = [{ stableId: 'terminal-camera-hub' }, { stableId: 'terminal-camera-edge-top' }]
    renderPage()
    expect(screen.queryByText('terminal-camera-hub')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Adopt legacy cameras (2)' }))
    await waitFor(() => {
      expect(mocks.custom).toHaveBeenCalledWith({
        addonId: 'terminal',
        action: 'adoptLegacyCameras',
        input: {},
      })
    })
  })
})
