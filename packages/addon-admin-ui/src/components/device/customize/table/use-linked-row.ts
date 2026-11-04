/**
 * What the Customize table says about the device's linked devices, read from
 * the same slot the Linked devices editor reads. Only a host device has the
 * slot (`hidden` otherwise); an unanswered read is `pending`, a failed one
 * `unknown` with its reason — never "none linked" (D315).
 */
import { type DeviceInfo, EXTENSION_HOST_DEVICE_TYPES } from '@camstack/types'
import { useDeviceExtensionListSlots } from '@camstack/ui-library'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { linkedRows, linkedSlotOf } from '../kinds/linked-devices-model'

export type LinkedRowRead =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown'; readonly reason: string }
  | {
      readonly kind: 'present'
      readonly names: readonly string[]
      /** The fleet that names a device the slot did not name has not answered yet. */
      readonly namesPending: boolean
    }

export function useLinkedRow(device: DeviceInfo): LinkedRowRead {
  const isHost = EXTENSION_HOST_DEVICE_TYPES.includes(device.type)
  const slots = useDeviceExtensionListSlots({ deviceId: device.id }, { enabled: isHost })
  const read = linkedSlotOf({
    status: slots.status,
    data: slots.data,
    error:
      slots.error === null || slots.error === undefined ? null : { message: slots.error.message },
  })
  const rows = read.kind === 'present' ? linkedRows(read.slot, read.value) : []
  const unnamed = rows.some((row) => row.name === null)
  const fleet = useCandidateDevices(isHost && unnamed)
  if (!isHost || read.kind === 'absent') return { kind: 'hidden' }
  if (read.kind !== 'present') return read
  const byId = new Map(fleet.kind === 'known' ? fleet.value.map((row) => [row.id, row.name]) : [])
  return {
    kind: 'present',
    names: rows.map((row) => row.name ?? byId.get(row.deviceId) ?? `#${row.deviceId}`),
    namesPending: unnamed && fleet.kind === 'pending',
  }
}
