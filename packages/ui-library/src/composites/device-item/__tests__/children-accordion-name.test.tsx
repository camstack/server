// @vitest-environment jsdom
/**
 * Card-view parity: when a device card is expanded, its `<ChildrenAccordion>`
 * child rows must strip the redundant parent-name prefix exactly like the
 * device-detail list + the devices table (shared `childListName`).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import type { DeviceItemDevice } from '../helpers'
import { DeviceItem } from '../index'

beforeAll(() => {
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

const parent: DeviceItemDevice = {
  id: 1,
  stableId: 's-1',
  addonId: 'dreame',
  type: 'container',
  name: 'Robot primo piano',
  online: true,
  disabled: false,
  parentDeviceId: null,
  role: null,
}

const child = (id: number, name: string): DeviceItemDevice => ({
  id,
  stableId: `s-1-${String(id)}`,
  addonId: 'dreame',
  type: 'numeric-sensor',
  name,
  online: true,
  disabled: false,
  parentDeviceId: 1,
  role: 'numeric-sensor',
})

function withQuery(node: ReactNode): ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

describe('DeviceItem card — ChildrenAccordion parent-prefix strip', () => {
  it('strips the parent prefix from expanded card child rows', () => {
    render(
      withQuery(
        <DeviceItem
          trpc={mockTrpc}
          device={parent}
          view="card"
          variant="compact"
          showChildrenAccordion
          expanded
          onToggleExpand={() => {}}
          children={[child(2, 'Robot primo piano Filter Time Left')]}
        />,
      ),
    )
    expect(screen.getByText('Filter Time Left')).toBeDefined()
    expect(screen.queryByText('Robot primo piano Filter Time Left')).toBeNull()
  })
})
