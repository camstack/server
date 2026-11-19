// @vitest-environment jsdom
/**
 * A row click (and Enter) opens the host's quick-detail modal when a
 * `DeviceQuickDetailProvider` is mounted; without one it navigates; batch
 * selection still wins over both.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DeviceQuickDetailProvider } from '../../../contexts/device-quick-detail'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import type { DeviceItemDevice } from '../helpers'
import { DeviceItem } from '../index'

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

const device: DeviceItemDevice = {
  id: 42,
  stableId: 'provider-test-cam-9527',
  addonId: 'provider-test',
  type: 'camera',
  name: 'Test camera',
  online: true,
  disabled: false,
  parentDeviceId: null,
  features: ['native-snapshot'],
}

interface Setup {
  readonly open?: (id: number) => void
  readonly onNavigate: (id: number) => void
  readonly selection?: { readonly selected: boolean; readonly onToggle: () => void }
  readonly rowClickSelects?: boolean
}

function renderRow(setup: Setup): HTMLTableRowElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const item = (
    <table>
      <tbody>
        <DeviceItem
          trpc={mockTrpc}
          device={device}
          view="table"
          onNavigate={setup.onNavigate}
          selection={setup.selection}
          rowClickSelects={setup.rowClickSelects}
        />
      </tbody>
    </table>
  )
  const body: ReactNode =
    setup.open !== undefined ? (
      <DeviceQuickDetailProvider open={setup.open}>{item}</DeviceQuickDetailProvider>
    ) : (
      item
    )
  const { container } = render(<QueryClientProvider client={client}>{body}</QueryClientProvider>)
  const row = container.querySelector('tr')
  if (row === null) throw new Error('row missing')
  return row
}

describe('DeviceItem row click and quick detail', () => {
  it('with a provider, click and Enter open the modal and do not navigate', () => {
    const open = vi.fn()
    const onNavigate = vi.fn()
    const row = renderRow({ open, onNavigate })
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledWith(42)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('without a provider, a click navigates (the row is not a keyboard target)', () => {
    const onNavigate = vi.fn()
    const row = renderRow({ onNavigate })
    fireEvent.click(row)
    expect(row.getAttribute('tabindex')).toBeNull()
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(42)
  })

  it('with rowClickSelects and a selection, click and Enter toggle, not open or navigate', () => {
    const open = vi.fn()
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const row = renderRow({
      open,
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: true,
    })
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledTimes(2)
    expect(open).not.toHaveBeenCalled()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('the row button opens the device page and does not open the modal', () => {
    const open = vi.fn()
    const onNavigate = vi.fn()
    const row = renderRow({ open, onNavigate })
    const button = row.querySelector('[data-testid="device-row-open-page"]')
    if (button === null) throw new Error('open-page button missing')
    fireEvent.click(button)
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(42)
    expect(open).not.toHaveBeenCalled()
  })

  it('draws no open-page button when the caller wired no navigation', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={client}>
        <table>
          <tbody>
            <DeviceItem trpc={mockTrpc} device={device} view="table" />
          </tbody>
        </table>
      </QueryClientProvider>,
    )
    expect(container.querySelector('[data-testid="device-row-open-page"]')).toBeNull()
  })
})
