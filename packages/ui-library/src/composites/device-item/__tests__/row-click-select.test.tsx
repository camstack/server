// @vitest-environment jsdom
/**
 * Task 5.2 — in batch mode a ROW click toggles that row's selection
 * instead of navigating. DeviceItem gates this on the `rowClickSelects`
 * prop: when set (and `selection` is present), the row's primary click
 * calls `selection.onToggle()` and suppresses `onNavigate`. When unset,
 * the row navigates as before. Clicking the checkbox itself still toggles
 * (and never double-fires navigate).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
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

function renderTableRow(props: {
  readonly onNavigate?: (id: number) => void
  readonly selection?: { readonly selected: boolean; readonly onToggle: () => void }
  readonly rowClickSelects?: boolean
}): HTMLTableRowElement {
  const { container } = render(
    <Wrapper>
      <table>
        <tbody>
          <DeviceItem
            trpc={mockTrpc}
            device={baseDevice}
            view="table"
            onNavigate={props.onNavigate}
            selection={props.selection}
            rowClickSelects={props.rowClickSelects}
          />
        </tbody>
      </table>
    </Wrapper>,
  )
  const row = container.querySelector('tr')
  expect(row).not.toBeNull()
  return row as HTMLTableRowElement
}

describe('DeviceItem row-click selection (table view)', () => {
  it('batch mode ON: clicking the row toggles selection and does NOT navigate', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const row = renderTableRow({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: true,
    })
    fireEvent.click(row)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('batch mode OFF: clicking the row navigates and does NOT toggle selection', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const row = renderTableRow({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: false,
    })
    fireEvent.click(row)
    expect(onNavigate).toHaveBeenCalledWith(42)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('batch mode ON: the selectable row exposes an accessible pressed affordance', () => {
    const row = renderTableRow({
      onNavigate: vi.fn(),
      selection: { selected: true, onToggle: vi.fn() },
      rowClickSelects: true,
    })
    expect(row.getAttribute('aria-pressed')).toBe('true')
  })

  it('batch mode ON: clicking the checkbox toggles once and never navigates', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    renderTableRow({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: true,
    })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('batch mode ON: pressing Enter on the row toggles selection and does NOT navigate', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const row = renderTableRow({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: true,
    })
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('batch mode ON: pressing Space on the row toggles selection and does NOT navigate', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const row = renderTableRow({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: true,
    })
    fireEvent.keyDown(row, { key: ' ' })
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('batch mode ON: the selectable row has tabIndex=0', () => {
    const row = renderTableRow({
      onNavigate: vi.fn(),
      selection: { selected: false, onToggle: vi.fn() },
      rowClickSelects: true,
    })
    expect(row.getAttribute('tabindex')).toBe('0')
  })

  it('batch mode OFF: the row does NOT have tabIndex and keyboard events do NOT toggle', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const row = renderTableRow({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: false,
    })
    expect(row.getAttribute('tabindex')).toBeNull()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onToggle).not.toHaveBeenCalled()
  })
})

describe('DeviceItem row-click selection (card view)', () => {
  function renderCard(props: {
    readonly onNavigate?: (id: number) => void
    readonly selection?: { readonly selected: boolean; readonly onToggle: () => void }
    readonly rowClickSelects?: boolean
  }): HTMLElement {
    const { container } = render(
      <Wrapper>
        <DeviceItem
          trpc={mockTrpc}
          device={baseDevice}
          view="card"
          onNavigate={props.onNavigate}
          selection={props.selection}
          rowClickSelects={props.rowClickSelects}
        />
      </Wrapper>,
    )
    // The clickable body is the inner div carrying the onClick handler.
    const body = container.querySelector('[data-testid="device-card-body"]')
    expect(body).not.toBeNull()
    return body as HTMLElement
  }

  it('batch mode ON: clicking the card body toggles selection, no navigate', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const body = renderCard({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: true,
    })
    fireEvent.click(body)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('batch mode OFF: clicking the card body navigates', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const body = renderCard({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: false,
    })
    fireEvent.click(body)
    expect(onNavigate).toHaveBeenCalledWith(42)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('batch mode ON: pressing Enter on the card body toggles selection and does NOT navigate', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const body = renderCard({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: true,
    })
    fireEvent.keyDown(body, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('batch mode ON: pressing Space on the card body toggles selection and does NOT navigate', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const body = renderCard({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: true,
    })
    fireEvent.keyDown(body, { key: ' ' })
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('batch mode ON: the selectable card body has tabIndex=0', () => {
    const body = renderCard({
      onNavigate: vi.fn(),
      selection: { selected: false, onToggle: vi.fn() },
      rowClickSelects: true,
    })
    expect(body.getAttribute('tabindex')).toBe('0')
  })

  it('batch mode OFF: the card body does NOT have tabIndex and keyboard events do NOT toggle', () => {
    const onNavigate = vi.fn()
    const onToggle = vi.fn()
    const body = renderCard({
      onNavigate,
      selection: { selected: false, onToggle },
      rowClickSelects: false,
    })
    expect(body.getAttribute('tabindex')).toBeNull()
    fireEvent.keyDown(body, { key: 'Enter' })
    expect(onToggle).not.toHaveBeenCalled()
  })
})
