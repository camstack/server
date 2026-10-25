// @vitest-environment jsdom
/**
 * Chevron-slot alignment: a row WITHOUT children must reserve the SAME
 * leading slot width as a row WITH children, so the lead icon + name
 * start at the same x in both. jsdom cannot measure pixels, so we assert
 * the structural invariant instead: both the interactive chevron button
 * and the empty placeholder carry the SAME fixed-width slot class via a
 * shared `data-testid="chevron-slot"` hook.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../hooks/use-device-proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/use-device-proxy')>()
  return { ...actual, useDeviceState: () => undefined }
})

const trpcStub = {} as import('../../../hooks/use-device-proxy').UseDeviceProxyTrpc
import { DeviceItemHeader } from '../header'
import type { VariantDefaults } from '../helpers'
import type { DeviceItemDevice } from '../helpers'

const flags: VariantDefaults = {
  showIntegrationIcon: false,
  showParentBadge: false,
  showSnapshot: false,
  showBattery: false,
  showStableId: false,
  showId: false,
  showSwitchToggle: false,
  showChildrenAccordion: true,
}

const device: DeviceItemDevice = {
  id: 7,
  stableId: 'st-7',
  addonId: 'test',
  type: 'camera',
  name: 'Cam 7',
  online: true,
  disabled: false,
  parentDeviceId: null,
  features: [],
}

function renderHeader(hasChildren: boolean, stacked: boolean): ReturnType<typeof render> {
  return render(
    <DeviceItemHeader
      trpc={trpcStub}
      device={device}
      variant="compact"
      flags={flags}
      parent={null}
      integrationIcon={null}
      hasChildren={hasChildren}
      expanded={false}
      onToggleExpand={() => {}}
      onNavigateToParent={() => {}}
      stacked={stacked}
    />,
  )
}

describe('DeviceItemHeader — chevron slot reservation (horizontal)', () => {
  it('row WITH children renders an interactive chevron button in the slot', () => {
    renderHeader(true, false)
    const slot = screen.getByTestId('chevron-slot')
    expect(slot.tagName).toBe('BUTTON')
    expect(slot.getAttribute('aria-label')).toBe('Expand children')
  })

  it('row WITHOUT children still reserves the slot (empty placeholder, not the button)', () => {
    renderHeader(false, false)
    const slot = screen.getByTestId('chevron-slot')
    expect(slot.tagName).not.toBe('BUTTON')
    expect(slot.getAttribute('aria-label')).toBeNull()
  })

  it('with-children and without-children rows carry the SAME slot width class', () => {
    const a = renderHeader(true, false)
    const withSlot = a.getByTestId('chevron-slot')
    const widthWith = Array.from(withSlot.classList).filter((c) => c.startsWith('w-'))
    a.unmount()

    const b = renderHeader(false, false)
    const withoutSlot = b.getByTestId('chevron-slot')
    const widthWithout = Array.from(withoutSlot.classList).filter((c) => c.startsWith('w-'))

    expect(widthWith.length).toBeGreaterThan(0)
    expect(widthWithout).toEqual(widthWith)
  })
})

describe('DeviceItemHeader — chevron slot reservation (stacked card)', () => {
  it('row WITHOUT children reserves the slot in the stacked layout too', () => {
    renderHeader(false, true)
    const slot = screen.getByTestId('chevron-slot')
    expect(slot.tagName).not.toBe('BUTTON')
  })

  it('stacked with/without children share the SAME slot width class', () => {
    const a = renderHeader(true, true)
    const widthWith = Array.from(a.getByTestId('chevron-slot').classList).filter((c) =>
      c.startsWith('w-'),
    )
    a.unmount()

    const b = renderHeader(false, true)
    const widthWithout = Array.from(b.getByTestId('chevron-slot').classList).filter((c) =>
      c.startsWith('w-'),
    )

    expect(widthWith.length).toBeGreaterThan(0)
    expect(widthWithout).toEqual(widthWith)
  })
})
