/**
 * Device pins the session path cannot honour (D748): the pinned key is enabled
 * and available on NO node (`disabled`), or no node offers it at all
 * (`absent`). The session path ignores such a pin (said once); the Load
 * balancing tab lists it with a one-click clear. Never cleared here. Pure.
 */
import type { StaleDevicePin } from '@camstack/types'

export interface PinnedCamera {
  readonly deviceId: number
  readonly deviceKey: string
}

export interface OfferedDevices {
  readonly devices: readonly {
    readonly key: string
    readonly enabled: boolean
    readonly available: boolean
  }[]
}

export function findStaleDevicePins(
  pins: readonly PinnedCamera[],
  nodes: readonly OfferedDevices[],
): readonly StaleDevicePin[] {
  const usable = new Map<string, boolean>()
  for (const node of nodes) {
    for (const d of node.devices) {
      usable.set(d.key, (usable.get(d.key) ?? false) || (d.enabled && d.available))
    }
  }
  return pins
    .flatMap((pin): StaleDevicePin[] => {
      const state = usable.get(pin.deviceKey)
      if (state === true) return []
      return [
        {
          deviceId: pin.deviceId,
          deviceKey: pin.deviceKey,
          reason: state === false ? 'disabled' : 'absent',
        },
      ]
    })
    .toSorted((a, b) => a.deviceId - b.deviceId)
}
