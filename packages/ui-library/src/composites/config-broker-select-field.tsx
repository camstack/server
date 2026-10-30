/**
 * `broker-select` — the control of a schema field that picks a broker of one
 * kind. The host's picker (list + "Create new…") when it provided one, else a
 * plain select over the existing brokers. The kind is data, never named here.
 */
import type { JSX } from 'react'
import type { ConfigBrokerSelectField } from '@camstack/types'
import { useBrokerList } from '../generated/system-hooks'
import { useBrokerPickerSlot } from '../contexts/broker-picker-slot'
import { useUiText } from '../contexts/ui-text'
import { Select } from '../primitives/select'

interface BrokerRow {
  readonly id: string
  readonly name: string
  readonly kind: string
}

function toRows(data: unknown): readonly BrokerRow[] {
  if (!Array.isArray(data)) return []
  const rows: BrokerRow[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const row: Record<string, unknown> = { ...entry }
    const { id, name, kind } = row
    if (typeof id === 'string' && typeof kind === 'string') {
      rows.push({ id, kind, name: typeof name === 'string' ? name : id })
    }
  }
  return rows
}

function PlainBrokerSelect({
  kind,
  value,
  onChange,
  disabled,
  controlId,
}: {
  readonly kind: string
  readonly value: string
  readonly onChange: (brokerId: string) => void
  readonly disabled?: boolean
  readonly controlId: string
}): JSX.Element {
  const t = useUiText()
  const query = useBrokerList({ kind })
  const rows = toRows(query.data).filter((row) => row.kind === kind)
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
            : t('uiLibrary.configFormField.select', '— Select —'),
        },
        ...rows.map((row) => ({ value: row.id, label: row.name })),
      ]}
    />
  )
}

export function ConfigBrokerSelectControl({
  field,
  value,
  onChange,
  disabled,
  controlId,
}: {
  readonly field: ConfigBrokerSelectField
  readonly value: unknown
  readonly onChange: (brokerId: string) => void
  readonly disabled?: boolean
  readonly controlId: string
}): JSX.Element {
  const Picker = useBrokerPickerSlot()
  const current = typeof value === 'string' ? value : ''
  if (Picker !== null) {
    return (
      <Picker
        kind={field.brokerKind}
        value={current === '' ? null : current}
        onChange={(brokerId) => onChange(brokerId ?? '')}
      />
    )
  }
  return (
    <PlainBrokerSelect
      kind={field.brokerKind}
      value={current}
      onChange={onChange}
      disabled={disabled || field.disabled}
      controlId={controlId}
    />
  )
}
