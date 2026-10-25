// @vitest-environment jsdom
/**
 * A CONTAINER device row renders AS its PRIMARY child, so its reachability
 * dot must follow that primary child's `online` — NOT "any child online".
 * Resolution reuses `resolveContainerPrimary(children, linkDeviceId)`, the
 * same helper the row control binds to, so the dot and the control agree.
 *
 * The StatusDot atom carries a `title` of Online / Offline / Disabled, which
 * we assert against. Covered in BOTH card and table views.
 */
import { render } from '@testing-library/react'
import { describe, it, expect, beforeAll } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DeviceType } from '@camstack/types'
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

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function child(id: number, type: string, entityId: string, online: boolean): DeviceItemDevice {
  return {
    id,
    stableId: `st-${String(id)}`,
    addonId: 'ha',
    type,
    name: `child-${String(id)}`,
    online,
    disabled: false,
    parentDeviceId: 100,
    features: [],
    sourceInfo: { id: entityId, system: 'homeassistant' },
  }
}

function container(extra: Partial<DeviceItemDevice> = {}): DeviceItemDevice {
  return {
    id: 100,
    stableId: 'st-container',
    addonId: 'ha',
    type: DeviceType.Container,
    name: 'Lock container',
    // The container's OWN online is intentionally `true` so the assertions
    // prove the dot follows the PRIMARY CHILD, not the container row.
    online: true,
    disabled: false,
    parentDeviceId: null,
    features: [],
    ...extra,
  }
}

// lock > switch in PRIORITY → lock is the priority-default primary child.
function dotTitle(scope: { querySelector: (s: string) => Element | null }): string | null {
  return (
    scope
      .querySelector('[title="Online"], [title="Offline"], [title="Disabled"]')
      ?.getAttribute('title') ?? null
  )
}

describe('DeviceItem — container status dot follows primary child reachability', () => {
  describe('card view', () => {
    it('primary child OFFLINE → dot is Offline even if other children are online', () => {
      const lockOffline = child(9, DeviceType.Lock, 'lock.front', false)
      const switchOnline = child(8, DeviceType.Switch, 'switch.lamp', true)
      const { container: dom } = render(
        <Wrapper>
          <DeviceItem trpc={mockTrpc} device={container({ linkDeviceId: null })} view="card">
            {[switchOnline, lockOffline]}
          </DeviceItem>
        </Wrapper>,
      )
      expect(dotTitle(dom)).toBe('Offline')
    })

    it('primary child ONLINE → dot is Online even if other children are offline', () => {
      const lockOnline = child(9, DeviceType.Lock, 'lock.front', true)
      const switchOffline = child(8, DeviceType.Switch, 'switch.lamp', false)
      const { container: dom } = render(
        <Wrapper>
          <DeviceItem trpc={mockTrpc} device={container({ linkDeviceId: null })} view="card">
            {[switchOffline, lockOnline]}
          </DeviceItem>
        </Wrapper>,
      )
      expect(dotTitle(dom)).toBe('Online')
    })

    it('override (linkDeviceId) picks the switch child → dot follows the switch', () => {
      const lockOnline = child(9, DeviceType.Lock, 'lock.front', true)
      const switchOffline = child(8, DeviceType.Switch, 'switch.lamp', false)
      const { container: dom } = render(
        <Wrapper>
          <DeviceItem trpc={mockTrpc} device={container({ linkDeviceId: 8 })} view="card">
            {[switchOffline, lockOnline]}
          </DeviceItem>
        </Wrapper>,
      )
      expect(dotTitle(dom)).toBe('Offline')
    })

    it('no children → falls back to device.online (container offline)', () => {
      const { container: dom } = render(
        <Wrapper>
          <DeviceItem
            trpc={mockTrpc}
            device={container({ online: false, linkDeviceId: null })}
            view="card"
          />
        </Wrapper>,
      )
      expect(dotTitle(dom)).toBe('Offline')
    })

    it('disabled container → dot is Disabled regardless of primary child online', () => {
      const lockOnline = child(9, DeviceType.Lock, 'lock.front', true)
      const { container: dom } = render(
        <Wrapper>
          <DeviceItem
            trpc={mockTrpc}
            device={container({ disabled: true, linkDeviceId: null })}
            view="card"
          >
            {[lockOnline]}
          </DeviceItem>
        </Wrapper>,
      )
      expect(dotTitle(dom)).toBe('Disabled')
    })
  })

  describe('table view', () => {
    it('primary child OFFLINE → dot is Offline even if other children are online', () => {
      const lockOffline = child(9, DeviceType.Lock, 'lock.front', false)
      const switchOnline = child(8, DeviceType.Switch, 'switch.lamp', true)
      const { container: dom } = render(
        <Wrapper>
          <table>
            <tbody>
              <DeviceItem trpc={mockTrpc} device={container({ linkDeviceId: null })} view="table">
                {[switchOnline, lockOffline]}
              </DeviceItem>
            </tbody>
          </table>
        </Wrapper>,
      )
      expect(dotTitle(dom)).toBe('Offline')
    })

    it('primary child ONLINE → dot is Online', () => {
      const lockOnline = child(9, DeviceType.Lock, 'lock.front', true)
      const { container: dom } = render(
        <Wrapper>
          <table>
            <tbody>
              <DeviceItem trpc={mockTrpc} device={container({ linkDeviceId: null })} view="table">
                {[lockOnline]}
              </DeviceItem>
            </tbody>
          </table>
        </Wrapper>,
      )
      expect(dotTitle(dom)).toBe('Online')
    })

    it('no children → falls back to device.online (container online)', () => {
      const { container: dom } = render(
        <Wrapper>
          <table>
            <tbody>
              <DeviceItem
                trpc={mockTrpc}
                device={container({ online: true, linkDeviceId: null })}
                view="table"
              />
            </tbody>
          </table>
        </Wrapper>,
      )
      expect(dotTitle(dom)).toBe('Online')
    })

    it('disabled container → dot is Disabled regardless of primary child online', () => {
      const lockOnline = child(9, DeviceType.Lock, 'lock.front', true)
      const { container: dom } = render(
        <Wrapper>
          <table>
            <tbody>
              <DeviceItem
                trpc={mockTrpc}
                device={container({ disabled: true, linkDeviceId: null })}
                view="table"
              >
                {[lockOnline]}
              </DeviceItem>
            </tbody>
          </table>
        </Wrapper>,
      )
      expect(dotTitle(dom)).toBe('Disabled')
    })
  })

  it('non-container device is unaffected (dot follows device.online)', () => {
    const camOffline: DeviceItemDevice = {
      id: 42,
      stableId: 'cam-1',
      addonId: 'provider-test',
      type: 'camera',
      name: 'Cam',
      online: false,
      disabled: false,
      parentDeviceId: null,
      features: [],
    }
    const { container: dom } = render(
      <Wrapper>
        <DeviceItem trpc={mockTrpc} device={camOffline} view="card" />
      </Wrapper>,
    )
    expect(dotTitle(dom)).toBe('Offline')
  })
})
