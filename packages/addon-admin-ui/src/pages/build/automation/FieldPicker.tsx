/**
 * Device → value, the one picker every surface here shares — and it is the
 * common `SourceSelector` (D944 §5), not a list of its own: the device column
 * scrolls inside its container, shows the parent, groups by room and suggests
 * the siblings, and the values column lists the fields with their live reading.
 *
 * A trigger that watches a field and a condition that compares one are asking
 * the same question, so they ask it with the same control — and both get the
 * field's KIND from the same place, which is what lets the operator list narrow
 * honestly instead of offering `>` next to a boolean.
 *
 * Choosing a device clears the field. That is not tidiness: `power-switch.on`
 * left behind after the device changes is a perfectly well-formed row that
 * reads a field the new device does not have, and the leaf evaluates FALSE
 * forever without ever looking broken.
 */

import { Button, ItemFormDialog, useDeviceManagerListAll } from '@camstack/ui-library'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type PickerDevice,
  toPickerDevices,
} from '../../../components/device/customize/source-picker-model'
import { SourceSelector } from '../../../components/device/customize/source-selector/SourceSelector'
import { type AutomationDevice, fieldsOfCap, useWireableFields } from './automation-data'
import type { WireableField } from './recipe-parts'

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
  const [open, setOpen] = useState(false)
  const device = devices.find((d) => d.id === value.deviceId)
  const summary =
    value.deviceId === 0
      ? t('automation.fieldPicker.pickAValue', 'Pick a device value…')
      : `${device?.name ?? `#${String(value.deviceId)}`}${
          value.cap === '' ? '' : ` · ${value.cap}.${value.fieldPath}`
        }`

  return (
    <div className="min-w-[14rem] max-w-full flex-[2]">
      <PickerLabel>{t('automation.fieldPicker.value', 'Device value')}</PickerLabel>
      <Button
        variant="outline"
        className="w-full min-w-0 justify-between"
        data-testid="field-picker-open"
        onClick={() => setOpen(true)}
      >
        <span className="w-0 flex-1 truncate text-left">{summary}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </Button>
      {open && (
        <FieldPickerDialog
          value={value}
          devices={devices}
          onCancel={() => setOpen(false)}
          onConfirm={(next) => {
            setOpen(false)
            onChange(next)
          }}
        />
      )}
    </div>
  )
}

interface FieldPickerDialogProps {
  readonly value: FieldSelection
  readonly devices: readonly AutomationDevice[]
  readonly onCancel: () => void
  readonly onConfirm: (next: FieldSelection) => void
}

/** The common selector in a dialog: destination (this surface) → device → value. */
function FieldPickerDialog({
  value,
  devices,
  onCancel,
  onConfirm,
}: FieldPickerDialogProps): ReactNode {
  const { t } = useTranslation()
  const fleet = useDeviceManagerListAll({ projection: 'slim' })
  const allowed = useMemo(() => new Set(devices.map((d) => d.id)), [devices])
  const deviceFilter = useMemo(
    () =>
      (d: PickerDevice): boolean =>
        allowed.has(d.id),
    [allowed],
  )
  const [picked, setPicked] = useState<PickerDevice | null>(null)
  const [seeded, setSeeded] = useState(false)
  const [field, setField] = useState<{ cap: string; path: string } | null>(
    value.cap === '' ? null : { cap: value.cap, path: value.fieldPath },
  )
  if (!seeded && fleet.status === 'success') {
    setSeeded(true)
    setPicked(toPickerDevices(fleet.data).find((d) => d.id === value.deviceId) ?? null)
  }
  const title = t('automation.fieldPicker.title', 'Device value')
  return (
    <ItemFormDialog
      open
      onClose={onCancel}
      title={title}
      width="xl"
      fill
      testId="field-picker-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={picked === null || field === null}
            data-testid="field-picker-confirm"
            onClick={() => {
              if (picked === null || field === null) return
              onConfirm({
                deviceId: picked.id,
                cap: field.cap,
                fieldPath: field.path,
              })
            }}
          >
            {t('automation.fieldPicker.use', 'Use this value')}
          </Button>
        </>
      }
    >
      <SourceSelector
        kind="formula"
        enabled
        fillHeight
        hostId={-1}
        destination={{
          cap: 'automation',
          targetId: 'field',
          title,
          pickerTargetKind: null,
        }}
        device={picked}
        field={field}
        deviceFilter={deviceFilter}
        onDeviceChange={setPicked}
        onFieldChange={setField}
      />
    </ItemFormDialog>
  )
}
