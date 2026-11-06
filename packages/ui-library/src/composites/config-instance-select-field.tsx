/**
 * `instance-select` — the control of a schema field that links to an instance of one function cap
 * (D1013 rule 5). The host's picker (list + "Create new…") when it provided one, else a plain
 * select over the existing instances. The cap and kind are data, never named here.
 */
import type { JSX } from 'react'
import type { ConfigInstanceSelectField } from '@camstack/types'
import { useInstancePickerSlot } from '../contexts/instance-picker-slot'
import { useUiText } from '../contexts/ui-text'
import { selectableInstances, useInstancesOfCap } from '../hooks/use-instances-of-cap'
import { Select } from '../primitives/select'

function PlainInstanceSelect({
  field,
  value,
  onChange,
  disabled,
  controlId,
}: {
  readonly field: ConfigInstanceSelectField
  readonly value: string
  readonly onChange: (instanceId: string) => void
  readonly disabled?: boolean
  readonly controlId: string
}): JSX.Element {
  const t = useUiText()
  const query = useInstancesOfCap({
    functionCap: field.functionCap,
    ...(field.kind !== undefined ? { kind: field.kind } : {}),
  })
  const rows = selectableInstances(query.data ?? [], value)
  return (
    <Select
      id={controlId}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={[
        {
          value: '',
          label: query.isLoading
            ? t('uiLibrary.configFormField.loadingOptions', 'Loading options…')
            : field.noneLabel !== undefined
              ? t(field.noneLabelKey ?? 'uiLibrary.configFormField.select', field.noneLabel)
              : t('uiLibrary.configFormField.select', '— Select —'),
        },
        ...rows.map((row) => ({ value: row.id, label: row.name })),
      ]}
    />
  )
}

export function ConfigInstanceSelectControl({
  field,
  value,
  onChange,
  disabled,
  controlId,
}: {
  readonly field: ConfigInstanceSelectField
  readonly value: unknown
  readonly onChange: (instanceId: string) => void
  readonly disabled?: boolean
  readonly controlId: string
}): JSX.Element {
  const Picker = useInstancePickerSlot()
  const current = typeof value === 'string' ? value : ''
  if (Picker !== null) {
    return (
      <Picker
        functionCap={field.functionCap}
        {...(field.kind !== undefined ? { kind: field.kind } : {})}
        {...(field.noneLabel !== undefined ? { noneLabel: field.noneLabel } : {})}
        value={current === '' ? null : current}
        onChange={(instanceId) => onChange(instanceId ?? '')}
      />
    )
  }
  return (
    <PlainInstanceSelect
      field={field}
      value={current}
      onChange={onChange}
      disabled={disabled || field.disabled}
      controlId={controlId}
    />
  )
}
