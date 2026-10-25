/**
 * Script settings / devices panels — error vs empty (D315) and ownership scope.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function renderWithQc(ui: ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  )
}

const listAll = vi.fn()
const getBlockSettings = vi.fn()
const updateBlockSettings = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useDeviceManagerListAll: (...args: unknown[]) => listAll(...args),
    useCoreBlocksGet: () => ({
      data: { block: { enabled: false } },
      isLoading: false,
      isError: false,
    }),
    useCoreBlocksGetBlockSettings: (...args: unknown[]) => getBlockSettings(...args),
    useCoreBlocksUpdateBlockSettings: () => ({
      mutate: updateBlockSettings,
      isPending: false,
    }),
    useCoreBlocksRestart: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useCoreBlocksSetEnabled: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSystem: () => ({
      trpcClient: {
        coreBlocks: { updateBlockSettings: { mutate: vi.fn() } },
      },
    }),
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  }
})

const { ScriptDevicesPanel } = await import('../ScriptDevicesPanel')
const { ScriptSettingsPanel } = await import('../ScriptSettingsPanel')

describe('ScriptSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows an error when the settings query failed (not silence)', () => {
    getBlockSettings.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('hub rejected'),
      refetch: vi.fn(),
    })
    renderWithQc(<ScriptSettingsPanel blockId="b1" />)
    expect(screen.getByTestId('script-settings-error')).toHaveTextContent('hub rejected')
  })

  it('renders nothing when settings are absent (no schema yet)', () => {
    getBlockSettings.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
    const { container } = renderWithQc(<ScriptSettingsPanel blockId="b1" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ScriptDevicesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('scopes the fleet read to core-block-<id>', () => {
    listAll.mockReturnValue({ data: [], isLoading: false, isError: false })
    renderWithQc(<ScriptDevicesPanel blockId="abc" />)
    expect(listAll).toHaveBeenCalledWith(
      expect.objectContaining({ addonId: 'core-block-abc' }),
      expect.anything(),
    )
    expect(screen.getByTestId('script-devices-panel')).toHaveTextContent('No devices yet')
  })

  it('lists owned devices and links to the detail page — no export strip', () => {
    listAll.mockReturnValue({
      data: [{ id: 42, name: 'WAN alert', type: 'sensor', stableId: 'wan-alert' }],
      isLoading: false,
      isError: false,
    })
    renderWithQc(<ScriptDevicesPanel blockId="abc" />)
    const row = screen.getByTestId('script-device-42')
    expect(row).toHaveTextContent('WAN alert')
    expect(row).toHaveTextContent('wan-alert')
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/devices/42')
    // Export lives on the device detail page — not duplicated here.
    expect(screen.queryByText(/Exported to/i)).toBeNull()
    expect(screen.queryByTestId(/script-export-/)).toBeNull()
  })
})
