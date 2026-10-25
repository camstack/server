/**
 * SensorInlineControl — registry-compatible wrapper around SensorValueAtom.
 *
 * Bridges the registry's `DeviceControlProps` (trpc, deviceId, features) into
 * SensorValueAtom's `{trpc, device}` shape by fetching the device row (role)
 * from `deviceManager.getDevice`. Returns null while the device row is loading
 * or when no role is found (not a sensor accessory).
 *
 * Unit resolution happens in SensorValueAtom: typed roles use the descriptor's
 * canonical unit; generic numeric-sensor reads unit live from the slice.
 * sourceInfo is no longer needed here.
 */
import type { ReactNode } from 'react'
import { useDeviceManagerGetDevice } from '../../generated/system-hooks'
import { SensorValueAtom } from './sensor-value-atom'
import type { DeviceControlProps } from './control-registry'
import type { DeviceItemDevice } from '../device-item/helpers'

/**
 * Minimal subset of DeviceInfoSchema fields needed to construct a
 * DeviceItemDevice for SensorValueAtom. Structural — not imported from
 * a generated schema so the component doesn't couple to a specific output
 * shape at compile time.
 */
interface DeviceInfoRow {
  readonly id: number
  readonly stableId: string
  readonly addonId: string
  readonly type: string
  readonly name: string
  readonly online: boolean
  readonly disabled: boolean
  readonly parentDeviceId: number | null
  readonly role?: string | null
  readonly features?: readonly string[]
}

function toDeviceItemDevice(row: DeviceInfoRow): DeviceItemDevice {
  return {
    id: row.id,
    stableId: row.stableId,
    addonId: row.addonId,
    type: row.type,
    name: row.name,
    online: row.online,
    disabled: row.disabled,
    parentDeviceId: row.parentDeviceId,
    role: row.role ?? undefined,
    features: row.features,
  }
}

/**
 * Registry InlineControl for Sensor and Presence device types.
 *
 * Fetches the device row once (React Query cache — no waterfall for
 * repeated renders), maps to DeviceItemDevice, and delegates rendering
 * to the existing SensorValueAtom so both the row special-case path and
 * the registry path stay in sync.
 */
export function SensorInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const { data } = useDeviceManagerGetDevice({ deviceId }, { staleTime: 60_000 })

  if (data === undefined) return null

  const device = toDeviceItemDevice(data as DeviceInfoRow)

  return <SensorValueAtom trpc={trpc} device={device} />
}
