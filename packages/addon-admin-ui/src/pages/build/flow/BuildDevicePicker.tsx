/**
 * The device picker every Build-your-self surface uses when only a DEVICE is
 * chosen (a trigger's source, a camera, a command's target): the ui-library
 * `DevicePicker`, fed from the editor's own device list. When a device's VALUE
 * is chosen too, the surface uses `FieldPicker` (the common `SourceSelector`).
 * A surface keeps its own validity rule by passing the list it allows.
 */
import { type DeviceListState, DevicePicker, type PickerNoun } from '@camstack/ui-library'
import { useMemo } from 'react'
import type { AutomationDevice } from '../automation/automation-data'

export interface BuildDevicePickerProps {
  /** The devices this surface may choose from. */
  readonly devices: readonly AutomationDevice[]
  readonly value: readonly number[]
  readonly onChange: (next: readonly number[]) => void
  readonly selection: 'single' | 'multiple'
  readonly noun?: PickerNoun
  readonly listState?: DeviceListState
  /** What an empty choice reads as, e.g. "Any device". */
  readonly emptyLabel?: string
  readonly testId: string
}

export function BuildDevicePicker({
  devices,
  value,
  onChange,
  selection,
  noun = 'device',
  listState = 'answered',
  emptyLabel,
  testId,
}: BuildDevicePickerProps) {
  const items = useMemo(
    () =>
      devices.map((d) => ({
        id: d.id,
        name: d.name,
        ...(d.type === undefined ? {} : { type: d.type }),
        location: d.location ?? null,
      })),
    [devices],
  )
  return (
    <DevicePicker
      devices={items}
      listState={listState}
      value={[...value]}
      onChange={(next) => onChange(next)}
      selection={selection}
      noun={noun}
      groupBy="location"
      {...(emptyLabel === undefined ? {} : { emptyLabel })}
      testId={testId}
    />
  )
}
