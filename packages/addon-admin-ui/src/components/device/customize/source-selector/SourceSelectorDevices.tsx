/**
 * Device half of `SourceSelector` for a surface that links other devices (Linked
 * devices, Triggered by, a composition's command rows): the shared
 * {@link DevicePicker} over owner-filtered candidates, kind chips, and the room's
 * valid candidates first as "Suggested · <room>" (D749). Names are the common
 * device label, so a child reads with its parent like every other device list.
 */
import {
  Button,
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  type DeviceListState,
  DevicePicker,
  type PickerItem,
  resolveDeviceLabel,
  useDeviceNameIndex,
  useDeviceNameNouns,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type AssignmentCandidate,
  type AssignmentFilter,
  filterCandidates,
} from '../assignments/assignment-candidates'
import {
  type RoomSuggestions,
  splitByRoom,
  suggestionContainer,
} from '../assignments/room-suggestions'
import { SuggestedDevices } from '../assignments/SuggestedDevices'
import type { Known } from '../known'

export type SourceSelectorDevicesSelection = 'single' | 'multi'

export interface SourceSelectorDevicesProps {
  readonly kind: 'devices'
  readonly selection: SourceSelectorDevicesSelection
  readonly candidates: Known<readonly AssignmentCandidate[]>
  readonly filters?: readonly AssignmentFilter[]
  /** The host's room; null/absent = no suggestions group. */
  readonly room?: RoomSuggestions | null
  readonly picked: readonly number[]
  readonly onPickedChange: (ids: readonly number[]) => void
  /** A suggestion's one-click add: the host confirms exactly these devices. */
  readonly onChoose: (chosen: readonly AssignmentCandidate[]) => void
}

function listStateOf(candidates: Known<readonly AssignmentCandidate[]>): DeviceListState {
  if (candidates.kind === 'pending') return 'pending'
  if (candidates.kind === 'unknown') return 'failed'
  return 'answered'
}

function toPickerItems(
  candidates: readonly AssignmentCandidate[],
  labelOf: (candidate: AssignmentCandidate) => string,
): readonly PickerItem<number>[] {
  return candidates.map((c) => ({
    id: c.deviceId,
    name: labelOf(c),
    ...(c.meta !== null ? { type: c.meta } : {}),
    ...(c.detail !== null
      ? {
          location: c.detail.includes(' · ') ? (c.detail.split(' · ').at(-1) ?? null) : c.detail,
        }
      : {}),
    ...(c.detail !== null ? { detail: c.detail } : {}),
  }))
}

export function SourceSelectorDevices({
  selection,
  candidates,
  filters,
  room = null,
  picked,
  onPickedChange,
  onChoose,
}: SourceSelectorDevicesProps): ReactNode {
  const { t } = useTranslation()
  const index = useDeviceNameIndex()
  const nouns = useDeviceNameNouns()
  const [filterId, setFilterId] = useState<string | null>(null)
  const filter = filters?.find((f) => f.id === filterId) ?? filters?.[0] ?? null
  const labelOf = (c: AssignmentCandidate): string => {
    const known = index?.byId.get(c.deviceId)
    return known === undefined ? c.name : resolveDeviceLabel(known, 'compact', index, nouns)
  }
  const answered = candidates.kind === 'known' ? candidates.value : []
  const filtered = candidates.kind === 'known' ? filterCandidates(candidates.value, '', filter) : []
  // The suggestions are every room candidate valid for the card — the kind chips narrow only the list below.
  const suggested = splitByRoom(answered, room, (c) => c.deviceId).suggested
  const others = splitByRoom(filtered, room, (c) => c.deviceId).others
  const devices = toPickerItems(others, labelOf)
  return (
    <div data-testid="source-selector" className="flex flex-col gap-2">
      {filters !== undefined && filters.length > 0 && (
        <div
          className="flex flex-wrap gap-1"
          role="tablist"
          aria-label={t('customize.assign.filtersLabel')}
        >
          {filters.map((f) => (
            <Button
              variant="unstyled"
              key={f.id}
              type="button"
              role="tab"
              aria-selected={(filter?.id ?? null) === f.id}
              className={`${CHIP_BASE} ${
                (filter?.id ?? null) === f.id ? CHIP_ACTIVE : CHIP_INACTIVE
              }`}
              onClick={() => setFilterId(f.id)}
            >
              {t(f.labelKey)}
            </Button>
          ))}
        </div>
      )}
      {room !== null && (
        <SuggestedDevices
          location={room.location}
          devices={suggested.map((c) => ({
            id: c.deviceId,
            name: labelOf(c),
            container: suggestionContainer(room, c.deviceId),
            detail: c.detail,
          }))}
          action="add"
          onPick={(id) => onChoose(suggested.filter((c) => c.deviceId === id))}
          {...(selection === 'multi' ? { onPickAll: () => onChoose(suggested) } : {})}
        />
      )}
      {candidates.kind === 'unknown' ? (
        <p role="alert" className="text-xs text-warning">
          {t('customize.assign.unknown', { reason: candidates.reason })}
        </p>
      ) : devices.length === 0 && suggested.length > 0 ? null : (
        <DevicePicker
          devices={devices}
          listState={listStateOf(candidates)}
          value={picked}
          onChange={(next) =>
            onPickedChange(
              selection === 'single' ? (next.length > 0 ? [next[next.length - 1]!] : []) : next,
            )
          }
          noun="device"
          emptyLabel={t('customize.assign.none')}
          showAll
          testId="customize-device-picker"
        />
      )}
    </div>
  )
}
