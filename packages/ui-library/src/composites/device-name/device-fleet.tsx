/**
 * One slim fleet, shared. A row reads its parent from this index — never a
 * `getDevice` per row (the Customize bounded-read rule). `null` is "not
 * answered yet": a label then keeps the stored name, so a list does not flash
 * `#id` while the fleet is in flight. An empty array is an answer.
 */
import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from 'react'
import { useDeviceManagerListAll } from '../../generated/system-hooks'
import type { DeviceNameFields } from './format-device-name'

export interface DeviceNameIndex {
  readonly byId: ReadonlyMap<number, DeviceNameFields>
  readonly childIds: ReadonlyMap<number, readonly number[]>
}

const DeviceNameIndexContext = createContext<DeviceNameIndex | null>(null)

export function useDeviceNameIndex(): DeviceNameIndex | null {
  return useContext(DeviceNameIndexContext)
}

function copyDevice(device: DeviceNameFields): DeviceNameFields {
  const label = device.display?.label
  const trimmed = label === undefined || label === null ? '' : label.trim()
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    stableId: device.stableId,
    role: device.role ?? null,
    parentDeviceId: device.parentDeviceId ?? null,
    location: device.location ?? null,
    ...(trimmed.length > 0 ? { display: { label: trimmed } } : {}),
    ...(device.primaryChildEntityId !== undefined
      ? { primaryChildEntityId: device.primaryChildEntityId }
      : {}),
    ...(device.userNamed === undefined ? {} : { userNamed: device.userNamed }),
  }
}

/** Build the parent/child maps once per fleet answer. */
export function indexDeviceNames(devices: readonly DeviceNameFields[]): DeviceNameIndex {
  const byId = new Map<number, DeviceNameFields>()
  const children = new Map<number, number[]>()
  for (const device of devices) {
    const fields = copyDevice(device)
    byId.set(fields.id, fields)
    const parentId = fields.parentDeviceId
    if (parentId === null || parentId === undefined || parentId === fields.id) continue
    const list = children.get(parentId)
    if (list === undefined) children.set(parentId, [fields.id])
    else list.push(fields.id)
  }
  return { byId, childIds: children }
}

export interface DeviceFleetProviderProps {
  /** `null` while the list has not answered. An array, including empty, has. */
  readonly devices: readonly DeviceNameFields[] | null
  readonly children: ReactNode
}

export function DeviceFleetProvider({ devices, children }: DeviceFleetProviderProps): ReactElement {
  const index = useMemo(() => (devices === null ? null : indexDeviceNames(devices)), [devices])
  return <DeviceNameIndexContext.Provider value={index}>{children}</DeviceNameIndexContext.Provider>
}

export interface DeviceFleetFromServerProps {
  readonly children: ReactNode
}

/**
 * The one `deviceManager.listAll` subscriber for names. Same query key the
 * pickers already use, so a second observer does not fetch a second fleet.
 */
export function DeviceFleetFromServer({ children }: DeviceFleetFromServerProps): ReactElement {
  const query = useDeviceManagerListAll({ projection: 'slim' })
  const devices = query.data === undefined ? null : query.data
  return <DeviceFleetProvider devices={devices}>{children}</DeviceFleetProvider>
}
