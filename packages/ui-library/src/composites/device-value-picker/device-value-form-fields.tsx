import type { ConfigDeviceMultiSelectField, ConfigDeviceSelectField } from '@camstack/types'
import type { JSX } from 'react'
import type { TranslationFn } from '../config-form-builder'
import { DeviceMultiSelectField, DeviceSelectField, FieldShell } from '../device-select-field'
import { DeviceValuePicker } from './DeviceValuePicker'
import {
  deviceIdStrings,
  pickedFromDeviceIdString,
  pickedFromDeviceIdStrings,
} from './device-value-picker-model'

interface FormFieldProps<F> {
  readonly field: F
  readonly value: unknown
  readonly onChange: (v: unknown) => void
  readonly disabled?: boolean
  readonly translationFn?: TranslationFn
}

/**
 * `device-select` / `device-multiselect` in a schema form. The stored shape
 * is unchanged — device ids as strings — so a form stores only the device
 * even though the picker offers values: rows pick the whole device.
 *
 * `deviceFilter` maps onto the search: `caps` become the required
 * capabilities, `types` the fixed types, the two exclusions are applied to
 * the list. A filter that UNIONs `caps` with `types`, and `suggestLocation`
 * (a room NAME, where the search takes a context device), have no search
 * equivalent yet: those fields keep the earlier client-side picker.
 */
function filterParts(filter: ConfigDeviceSelectField['deviceFilter']) {
  const caps = filter?.caps ?? []
  return {
    caps,
    requires: caps.length > 0 ? { caps, mode: 'any' as const } : undefined,
    fixedTypes: filter?.types,
    excludeIds: filter?.excludeDeviceId === undefined ? undefined : [filter.excludeDeviceId],
    excludeTypes: filter?.excludeTypes,
    union: caps.length > 0 && (filter?.types?.length ?? 0) > 0,
  }
}

export function DeviceSelectFormField(
  props: FormFieldProps<ConfigDeviceSelectField>,
): JSX.Element | null {
  const { field, value, onChange, disabled, translationFn } = props
  const parts = filterParts(field.deviceFilter)
  if (parts.union) return <DeviceSelectField {...props} />
  return (
    <FieldShell
      label={field.label}
      description={field.description}
      required={field.required}
      translationFn={translationFn}
    >
      <DeviceValuePicker
        variant="inline"
        pick="device"
        requires={parts.requires}
        fixedTypes={parts.fixedTypes}
        excludeIds={parts.excludeIds}
        excludeTypes={parts.excludeTypes}
        disabled={disabled || field.disabled}
        clearable={field.required !== true}
        recentKey={field.key}
        value={pickedFromDeviceIdString(value)}
        onChange={(picked) => onChange(picked === null ? '' : String(picked.deviceId))}
      />
    </FieldShell>
  )
}

export function DeviceMultiSelectFormField(
  props: FormFieldProps<ConfigDeviceMultiSelectField>,
): JSX.Element | null {
  const { field, value, onChange, disabled, translationFn } = props
  const parts = filterParts(field.deviceFilter)
  if (parts.union || (field.suggestLocation ?? null) !== null) {
    return <DeviceMultiSelectField {...props} />
  }
  return (
    <FieldShell
      label={field.label}
      description={field.description}
      required={field.required}
      translationFn={translationFn}
    >
      <DeviceValuePicker
        multiple
        variant="inline"
        pick="device"
        requires={parts.requires}
        fixedTypes={parts.fixedTypes}
        excludeIds={parts.excludeIds}
        excludeTypes={parts.excludeTypes}
        maxItems={field.maxItems}
        disabled={disabled || field.disabled}
        recentKey={field.key}
        value={pickedFromDeviceIdStrings(value)}
        onChange={(picked) => onChange(deviceIdStrings(picked))}
      />
    </FieldShell>
  )
}
