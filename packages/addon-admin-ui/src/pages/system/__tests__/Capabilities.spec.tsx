/**
 * Integration tests for the System → Capabilities (Bindings) page.
 *
 * Covers: singleton provider selection (setActiveSingleton), collection
 * enable/disable (setCollectionEnabledProviders sends the FULL desired set),
 * per-node caps filtered out, and loading/error states.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { CapabilityInfo } from '@camstack/types'

// ---------------------------------------------------------------------------
// Mock the live tRPC client behind `useSystem()`
// ---------------------------------------------------------------------------

interface SetActiveSingletonInput {
  readonly capability: string
  readonly addonId: string
}
interface SetCollectionInput {
  readonly capability: string
  readonly enabledAddonIds: readonly string[]
}

let mockCapabilities: CapabilityInfo[] = []
let mockListError: Error | null = null
const mockSetActiveSingleton = vi.fn(
  (_input: SetActiveSingletonInput): Promise<void> => Promise.resolve(),
)
const mockSetCollectionEnabled = vi.fn(
  (_input: SetCollectionInput): Promise<void> => Promise.resolve(),
)
const mockListCapabilities = vi.fn(
  (): Promise<readonly CapabilityInfo[]> =>
    mockListError ? Promise.reject(mockListError) : Promise.resolve(mockCapabilities),
)

interface ErrorBoxProps {
  readonly title?: string
  readonly message: ReactNode
  readonly onRetry?: () => void
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useSystem: () => ({
      trpcClient: {
        capabilities: {
          listCapabilities: { query: mockListCapabilities },
          setActiveSingleton: { mutate: mockSetActiveSingleton },
          setCollectionEnabledProviders: { mutate: mockSetCollectionEnabled },
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
  }
})

// ---------------------------------------------------------------------------
// Import page AFTER mocks
// ---------------------------------------------------------------------------

import { CapabilitiesPage } from '../Capabilities'

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <CapabilitiesPage />
    </QueryClientProvider>,
  )
}

function singleton(name: string, providers: string[], active: string | null): CapabilityInfo {
  return { name, mode: 'singleton', providers, activeProvider: active, disabledProviders: [] }
}

function collection(name: string, providers: string[], disabled: string[]): CapabilityInfo {
  return { name, mode: 'collection', providers, activeProvider: null, disabledProviders: disabled }
}

describe('Capabilities (Bindings) page', () => {
  beforeEach(() => {
    mockCapabilities = []
    mockListError = null
    mockSetActiveSingleton.mockClear()
    mockSetCollectionEnabled.mockClear()
    mockListCapabilities.mockClear()
  })

  it('renders a singleton cap with its active provider highlighted', async () => {
    mockCapabilities = [
      singleton('webrtc-session', ['webrtc-native', 'stream-broker'], 'stream-broker'),
    ]
    renderPage()

    await waitFor(() => expect(screen.getByText('webrtc-session')).toBeTruthy())
    // Provider ids are surfaced node-qualified ("<addonId> (hub)") in the UI.
    expect(screen.getByText('webrtc-native (hub)')).toBeTruthy()
    // Exactly one ACTIVE badge for the active provider.
    expect(screen.getAllByText('ACTIVE')).toHaveLength(1)
  })

  it('selecting a different singleton provider calls setActiveSingleton', async () => {
    mockCapabilities = [
      singleton('webrtc-session', ['webrtc-native', 'stream-broker'], 'stream-broker'),
    ]
    renderPage()

    // The displayed name is node-qualified; the underlying addonId stays bare.
    await waitFor(() => expect(screen.getByText('webrtc-native (hub)')).toBeTruthy())
    const button = screen.getByText('webrtc-native (hub)').closest('button')
    expect(button).toBeTruthy()
    fireEvent.click(button!)

    await waitFor(() =>
      expect(mockSetActiveSingleton).toHaveBeenCalledWith({
        capability: 'webrtc-session',
        addonId: 'webrtc-native',
      }),
    )
  })

  it('toggling a collection provider sends the full desired enabled set', async () => {
    // detector: two registered, one already disabled → enabling it should send BOTH.
    mockCapabilities = [collection('detector', ['yolo', 'motion'], ['motion'])]
    renderPage()

    await waitFor(() => expect(screen.getByText('detector')).toBeTruthy())
    const motionCheckbox = screen
      .getAllByRole('checkbox')
      .find((el) => el.closest('label')?.textContent?.includes('motion'))
    expect(motionCheckbox).toBeTruthy()
    fireEvent.click(motionCheckbox!)

    await waitFor(() => expect(mockSetCollectionEnabled).toHaveBeenCalledTimes(1))
    const callArg = mockSetCollectionEnabled.mock.calls[0]![0]
    expect(callArg.capability).toBe('detector')
    expect([...callArg.enabledAddonIds].toSorted()).toEqual(['motion', 'yolo'])
  })

  it('filters out per-node caps (no select/toggle procedure)', async () => {
    mockCapabilities = [
      singleton('webrtc-session', ['webrtc-native'], 'webrtc-native'),
      {
        name: 'metrics-native',
        mode: 'per-node',
        providers: ['m'],
        activeProvider: null,
        disabledProviders: [],
      },
    ]
    renderPage()

    await waitFor(() => expect(screen.getByText('webrtc-session')).toBeTruthy())
    expect(screen.queryByText('metrics-native')).toBeNull()
  })

  it('shows an error box when the listing query fails', async () => {
    mockListError = new Error('registry unavailable')
    renderPage()

    await waitFor(() => expect(screen.getByTestId('error-box')).toBeTruthy())
    expect(screen.getByText('registry unavailable')).toBeTruthy()
  })
})
