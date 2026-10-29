// @vitest-environment jsdom
/**
 * A row listed inside its container's own list never carries the container's
 * name (D356): the header in `nested` form with the parent renders the bare
 * noun.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../hooks/use-device-proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/use-device-proxy')>()
  return { ...actual, useDeviceState: () => undefined }
})

import { DeviceItemHeader } from '../header'
import type { DeviceItemDevice, VariantDefaults } from '../helpers'
import { childListName } from '../helpers'

const trpcStub = {} as import('../../../hooks/use-device-proxy').UseDeviceProxyTrpc

const flags: VariantDefaults = {
  showIntegrationIcon: false,
  showParentBadge: false,
  showSnapshot: false,
  showBattery: false,
  showStableId: false,
  showId: false,
  showSwitchToggle: false,
  showChildrenAccordion: false,
}

const child: DeviceItemDevice = {
  id: 2,
  stableId: 's-2',
  addonId: 'zigbee',
  type: 'sensor',
  name: 'Zigbee hub - Door contact',
  online: true,
  disabled: false,
  parentDeviceId: 1,
  role: null,
  features: [],
}
const parent = { id: 1, name: 'Zigbee hub', type: 'container' }

function renderHeader(form: 'nested'): void {
  render(
    <DeviceItemHeader
      trpc={trpcStub}
      device={{ ...child, name: childListName(child, parent.name) }}
      variant="minimal"
      flags={flags}
      parent={parent}
      nameForm={form}
      integrationIcon={null}
      hasChildren={false}
      expanded={false}
      onToggleExpand={() => {}}
      onNavigateToParent={() => {}}
    />,
  )
}

describe('child row inside its parent list', () => {
  it('nested form shows the bare noun', () => {
    renderHeader('nested')
    expect(screen.getByTestId('device-name').textContent).toBe('Door contact')
  })
})
