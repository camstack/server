/**
 * The Scripts tab, as a surface — not as rules.
 *
 * `core-block-status.spec.ts` already pins the rules. What is tested here is
 * that the page does not throw them away: a block whose process is gone must
 * reach the screen carrying its reason, a delete must not happen on one click,
 * a server-side compile refusal must be shown rather than swallowed into a
 * closed editor that looks like a successful save, and the logs pane must be
 * scoped to the runner id the block actually runs under — a pane scoped to the
 * wrong id is indistinguishable from a block that logged nothing.
 *
 * `BlockEditor` is mocked: it mounts Monaco, which needs a real worker, and the
 * thing worth asserting here is the wiring around it.
 */

import { DeviceType, type CoreBlock } from '@camstack/types'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const COMPOSITION_SOURCE: NonNullable<CoreBlock['source']> = {
  kind: 'composition',
  composition: {
    target: { kind: 'new', type: DeviceType.Sensor },
    features: [{ kind: 'fields', cap: 'binary', fields: {} }],
  },
}

// ── the live tRPC client behind `useSystem()` ─────────────────────────────

let mockBlocks: CoreBlock[] = []
let mockListError: Error | null = null
let mockCreateError: Error | null = null
let mockRestartError: Error | null = null

const mockList = vi.fn(() =>
  mockListError ? Promise.reject(mockListError) : Promise.resolve({ blocks: mockBlocks }),
)
const mockGetTypeDefs = vi.fn(() => Promise.resolve({ libs: [] }))
const mockCreate = vi.fn(() =>
  mockCreateError ? Promise.reject(mockCreateError) : Promise.resolve({ block: mockBlocks[0] }),
)
const mockUpdate = vi.fn(() => Promise.resolve({ block: mockBlocks[0] }))
const mockDelete = vi.fn(() => Promise.resolve({ success: true as const }))
const mockSetEnabled = vi.fn(() => Promise.resolve({ block: mockBlocks[0] }))
const mockRestart = vi.fn(() =>
  mockRestartError ? Promise.reject(mockRestartError) : Promise.resolve({ block: mockBlocks[0] }),
)

