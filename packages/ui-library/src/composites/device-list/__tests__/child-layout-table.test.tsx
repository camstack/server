// @vitest-environment jsdom
/**
 * DevicesList table — container-row expansion renders `childLayout` sections
 * as collapsible section-header <tr>s, with ungrouped children rendered flat
 * (as today). Without `childLayout`, the expansion is byte-for-byte the
 * existing flat accessory sub-rows (no section rows).
 */

import type { ChildLayout } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import type { DeviceItemDevice } from '../../device-item/helpers'
import { DeviceList } from '../index'

beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: RO })
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      media: '',
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
  deviceManager: { getBindings: { query: async () => ({ deviceId: 0, entries: [] }) } },
} as unknown as UseDeviceProxyTrpc

const PARENT_STABLE = 's-1'

const dev = (id: number, overrides: Partial<DeviceItemDevice> = {}): DeviceItemDevice => ({
  id,
  stableId: `s-${id}`,
  addonId: 'rtsp',
  type: 'camera',
  name: `Cam ${id}`,
  online: true,
  disabled: false,
  parentDeviceId: null,
  role: null,
  ...overrides,
})

const accessory = (id: number, suffix: string, name: string): DeviceItemDevice =>
  dev(id, {
    stableId: `${PARENT_STABLE}-${suffix}`,
    name,
    role: 'numeric-sensor',
    parentDeviceId: 1,
    type: 'numeric-sensor',
  })

function withQuery(node: ReactNode): ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

function expandFirstParent(container: HTMLElement): void {
  const chevron = container.querySelector('[data-testid="chevron-slot"]')
  if (chevron) fireEvent.click(chevron)
}

describe('DevicesList table — childLayout sections', () => {
  it('without childLayout: expansion shows flat accessory sub-rows, no section header', () => {
    const devices = [
      dev(1, { stableId: PARENT_STABLE, name: 'Container' }),
      accessory(2, 'voltage', 'Voltage'),
      accessory(3, 'current', 'Current'),
    ]
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expandFirstParent(container)
    expect(screen.getByText('Voltage')).toBeDefined()
    expect(screen.getByText('Current')).toBeDefined()
    // No section header button rendered.
    expect(container.querySelector('[aria-expanded]')).not.toBeNull() // parent chevron exists
    expect(screen.queryByText('Diagnostics')).toBeNull()
  })

  it('with childLayout: listed children group into a collapsible section, unlisted stay flat', () => {
    const childLayout: ChildLayout = [
      { childKey: 'voltage', section: 'Diagnostics' },
      { childKey: 'current', section: 'Diagnostics' },
    ]
    const devices = [
      dev(1, { stableId: PARENT_STABLE, name: 'Container', childLayout }),
      accessory(2, 'voltage', 'Voltage'),
      accessory(3, 'current', 'Current'),
      accessory(4, 'plain', 'Plain'),
    ]
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expandFirstParent(container)

    // Section header present + open by default → grouped children visible.
    const sectionBtn = screen.getByText('Diagnostics').closest('button')
    expect(sectionBtn).not.toBeNull()
    expect(sectionBtn?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Voltage')).toBeDefined()
    expect(screen.getByText('Current')).toBeDefined()
    // Ungrouped child still renders flat.
    expect(screen.getByText('Plain')).toBeDefined()
  })

  it('clicking the section header collapses its children (others/ungrouped unaffected)', () => {
    const childLayout: ChildLayout = [{ childKey: 'voltage', section: 'Diagnostics' }]
    const devices = [
      dev(1, { stableId: PARENT_STABLE, name: 'Container', childLayout }),
      accessory(2, 'voltage', 'Voltage'),
      accessory(4, 'plain', 'Plain'),
    ]
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expandFirstParent(container)
    expect(screen.getByText('Voltage')).toBeDefined()

    const sectionBtn = screen.getByText('Diagnostics').closest('button')
    fireEvent.click(sectionBtn!)
    expect(sectionBtn?.getAttribute('aria-expanded')).toBe('false')
    // Grouped child hidden; ungrouped child still visible.
    expect(screen.queryByText('Voltage')).toBeNull()
    expect(screen.getByText('Plain')).toBeDefined()
  })
})

// Container children are named fully-qualified by their providers so the entity
// reads cleanly standalone; under the parent row that prefix is redundant. The
// table must strip it (aligning with the device-detail children list).
describe('DevicesList table — child parent-prefix strip', () => {
  it('strips an Ecowitt em-dash-joined parent prefix from accessory sub-rows', () => {
    const devices = [
      dev(1, { stableId: PARENT_STABLE, name: 'Ecowitt Gateway' }),
      accessory(2, 'gateway', 'Ecowitt Gateway — gateway'),
      accessory(3, 'weather', 'Ecowitt Gateway — weather-station'),
    ]
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expandFirstParent(container)
    expect(screen.getByText('gateway')).toBeDefined()
    expect(screen.getByText('weather-station')).toBeDefined()
    // The full baked-in name is never shown under the parent.
    expect(screen.queryByText('Ecowitt Gateway — gateway')).toBeNull()
    expect(screen.queryByText('Ecowitt Gateway — weather-station')).toBeNull()
  })

  it('strips a Dreame plain-space-joined parent prefix from accessory sub-rows', () => {
    const devices = [
      dev(1, { stableId: PARENT_STABLE, name: 'Robot primo piano' }),
      accessory(2, 'filter', 'Robot primo piano Filter Time Left'),
      accessory(3, 'brush', 'Robot primo piano Main Brush Time Left'),
    ]
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expandFirstParent(container)
    expect(screen.getByText('Filter Time Left')).toBeDefined()
    expect(screen.getByText('Main Brush Time Left')).toBeDefined()
    expect(screen.queryByText('Robot primo piano Filter Time Left')).toBeNull()
    expect(screen.queryByText('Robot primo piano Main Brush Time Left')).toBeNull()
  })
})
