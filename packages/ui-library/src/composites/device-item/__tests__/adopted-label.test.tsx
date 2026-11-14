// @vitest-environment jsdom
/**
 * A role-less child is "adopted" only under an NVR or a gateway.
 * A container's child is a part of it, and the child the container draws
 * reads "primary".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import { DeviceItem } from '../index'
import { deriveDeviceKind, type DeviceItemDevice } from '../helpers'

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

const trpc = {
  deviceManager: { getBindings: { query: async () => ({ deviceId: 0, entries: [] }) } },
} as unknown as UseDeviceProxyTrpc

function row(
  id: number,
  type: string,
  parentDeviceId: number | null,
  extra: Partial<DeviceItemDevice> = {},
): DeviceItemDevice {
  return {
    id,
    stableId: extra.stableId ?? `s-${String(id)}`,
    addonId: 'provider-enpal',
    type,
    name: extra.name ?? `Device ${String(id)}`,
    online: true,
    disabled: false,
    parentDeviceId,
    role: extra.role ?? null,
    ...extra,
  }
}

function withQuery(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

const child = row(5766, DeviceType.EnergySystem, 5684, {
  stableId: 'enpal-system-energy',
  name: 'Energy system',
})

describe('deriveDeviceKind', () => {
  it('does not call a container child adopted', () => {
    expect(deriveDeviceKind(child, { parentType: DeviceType.Container })).not.toBe('adopted')
  })

  it('names the container primary child primary and the other children parts', () => {
    expect(
      deriveDeviceKind(child, { parentType: DeviceType.Container, primaryChildId: 5766 }),
    ).toBe('primary')
    expect(
      deriveDeviceKind(row(5767, 'sensor', 5684), {
        parentType: DeviceType.Container,
        primaryChildId: 5766,
      }),
    ).toBe('part')
  })

  it('still calls a role-less child adopted under an NVR or a gateway', () => {
    const camera = row(12, DeviceType.Camera, 3)
    expect(deriveDeviceKind(camera, { parentType: 'nvr' })).toBe('adopted')
    expect(deriveDeviceKind(camera, { parentType: DeviceType.Gateway })).toBe('adopted')
  })
})

describe('container children are parts, hub children stay adopted', () => {
  const container = row(5684, DeviceType.Container, null, {
    stableId: 'enpal-system',
    name: 'Enpal system',
    primaryChildPreference: ['energy'],
  })
  const grid = row(5767, 'sensor', 5684, { stableId: 'enpal-system-grid', name: 'Grid' })

  it('labels the expanded container Primary and Parts, never Adopted devices', () => {
    render(
      withQuery(
        <DeviceItem
          trpc={trpc}
          device={container}
          view="card"
          showChildrenAccordion
          expanded
          onToggleExpand={() => {}}
          children={[grid, child]}
        />,
      ),
    )
    expect(screen.queryByText('Adopted devices')).toBeNull()
    expect(screen.getByText('Primary')).toBeTruthy()
    expect(screen.getByText('Parts')).toBeTruthy()
    expect(screen.getByTitle('Primary · 1 part')).toBeTruthy()
  })

  it('keeps Adopted devices for an nvr', () => {
    const hub = row(3, 'nvr', null, { name: 'Home hub' })
    const camera = row(12, DeviceType.Camera, 3, { name: 'Porch' })
    render(
      withQuery(
        <DeviceItem
          trpc={trpc}
          device={hub}
          view="card"
          showChildrenAccordion
          expanded
          onToggleExpand={() => {}}
          children={[camera]}
        />,
      ),
    )
    expect(screen.getByText('Adopted devices')).toBeTruthy()
    expect(screen.getByTitle('1 adopted')).toBeTruthy()
  })

  it('reads the primary child as primary of its container, and a hub camera as adopted by', () => {
    render(
      withQuery(
        <table>
          <tbody>
            <DeviceItem
              trpc={trpc}
              device={child}
              view="table"
              parent={{
                id: 5684,
                name: 'Enpal system',
                type: DeviceType.Container,
                primaryChildId: 5766,
              }}
            />
            <DeviceItem
              trpc={trpc}
              device={row(12, DeviceType.Camera, 3, { name: 'Porch' })}
              view="table"
              parent={{ id: 3, name: 'Home hub', type: DeviceType.Gateway }}
            />
          </tbody>
        </table>,
      ),
    )
    expect(screen.getByText('Primary · Enpal system')).toBeTruthy()
    expect(screen.getByText('Adopted by Home hub')).toBeTruthy()
  })
})
