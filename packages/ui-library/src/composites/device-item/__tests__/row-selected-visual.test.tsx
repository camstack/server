// @vitest-environment jsdom
/**
 * Batch-mode visual selected state — a selected row must read as visibly
 * selected, not merely `aria-pressed`. The `<tr>` gets a selected background
 * (`bg-primary/10`) and the sticky NAME `<td>` MIRRORS it so the pinned cell
 * doesn't show a plain surface stripe over the highlighted row. The checkbox
 * reflects the selected state. Clicking an inline affordance (the built-in
 * delete) must NOT toggle selection (stopPropagation).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceItem } from '../index'
import type { DeviceItemDevice } from '../helpers'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import { ConfirmDialogProvider } from '../../confirm-dialog'

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
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  })
  return (
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
    </QueryClientProvider>
  )
}

function renderRow(props: {
  readonly selected: boolean
  readonly onToggle?: () => void
  readonly onDelete?: (d: DeviceItemDevice) => void
}): HTMLTableRowElement {
  const { container } = render(
    <Wrapper>
      <table>
        <tbody>
          <DeviceItem
            trpc={mockTrpc}
            device={baseDevice}
            view="table"
            onNavigate={vi.fn()}
            selection={{ selected: props.selected, onToggle: props.onToggle ?? vi.fn() }}
            rowClickSelects
            onDelete={props.onDelete}
          />
        </tbody>
      </table>
    </Wrapper>,
  )
  const row = container.querySelector('tr')
  expect(row).not.toBeNull()
  return row as HTMLTableRowElement
}

describe('DeviceItem batch-mode selected visual state (table view)', () => {
  it('selected row: the <tr> carries the selected background', () => {
    const row = renderRow({ selected: true })
    expect(row.className).toContain('bg-primary/10')
  })

  it('unselected row: the <tr> does NOT carry the selected background', () => {
    const row = renderRow({ selected: false })
    expect(row.className).not.toContain('bg-primary/10')
  })

  it('selected row: the sticky NAME cell mirrors the selected background', () => {
    const row = renderRow({ selected: true })
    const nameCell = row.querySelector('td')
    expect(nameCell).not.toBeNull()
    expect(nameCell!.className).toContain('bg-primary/10')
    // Must NOT also paint the plain surface stripe over the highlighted row.
    expect(nameCell!.className).not.toContain('bg-surface ')
  })

  it('unselected row: the sticky NAME cell keeps the plain surface background', () => {
    const row = renderRow({ selected: false })
    const nameCell = row.querySelector('td')
    expect(nameCell).not.toBeNull()
    expect(nameCell!.className).toContain('bg-surface')
    expect(nameCell!.className).not.toContain('bg-primary/10')
  })

  it('selected row: the leading checkbox reflects the checked state', () => {
    renderRow({ selected: true })
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeInstanceOf(HTMLInputElement)
    expect((checkbox as HTMLInputElement).checked).toBe(true)
  })

  it('clicking the built-in delete affordance does NOT toggle selection', () => {
    const onToggle = vi.fn()
    const onDelete = vi.fn()
    renderRow({ selected: false, onToggle, onDelete })
    const deleteBtn = screen.getByRole('button', { name: /delete/i })
    fireEvent.click(deleteBtn)
    expect(onToggle).not.toHaveBeenCalled()
  })
})

describe('DeviceItem batch-mode selected visual state (card view)', () => {
  function renderCard(selected: boolean): HTMLElement {
    const { container } = render(
      <Wrapper>
        <DeviceItem
          trpc={mockTrpc}
          device={baseDevice}
          view="card"
          onNavigate={vi.fn()}
          selection={{ selected, onToggle: vi.fn() }}
          rowClickSelects
        />
      </Wrapper>,
    )
    const body = container.querySelector('[data-testid="device-card-body"]')
    expect(body).not.toBeNull()
    return body as HTMLElement
  }

  it('selected card body carries the selected background', () => {
    const body = renderCard(true)
    expect(body.className).toContain('bg-primary/10')
  })

  it('unselected card body does NOT carry the selected background', () => {
    const body = renderCard(false)
    expect(body.className).not.toContain('bg-primary/10')
  })
})
