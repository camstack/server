// @vitest-environment jsdom
//
// A device row with a removal in flight: pending dims it, shows "Removing…",
// withholds the actions and the row click; failed restores it with the error.
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DeviceItem } from '../index'
import type { DeviceItemDevice } from '../helpers'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import { ConfirmDialogProvider } from '../../confirm-dialog'
import type { RowOperationState } from '../../../hooks/use-row-operations'

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

const device: DeviceItemDevice = {
  id: 11,
  stableId: 'lamp-11',
  addonId: 'test',
  type: 'light',
  name: 'Hall lamp',
  online: true,
  disabled: false,
  parentDeviceId: null,
}

const trpc = {
  deviceManager: {
    getBindings: { query: async () => ({ deviceId: 0, entries: [] }) },
  },
} as unknown as UseDeviceProxyTrpc

function renderRow(operation: RowOperationState | undefined, onNavigate = vi.fn()): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  })
  render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <table>
          <tbody>
            <DeviceItem
              trpc={trpc}
              device={device}
              view="table"
              onDelete={vi.fn()}
              onNavigate={onNavigate}
              {...(operation !== undefined ? { operation } : {})}
            />
          </tbody>
        </table>
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
  return screen.getByRole('row')
}

describe('DeviceItem table row operation', () => {
  it('pending: shows Removing…, drops the delete action and ignores the row click', () => {
    const onNavigate = vi.fn()
    const row = renderRow({ kind: 'pending' }, onNavigate)
    expect(row.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('Removing…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete device' })).toBeNull()
    fireEvent.click(row)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('failed: restores the actions and shows the error inline', () => {
    const row = renderRow({ kind: 'failed', message: 'provider offline' })
    expect(row.getAttribute('aria-busy')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('provider offline')
    expect(screen.getByRole('button', { name: 'Delete device' })).toBeTruthy()
  })

  it('idle: renders as before', () => {
    const row = renderRow(undefined)
    expect(row.getAttribute('aria-busy')).toBeNull()
    expect(screen.queryByText('Removing…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete device' })).toBeTruthy()
  })
})
