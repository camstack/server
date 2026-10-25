/**
 * Component tests for the notification targets management page (T14).
 *
 * Uses a mocked live tRPC client behind `useSystem()` (mirrors the
 * Capabilities page test). Verifies: the kind catalog renders grouped by
 * addon, password fields are masked in the config form, and `addonId` is
 * threaded through every mutation (enable toggle, delete, upsert).
 */

import type { ConfigUISchema, Target, TargetKind } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock state ──────────────────────────────────────────────────────

let mockTargets: Target[] = []
let mockKinds: TargetKind[] = []

const mockSetEnabled = vi.fn((_i: unknown): Promise<void> => Promise.resolve())
const mockDelete = vi.fn((_i: unknown): Promise<void> => Promise.resolve())
const mockUpsert = vi.fn((i: { target: Target }): Promise<Target> => Promise.resolve(i.target))
const mockListTargets = vi.fn((): Promise<readonly Target[]> => Promise.resolve(mockTargets))
const mockListKinds = vi.fn((): Promise<readonly TargetKind[]> => Promise.resolve(mockKinds))
/** Unredacted secret returned by getTarget (list rows stay `__redacted__`). */
const LIVE_TOKEN = 'live-token-value'

function getTargetLive(i: { targetId: string }): Promise<Target> {
  const hit = mockTargets.find((t) => t.id === i.targetId)
  if (!hit) return Promise.reject(new Error(`Unknown target '${i.targetId}'`))
  // Admin edit/duplicate hydration — live secrets, never the list mask.
  return Promise.resolve({
    ...hit,
    config: { ...hit.config, token: LIVE_TOKEN },
  })
}

/** Redacted getTarget (no live hydrate) — D634 re-enter UI path. */
function getTargetRedacted(i: { targetId: string }): Promise<Target> {
  const hit = mockTargets.find((t) => t.id === i.targetId)
  if (!hit) return Promise.reject(new Error(`Unknown target '${i.targetId}'`))
  return Promise.resolve(hit)
}

const mockGetTarget = vi.fn(getTargetLive)

interface ErrorBoxProps {
  readonly title?: string
  readonly message: ReactNode
  readonly onRetry?: () => void
}

vi.mock('@camstack/ui-library', async () => {
  // Reuse the REAL ConfigFormBuilder so password masking is exercised
  // end-to-end (the point of the "password masked" assertion).
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        notificationOutput: {
          listTargets: { query: mockListTargets },
          listTargetKinds: { query: mockListKinds },
          getTarget: { query: mockGetTarget },
          setTargetEnabled: { mutate: mockSetEnabled },
          deleteTarget: { mutate: mockDelete },
          upsertTarget: { mutate: mockUpsert },
          discoverTargets: { query: vi.fn().mockResolvedValue([]) },
          probeTargetConfig: { mutate: vi.fn().mockResolvedValue({ ok: true, resolvedUrl: '' }) },
          testTarget: { mutate: vi.fn().mockResolvedValue({ success: true }) },
        },
        userManagement: {
          listUsers: { query: vi.fn().mockResolvedValue([]) },
        },
      },
    }),
    ErrorBox: ({ title, message, onRetry }: ErrorBoxProps) => (
      <div data-testid="error-box">
        <span>{title}</span>
        <span>{message}</span>
        {onRetry && (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    ),
  }
})

import { NotificationTargetsPage } from '../NotificationTargets'

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <NotificationTargetsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const NTFY_SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'ntfy',
      title: 'ntfy',
      fields: [
        { type: 'text', key: 'serverUrl', label: 'Server URL' },
        { type: 'password', key: 'token', label: 'Access token' },
      ],
    },
  ],
}

function ntfyKind(addonId = 'notifiers'): TargetKind {
  return {
    kind: 'ntfy',
    label: 'ntfy',
    icon: '📮',
    addonId,
    configSchema: NTFY_SCHEMA,
    supportsDiscovery: false,
    caps: {
      attachments: { mediaTypes: ['image'], mode: 'both', max: 1 },
      actions: 3,
      levels: [{ id: 'default', label: 'Default', ordinal: 3 }],
      format: ['text', 'markdown'],
      clickUrl: true,
      sound: false,
      ttl: false,
      bodyMaxLen: 4096,
    },
  }
}

function haKind(): TargetKind {
  return {
    ...ntfyKind('homeassistant'),
    kind: 'homeassistant',
    label: 'Home Assistant',
    icon: '🏠',
  }
}

function ntfyTarget(): Target {
  return {
    id: 't1',
    name: 'Alerts',
    kind: 'ntfy',
    addonId: 'notifiers',
    enabled: true,
    // List rows are redacted; getTarget hydrates LIVE_TOKEN into the form.
    config: { serverUrl: 'https://ntfy.sh', token: '__redacted__' },
  }
}

