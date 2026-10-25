// @vitest-environment jsdom
/**
 * Task 4.2 — a CONTAINER device row renders AS its primary child: the SAME
 * InlineControl a top-level device of the primary child's type would render,
 * bound to the primary CHILD's numeric deviceId. Resolution = priority default,
 * or the picker override persisted on the container's `linkDeviceId`.
 *
 * The control registry is mocked so each type's InlineControl renders an
 * identifiable marker carrying the bound deviceId — letting us assert WHICH
 * child's control (and bound id) is on screen without the live panel controls.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DeviceType } from '@camstack/types'

vi.mock('../../device-controls/control-registry', () => ({
  resolveDeviceControl: (type: string) => ({
    InlineControl: ({ deviceId }: { deviceId: number }) => (
      <span data-testid="inline">{`inline:${type}:${String(deviceId)}`}</span>
    ),
  }),
  resolveControlAlign: (_type: string, placement: 'right' | 'center') => placement,
}))

import { DeviceItemActions } from '../actions'
import { ContainerChildrenProvider } from '../container-children-context'
import type { DeviceItemDevice } from '../helpers'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'

/** Render the actions for a container row, publishing its children through the
 *  list-level context exactly as `DeviceModeList` does (keyed by parent id). */
function renderContainerActions(
  device: DeviceItemDevice,
  containerChildren: readonly DeviceItemDevice[] | null,
): ReturnType<typeof render> {
  const map = new Map<number, readonly DeviceItemDevice[]>()
  if (containerChildren !== null) map.set(device.id, containerChildren)
  return render(
    <ContainerChildrenProvider value={map}>
      <DeviceItemActions trpc={trpc} device={device} flags={flags} />
    </ContainerChildrenProvider>,
  )
}

const trpc: UseDeviceProxyTrpc = {
  deviceManager: {
    getBindings: { query: () => Promise.reject(new Error('not used')) },
  },
}

const flags = {
  showIntegrationIcon: false,
  showParentBadge: false,
  showSnapshot: false,
  showBattery: false,
  showStableId: false,
  showId: false,
  showSwitchToggle: false,
  showChildrenAccordion: false,
}

function child(id: number, type: string, entityId: string): DeviceItemDevice {
  return {
    id,
    stableId: `st-${String(id)}`,
    addonId: 'ha',
    type,
    name: `child-${String(id)}`,
    online: true,
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
    online: true,
    disabled: false,
    parentDeviceId: null,
    features: [],
    ...extra,
  }
}

// switch > sensor in PRIORITY; both render via the registry InlineControl in
// these tests (sensor's real special-case path is covered separately).
const lockChild = child(9, DeviceType.Lock, 'lock.front')
const switchChild = child(8, DeviceType.Switch, 'switch.lamp')
const children: readonly DeviceItemDevice[] = [switchChild, lockChild]

describe('DeviceItemActions — container row renders as its primary child', () => {
  it('default: renders the priority-default child control (lock) bound to the child id', () => {
    renderContainerActions(container({ linkDeviceId: null }), children)
    expect(screen.getByTestId('inline').textContent).toBe(`inline:${DeviceType.Lock}:9`)
  })

  it('override: linkDeviceId selects the switch child, so the row renders the switch control', () => {
    renderContainerActions(container({ linkDeviceId: 8 }), children)
    expect(screen.getByTestId('inline').textContent).toBe(`inline:${DeviceType.Switch}:8`)
  })

  it('stale override: linkDeviceId no longer present → falls back to priority default (lock)', () => {
    renderContainerActions(container({ linkDeviceId: 9999 }), children)
    expect(screen.getByTestId('inline').textContent).toBe(`inline:${DeviceType.Lock}:9`)
  })

  it('no children: renders nothing (degrades gracefully, no crash)', () => {
    const { container: dom } = renderContainerActions(container({ linkDeviceId: null }), [])
    expect(dom.firstChild).toBeNull()
  })

  it('no provider (children unresolved): renders nothing (no crash)', () => {
    const { container: dom } = renderContainerActions(container({ linkDeviceId: null }), null)
    expect(dom.firstChild).toBeNull()
  })
})
