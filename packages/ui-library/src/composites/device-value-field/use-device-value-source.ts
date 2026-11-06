import { useMemo } from 'react'
import {
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceManagerListDeviceIdsByCaps,
  useDeviceStateGetSnapshot,
} from '../../generated/system-hooks'
import type { PickerItem } from '../device-picker/device-picker-model'
import type { DeviceListState } from '../device-picker/device-selection'
import type { DeviceValueGroup, DeviceValuesState } from './device-value-field'

/** A field the picked device offers, as the adapter judges it. */
export interface DeviceValueCandidate {
  readonly cap: string
  readonly path: string
  readonly kind: string
  readonly unit: string | null
}

export interface DeviceValueSourceOptions {
  readonly deviceId: number | null
  /** Devices holding none of these caps are not listed (a device with no fitting value never shows). */
  readonly capNames?: readonly string[]
  /** Never offered: the host device itself. */
  readonly excludeIds?: readonly number[]
  /** The fit of a field as a short phrase ('' = as is), or null when it does not fit: then it is not offered. */
  readonly fit: (field: DeviceValueCandidate) => string | null
  readonly capTitle: (cap: string) => string
  readonly fieldLabel: (cap: string, path: string) => string
}

export interface DeviceValueSource {
  readonly devices: readonly PickerItem<number>[]
  readonly listState: DeviceListState
  readonly valuesState: DeviceValuesState
  readonly groups: readonly DeviceValueGroup[]
}

function text(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return value === null ? 'null' : JSON.stringify(value)
}

function readField(slice: unknown, path: string): unknown {
  let current: unknown = slice
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = Object.getOwnPropertyDescriptor(current, segment)?.value
  }
  return current
}

/** The data half of the device → value picker: the fleet, and the picked device's fitting values. */
export function useDeviceValueSource(options: DeviceValueSourceOptions): DeviceValueSource {
  const all = useDeviceManagerListAll({ projection: 'slim' })
  const capFilter = options.capNames !== undefined && options.capNames.length > 0
  const holders = useDeviceManagerListDeviceIdsByCaps(
    { capNames: [...(options.capNames ?? [])] },
    { enabled: capFilter },
  )
  const id = options.deviceId ?? 0
  const wireable = useDeviceManagerGetWireableFields({ deviceId: id }, { enabled: id !== 0 })
  const snapshot = useDeviceStateGetSnapshot({ deviceId: id }, { enabled: id !== 0 })
  const { fit, capTitle, fieldLabel, excludeIds } = options

  const devices = useMemo(() => {
    if (all.data === undefined) return []
    const holding = capFilter && holders.data !== undefined ? new Set(holders.data) : null
    return all.data
      .filter((d) => !(excludeIds ?? []).includes(d.id))
      .filter((d) => holding === null || holding.has(d.id))
      .map(
        (d): PickerItem<number> => ({
          id: d.id,
          name: d.name,
          type: d.type,
          location: d.location,
          parentDeviceId: d.parentDeviceId,
        }),
      )
  }, [all.data, holders.data, capFilter, excludeIds])

  const groups = useMemo((): readonly DeviceValueGroup[] => {
    // A unit is read from the snapshot: judge the values only once it answered (D315).
    if (wireable.data === undefined || snapshot.status !== 'success') return []
    return wireable.data.caps
      .map((entry) => {
        const unitRaw = readField(snapshot.data[entry.cap], 'unit')
        const unit = typeof unitRaw === 'string' && unitRaw !== '' ? unitRaw : null
        const rows = entry.fields
          .filter((f) => f.item !== true)
          .flatMap((f) => {
            const fitText = fit({ cap: entry.cap, path: f.path, kind: f.kind, unit })
            if (fitText === null) return []
            const value = readField(snapshot.data[entry.cap], f.path)
            return [
              {
                cap: entry.cap,
                path: f.path,
                label: fieldLabel(entry.cap, f.path),
                valueText: text(value),
                fitText,
              },
            ]
          })
        return { cap: entry.cap, title: capTitle(entry.cap), rows }
      })
      .filter((g) => g.rows.length > 0)
  }, [wireable.data, snapshot.status, snapshot.data, fit, capTitle, fieldLabel])

  const listState: DeviceListState =
    all.status === 'error' || (capFilter && holders.status === 'error')
      ? 'failed'
      : all.status === 'success' && (!capFilter || holders.status === 'success')
        ? 'answered'
        : 'pending'
  const valuesState: DeviceValuesState =
    wireable.status === 'error' || snapshot.status === 'error'
      ? 'failed'
      : wireable.status === 'success' && snapshot.status === 'success'
        ? 'ready'
        : 'loading'
  return { devices, listState, valuesState, groups }
}
