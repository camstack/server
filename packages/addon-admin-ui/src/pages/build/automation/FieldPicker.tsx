/**
 * Device → capability → field, the one picker every surface here shares.
 *
 * A trigger that watches a field and a condition that compares one are asking
 * the same question, so they ask it with the same control — and both get the
 * field's KIND from the same place, which is what lets the operator list narrow
 * honestly instead of offering `>` next to a boolean.
 *
 * Choosing a device clears the capability, and choosing a capability clears the
 * field. That is not tidiness: `power-switch.on` left behind after the device
 * changes is a perfectly well-formed row that reads a field the new device does
 * not have, and the leaf evaluates FALSE forever without ever looking broken.
 */

import { Select } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { type AutomationDevice, fieldsOfCap, useWireableFields } from './automation-data'
import type { WireableField } from './recipe-parts'
import { useTranslation } from 'react-i18next'
import i18n from '../../../i18n/index'

export interface FieldSelection {
  readonly deviceId: number
  readonly cap: string
  readonly fieldPath: string
}

export interface FieldPickerProps {
  readonly value: FieldSelection
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: FieldSelection) => void
}

/** The label above a control. One component so the whole editor's small print
 *  is the same size and colour — a form where it is not reads as unfinished. */
export function PickerLabel({ children }: { readonly children: ReactNode }) {
  return <span className="mb-1 block text-xs text-foreground-subtle">{children}</span>
}

/**
 * The descriptor of the currently selected field, when it can be resolved.
 *
 * `undefined` means "not known", never "not typed" — the fields may still be
 * loading, or the recipe may name a field a provider has since removed. Callers
 * must treat it as unknown rather than as a default.
 */
export function useFieldDescriptor(selection: FieldSelection): WireableField | undefined {
  const fields = useWireableFields(selection.deviceId)
  if (fields.data === undefined) return undefined
  return fieldsOfCap(fields.data, selection.cap).find((f) => f.path === selection.fieldPath)
}

export function FieldPicker({ value, devices, onChange }: FieldPickerProps) {
  const { t } = useTranslation()
  const fields = useWireableFields(value.deviceId)
  const caps = fields.data ?? []
  const capFields = fieldsOfCap(caps, value.cap)

  return (
    <>
      <label className="min-w-[10rem] flex-1">
        <PickerLabel>{t('automation.fieldPicker.device', 'Device')}</PickerLabel>
        <Select
          value={String(value.deviceId)}
          onChange={(e) => onChange({ deviceId: Number(e.target.value), cap: '', fieldPath: '' })}
          options={[
            { value: '0', label: t('automation.fieldPicker.selectADevice', 'Select a device…') },
            ...devices.map((d) => ({ value: String(d.id), label: d.name })),
          ]}
        />
      </label>

      <label className="min-w-[9rem] flex-1">
        <PickerLabel>{t('automation.fieldPicker.capability', 'Capability')}</PickerLabel>
        <Select
          value={value.cap}
          disabled={value.deviceId === 0}
          onChange={(e) => onChange({ ...value, cap: e.target.value, fieldPath: '' })}
          options={[
            { value: '', label: capsPlaceholder(value.deviceId, caps.length, fields.isLoading) },
            ...caps.map((c) => ({ value: c.cap, label: c.cap })),
          ]}
        />
      </label>

      <label className="min-w-[9rem] flex-1">
        <PickerLabel>{t('automation.fieldPicker.field', 'Field')}</PickerLabel>
        <Select
          value={value.fieldPath}
          disabled={value.cap === ''}
          onChange={(e) => onChange({ ...value, fieldPath: e.target.value })}
          options={[
            {
              value: '',
              label:
                capFields.length === 0
                  ? t('automation.fieldPicker.noReadableFields', 'No readable fields')
                  : t('automation.fieldPicker.selectAField', 'Select a field…'),
            },
            ...capFields.map((f) => ({ value: f.path, label: `${f.path} (${f.kind})` })),
          ]}
        />
      </label>
    </>
  )
}

/**
 * What the capability box says when it has nothing to offer.
 *
 * "No capabilities" while the read is still in flight states as fact the one
 * thing that is not yet known — the same mistake as rendering "no scripts" over
 * a failed list read.
 */
function capsPlaceholder(deviceId: number, count: number, loading: boolean): string {
  if (deviceId === 0) return i18n.t('automation.fieldPicker.pickDeviceFirst')
  if (loading) return i18n.t('automation.fieldPicker.readingDevice')
  if (count === 0) return i18n.t('automation.fieldPicker.noReadableCaps')
  return i18n.t('automation.fieldPicker.selectCap')
}
