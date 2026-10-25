// @vitest-environment jsdom
/**
 * The NAME column must never ellipsise a device name on a narrow viewport.
 *
 * The reported defect: on a phone every row read "Camera ve…" /
 * "Camera co…" — the cameras were indistinguishable, and the operator's
 * chosen trade was explicit: show the ENTIRE name, at the cost of scrolling
 * the table sideways.
 *
 * These assert the responsive DECISION (`truncate` is behind a breakpoint, the
 * width cap is behind a breakpoint) rather than a `className` literal — see
 * `docs/ui/conventions.md`, "Frozen-string tests have an expiry date". The
 * layout consequence itself (the name box growing to the full text width and
 * the wrapper becoming scrollable) was measured in a real engine; jsdom has no
 * layout, so what a unit test can guard is the class decision that produces it.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceList } from '../index'
import { DeviceItem } from '../../device-item'
import { NAME_COLUMN_TRUNCATE_BREAKPOINT } from '../columns'
import { classTokens, hasUnconditionalClass, hasVariantClass } from '../../../lib/tailwind-variants'
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

/** Width utilities applied at EVERY width — the ones that cap the column. */
function unconditionalWidthTokens(className: string): readonly string[] {
  return classTokens(className).filter(
    (token) => !token.includes(':') && /^(?:w|max-w)-/.test(token),
  )
}

describe('device table — the NAME is never cut', () => {
  it('renders the name in full, and exposes it as the accessible title too', () => {
    const container = renderList()
    const name = el(container, '[data-testid="device-name"]')
    // The DOM has always carried the full string; the defect was purely that
    // the operator could not READ it. Keep both the text and the title.
    expect(name.textContent).toBe(LONG_NAME)
    expect(name.getAttribute('title')).toBe(LONG_NAME)
  })

  it('the name text does not truncate at every width — only from the breakpoint up', () => {
    const container = renderList()
    const cls = el(container, '[data-testid="device-name"]').className
    // The defect, stated as an invariant: `truncate` (overflow-hidden +
    // text-ellipsis + nowrap) applied unconditionally is what produced
    // "Camera ve…" on a phone.
    expect(hasUnconditionalClass(cls, 'truncate')).toBe(false)
    expect(hasVariantClass(cls, NAME_COLUMN_TRUNCATE_BREAKPOINT, 'truncate')).toBe(true)
    // One line at every width: below the breakpoint the row scrolls sideways
    // rather than the name wrapping into a two-line cell.
    expect(hasUnconditionalClass(cls, 'whitespace-nowrap')).toBe(true)
  })

  it('the NAME column carries no width cap below the breakpoint', () => {
    const container = renderList()
    // A cap on the <td>/<th> is the OTHER half: with `w-44 max-w-[11rem]` the
    // column could not grow to the name however the text was styled.
    for (const cls of [nameHeader(container).className, el(container, 'tbody tr td').className]) {
      expect(unconditionalWidthTokens(cls)).toEqual([])
      expect(hasVariantClass(cls, NAME_COLUMN_TRUNCATE_BREAKPOINT, 'w-64')).toBe(true)
    }
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

  it('the controls column stays LAST and unhidden, so scrolling right reaches it', () => {
    const container = renderList()
    const cells = [...container.querySelectorAll('tbody tr td')]
    const last = cells[cells.length - 1]
    // The merged previewActions cell — snapshot / inline control / status dot.
    // It is the rightmost thing on the row, so it is what the operator reaches
    // at the end of the sideways scroll; it must not be a hidden column.
    expect(last?.className).not.toContain('hidden')
    expect(last?.querySelector('[title="Online"]')).not.toBeNull()
  })

  it('the secondary lines in the cell follow the same policy as the name', () => {
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
    // A full name over an ellipsised "Under: …" / stableId reads as broken.
    const parentBadge = [...container.querySelectorAll('span')].find((s) =>
      s.textContent?.startsWith('Under:'),
    )
    expect(parentBadge).toBeDefined()
    expect(hasUnconditionalClass(parentBadge?.className, 'truncate')).toBe(false)
    expect(
      hasVariantClass(parentBadge?.className, NAME_COLUMN_TRUNCATE_BREAKPOINT, 'truncate'),
    ).toBe(true)
  })
})

describe('the card layouts are untouched — they have nowhere to scroll to', () => {
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
