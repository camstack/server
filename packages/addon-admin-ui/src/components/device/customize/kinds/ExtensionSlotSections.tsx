/**
 * The Customize rows of every extension slot a device hosts (D648). The table
 * is keyed by `ExtensionSlotId`, so a slot declared by a cap without rows here
 * is a type error, and `check-customize-coverage` confirms it from the generated
 * table. Hosting comes from the slot's own `hostDeviceTypes` (a device a host
 * can take as a source gets its rows from the other side), never from a device
 * type named in a tab. A slot's rows are a hook: the Customize table calls it
 * once for the devices that host the slot and renders the lines it returns.
 */
import type { DeviceInfo, ExtensionSlotId } from '@dominevo/types'
import { hostsLinkedDevices, type LinkedDevicesState, useLinkedDevices } from './LinkedDevicesRows'

export interface ExtensionSlotRows {
  /** Does a device of this type host the slot? */
  readonly hosts: (deviceType: string) => boolean
  readonly useRows: (device: DeviceInfo) => LinkedDevicesState
}

export const EXTENSION_SLOT_ROWS: Readonly<Record<ExtensionSlotId, ExtensionSlotRows>> = {
  'linked-devices': { hosts: hostsLinkedDevices, useRows: useLinkedDevices },
}
