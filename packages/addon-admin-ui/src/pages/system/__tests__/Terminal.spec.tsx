/**
 * Tests for System → Terminal.
 *
 *  1. `parseSseBuffer` — the hand-rolled SSE frame parser that feeds xterm:
 *     decodes `data:` frames, skips `: keepalive` comments, and keeps a partial
 *     tail for the next chunk.
 *  2. `TerminalPage` — renders the node picker, launcher, and live-session list
 *     from the capability hooks (with `<TerminalPanel>` stubbed).
 */
/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// The root `setupFiles` import of `@testing-library/jest-dom/vitest` does not
// reach this file — `toBeInTheDocument` resolved as a plain Chai property and
// threw. Registering the matchers explicitly is the pattern the specs under
// `components/pipeline/__tests__/` already use.
expect.extend(jestDomMatchers)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
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
// 2. Page render — stub the terminal panel + capability hooks
// ---------------------------------------------------------------------------
vi.mock('../../../components/TerminalPanel', () => ({
  TerminalPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="terminal-panel">panel:{sessionId}</div>
  ),
}))

const terminalMutations = vi.hoisted(() => ({
  createInstance: vi.fn(async () => ({})),
  updateInstance: vi.fn(async () => ({})),
  deleteInstance: vi.fn(async () => {}),
  setInstanceEnabled: vi.fn(async () => ({})),
  adoptLegacyMonitor: vi.fn(async () => ({})),
}))

/**
 * Every argument list `useTerminalSessionListLegacyCameras` was called with.
 *
 * The legacy-camera list is the only read on this page that leaves the addon's
 * in-memory maps: it resolves to `deviceManager.listAll({ addonId })`, whose
 * full projection reaches the settings door for the whole `device-manager:`
 * prefix of `addon-device-settings`. Its cadence is therefore a property of
 * the page worth pinning — asserted on the CALL, because the rendered rows are
 * identical at any interval.
 */
const legacyCameraReads = vi.hoisted(() => ({ calls: [] as unknown[][] }))

/** Mutable so a test can simulate "this node has no profiles enabled". */
const profileFixtures = vi.hoisted(() => ({
  list: [{ profileId: 'monitor', label: 'System Monitor', description: 'btm' }] as {
    profileId: string
    label: string
    description?: string
    settingsSchema?: {
      sections: readonly {
        id: string
        title?: string
        fields: readonly { type: string; key: string; label: string; default?: unknown }[]
      }[]
    } | null
  }[],
}))

// The real panel issues tRPC queries; here we only assert the wiring — WHICH
// addon and WHICH node the page asks it to render. That is the whole point of
// putting the schema on this page rather than re-declaring fields.
vi.mock('../../../components/settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: ({
    nodeId,
    addonIds,
    level,
  }: {
    nodeId: string | null
    addonIds: readonly string[]
    level: string
  }) => (
    <div data-testid="addon-settings-panel" data-node-id={nodeId ?? ''} data-level={level}>
      {addonIds.join(',')}
    </div>
  ),
}))

vi.mock('@camstack/ui-library', () => ({
  // Root-mounted in these tests: the mount resolver is the identity.
  hubPath: (p: string) => p,
  ErrorBox: ({ message }: { message: ReactNode }) => <div data-testid="error-box">{message}</div>,
  ConfigFormBuilder: ({
    schema,
    values,
    onChange,
  }: {
    schema: { sections: readonly { id: string }[] }
    values: Record<string, unknown>
    onChange: (next: Record<string, unknown>) => void
  }) => (
    <div data-testid="config-form-builder" data-section-id={schema.sections[0]?.id ?? ''}>
      {JSON.stringify(values)}
      <button type="button" onClick={() => onChange({ ...values, showProcessList: false })}>
        disable process list
      </button>
    </div>
  ),
  NodePicker: ({
    selectedNodeId,
    onSelect,
  }: {
    selectedNodeId: string
    onSelect: (nodeId: string) => void
  }) => (
    <div data-testid="node-picker">
      {selectedNodeId}
      <button onClick={() => onSelect('agent-a')}>pick agent-a</button>
    </div>
  ),
  useTerminalSessionListProfiles: () => ({
    data: profileFixtures.list,
    isError: false,
    refetch: vi.fn(),
  }),
  useTerminalSessionListSessions: () => ({
    data: [
      {
        sessionId: 'sess-1',
        profileId: 'monitor',
        label: 'System Monitor',
        cols: 120,
        rows: 32,
        startedAt: 1_700_000_000_000,
      },
    ],
    refetch: vi.fn(),
  }),
  useTerminalSessionOpenSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTerminalSessionClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTerminalSessionListInstances: () => ({ data: [], refetch: vi.fn() }),
  useTerminalSessionListLegacyCameras: (...args: unknown[]) => {
    legacyCameraReads.calls.push(args)
    return {
      data: [
        {
          stableId: 'terminal-camera-hub',
          nodeId: 'hub',
          profileId: 'monitor',
          profileLabel: 'BTM',
          name: 'Terminal Hub',
          adoptable: true,
        },
      ],
      refetch: vi.fn(),
    }
  },
  useTerminalSessionCreateInstance: () => ({
    mutateAsync: terminalMutations.createInstance,
    isPending: false,
  }),
  useTerminalSessionUpdateInstance: () => ({
    mutateAsync: terminalMutations.updateInstance,
    isPending: false,
  }),
  useTerminalSessionDeleteInstance: () => ({
    mutateAsync: terminalMutations.deleteInstance,
    isPending: false,
  }),
  useTerminalSessionSetInstanceEnabled: () => ({
    mutateAsync: terminalMutations.setInstanceEnabled,
    isPending: false,
  }),
  useTerminalSessionAdoptLegacyMonitor: () => ({
    mutateAsync: terminalMutations.adoptLegacyMonitor,
    isPending: false,
  }),
  // AdminPage wraps library PageShell after the composite-patterns migration.
  PageShell: ({
    children,
    title,
    actions,
    nav,
  }: {
    children: ReactNode
    title?: string
    actions?: ReactNode
    nav?: ReactNode
  }) => (
    <div>
      {title !== undefined && title !== '' ? <h1>{title}</h1> : null}
      {actions}
      {nav}
      {children}
    </div>
  ),
}))