interface ErrorBoxProps {
  readonly title?: string
  readonly message: ReactNode
  readonly onRetry?: () => void
}
interface ChildrenProps {
  readonly children?: ReactNode
}
interface ButtonProps extends ChildrenProps {
  readonly onClick?: () => void
  readonly disabled?: boolean
  readonly title?: string
}
interface LogStreamProps {
  readonly addonId?: string
}

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  // Real ConfirmDialogProvider + useConfirm: the delete test drives the modal.
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useUiText: () => (_key: string, fallback: string | { other: string }) =>
    typeof fallback === 'string' ? fallback : fallback.other,
  useSystem: () => ({
    trpcClient: {
      coreBlocks: {
        list: { query: mockList },
        getTypeDefs: { query: mockGetTypeDefs },
        create: { mutate: mockCreate },
        update: { mutate: mockUpdate },
        delete: { mutate: mockDelete },
        setEnabled: { mutate: mockSetEnabled },
        restart: { mutate: mockRestart },
      },
    },
  }),
  Badge: ({ children }: ChildrenProps) => <span>{children}</span>,
  Button: ({ children, onClick, disabled, title }: ButtonProps) => (
    <button type="button" onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  ),
  ErrorBox: ({ title, message }: ErrorBoxProps) => (
    <div data-testid="error-box">
      <span>{title}</span>
      <span>{message}</span>
    </div>
  ),
  formatLastSeen: () => '2h ago',
  TABLE_SCROLL_MAX_H: 'max-h-96',
  useItemFormUrl: () => {
    const [mode, setMode] = useState<'closed' | 'new' | 'edit'>('closed')
    const [id, setId] = useState<string | null>(null)
    return {
      state:
        mode === 'closed'
          ? { mode: 'closed' as const }
          : mode === 'new'
            ? { mode: 'new' as const }
            : { mode: 'edit' as const, id: id ?? '' },
      openNew: () => {
        setMode('new')
        setId(null)
      },
      openEdit: (next: string) => {
        setMode('edit')
        setId(next)
      },
      close: () => {
        setMode('closed')
        setId(null)
      },
    }
  },
  DataTable: ({
    rows,
    rowKey,
    columns,
    emptyMessage,
    onRowClick,
  }: {
    rows: readonly CoreBlock[]
    rowKey: (r: CoreBlock) => string
    columns: readonly { key: string; render: (r: CoreBlock) => ReactNode }[]
    emptyMessage?: string
    onRowClick?: (r: CoreBlock) => void
  }) => (
    <div data-testid="scripts-table">
      {rows.length === 0 ? (
        <p>{emptyMessage}</p>
      ) : (
        <ul data-testid="scripts-list">
          {rows.map((row) => (
            <li key={rowKey(row)} onClick={() => onRowClick?.(row)}>
              {columns.map((col) => (
                <div key={col.key}>{col.render(row)}</div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  ),
  ItemFormDialog: ({
    open,
    children,
    testId,
  }: {
    open: boolean
    children: ReactNode
    testId?: string
  }) => (open ? <div data-testid={testId ?? 'item-form-dialog'}>{children}</div> : null),
  // The real one opens a websocket. What matters here is the id it is handed.
  LogStream: ({ addonId }: LogStreamProps) => <div data-testid="log-stream">{addonId}</div>,
}))

// Monaco needs a real worker; the wiring around it is what matters here.
interface MockEditorProps {
  readonly saveError: string | null
  readonly onSave: (input: {
    name: string
    code: string
    enabled: boolean
    placement: string
  }) => void
  readonly onRestart?: () => void
}
vi.mock('../BlockEditor', () => ({
  BlockEditor: ({ saveError, onSave, onRestart }: MockEditorProps) => (
    <div data-testid="editor">
      {saveError !== null && <span data-testid="save-error">{saveError}</span>}
      <span data-testid="editor-can-restart">{onRestart === undefined ? 'no' : 'yes'}</span>
      <button
        type="button"
        onClick={() => onSave({ name: 'X', code: 'x', enabled: true, placement: 'hub' })}
      >
        mock-save
      </button>
    </div>
  ),
}))

import { freshest, ScriptsTab } from '../ScriptsTab'

const block = (over: Partial<CoreBlock> = {}): CoreBlock => ({
  id: 'b1',
  name: 'Block',
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'u',
  status: 'running',
  lastChangedAt: 1,
  ...over,
})

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmDialogProvider>
        <ScriptsTab />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

describe('Scripts tab', () => {
  beforeEach(() => {
    mockBlocks = []
    mockListError = null
    mockCreateError = null
    mockRestartError = null
    for (const m of [
      mockList,
      mockGetTypeDefs,
      mockCreate,
      mockUpdate,
      mockDelete,
      mockSetEnabled,
      mockRestart,
    ])
      m.mockClear()
  })

  it('hides composition blocks — they are Custom Device rows, not scripts', async () => {
    mockBlocks = [
      block({ id: 'comp', name: 'Porch (composto)', code: '', source: COMPOSITION_SOURCE }),
      block({ id: 'script', name: 'My script', code: 'export default () => {}' }),
    ]
    renderTab()
    await waitFor(() => expect(screen.getByText('My script')).toBeTruthy())
    expect(screen.queryByText('Porch (composto)')).toBeNull()
  })

  it('shows No scripts yet when the list only has compositions', async () => {
    mockBlocks = [
      block({ id: 'comp', name: 'customize:doorbell', code: '', source: COMPOSITION_SOURCE }),
    ]
    renderTab()
    await waitFor(() => expect(screen.getByText(/No scripts yet/)).toBeTruthy())
    expect(screen.queryByText('customize:doorbell')).toBeNull()
  })

  it('shows a failed block WITH the recorded reason', async () => {
    mockBlocks = [block({ status: 'failed', lastError: 'the code does not compile (line 3)' })]
    renderTab()
    await waitFor(() => expect(screen.getByText('Failed')).toBeTruthy())
    expect(screen.getByText(/does not compile \(line 3\)/)).toBeTruthy()
  })

  it('an ENABLED block reading `stopped` is presented as not running, not as idle', async () => {
    // The whole reason the status rules exist: the raw field alone reads as a
    // resting state.
    mockBlocks = [block({ status: 'stopped' })]
    renderTab()
    await waitFor(() => expect(screen.getByText('Not running')).toBeTruthy())
    expect(screen.queryByText('Disabled')).toBeNull()
  })

  it('says a failure in the header, before any row is read', async () => {
    mockBlocks = [block({ id: 'a', status: 'running' }), block({ id: 'b', status: 'failed' })]
    renderTab()
    await waitFor(() => expect(screen.getByText(/NOT running/)).toBeTruthy())
  })

  it('toggling calls setEnabled with the INVERTED value', async () => {
    mockBlocks = [block({ enabled: true })]
    renderTab()
    await waitFor(() => expect(screen.getByText('Disable')).toBeTruthy())
    fireEvent.click(screen.getByText('Disable'))
    await waitFor(() =>
      expect(mockSetEnabled).toHaveBeenCalledWith({ blockId: 'b1', enabled: false }),
    )
  })

  it('does NOT delete on the first click — deleting a script destroys its source', async () => {
    mockBlocks = [block()]
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Delete')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Delete'))
    expect(mockDelete).not.toHaveBeenCalled()
    const modal = await screen.findByRole('dialog')
    expect(within(modal).getByText('Delete this script?')).toBeTruthy()
    expect(within(modal).getByText(/will be deleted/).textContent).toContain('Block')

    fireEvent.click(within(modal).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith({ blockId: 'b1' }))
  })

  it('cancelling the delete modal deletes nothing', async () => {
    mockBlocks = [block()]
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Delete')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Delete'))
    const modal = await screen.findByRole('dialog')
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it("surfaces the server's compile refusal instead of closing the editor", async () => {
    // The server compiles before it stores. If that verdict is swallowed the
    // operator sees a save that did nothing.
    mockCreateError = new Error('core-blocks: the code does not compile (line 7): Unexpected token')
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <ConfirmDialogProvider>
          <ScriptsTab createRequested />
        </ConfirmDialogProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
    fireEvent.click(screen.getByText('mock-save'))

    await waitFor(() => expect(screen.getByTestId('save-error').textContent).toContain('line 7'))
    // Still open — a closed editor would read as a successful save.
    expect(screen.getByTestId('editor')).toBeTruthy()
  })

  it('reports a failure to READ the scripts rather than rendering an empty list', async () => {
    // An empty read is not "there is nothing" — twice this repo has destroyed
    // or hidden state by treating it that way.
    mockListError = new Error('provider not available')
    renderTab()
    await waitFor(() => expect(screen.getByTestId('error-box')).toBeTruthy())
    expect(screen.queryByText('No scripts yet.')).toBeNull()
  })

  it('restart calls the ONE authority, with the block id', async () => {
    mockBlocks = [block()]
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Restart')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Restart'))
    await waitFor(() => expect(mockRestart).toHaveBeenCalledWith({ blockId: 'b1' }))
  })

  it('refuses to offer Restart on a DISABLED block', async () => {
    // The server refuses it too. A button that appears to work while nothing
    // starts is the failure this gate exists to prevent.
    mockBlocks = [block({ enabled: false })]
    renderTab()
    await waitFor(() => expect(screen.getByText('Enable')).toBeTruthy())
    const restartButton = screen.getByTitle(/Enable it instead/)
    expect(restartButton.hasAttribute('disabled')).toBe(true)
    fireEvent.click(restartButton)
    expect(mockRestart).not.toHaveBeenCalled()
  })

  it("scopes the logs pane to the BLOCK'S OWN runner id", async () => {
    // `core-block-<id>` is the runner id the supervisor spawns under. Scoped to
    // anything else, the pane is silently always empty — which reads exactly
    // like a block that logged nothing.
    mockBlocks = [block({ id: 'b7f2' })]
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Logs')).toBeTruthy())
    expect(screen.queryByTestId('log-stream')).toBeNull()
    fireEvent.click(screen.getByTitle('Logs'))
    expect(screen.getByTestId('log-stream').textContent).toBe('core-block-b7f2')
  })

  it('keeps the editor open after a create, on the block that was created', async () => {
    // Compile → Save → Restart → Logs is the loop. Closing on save breaks it
    // after the first step, and the editor cannot offer Restart for a block it
    // no longer holds.
    mockBlocks = [block()]
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <ConfirmDialogProvider>
          <ScriptsTab createRequested />
        </ConfirmDialogProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
    expect(screen.getByTestId('editor-can-restart').textContent).toBe('no')
    fireEvent.click(screen.getByText('mock-save'))
    await waitFor(() => expect(screen.getByTestId('editor-can-restart').textContent).toBe('yes'))
  })

  it('surfaces a restart failure rather than swallowing it', async () => {
    mockBlocks = [block()]
    mockRestartError = new Error('core-blocks: no block supervisor runs on this node')
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Restart')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Restart'))
    await waitFor(() => expect(screen.getByText(/no block supervisor/)).toBeTruthy())
  })
})

describe('freshest', () => {
  // The editor gates Restart on "does the screen match what the server stored".
  // The list is up to one poll behind a save, so binding the editor to the list
  // alone keeps Restart refused for five seconds after a SUCCESSFUL save — which
  // tells the operator their save did not take.
  it('prefers the block a write just returned over a stale list row', () => {
    const listed = [block({ code: 'old', updatedAt: 1 })]
    const held = block({ code: 'new', updatedAt: 2 })
    expect(freshest(listed, held).code).toBe('new')
  })

  it('prefers the LIST once it has caught up — the status badge lives there', () => {
    const listed = [block({ status: 'running', updatedAt: 2 })]
    const held = block({ status: 'starting', updatedAt: 2 })
    expect(freshest(listed, held).status).toBe('running')
  })

  it('falls back to the held block when the list does not know it yet', () => {
    expect(freshest([], block({ id: 'b9' })).id).toBe('b9')
  })
})
