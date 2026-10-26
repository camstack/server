/**
 * Pending fleet keeps the stored name. An answered fleet applies the rule.
 * `#id` is only for a lookup by id that has not answered.
 */
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { UiTextProvider, type UiTextFn } from '../../../contexts/ui-text'
import { DeviceFleetProvider } from '../device-fleet'
import { DeviceName } from '../DeviceName'
import type { DeviceNameFields } from '../format-device-name'
import { useDeviceLabelById } from '../use-device-label'

const parent: DeviceNameFields = {
  id: 3297,
  name: 'Sensore movimento veranda',
  type: 'container',
  stableId: 'p3297',
  parentDeviceId: null,
}
const motion: DeviceNameFields = {
  id: 3299,
  name: 'Motion',
  type: 'sensor',
  role: 'motion-sensor',
  parentDeviceId: 3297,
  stableId: 'm3299',
  location: 'Veranda',
}
const battery: DeviceNameFields = {
  id: 3298,
  name: 'Battery',
  type: 'sensor',
  role: 'battery-sensor',
  parentDeviceId: 3297,
  stableId: 'b3298',
}

const italian: UiTextFn = (key, fallback) => {
  if (key === 'uiLibrary.deviceMeta.noun.role.motionSensor') return 'Movimento'
  if (key === 'uiLibrary.deviceMeta.noun.role.batterySensor') return 'Batteria'
  return typeof fallback === 'string' ? fallback : fallback.other
}

function paint(node: ReactNode, devices: readonly DeviceNameFields[] | null): void {
  render(
    <UiTextProvider t={italian}>
      <DeviceFleetProvider devices={devices}>{node}</DeviceFleetProvider>
    </UiTextProvider>,
  )
}

function ById({ id }: { readonly id: number }): ReactNode {
  const label = useDeviceLabelById(id, 'compact')
  return <span>{label}</span>
}

describe('DeviceName', () => {
  it('renders the stored name while the fleet has not answered', () => {
    paint(<DeviceName device={motion} form="compact" />, null)
    expect(screen.getByText('Motion')).toBeTruthy()
    expect(screen.queryByText('#3299')).toBeNull()
  })

  it('uses the fleet once it has answered', () => {
    paint(<DeviceName device={motion} form="full" />, [parent, motion, battery])
    expect(screen.getByText('Sensore movimento veranda · Movimento')).toBeTruthy()
  })

  it('a passed parent does not wait for the fleet', () => {
    paint(
      <DeviceName device={motion} form="nested" parent={parent} siblings={[motion, battery]} />,
      null,
    )
    expect(screen.getByText('Movimento')).toBeTruthy()
  })

  it('useDeviceLabelById is #id until the list answers, then the label', () => {
    paint(<ById id={3299} />, null)
    expect(screen.getByText('#3299')).toBeTruthy()
  })

  it('useDeviceLabelById names a device the list answered with', () => {
    paint(<ById id={3299} />, [parent, motion, battery])
    expect(screen.getByText('Sensore movimento veranda')).toBeTruthy()
  })
})