// Imported after the mocks so the page picks up the stubbed hooks.
import { TerminalPage } from '../Terminal'

function renderPage() {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <TerminalPage />
    </QueryClientProvider>,
  )
}

describe('TerminalPage', () => {
  it('polls the legacy migration list on its own cadence, not the 5 s session cadence', () => {
    legacyCameraReads.calls.length = 0
    renderPage()

    expect(legacyCameraReads.calls.length).toBeGreaterThan(0)
    const [input, options] = legacyCameraReads.calls[0] ?? []
    expect(input).toEqual({ nodeId: 'hub' })
    expect(options).toMatchObject({ refetchInterval: 60_000 })
  })

  it('creates an explicit Terminal instance instead of deriving a camera from the profile', async () => {
    terminalMutations.createInstance.mockClear()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /create terminal camera/i }))

    await waitFor(() => {
      expect(terminalMutations.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'hub',
          targetNodeId: 'hub',
          profileId: 'monitor',
        }),
      )
    })
    expect(screen.queryByTestId('config-form-builder')).not.toBeInTheDocument()
    expect(screen.getByText(/legacy automatic cameras/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /adopt btm/i })).toBeInTheDocument()
  })

  it('renders the launcher and lists live sessions', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'Terminal' })).toBeInTheDocument()
    expect(screen.getByTestId('node-picker')).toHaveTextContent('hub')
    expect(screen.getByRole('button', { name: /open session/i })).toBeInTheDocument()
    expect(screen.getByText('Live sessions')).toBeInTheDocument()
    expect(screen.getByText('sess-1', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /attach/i })).toBeInTheDocument()
  })

  it('hosts the terminal addon settings schema on the page, for the selected node', () => {
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /terminal configuration/i }))

    const panel = screen.getByTestId('addon-settings-panel')
    expect(panel).toHaveTextContent('terminal')
    expect(panel).toHaveAttribute('data-node-id', 'hub')
    expect(panel).toHaveAttribute('data-level', 'global')
  })

  it('retargets the settings schema when the node picker moves, so config follows the profiles shown', () => {
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /terminal configuration/i }))
    fireEvent.click(screen.getByRole('button', { name: /pick agent-a/i }))

    expect(screen.getByTestId('addon-settings-panel')).toHaveAttribute('data-node-id', 'agent-a')
  })

  it('opens the configuration by default when the node offers no profiles at all', () => {
    const original = profileFixtures.list
    profileFixtures.list = []
    try {
      renderPage()
      expect(screen.getByTestId('addon-settings-panel')).toBeInTheDocument()
    } finally {
      profileFixtures.list = original
    }
  })

  it('keeps the configuration collapsed while the node has profiles', () => {
    renderPage()
    expect(screen.queryByTestId('addon-settings-panel')).not.toBeInTheDocument()
  })

  it('renders the Glances panel form and sends profileSettings on create', async () => {
    const original = profileFixtures.list
    profileFixtures.list = [
      {
        profileId: 'glances',
        label: 'Glances',
        description: 'glances',
        settingsSchema: {
          sections: [
            {
              id: 'glances-panels',
              title: 'Glances panels',
              fields: [
                {
                  type: 'boolean',
                  key: 'showProcessList',
                  label: 'Process list',
                  default: true,
                },
              ],
            },
          ],
        },
      },
    ]
    try {
      terminalMutations.createInstance.mockClear()
      renderPage()

      expect(screen.getByTestId('config-form-builder')).toHaveAttribute(
        'data-section-id',
        'glances-panels',
      )

      fireEvent.click(screen.getByRole('button', { name: /disable process list/i }))
      fireEvent.click(screen.getByRole('button', { name: /create terminal camera/i }))

      await waitFor(() => {
        expect(terminalMutations.createInstance).toHaveBeenCalledWith(
          expect.objectContaining({
            nodeId: 'hub',
            targetNodeId: 'hub',
            profileId: 'glances',
            profileSettings: expect.objectContaining({ showProcessList: false }),
          }),
        )
      })
    } finally {
      profileFixtures.list = original
    }
  })

  it('removes an explicitly closed session immediately, even before a stale list refetch settles', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /attach/i }))
    expect(screen.getByTestId('terminal-panel')).toHaveTextContent('panel:sess-1')

    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!)

    await waitFor(() => {
      expect(screen.queryByText('sess-1', { exact: false })).not.toBeInTheDocument()
      expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument()
    })
  })
})
