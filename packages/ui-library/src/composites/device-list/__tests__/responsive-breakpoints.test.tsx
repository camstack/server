// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceList } from '../index'
import { COLUMN_BREAKPOINT_CLASS } from '../columns'
import type { DeviceItemDevice } from '../../device-item/helpers'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'

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

function withQuery(node: ReactNode): ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

function ths(container: HTMLElement): HTMLTableCellElement[] {
  return [...container.querySelectorAll<HTMLTableCellElement>('thead th')]
}

describe('priority-derived responsive breakpoints — th/td single source', () => {
  it('Type header carries the derived type breakpoint (hidden lg:table-cell)', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const type = ths(container).find((th) => th.textContent?.trim() === 'Type')
    expect(type?.className).toContain(COLUMN_BREAKPOINT_CLASS.type)
    expect(type?.className).toContain('hidden')
    expect(type?.className).toContain('lg:table-cell')
  })

  it('Features header carries the derived features breakpoint (hidden md:table-cell)', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const features = ths(container).find((th) => th.textContent?.trim() === 'Features')
    expect(features?.className).toContain(COLUMN_BREAKPOINT_CLASS.features)
    expect(features?.className).toContain('hidden')
    expect(features?.className).toContain('md:table-cell')
  })

  it('Type td carries the SAME breakpoint class as the Type th', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    // Type cell renders the raw `device.type` text ("camera").
    const typeTd = [...container.querySelectorAll<HTMLTableCellElement>('tbody td')].find(
      (td) => td.textContent?.trim() === 'camera',
    )
    expect(typeTd?.className).toContain(COLUMN_BREAKPOINT_CLASS.type)
  })

  it('Features td carries the SAME breakpoint class as the Features th', () => {
    const { container } = render(
      withQuery(
        <DeviceList devices={[dev(1, { features: ['native-snapshot'] })]} trpc={mockTrpc} />,
      ),
    )
    // The Features cell is the only td that carries the features breakpoint.
    const featuresTd = [...container.querySelectorAll<HTMLTableCellElement>('tbody td')].find(
      (td) => td.className.includes(COLUMN_BREAKPOINT_CLASS.features),
    )
    expect(featuresTd).toBeDefined()
    expect(featuresTd?.className).toContain('md:table-cell')
  })

  it('NAME + previewActions headers carry NO hide class (always visible)', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const name = ths(container).find((th) => th.textContent?.trim() === 'Name')
    const preview = ths(container).find((th) => th.textContent?.trim() === 'Preview')
    expect(name?.className).not.toContain('hidden')
    expect(preview?.className).not.toContain('hidden')
  })

  it('type drops at a WIDER width than features (type hides first)', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const type = ths(container).find((th) => th.textContent?.trim() === 'Type')
    const features = ths(container).find((th) => th.textContent?.trim() === 'Features')
    // `lg` > `md`: type only appears from lg up, so it disappears first as the
    // viewport narrows — matching the COLUMN_PRIORITY intent.
    expect(type?.className).toContain('lg:table-cell')
    expect(features?.className).toContain('md:table-cell')
  })
})
