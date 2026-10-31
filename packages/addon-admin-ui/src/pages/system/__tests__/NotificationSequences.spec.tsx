/**
 * Sequences tab — list chrome and URL-owned create/edit dialog.
 *
 * Pins the managed-list contract: DataTable rows, ItemFormDialog for create/
 * edit (`?new=1` / `?sequence=<id>`), and delete through the shared confirm.
 *
 * Full ui-library mock (like ScriptsTab): `importActual` pulls `@camstack/sdk`
 * → `@camstack/types/client`, which this vitest graph does not resolve.
 */

import type { NcSharedSequence } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SEQUENCE: NcSharedSequence = {
  id: 'seq_1',
  name: 'Unlock gate',
  actions: [{ kind: 'wait', seconds: 2 }],
  minDelaySec: 30,
}

let sequences: NcSharedSequence[] = []
let listPending = false
let listError: Error | null = null

const mockListRefetch = vi.fn()
const mockCreate = vi.fn()
const mockUpdate = vi.fn()
const mockDelete = vi.fn()
const mockCreateReset = vi.fn()
const mockUpdateReset = vi.fn()
const mockConfirm = vi.fn(async (_opts: { title?: string }) => true)

interface ChildrenProps {
  readonly children?: ReactNode
}
interface ButtonProps extends ChildrenProps {
  readonly onClick?: () => void
  readonly disabled?: boolean
  readonly title?: string
  readonly type?: 'button' | 'submit' | 'reset'
}
interface ErrorBoxProps {
  readonly title?: string
  readonly message: ReactNode
  readonly onRetry?: () => void
}
interface DataTableProps {
  readonly rows: readonly NcSharedSequence[]
  readonly rowKey: (r: NcSharedSequence) => string
  readonly columns: readonly { key: string; render: (r: NcSharedSequence) => ReactNode }[]
  readonly onRowClick?: (r: NcSharedSequence) => void
}
interface ItemFormDialogProps {
  readonly open: boolean
  readonly children: ReactNode
  readonly title?: string
  readonly testId?: string
  readonly footer?: ReactNode
}
interface SelectProps {
  readonly value?: string
  readonly options?: readonly { value: string; label: string }[]
  readonly onChange?: (e: { target: { value: string } }) => void
  readonly className?: string
}
interface InputProps {
  readonly value?: string
  readonly onChange?: (e: { target: { value: string } }) => void
  readonly className?: string
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useDeviceManagerListAll: () => ({ data: [], isLoading: false, isError: false }),
    useNotificationRulesListSequences: () => ({
      data: listPending || listError !== null ? undefined : { sequences },
      isPending: listPending,
      error: listError,
      refetch: mockListRefetch,
    }),
    useNotificationRulesCreateSequence: () => ({
      mutateAsync: mockCreate,
      isPending: false,
      error: null,
      reset: mockCreateReset,
    }),
    useNotificationRulesUpdateSequence: () => ({
      mutateAsync: mockUpdate,
      isPending: false,
      error: null,
      reset: mockUpdateReset,
    }),
    useNotificationRulesDeleteSequence: () => ({
      mutateAsync: mockDelete,
      isPending: false,
      error: null,
    }),
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
    useConfirm: () => mockConfirm,
    ConfirmDialogProvider: ({ children }: ChildrenProps) => <>{children}</>,
    Button: ({
      children,
      onClick,
      disabled,
      title,
      type = 'button',
      'data-testid': testId,
    }: ButtonProps & { readonly 'data-testid'?: string }) => (
      <button type={type} onClick={onClick} disabled={disabled} title={title} data-testid={testId}>
        {children}
      </button>
    ),
    Input: ({ value, onChange, className }: InputProps) => (
      <input className={className} value={value} onChange={onChange} />
    ),
    Select: ({ value, options = [], onChange, className }: SelectProps) => (
      <select
        className={className}
        value={value}
        onChange={(e) => onChange?.({ target: { value: e.target.value } })}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ),
    ErrorBox: ({ title, message }: ErrorBoxProps) => (
      <div data-testid="error-box">
        <span>{title}</span>
        <span>{message}</span>
      </div>
    ),
    Badge: ({ children }: ChildrenProps) => <span>{children}</span>,
    Card: ({ children }: ChildrenProps) => <div data-testid="card">{children}</div>,
    TABLE_SCROLL_MAX_H: 'max-h-96',
    DataTable: ({ rows, rowKey, columns, onRowClick }: DataTableProps) => (
      <div data-testid="sequences-table">
        <ul>
          {rows.map((row) => (
            <li key={rowKey(row)} onClick={() => onRowClick?.(row)}>
              {columns.map((col) => (
                <div key={col.key}>{col.render(row)}</div>
              ))}
            </li>
          ))}
        </ul>
      </div>
    ),
    ItemFormDialog: ({ open, children, title, testId, footer }: ItemFormDialogProps) =>
      open ? (
        <div data-testid={testId ?? 'item-form-dialog'}>
          <h2>{title}</h2>
          {children}
          {footer}
        </div>
      ) : null,
    fleetViewOf: () => ({
      state: 'ready' as const,
      byId: new Map(),
      cameras: [],
    }),
  }
})

