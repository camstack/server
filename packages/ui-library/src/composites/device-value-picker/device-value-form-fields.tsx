import type { ConfigDeviceMultiSelectField, ConfigDeviceSelectField } from '@camstack/types'
import type { JSX, ReactNode } from 'react'
import { resolveLabel, type TranslationFn } from '../config-form-builder'
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

const LABEL_CLASS = 'block text-[11px] font-medium text-foreground mb-1 break-words'
const DESC_CLASS = 'text-[10px] text-foreground-subtle mt-0.5 break-words'

export interface FieldShellProps {
  readonly label?: string
  readonly description?: string
  readonly required?: boolean
  readonly translationFn?: TranslationFn
  readonly children: ReactNode
}

/** A schema field's label, required mark and description around its control. */
export function FieldShell({
  label,
  description,
  required,
  translationFn,
  children,
}: FieldShellProps): JSX.Element {
  const resolvedLabel = resolveLabel(label, translationFn)
  const resolvedDescription = resolveLabel(description, translationFn)
  const hasLabel = resolvedLabel !== undefined && resolvedLabel !== ''
  return (
    <div className="min-w-0">
      {hasLabel && (
        <label className={LABEL_CLASS}>
          {resolvedLabel}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      {children}
      {resolvedDescription && <p className={DESC_CLASS}>{resolvedDescription}</p>}
    </div>
  )
}

/**
 * `device-select` / `device-multiselect` in a schema form. The stored shape
 * is unchanged — device ids as strings — so a form stores only the device
 * even though the picker offers values: rows pick the whole device.
 *
 * `deviceFilter` maps onto the search: `caps` become the required
 * capabilities (any of them), `types` the fixed types, the two exclusions
 * are applied to the list. With both `caps` and `types`, a device must
 * satisfy both.
 */
function filterParts(filter: ConfigDeviceSelectField['deviceFilter']) {
  const caps = filter?.caps ?? []
  return {
    requires: caps.length > 0 ? { caps, mode: 'any' as const } : undefined,
    fixedTypes: filter?.types,
    excludeIds: filter?.excludeDeviceId === undefined ? undefined : [filter.excludeDeviceId],
    excludeTypes: filter?.excludeTypes,
  }
}

export function DeviceSelectFormField(
  props: FormFieldProps<ConfigDeviceSelectField>,
): JSX.Element | null {
  const { field, value, onChange, disabled, translationFn } = props
  const parts = filterParts(field.deviceFilter)
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
