// @vitest-environment jsdom
/**
 * The device table on a phone: NAME + the controls cell, no sideways scroll.
 *
 * The reported defect: the controls cell wrapped its cluster one item per line
 * and a row grew to ~200 px. Below `md` the name is now shown in full (it may
 * take a second line), the controls cell is one nowrap line and the row's
 * secondary actions sit in its swipe tray; from `md` up the name is one
 * truncated line in a fixed column.
 *
 * jsdom has no layout, so these assert the class decisions that produce it
 * (see `docs/ui/conventions.md`, "Frozen-string tests have an expiry date");
 * `ui:shots` measures the row height and the overflow at 390 px.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceList } from '../index'
import { DeviceItem } from '../../device-item'
import { NAME_COLUMN_TRUNCATE_BREAKPOINT } from '../columns'
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

const LONG_NAME = 'Camera porch front door principale lato strada'

const dev = (id: number, overrides: Partial<DeviceItemDevice> = {}): DeviceItemDevice => ({
  id,
  stableId: `s-${id}`,
  addonId: 'rtsp',
  type: 'camera',
  name: LONG_NAME,
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

function renderList(): HTMLElement {
  return render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />)).container
}

function el(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`not rendered: ${selector}`)
  return found
}

function nameHeader(container: HTMLElement): HTMLElement {
  const th = [...container.querySelectorAll('thead th')].find(
    (node) => node.textContent?.trim() === 'Name',
  )
  if (!(th instanceof HTMLElement)) throw new Error('NAME header not rendered')
  return th
}

describe('device table — the NAME column', () => {
  it('keeps the full name in the DOM and in the accessible title', () => {
    const container = renderList()
    const name = el(container, '[data-testid="device-name"]')
    // The DOM has always carried the full string; the defect was purely that
    // the operator could not READ it. Keep both the text and the title.
    expect(name.textContent).toBe(LONG_NAME)
    expect(name.getAttribute('title')).toBe(LONG_NAME)
  })

  it('the name is shown in full below the breakpoint and truncates on one line from it up', () => {
    const container = renderList()
    const cls = el(container, '[data-testid="device-name"]').className
    expect(hasUnconditionalClass(cls, 'truncate')).toBe(false)
    expect(hasVariantClass(cls, NAME_COLUMN_TRUNCATE_BREAKPOINT, 'truncate')).toBe(true)
    expect(cls).toContain('max-md:break-words')
  })

  it('the NAME column is the flexible one below the breakpoint, fixed from it up', () => {
    const container = renderList()
    for (const cls of [nameHeader(container).className, el(container, 'tbody tr td').className]) {
      expect(hasUnconditionalClass(cls, 'w-full')).toBe(true)
      expect(hasUnconditionalClass(cls, 'min-w-[6.5rem]')).toBe(true)
      expect(hasVariantClass(cls, NAME_COLUMN_TRUNCATE_BREAKPOINT, 'w-64')).toBe(true)
    }
  })

  it('the controls cell never wraps — a wrapping cluster is what blew the row up', () => {
    const container = renderList()
    const cells = [...container.querySelectorAll('tbody tr td')]
    const last = cells[cells.length - 1]
    expect(hasUnconditionalClass(last?.className, 'whitespace-nowrap')).toBe(true)
    expect(last?.className).not.toContain('whitespace-normal')
    for (const node of last?.querySelectorAll('*') ?? []) {
      expect(String(node.getAttribute('class') ?? '')).not.toContain('flex-wrap')
    }
  })

  it('ONE scroll context from the breakpoint up, and none below it', () => {
    const container = renderList()
    const wrapper = el(container, 'table').parentElement
    // Below `md` the wrapper clips (the parked swipe trays must not widen the
    // page); from `md` up it is the one horizontal scroller.
    expect(hasUnconditionalClass(wrapper?.className, 'overflow-x-clip')).toBe(true)
    expect(
      hasVariantClass(wrapper?.className, NAME_COLUMN_TRUNCATE_BREAKPOINT, 'overflow-x-auto'),
    ).toBe(true)
    // Per-row scrollers would misalign every column from its header.
    for (const row of container.querySelectorAll('tbody tr, tbody tr td')) {
      expect(row.className).not.toContain('overflow-x-auto')
      expect(row.className).not.toContain('overflow-x-scroll')
    }
  })

  it('the controls column stays LAST and unhidden', () => {
    const container = renderList()
    const cells = [...container.querySelectorAll('tbody tr td')]
    const last = cells[cells.length - 1]
    // The merged previewActions cell — snapshot / inline control / status dot.
    // It carries the row's main control and its status: never a hidden column.
    expect(last?.className).not.toContain('hidden')
    expect(last?.querySelector('[data-status="online"]')).not.toBeNull()
  })

  it('the secondary lines in the cell truncate with the name', () => {
    const { container } = render(
      withQuery(
        <table>
          <tbody>
            <DeviceItem
              trpc={mockTrpc}
              device={dev(1, { parentDeviceId: 7 })}
              parent={{ id: 7, name: 'NVR front door lato strada' }}
              view="table"
              showStableId
              showId
            />
          </tbody>
        </table>,
      ),
    )
    const parentBadge = [...container.querySelectorAll('span')].find((s) =>
      s.textContent?.startsWith('Under:'),
    )
    expect(parentBadge).toBeDefined()
    expect(hasUnconditionalClass(parentBadge?.className, 'truncate')).toBe(true)
  })
})

describe('the card layouts are untouched', () => {
  it('a minimal in-panel row still truncates at every width', () => {
    const { container } = render(
      withQuery(<DeviceItem trpc={mockTrpc} device={dev(1)} variant="minimal" />),
    )
    const cls = el(container, '[data-testid="device-name"]').className
    expect(hasUnconditionalClass(cls, 'truncate')).toBe(true)
  })

  it('a stacked card still wraps to two lines instead of scrolling', () => {
    const { container } = render(withQuery(<DeviceItem trpc={mockTrpc} device={dev(1)} />))
    const cls = el(container, '[data-testid="device-name"]').className
    expect(cls).toContain('line-clamp-2')
    expect(hasUnconditionalClass(cls, 'whitespace-nowrap')).toBe(false)
  })
})
