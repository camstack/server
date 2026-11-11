import type { DeviceSearchRequires } from '@camstack/types'
import { useMemo } from 'react'
import {
  useDeviceManagerGetWireableFields,
  useDeviceStateGetSnapshot,
} from '../../generated/system-hooks'
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
  /** The fit of a field as a short phrase ('' = as is), or null when it does not fit: then it is not offered. */
  readonly fit: (field: DeviceValueCandidate) => string | null
  readonly capTitle: (cap: string) => string
  readonly fieldLabel: (cap: string, path: string) => string
}

export interface DeviceValueSource {
  /** What the device search must require: pass it to `DeviceValueField`'s `requires`. */
  readonly requires: DeviceSearchRequires | undefined
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

/**
 * The data half of the device → value picker: what the device search requires,
 * and the picked device's fitting values. The device list itself is the field's
 * search panel.
 */
export function useDeviceValueSource(options: DeviceValueSourceOptions): DeviceValueSource {
  const capNames = options.capNames
  const requires = useMemo(
    (): DeviceSearchRequires | undefined =>
      capNames !== undefined && capNames.length > 0
        ? { caps: [...capNames], mode: 'any' }
        : undefined,
    [capNames],
  )
  const id = options.deviceId ?? 0
  const wireable = useDeviceManagerGetWireableFields({ deviceId: id }, { enabled: id !== 0 })
  const snapshot = useDeviceStateGetSnapshot({ deviceId: id }, { enabled: id !== 0 })
  const { fit, capTitle, fieldLabel } = options

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

  const valuesState: DeviceValuesState =
    wireable.status === 'error' || snapshot.status === 'error'
      ? 'failed'
      : wireable.status === 'success' && snapshot.status === 'success'
        ? 'ready'
        : 'loading'
  return { requires, valuesState, groups }
}
