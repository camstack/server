// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceList } from '../index'
import { NAME_COLUMN_PIN_BREAKPOINT, NAME_COLUMN_WIDTH_CLASS } from '../columns'
import { hasUnconditionalClass, hasVariantClass } from '../../../lib/tailwind-variants'
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

function nameHeader(container: HTMLElement): HTMLElement {
  const th = [...container.querySelectorAll('thead th')].find(
    (el) => el.textContent?.trim() === 'Name',
  )
  if (!(th instanceof HTMLElement)) throw new Error('NAME header not rendered')
  return th
}

function nameCell(container: HTMLElement): HTMLElement {
  const td = container.querySelector('tbody tr td')
  if (!(td instanceof HTMLElement)) throw new Error('NAME cell not rendered')
  return td
}

describe('TableLayout — internal x-scroll + the NAME pin', () => {
  it('wraps the table in an overflow-x-auto scroller', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const table = container.querySelector('table')
    const wrapper = table?.parentElement
    expect(wrapper?.className).toContain('overflow-x-auto')
  })

  it('NAME header cell pins only from the pin breakpoint up', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const cls = nameHeader(container).className
    // The defect: a pin that applies at EVERY width. On a phone the viewport
    // is narrower than this column alone, so it holds its width permanently
    // and pushes every other column off-screen.
    expect(hasUnconditionalClass(cls, 'sticky')).toBe(false)
    expect(hasUnconditionalClass(cls, 'left-0')).toBe(false)
    expect(hasVariantClass(cls, NAME_COLUMN_PIN_BREAKPOINT, 'sticky')).toBe(true)
    expect(hasVariantClass(cls, NAME_COLUMN_PIN_BREAKPOINT, 'left-0')).toBe(true)
    // Opaque bg so scrolled content slides under it cleanly once pinned.
    expect(cls).toContain('bg-surface')
  })

  it('NAME body cell pins only from the pin breakpoint up', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const cls = nameCell(container).className
    expect(hasUnconditionalClass(cls, 'sticky')).toBe(false)
    expect(hasUnconditionalClass(cls, 'left-0')).toBe(false)
    expect(hasVariantClass(cls, NAME_COLUMN_PIN_BREAKPOINT, 'sticky')).toBe(true)
    expect(hasVariantClass(cls, NAME_COLUMN_PIN_BREAKPOINT, 'left-0')).toBe(true)
    expect(cls).toContain('bg-surface')
  })

  it('header and body cell share ONE width class, so they cannot drift', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const th = nameHeader(container).className
    const td = nameCell(container).className
    for (const token of NAME_COLUMN_WIDTH_CLASS.split(' ')) {
      expect(th).toContain(token)
      expect(td).toContain(token)
    }
  })

  it('row is a `group` and the sticky NAME cell follows the row hover bg', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const row = container.querySelector('tbody tr')
    // The row is a Tailwind `group` so the sticky cell can mirror its hover.
    expect(row?.className).toContain('group')
    expect(row?.className).toContain('hover:bg-surface-hover')
    // The sticky cell shows the hover bg on row hover (no plain stripe gap)
    // while staying opaque in the default state.
    const nameTd = container.querySelector('tbody tr td')
    expect(nameTd?.className).toContain('group-hover:bg-surface-hover')
  })

  it('NAME header cell keeps an opaque bg matching the header (no group-hover)', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const nameTh = [...container.querySelectorAll('thead th')].find(
      (th) => th.textContent?.trim() === 'Name',
    )
    expect(nameTh?.className).toContain('bg-surface')
  })

  it('NAME column is width-capped from the pin breakpoint up, and NOT below it', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const nameTd = container.querySelector('tbody tr td')
    // A max-width cap stops the merged name column from claiming the whole
    // table — but only where there is room for the ellipsis to be a choice
    // rather than data loss. Below the breakpoint the column is uncapped and
    // the table scrolls; see `name-never-truncates.test.tsx`.
    expect(hasVariantClass(nameTd?.className, NAME_COLUMN_PIN_BREAKPOINT, 'max-w-[16rem]')).toBe(
      true,
    )
    expect(hasUnconditionalClass(nameTd?.className, 'max-w-[11rem]')).toBe(false)
  })
})
