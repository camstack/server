// @vitest-environment jsdom
//
// Phase 2 — the table row renders ONE merged `previewActions` cell that
// composes the PASSIVE preview (battery/snapshot eye + status dot, always
// shown) with the INTERACTIVE cluster (live per-type control + quick-actions
// + renderRowAction, gated on online/enabled). The merge collapses the former
// separate Preview <td> and Actions <td> into a single trailing cell, so a
// device row now carries one fewer column than before.
import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeAll } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceItem } from '../index'
import type { DeviceItemDevice } from '../helpers'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'

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
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function renderRow(device: DeviceItemDevice, extra?: ReactNode): HTMLElement {
  const { container } = render(
    <Wrapper>
      <table>
        <tbody>
          <DeviceItem
            trpc={mockTrpc}
            device={device}
            view="table"
            showManufacturerCell={false}
            renderRowAction={extra === undefined ? undefined : () => extra}
          />
        </tbody>
      </table>
    </Wrapper>,
  )
  return container
}

const onlineCamera: DeviceItemDevice = {
  id: 7,
  stableId: 'provider-test-cam-7',
  addonId: 'provider-test',
  type: 'camera',
  name: 'Front cam',
  online: true,
  disabled: false,
  parentDeviceId: null,
  features: ['native-snapshot'],
}

describe('merged previewActions table cell', () => {
  it('online camera: 4 cells (name|type|features|previewActions), one fewer than the legacy 5', () => {
    renderRow(onlineCamera)
    const row = screen.getByText('Front cam').closest('tr')
    expect(row).not.toBeNull()
    expect(row?.querySelectorAll('td').length).toBe(4)
  })

  it('th count == td count per parent row (merged column alignment)', () => {
    const { container } = render(
      <Wrapper>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Features</th>
              <th>Preview</th>
            </tr>
          </thead>
          <tbody>
            <DeviceItem
              trpc={mockTrpc}
              device={onlineCamera}
              view="table"
              showManufacturerCell={false}
            />
          </tbody>
        </table>
      </Wrapper>,
    )
    const thCount = container.querySelectorAll('thead th').length
    const row = container.querySelector('tbody tr')
    const tdCount = row?.querySelectorAll('td').length ?? 0
    expect(tdCount).toBe(4)
    expect(tdCount).toBe(thCount)
  })

  it('merged cell renders the passive preview (snapshot thumbnail) and the status dot for an online camera', () => {
    const container = renderRow(onlineCamera)
    const lastCell = container.querySelector('tbody tr td:last-child')
    expect(lastCell).not.toBeNull()
    // Snapshot thumbnail (passive preview) — labelled button (device name).
    expect(lastCell?.querySelector('button[aria-label="Front cam"]')).not.toBeNull()
    // Status dot — the success-colored pill.
    expect(lastCell?.querySelector('span.bg-success')).not.toBeNull()
  })

  it('OFFLINE (online=false, still enabled): passive preview + dot still render in the merged cell', () => {
    const offlineCamera: DeviceItemDevice = { ...onlineCamera, online: false }
    const container = renderRow(offlineCamera)
    const lastCell = container.querySelector('tbody tr td:last-child')
    expect(lastCell).not.toBeNull()
    // Passive snapshot thumbnail still present even though the device is offline.
    expect(lastCell?.querySelector('button[aria-label="Front cam"]')).not.toBeNull()
    // The dot renders the OFFLINE (grey) color, not removed.
    expect(lastCell?.querySelector('span.bg-foreground-subtle')).not.toBeNull()
  })

  it('DISABLED: passive preview battery context + dot still render; interactive cluster suppressed', () => {
    // A disabled device suppresses the interactive cluster (DeviceItemActions
    // returns null) but the passive snapshot eye + the disabled status dot must
    // remain visible in the merged cell.
    const disabledCamera: DeviceItemDevice = { ...onlineCamera, disabled: true }
    const container = renderRow(disabledCamera)
    const lastCell = container.querySelector('tbody tr td:last-child')
    expect(lastCell).not.toBeNull()
    // Disabled status dot (black) is still rendered.
    expect(lastCell?.querySelector('span.bg-black')).not.toBeNull()
  })

  it('renders renderRowAction inside the merged cell', () => {
    const container = renderRow(onlineCamera, <button type="button">RowAct</button>)
    const lastCell = container.querySelector('tbody tr td:last-child')
    expect(lastCell?.textContent).toContain('RowAct')
  })
})
