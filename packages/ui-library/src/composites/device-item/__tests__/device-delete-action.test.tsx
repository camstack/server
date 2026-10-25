// @vitest-environment jsdom
//
// Built-in confirmed per-row delete (table feature). The unified table
// owns delete: when a consumer passes `onDelete` to <DeviceItem>, the merged
// previewActions cell renders a red trash button that confirms BEFORE calling
// `onDelete`. Without `onDelete`, no trash renders. Delete is destructive, so
// it MUST ask first — the confirm lives in ui-library (DeviceDeleteAction +
// useConfirm), not re-wired per consumer page.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceItem } from '../index'
import type { DeviceItemDevice } from '../helpers'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import { ConfirmDialogProvider } from '../../confirm-dialog'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

const mockTrpc = {
  deviceManager: {
    getBindings: { query: async () => ({ deviceId: 0, entries: [] }) },
  },
} as unknown as UseDeviceProxyTrpc

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  })
  return (
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
    </QueryClientProvider>
  )
}

function renderRow(
  device: DeviceItemDevice,
  onDelete?: (device: DeviceItemDevice) => void,
): HTMLElement {
  const { container } = render(
    <Wrapper>
      <table>
        <tbody>
          <DeviceItem trpc={mockTrpc} device={device} view="table" onDelete={onDelete} />
        </tbody>
      </table>
    </Wrapper>,
  )
  return container
}

const device: DeviceItemDevice = {
  id: 42,
  stableId: 'provider-test-cam-42',
  addonId: 'provider-test',
  type: 'camera',
  name: 'Front cam',
  online: true,
  disabled: false,
  parentDeviceId: null,
  features: ['native-snapshot'],
}

function trashButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Delete device"]')
}

describe('DeviceItem built-in delete (table)', () => {
  it('renders no trash when onDelete is omitted', () => {
    const container = renderRow(device)
    expect(trashButton(container)).toBeNull()
  })

  it('renders the trash button inside the merged previewActions cell when onDelete is provided', () => {
    const container = renderRow(device, vi.fn())
    const btn = trashButton(container)
    expect(btn).not.toBeNull()
    const lastCell = container.querySelector('tbody tr td:last-child')
    expect(lastCell?.contains(btn)).toBe(true)
  })

  it('clicking the trash opens the confirm and does NOT call onDelete until confirmed', async () => {
    const onDelete = vi.fn()
    const container = renderRow(device, onDelete)
    fireEvent.click(trashButton(container)!)
    // Confirm dialog visible.
    await screen.findByText('Delete device?')
    // Not yet deleted.
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('confirming calls onDelete with the device', async () => {
    const onDelete = vi.fn()
    const container = renderRow(device, onDelete)
    fireEvent.click(trashButton(container)!)
    await screen.findByText('Delete device?')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1))
    expect(onDelete).toHaveBeenCalledWith(device)
  })

  it('cancelling does not call onDelete', async () => {
    const onDelete = vi.fn()
    const container = renderRow(device, onDelete)
    fireEvent.click(trashButton(container)!)
    await screen.findByText('Delete device?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Delete device?')).toBeNull())
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('clicking the trash does not navigate the row (stopPropagation)', async () => {
    const onNavigate = vi.fn()
    const onDelete = vi.fn()
    const { container } = render(
      <Wrapper>
        <table>
          <tbody>
            <DeviceItem
              trpc={mockTrpc}
              device={device}
              view="table"
              onDelete={onDelete}
              onNavigate={onNavigate}
            />
          </tbody>
        </table>
      </Wrapper>,
    )
    fireEvent.click(trashButton(container)!)
    await screen.findByText('Delete device?')
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('confirm message names the device', async () => {
    const container = renderRow(device, vi.fn())
    fireEvent.click(trashButton(container)!)
    await screen.findByText('Delete device?')
    expect(screen.getByText(/will remove "Front cam"/)).not.toBeNull()
  })
})