vi.mock('../../../components/AdminPage', () => ({
  AdminPage: ({
    title,
    actions,
    children,
  }: {
    title: string
    actions?: ReactNode
    children?: ReactNode
  }) => (
    <div>
      <h1>{title}</h1>
      <div>{actions}</div>
      {children}
    </div>
  ),
}))

vi.mock('../../../components/device-do-action/DeviceDoActionFields', () => ({
  DeviceDoActionFields: () => <div data-testid="device-do-fields" />,
}))

import { NotificationSequencesPage } from '../NotificationSequences'

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationSequencesPage />
    </QueryClientProvider>,
  )
}

describe('NotificationSequences page', () => {
  beforeEach(() => {
    sequences = []
    listPending = false
    listError = null
    for (const m of [
      mockListRefetch,
      mockCreate,
      mockUpdate,
      mockDelete,
      mockCreateReset,
      mockUpdateReset,
      mockConfirm,
    ])
      m.mockClear()
    mockConfirm.mockResolvedValue(true)
    mockCreate.mockResolvedValue({ sequence: SEQUENCE })
    mockUpdate.mockResolvedValue({ sequence: SEQUENCE })
    mockDelete.mockResolvedValue({ success: true })
  })

  it('shows the empty state when the hub answered with no sequences', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('sequences-empty')).toBeTruthy())
    expect(screen.getByText(/No sequences yet/)).toBeTruthy()
  })

  it('lists sequences in a table and opens the editor from the row', async () => {
    sequences = [SEQUENCE]
    renderPage()
    await waitFor(() => expect(screen.getByText('Unlock gate')).toBeTruthy())
    expect(screen.getByText(/1 step · min delay 30s/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('sequence-open-seq_1'))
    await waitFor(() => expect(screen.getByTestId('sequence-editor-panel')).toBeTruthy())
    expect(screen.getByText('Edit Unlock gate')).toBeTruthy()
  })

  it('opens a New sequence dialog from the header action', async () => {
    sequences = [SEQUENCE]
    renderPage()
    await waitFor(() => expect(screen.getByText('Unlock gate')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /New sequence/i }))
    const panel = await screen.findByTestId('sequence-editor-panel')
    expect(within(panel).getByRole('heading', { name: 'New sequence' })).toBeTruthy()
  })

  it('asks before delete and then calls deleteSequence', async () => {
    sequences = [SEQUENCE]
    renderPage()
    await waitFor(() => expect(screen.getByTestId('sequence-delete-seq_1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sequence-delete-seq_1'))
    await waitFor(() =>
      expect(mockConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Delete this sequence?' }),
      ),
    )
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith({ sequenceId: 'seq_1' }))
  })
})
