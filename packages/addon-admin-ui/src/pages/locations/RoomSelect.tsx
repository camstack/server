/**
 * The room selector of the Locations page: the library's searchable
 * {@link OptionSelect}, one option per room as "<name> · <device count>".
 *
 * It replaced a tab strip that scrolled sideways without end once a site had
 * dozens of rooms. The selection itself stays in the URL (`?room=`), owned by
 * the page — this component only draws the choice and reports it.
 */
import { OptionSelect, type OptionSelectOption } from '@camstack/ui-library'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

export interface RoomChoice {
  readonly name: string
  /** Top-level devices in the room. */
  readonly count: number
}

export interface RoomSelectProps {
  readonly rooms: readonly RoomChoice[]
  /** The extra "Unassigned" entry and how many devices it holds; absent = no such entry. */
  readonly unassignedCount?: number
  /** The selected room name, or `unassignedValue` for the Unassigned entry. */
  readonly value: string
  readonly unassignedValue: string
  readonly onChange: (next: string) => void
}

export function roomOptions(
  rooms: readonly RoomChoice[],
  unassignedCount: number | undefined,
  unassignedValue: string,
  unassignedLabel: string,
): readonly OptionSelectOption[] {
  const named = rooms.map((room) => ({
    value: room.name,
    label: `${room.name} · ${String(room.count)}`,
  }))
  return unassignedCount === undefined
    ? named
    : [
        ...named,
        { value: unassignedValue, label: `${unassignedLabel} · ${String(unassignedCount)}` },
      ]
}

export function RoomSelect({
  rooms,
  unassignedCount,
  value,
  unassignedValue,
  onChange,
}: RoomSelectProps) {
  const { t } = useTranslation()
  const options = useMemo(
    () =>
      roomOptions(rooms, unassignedCount, unassignedValue, t('locations.roomPicker.unassigned')),
    [rooms, unassignedCount, unassignedValue, t],
  )
  return (
    <div className="max-w-sm" data-testid="room-select">
      <OptionSelect
        mode="single"
        singleDisplay="field"
        label={t('locations.roomPicker.label')}
        placeholder={t('locations.roomPicker.placeholder')}
        options={options}
        value={value}
        onChange={onChange}
        searchable
        testId="room-select-control"
        optionTestIdPrefix="room-option"
      />
    </div>
  )
}
