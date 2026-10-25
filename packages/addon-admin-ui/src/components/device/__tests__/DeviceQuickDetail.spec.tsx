// @vitest-environment jsdom
/**
 * The quick-detail modal keeps history in its own tab, and only after
 * listSeries has answered with at least one series. Leaving for the full
 * detail page asks before dropping unsaved edits.
 */
import { ConfirmDialogProvider, useDeviceQuickDetailOpen } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { historyTabVisible, type HistoryListSnapshot } from '../history-tab'

const series = vi.hoisted(() => ({
  presence: 'pending' as 'pending' | 'present' | 'absent' | 'unknown',
  list: { status: 'pending' } as HistoryListSnapshot,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useDeviceSeriesList: () => series,
    useDeviceManagerGetDevice: () => ({
      data: { id: 7, name: 'Driveway', location: 'Hall' },
    }),
    useDeviceManagerSetName: () => ({ mutateAsync: vi.fn() }),
    useDeviceManagerSetLocation: () => ({ mutateAsync: vi.fn() }),
    useSystem: () => ({ trpcClient: {} }),
  }
})

vi.mock('../overview-adapters/DeviceInfoAdapter', async () => {
  const { useQuickDetailSave } = await import('../quick-detail-save')
  return {
    DeviceInfoAdapter: () => {
      const api = useQuickDetailSave()
      return (
        <button type="button" onClick={() => api?.setIdentityName('Renamed')}>
          edit-name
        </button>
      )
    },
  }
})

vi.mock('../tabs/DisplaySection', () => ({ DisplaySection: () => <div>display</div> }))
vi.mock('../tabs/DeviceAggregateSection', () => ({
  DeviceAggregateSection: () => <div>export</div>,
}))
vi.mock('../DeviceQuickHistory', () => ({
  DeviceQuickHistory: () => <div data-testid="history-panel">history-panel</div>,
}))

import { DeviceQuickDetailHost } from '../DeviceQuickDetail'

function Open(): ReactNode {
  const open = useDeviceQuickDetailOpen()
  return (
    <button type="button" onClick={() => open?.(7)}>
      open-quick
    </button>
  )
}

function LocationProbe(): ReactNode {
  const location = useLocation()
  return <div data-testid="loc">{location.pathname}</div>
}

function renderModal(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <MemoryRouter initialEntries={['/devices']}>
          <LocationProbe />
          <DeviceQuickDetailHost>
            <Open />
          </DeviceQuickDetailHost>
        </MemoryRouter>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

function openModal(): void {
  fireEvent.click(screen.getByRole('button', { name: 'open-quick' }))
}

describe('historyTabVisible', () => {
  it('stays hidden until the series list answers with at least one series', () => {
    expect(historyTabVisible('pending', { status: 'pending' })).toBe(false)
    expect(historyTabVisible('unknown', { status: 'pending' })).toBe(false)
    expect(historyTabVisible('absent', { status: 'pending' })).toBe(false)
    expect(historyTabVisible('present', { status: 'pending' })).toBe(false)
    expect(historyTabVisible('present', { status: 'error', error: 'down' })).toBe(false)
    expect(historyTabVisible('present', { status: 'ok', data: [] })).toBe(false)
    expect(
      historyTabVisible('present', {
        status: 'ok',
        data: [{ key: 'cap:climate.temperature' }],
      }),
    ).toBe(true)
  })
})

describe('DeviceQuickDetail modal', () => {
  it('hides the History tab until series exist, and does not describe the modal', () => {
    series.presence = 'pending'
    series.list = { status: 'pending' }
    const view = renderModal()
    openModal()
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
    expect(screen.queryByText(/same surfaces as the detail page/)).toBeNull()

    series.presence = 'present'
    series.list = { status: 'ok', data: [] }
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ConfirmDialogProvider>
          <MemoryRouter initialEntries={['/devices']}>
            <LocationProbe />
            <DeviceQuickDetailHost>
              <Open />
            </DeviceQuickDetailHost>
          </MemoryRouter>
        </ConfirmDialogProvider>
      </QueryClientProvider>,
    )
    openModal()
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
    view.unmount()

    series.presence = 'present'
    series.list = { status: 'ok', data: [{ key: 'cap:climate.temperature' }] }
    renderModal()
    openModal()
    expect(screen.queryByRole('heading', { name: 'History' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(screen.getByTestId('history-panel')).toBeTruthy()
  })

  it('opens the full detail immediately when nothing is dirty', () => {
    series.presence = 'absent'
    series.list = { status: 'pending' }
    renderModal()
    openModal()
    fireEvent.click(screen.getByRole('button', { name: 'Open full detail' }))
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull()
    expect(screen.getByTestId('loc').textContent).toBe('/devices/7')
    expect(screen.queryByRole('heading', { name: 'Driveway' })).toBeNull()
  })

  it('asks before leaving unsaved edits, and stays when the operator cancels', async () => {
    series.presence = 'absent'
    series.list = { status: 'pending' }
    renderModal()
    openModal()
    fireEvent.click(screen.getByRole('button', { name: 'edit-name' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open full detail' }))
    const title = await screen.findByText('Discard unsaved changes?')
    const dialog = title.closest('dialog')
    expect(dialog).toBeTruthy()
    if (dialog === null) return
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('loc').textContent).toBe('/devices')
    expect(screen.getByRole('heading', { name: 'Driveway' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open full detail' }))
    const again = await screen.findByText('Discard unsaved changes?')
    const confirmDialog = again.closest('dialog')
    if (confirmDialog === null) throw new Error('confirm dialog missing')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/devices/7')
    })
    expect(screen.queryByRole('heading', { name: 'Driveway' })).toBeNull()
  })
})