describe('NotificationTargets page', () => {
  beforeEach(() => {
    mockTargets = []
    mockKinds = []
    mockSetEnabled.mockClear()
    mockDelete.mockClear()
    mockUpsert.mockClear()
    mockListTargets.mockClear()
    mockListKinds.mockClear()
    mockGetTarget.mockReset()
    mockGetTarget.mockImplementation(getTargetLive)
    // useItemFormUrl / useUrlQueryParam write window.location — clear so a
    // prior edit (?target=t1) cannot reopen Edit under Duplicate.
    window.history.replaceState(null, '', '/')
    // jsdom does not implement <dialog>.showModal()/close().
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
        this.open = true
      }
    }
    if (!HTMLDialogElement.prototype.close) {
      HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
        this.open = false
      }
    }
  })

  it('shows the empty state when there are no targets', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/No notification targets yet/i)).toBeTruthy())
  })

  it('renders the kind catalog grouped by addon when adding', async () => {
    mockKinds = [ntfyKind(), haKind()]
    renderPage()

    await waitFor(() => expect(screen.getByText('Add target')).toBeTruthy())
    fireEvent.click(screen.getByText('Add target'))

    await waitFor(() => expect(screen.getByText('Choose a notification kind')).toBeTruthy())
    // Both addon groups present as headers, both kinds rendered.
    expect(screen.getByText('notifiers')).toBeTruthy()
    expect(screen.getByText('homeassistant')).toBeTruthy()
    expect(screen.getByText('ntfy')).toBeTruthy()
    expect(screen.getByText('Home Assistant')).toBeTruthy()
  })

  it('masks password fields in the config form', async () => {
    mockKinds = [ntfyKind()]
    renderPage()

    await waitFor(() => expect(screen.getByText('Add target')).toBeTruthy())
    fireEvent.click(screen.getByText('Add target'))
    await waitFor(() => expect(screen.getByText('ntfy')).toBeTruthy())
    // Enter the form for the ntfy kind.
    fireEvent.click(screen.getByText('ntfy'))

    await waitFor(() => expect(screen.getByText('Access token')).toBeTruthy())
    const tokenInput = screen.getByText('Access token').closest('div')?.querySelector('input')
    expect(tokenInput?.getAttribute('type')).toBe('password')
  })

  it('threads addonId through the enable toggle and delete mutations', async () => {
    mockTargets = [ntfyTarget()]
    mockKinds = [ntfyKind()]
    renderPage()

    await waitFor(() => expect(screen.getByText('Alerts')).toBeTruthy())

    // Toggle enabled → setTargetEnabled with addonId + targetId.
    fireEvent.click(screen.getByLabelText('toggle Alerts'))
    await waitFor(() =>
      expect(mockSetEnabled).toHaveBeenCalledWith({
        addonId: 'notifiers',
        targetId: 't1',
        enabled: false,
      }),
    )

    // Delete → deleteTarget with addonId + targetId.
    fireEvent.click(screen.getByTitle('Delete'))
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith({ addonId: 'notifiers', targetId: 't1' }),
    )
  })

  it('threads addonId through upsert and round-trips the live secret from getTarget', async () => {
    mockTargets = [ntfyTarget()]
    mockKinds = [ntfyKind()]
    renderPage()

    await waitFor(() => expect(screen.getByText('Alerts')).toBeTruthy())
    fireEvent.click(screen.getByText('Alerts'))

    await waitFor(() => expect(mockGetTarget).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('Save changes')).toBeTruthy())
    // Wait until hydration finished (spinner off / button enabled).
    await waitFor(() => {
      const btn = screen.getByText('Save changes').closest('button')
      expect(btn?.disabled).toBe(false)
    })
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(mockUpsert).toHaveBeenCalledTimes(1))
    const arg = mockUpsert.mock.calls[0]![0] as { addonId: string; target: Target }
    expect(arg.addonId).toBe('notifiers')
    expect(arg.target.addonId).toBe('notifiers')
    expect(arg.target.id).toBe('t1')
    // Live secret from getTarget is sent so destination edits do not need re-type.
    expect(arg.target.config.token).toBe(LIVE_TOKEN)
    expect(arg.target.config.serverUrl).toBe('https://ntfy.sh')
  })

  /** The label of a config field, asterisk included when it is required. */
  function labelOf(text: string): string {
    return screen.getByText(text).closest('label')?.textContent ?? ''
  }

  it('after getTarget hydration, a destination edit does not demand re-typing the secret', async () => {
    mockTargets = [ntfyTarget()]
    mockKinds = [ntfyKind()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Alerts')).toBeTruthy())
    fireEvent.click(screen.getByText('Alerts'))
    await waitFor(() => {
      const btn = screen.getByText('Save changes').closest('button')
      expect(btn?.disabled).toBe(false)
    })
    expect(labelOf('Access token')).not.toContain('*')

    const url = screen.getByText('Server URL').closest('div')?.querySelector('input')
    expect(url).toBeTruthy()
    if (url) fireEvent.change(url, { target: { value: 'https://elsewhere.example' } })

    // Live token is already in the form and will be sent — no D634 re-enter.
    expect(labelOf('Access token')).not.toContain('*')
    expect(screen.queryByTestId('target-secret-reenter')).toBeNull()
  })

  it('marks a masked secret required once a destination field is edited (ADR 0634, no live hydrate)', async () => {
    // Persist for Strict Mode double-mount — Once would fall back to live on the 2nd call.
    mockGetTarget.mockImplementation(getTargetRedacted)
    mockTargets = [ntfyTarget()]
    mockKinds = [ntfyKind()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Alerts')).toBeTruthy())
    fireEvent.click(screen.getByText('Alerts'))
    await waitFor(() => {
      const btn = screen.getByText('Save changes').closest('button')
      expect(btn?.disabled).toBe(false)
    })
    expect(labelOf('Access token')).not.toContain('*')
    expect(screen.queryByTestId('target-secret-reenter')).toBeNull()

    const url = screen.getByText('Server URL').closest('div')?.querySelector('input')
    expect(url).toBeTruthy()
    if (url) fireEvent.change(url, { target: { value: 'https://elsewhere.example' } })

    await waitFor(() => expect(labelOf('Access token')).toContain('*'))
  })

  it("shows the hub's secret refusal next to the fields, verbatim, not as a generic error", async () => {
    const refusal =
      "Refusing to reuse the stored secret (token) of target 't1': its destination changed " +
      '(serverUrl). Re-enter the secret when changing where this target sends.'
    mockUpsert.mockImplementationOnce(() => Promise.reject(new Error(refusal)))
    mockGetTarget.mockImplementation(getTargetRedacted)
    mockTargets = [ntfyTarget()]
    mockKinds = [ntfyKind()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Alerts')).toBeTruthy())
    fireEvent.click(screen.getByText('Alerts'))
    await waitFor(() => {
      const btn = screen.getByText('Save changes').closest('button')
      expect(btn?.disabled).toBe(false)
    })
    fireEvent.click(screen.getByText('Save changes'))

    const box = await screen.findByTestId('target-secret-refusal')
    expect(box.textContent).toContain(refusal)
    expect(box.textContent).toContain('Access token')
    expect(screen.queryByTestId('target-form-error')).toBeNull()
    // After a refusal the untouched secret is required, destination edit or not.
    expect(labelOf('Access token')).toContain('*')
  })

  it('any other save failure stays the generic error', async () => {
    mockUpsert.mockImplementationOnce(() => Promise.reject(new Error('provider offline')))
    mockTargets = [ntfyTarget()]
    mockKinds = [ntfyKind()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Alerts')).toBeTruthy())
    fireEvent.click(screen.getByText('Alerts'))
    await waitFor(() => expect(screen.getByText('Save changes')).toBeTruthy())
    fireEvent.click(screen.getByText('Save changes'))
    const box = await screen.findByTestId('target-form-error')
    expect(box.textContent).toContain('provider offline')
    expect(screen.queryByTestId('target-secret-refusal')).toBeNull()
  })

  it('Duplicate hydrates the live secret via getTarget and sends it on create', async () => {
    mockTargets = [ntfyTarget()]
    mockKinds = [ntfyKind()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Alerts')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Duplicate'))

    const dialog = await screen.findByTestId('target-form-dialog')
    expect(within(dialog).getByText('Duplicate Alerts')).toBeTruthy()
    await waitFor(() => expect(within(dialog).getByDisplayValue('Alerts Copy')).toBeTruthy())
    await waitFor(() =>
      expect(mockGetTarget).toHaveBeenCalledWith({
        addonId: 'notifiers',
        targetId: 't1',
      }),
    )
    await waitFor(() => {
      const btn = screen.getByText('Create target').closest('button')
      expect(btn?.disabled).toBe(false)
    })

    fireEvent.click(screen.getByText('Create target'))
    await waitFor(() => expect(mockUpsert).toHaveBeenCalledTimes(1))
    const arg = mockUpsert.mock.calls[0]![0] as {
      addonId: string
      target: Target
      cloneSecretsFrom?: string
    }
    expect(arg.cloneSecretsFrom).toBe('t1')
    expect(arg.target.id).not.toBe('t1')
    expect(arg.target.name).toBe('Alerts Copy')
    expect(arg.target.config.serverUrl).toBe('https://ntfy.sh')
    expect(arg.target.config.token).toBe(LIVE_TOKEN)
  })
})
