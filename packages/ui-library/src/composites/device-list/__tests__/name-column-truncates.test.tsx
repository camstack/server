// @vitest-environment jsdom
/**
 * The NAME column fills what the controls leave and ellipsises on the RIGHT.
 *
 * The reported defect: on a phone the table was wider than the viewport, the
 * wrapper scrolled sideways and the name was clipped on the LEFT while the
 * header showed only "PREVIEW". The column is now the flexible one at every
 * width (`w-full max-w-0`, a readable `min-w`), the name truncates with an
 * ellipsis and the controls cell wraps below `md`.
 *
 * jsdom has no layout, so these assert the class decisions that produce it
 * (see `docs/ui/conventions.md`, "Frozen-string tests have an expiry date").
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

  it('the name text truncates at every width, on one line', () => {
    const container = renderList()
    const cls = el(container, '[data-testid="device-name"]').className
    expect(hasUnconditionalClass(cls, 'truncate')).toBe(true)
  })

  it('the NAME column is the flexible one below the breakpoint, fixed from it up', () => {
    const container = renderList()
    for (const cls of [nameHeader(container).className, el(container, 'tbody tr td').className]) {
      // `w-full max-w-0` = take the remaining width and let the text ellipsise;
      // the min width keeps two rows of one device kind tellable apart.
      expect(hasUnconditionalClass(cls, 'w-full')).toBe(true)
      expect(hasUnconditionalClass(cls, 'max-w-0')).toBe(true)
      expect(hasUnconditionalClass(cls, 'min-w-[8rem]')).toBe(true)
      expect(hasVariantClass(cls, NAME_COLUMN_TRUNCATE_BREAKPOINT, 'w-64')).toBe(true)
    }
  })

  it('the controls cell wraps below the breakpoint and stays on one line from it up', () => {
    const container = renderList()
    const cells = [...container.querySelectorAll('tbody tr td')]
    const cls = cells[cells.length - 1]?.className
    expect(hasUnconditionalClass(cls, 'whitespace-normal')).toBe(true)
    expect(hasVariantClass(cls, NAME_COLUMN_TRUNCATE_BREAKPOINT, 'whitespace-nowrap')).toBe(true)
  })

  it('ONE scroll context carries the overflow: the table wrapper, not each row', () => {
    const container = renderList()
    const wrapper = el(container, 'table').parentElement
    expect(wrapper?.className).toContain('overflow-x-auto')
    // Per-row scrollers would misalign every column from its header. No <tr>
    // or NAME <td> may become its own horizontal scroller.
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
    // It is the rightmost thing on the row, so it is what the operator reaches
    // at the end of the sideways scroll; it must not be a hidden column.
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
