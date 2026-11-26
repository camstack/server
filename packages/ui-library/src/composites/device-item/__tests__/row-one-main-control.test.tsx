/**
 * A list row is ONE line with the kind's main control (D1106). The timed run is
 * a secondary control: no row draws it inline, for any kind and for a
 * container's primary child alike. It stays reachable as the phone tray's
 * `lead` action, and the device page carries it.
 */
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DeviceType } from '@camstack/types'

vi.mock('../../../generated/system-hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../generated/system-hooks')>()),
  useDeviceManagerGetRoleDisplayDefaults: () => ({ data: undefined }),
  useHeroLayoutGetRowModels: () => ({ status: 'success', data: [], refetch: () => undefined }),
  useDeviceManagerGetBindings: () => ({ data: undefined }),
}))
vi.mock('../../hero-model/use-hero-live-refresh', () => ({ useHeroLiveRefresh: () => undefined }))
vi.mock('../../../contexts/system-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../contexts/system-context')>()),
  useTrpcClient: () => null,
}))
vi.mock('../../device-controls/timed-run-row-control', () => ({
  TimedRunRowControl: ({ deviceId }: { readonly deviceId: number }) => (
    <span data-testid="timed-run">{`run-${String(deviceId)}`}</span>
  ),
}))

import { DeviceItemActions } from '../actions'
import type { DeviceItemDevice } from '../helpers'
import { ContainerChildrenProvider } from '../container-children-context'
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

const trpc = {
  deviceManager: {
    getBindings: { query: async () => ({ deviceId: 0, entries: [] }) },
    getDevice: { query: async () => null },
  },
} as unknown as UseDeviceProxyTrpc // documented test-fake boundary: only the cap queries the row reads

function makeDevice(type: string, extra: Partial<DeviceItemDevice> = {}): DeviceItemDevice {
  return {
    id: 1,
    stableId: `test-${type}`,
    addonId: 'test',
    type,
    name: `Test ${type}`,
    online: true,
    disabled: false,
    parentDeviceId: null,
    features: [],
    ...extra,
  }
}

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('a list row draws one main control', () => {
  it.each([
    DeviceType.Switch,
    DeviceType.Light,
    DeviceType.Cover,
    DeviceType.Climate,
    DeviceType.Lock,
  ])('a %s row draws no timed run inline, wide or narrow', (type) => {
    for (const placement of ['table', 'card'] as const) {
      const { unmount } = render(
        <Wrapper>
          <DeviceItemActions
            trpc={trpc}
            device={makeDevice(type)}
            controlPlacement={placement === 'table' ? 'table' : 'right'}
          />
        </Wrapper>,
      )
      expect(screen.queryByTestId('timed-run')).toBeNull()
      unmount()
    }
  })

  it('a container row draws no timed run for its primary child', () => {
    const child = makeDevice(DeviceType.Switch, { id: 9, stableId: 'c-9' })
    render(
      <Wrapper>
        <ContainerChildrenProvider value={new Map([[2, [child]]])}>
          <DeviceItemActions
            trpc={trpc}
            device={makeDevice(DeviceType.Container, { id: 2, linkDeviceId: 9 })}
          />
        </ContainerChildrenProvider>
      </Wrapper>,
    )
    expect(screen.queryByTestId('timed-run')).toBeNull()
  })

  it("the phone tray's lead action still carries it", () => {
    render(
      <Wrapper>
        <DeviceItemActions trpc={trpc} device={makeDevice(DeviceType.Switch)} part="lead" />
      </Wrapper>,
    )
    expect(screen.getByTestId('timed-run')).toBeTruthy()
  })
})
