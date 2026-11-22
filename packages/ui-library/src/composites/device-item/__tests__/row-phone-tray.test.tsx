// @vitest-environment jsdom
//
// A device row below `md`: its name, its main control and its status dot.
// Everything else it offers (open, delete, the list's own row action) is in
// the swipe tray, which is mounted ONLY there — so no action exists twice on
// the row at any width, and a wide row is unchanged.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import { ConfirmDialogProvider } from '../../confirm-dialog'
import type { DeviceItemDevice } from '../helpers'
import { DeviceItem } from '../index'

/** Drives `useIsMobile` (`max-width: 767px`). */
function setViewport(phone: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: phone && query.includes('max-width: 767px'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

const mockTrpc = {
  deviceManager: { getBindings: { query: async () => ({ deviceId: 0, entries: [] }) } },
} as unknown as UseDeviceProxyTrpc

const device: DeviceItemDevice = {
  id: 42,
  stableId: 'provider-test-cam-42',
  addonId: 'provider-test',
  type: 'camera',
  name: 'Front cam',
  online: true,
  disabled: false,
  parentDeviceId: null,
  role: null,
}

interface RowOptions {
  readonly onDelete?: (device: DeviceItemDevice) => void
  readonly onNavigate?: (id: number) => void
  readonly renderRowAction?: (device: DeviceItemDevice) => ReactNode
  readonly confirmProvider?: boolean
}

function renderRow(options: RowOptions = {}): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  })
  const row = (
    <table>
      <tbody>
        <DeviceItem
          trpc={mockTrpc}
          device={device}
          view="table"
          onDelete={options.onDelete}
          onNavigate={options.onNavigate}
          renderRowAction={options.renderRowAction}
        />
      </tbody>
    </table>
  )
  return render(
    <QueryClientProvider client={client}>
      {options.confirmProvider === false ? (
        row
      ) : (
        <ConfirmDialogProvider>{row}</ConfirmDialogProvider>
      )}
    </QueryClientProvider>,
  ).container
}

function tray(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-swipe-tray]')
}

describe('device row below `md` — the swipe tray', () => {
  it('moves open and delete off the row and into the tray', () => {
    setViewport(true)
    const container = renderRow({ onDelete: vi.fn(), onNavigate: vi.fn() })
    const actions = tray(container)
    expect(actions).not.toBeNull()
    const names = within(actions as HTMLElement)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(names).toEqual(['Open', 'Delete'])
    // Each exists once on the row: the tray's.
    expect(container.querySelector('button[aria-label="Delete device"]')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
  })

  it("leads the tray with the list's own row action", () => {
    setViewport(true)
    const container = renderRow({
      onDelete: vi.fn(),
      onNavigate: vi.fn(),
      renderRowAction: () => <button type="button">Adopt</button>,
    })
    const names = within(tray(container) as HTMLElement)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(names).toEqual(['Adopt', 'Open', 'Delete'])
    expect(screen.getAllByRole('button', { name: 'Adopt' })).toHaveLength(1)
  })

  it('names the tray after the device', () => {
    setViewport(true)
    renderRow({ onNavigate: vi.fn() })
    expect(screen.getByRole('group', { name: 'Actions for Front cam' })).not.toBeNull()
  })

  it('opens the device page from the tray', () => {
    setViewport(true)
    const onNavigate = vi.fn()
    renderRow({ onNavigate })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onNavigate).toHaveBeenCalledWith(42)
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('asks before deleting, as the inline button does', async () => {
    setViewport(true)
    const onDelete = vi.fn()
    const container = renderRow({ onDelete })
    fireEvent.click(within(tray(container) as HTMLElement).getByRole('button', { name: 'Delete' }))
    await screen.findByText('Delete device?')
    expect(onDelete).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(device))
  })

  it('needs no confirm provider on a list that deletes nothing', () => {
    setViewport(true)
    const container = renderRow({ onNavigate: vi.fn(), confirmProvider: false })
    expect(tray(container)).not.toBeNull()
  })

  it('keeps the status dot on the row', () => {
    setViewport(true)
    const container = renderRow({ onDelete: vi.fn(), onNavigate: vi.fn() })
    const dot = container.querySelector('[data-status="online"]')
    expect(dot).not.toBeNull()
    expect(tray(container)?.contains(dot)).toBe(false)
  })
})

describe('device row from `md` up — unchanged', () => {
  it('keeps its inline buttons and mounts no tray', () => {
    setViewport(false)
    const container = renderRow({
      onDelete: vi.fn(),
      onNavigate: vi.fn(),
      renderRowAction: () => <button type="button">Adopt</button>,
    })
    expect(tray(container)).toBeNull()
    expect(container.querySelector('button[aria-label="Delete device"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Adopt' })).not.toBeNull()
  })
})
