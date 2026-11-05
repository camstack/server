/**
 * The Customize sections of every extension slot a device hosts (D648). The
 * renderer table is keyed by `ExtensionSlotId`, so a slot declared by a cap
 * without a section here is a type error, and `check-customize-coverage`
 * confirms it from the generated table. Hosting comes from the slot's own
 * `hostDeviceTypes`, never from a device type named in a tab.
 */
import {
  EXTENSION_SLOT_IDS,
  EXTENSION_SLOTS,
  type DeviceInfo,
  type ExtensionSlotId,
} from '@camstack/types'
import type { ComponentType, ReactNode } from 'react'
import { LinkedDevicesTable } from './LinkedDevicesTable'

interface ExtensionSlotSectionProps {
  readonly device: DeviceInfo
}

export const EXTENSION_SLOT_SECTIONS: Readonly<
  Record<ExtensionSlotId, ComponentType<ExtensionSlotSectionProps>>
> = {
  'linked-devices': LinkedDevicesTable,
}

export function ExtensionSlotSections({ device }: ExtensionSlotSectionProps): ReactNode {
  return (
    <>
      {EXTENSION_SLOT_IDS.filter((id) =>
        EXTENSION_SLOTS[id].hostDeviceTypes.includes(device.type),
      ).map((id) => {
        const Section = EXTENSION_SLOT_SECTIONS[id]
        return <Section key={id} device={device} />
      })}
    </>
  )
}
