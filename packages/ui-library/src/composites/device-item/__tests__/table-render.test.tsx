// @vitest-environment jsdom
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

const baseDevice: DeviceItemDevice = {
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

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('DeviceItem view=table', () => {
  it('renders inside <tbody> with the expected td count + name text', () => {
    render(
      <Wrapper>
        <table>
          <tbody>
            <DeviceItem trpc={mockTrpc} device={baseDevice} view="table" />
          </tbody>
        </table>
      </Wrapper>,
    )
    expect(screen.getByText('Test camera')).toBeDefined()

    // 5 logical columns (Phase 2 merged Preview + Actions; Hardware added):
    //   name | type | manufacturer | features | previewActions.
    const row = screen.getByText('Test camera').closest('tr')
    expect(row).not.toBeNull()
    expect(row?.querySelectorAll('td').length).toBe(5)

    // Type cell renders the raw `device.type` token.
    expect(screen.getByText('camera')).toBeDefined()
  })

  it('renders manufacturer · model in the hardware cell + the empty state when absent', () => {
    const withHw: DeviceItemDevice = {
      ...baseDevice,
      metadata: { manufacturer: 'Dreame', model: 'X40 Ultra', firmware: 'v1.2' },
    }
    const { rerender } = render(
      <Wrapper>
        <table>
          <tbody>
            <DeviceItem trpc={mockTrpc} device={withHw} view="table" />
          </tbody>
        </table>
      </Wrapper>,
    )
    expect(screen.getByText('Dreame · X40 Ultra')).toBeDefined()

    // No metadata → em-dash empty state in the hardware cell.
    rerender(
      <Wrapper>
        <table>
          <tbody>
            <DeviceItem trpc={mockTrpc} device={baseDevice} view="table" />
          </tbody>
        </table>
      </Wrapper>,
    )
    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThan(0)
  })

  it('omits the hardware cell when showManufacturerCell is false', () => {
    render(
      <Wrapper>
        <table>
          <tbody>
            <DeviceItem
              trpc={mockTrpc}
              device={baseDevice}
              view="table"
              showManufacturerCell={false}
            />
          </tbody>
        </table>
      </Wrapper>,
    )
    const row = screen.getByText('Test camera').closest('tr')
    expect(row?.querySelectorAll('td').length).toBe(4)
  })

  it('a childless (leaf) row reserves the chevron slot AND keeps the separator border', () => {
    // Regression: a simple device must align with container rows that own a
    // chevron — the leading slot is reserved as an empty placeholder — while
    // still carrying the subtle leaf separator (border keyed on hasChildren,
    // not the accordion-column flag).
    render(
      <Wrapper>
        <table>
          <tbody>
            <DeviceItem trpc={mockTrpc} device={baseDevice} view="table" showChildrenAccordion />
          </tbody>
        </table>
      </Wrapper>,
    )
    const slot = screen.getByTestId('chevron-slot')
    expect(slot.tagName).not.toBe('BUTTON') // empty placeholder, not an interactive chevron
    const row = screen.getByText('Test camera').closest('tr')
    expect(row?.className).toContain('border-b')
  })

  it('a parent (has children) row shows the interactive chevron and drops the separator', () => {
    const childDevice: DeviceItemDevice = {
      ...baseDevice,
      id: 43,
      stableId: 'provider-test-child-1',
      name: 'Child entity',
      parentDeviceId: 42,
    }
    render(
      <Wrapper>
        <table>
          <tbody>
            <DeviceItem
              trpc={mockTrpc}
              device={{ ...baseDevice, name: 'Container row' }}
              view="table"
              showChildrenAccordion
              children={[childDevice]}
            />
          </tbody>
        </table>
      </Wrapper>,
    )
    const slot = screen.getByTestId('chevron-slot')
    expect(slot.tagName).toBe('BUTTON') // expandable → interactive chevron
    const row = screen.getByText('Container row').closest('tr')
    expect(row?.className).not.toContain('border-b')
  })

  it('renders the lead icon for the device type', () => {
    const { container } = render(
      <Wrapper>
        <table>
          <tbody>
            <DeviceItem trpc={mockTrpc} device={baseDevice} view="table" />
          </tbody>
        </table>
      </Wrapper>,
    )
    // Lucide icons render <svg> elements; at least one should appear
    // inside the row (the lead icon).
    const row = container.querySelector('tr')
    expect(row?.querySelector('svg')).not.toBeNull()
  })
})
