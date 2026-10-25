/**
 * Customize's device-link dialog: the shared {@link DevicePicker} (Rules /
 * Automations chrome) over owner-filtered candidates. Selection is confirmed
 * explicitly — the picker edits a draft until Confirm. The room's valid
 * candidates come first as "Suggested · <room>" (D749); their one-click add
 * is the same confirm, with that device alone.
 */
import {
  Button,
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  type DeviceListState,
  DevicePicker,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type PickerItem,
} from '@camstack/ui-library'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Known } from '../known'
import {
  type AssignmentCandidate,
  type AssignmentFilter,
  filterCandidates,
} from './assignment-candidates'
import { type RoomSuggestions, splitByRoom, suggestionContainer } from './room-suggestions'
import { SuggestedDevices } from './SuggestedDevices'

export type CustomizePickerSelection = 'single' | 'multi'

export interface CustomizeDevicePickerDialogProps {
  readonly open: boolean
  readonly title: string
  readonly selection: CustomizePickerSelection
  readonly candidates: Known<readonly AssignmentCandidate[]>
  readonly filters?: readonly AssignmentFilter[]
  /** The host's room; null/absent = no suggestions group. */
  readonly room?: RoomSuggestions | null
  readonly confirmLabel: (count: number) => string
  readonly onConfirm: (picked: readonly AssignmentCandidate[]) => void
  readonly onClose: () => void
}

function listStateOf(candidates: Known<readonly AssignmentCandidate[]>): DeviceListState {
  if (candidates.kind === 'pending') return 'pending'
  if (candidates.kind === 'unknown') return 'failed'
  return 'answered'
}

function toPickerItems(candidates: readonly AssignmentCandidate[]): readonly PickerItem<number>[] {
  return candidates.map((c) => ({
    id: c.deviceId,
    name: c.name,
    ...(c.meta !== null ? { type: c.meta } : {}),
    ...(c.detail !== null
      ? {
          location: c.detail.includes(' · ') ? (c.detail.split(' · ').at(-1) ?? null) : c.detail,
        }
      : {}),
    ...(c.detail !== null ? { detail: c.detail } : {}),
  }))
}

export function CustomizeDevicePickerDialog({
  open,
  title,
  selection,
  candidates,
  filters,
  room = null,
  confirmLabel,
  onConfirm,
  onClose,
}: CustomizeDevicePickerDialogProps): ReactNode {
  const { t } = useTranslation()
  const [filterId, setFilterId] = useState<string | null>(null)
  const [picked, setPicked] = useState<readonly number[]>([])
  const filter = filters?.find((f) => f.id === filterId) ?? filters?.[0] ?? null
  const answered = candidates.kind === 'known' ? candidates.value : []
  const filtered = candidates.kind === 'known' ? filterCandidates(candidates.value, '', filter) : []
  // The suggestions are every room candidate valid for the card — the kind chips narrow only the list below.
  const suggested = splitByRoom(answered, room, (c) => c.deviceId).suggested
  const others = splitByRoom(filtered, room, (c) => c.deviceId).others
  const devices = useMemo(() => toPickerItems(others), [others])
  const listState = listStateOf(candidates)
  const pickedCandidates = answered.filter((c) => picked.includes(c.deviceId))

  useEffect(() => {
    if (!open) {
      setPicked([])
      setFilterId(null)
    }
  }, [open])

  const close = (): void => {
    setPicked([])
    setFilterId(null)
    onClose()
  }
  const confirmWith = (chosen: readonly AssignmentCandidate[]): void => {
    if (chosen.length === 0) return
    onConfirm(chosen)
    setPicked([])
    setFilterId(null)
  }
  const confirm = (): void => confirmWith(pickedCandidates)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2 p-2 sm:p-4">
          {filters !== undefined && filters.length > 0 && (
            <div
              className="flex flex-wrap gap-1"
              role="tablist"
              aria-label={t('customize.assign.filtersLabel')}
            >
              {filters.map((f) => (
                <button
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
                </button>
              ))}
            </div>
          )}
          {room !== null && (
            <SuggestedDevices
              location={room.location}
              devices={suggested.map((c) => ({
                id: c.deviceId,
                name: c.name,
                container: suggestionContainer(room, c.deviceId),
                detail: c.detail,
              }))}
              action="add"
              onPick={(id) => confirmWith(suggested.filter((c) => c.deviceId === id))}
              {...(selection === 'multi' ? { onPickAll: () => confirmWith(suggested) } : {})}
            />
          )}
          {candidates.kind === 'unknown' ? (
            <p role="alert" className="text-xs text-warning">
              {t('customize.assign.unknown', { reason: candidates.reason })}
            </p>
          ) : devices.length === 0 && suggested.length > 0 ? null : (
            <DevicePicker
              devices={devices}
              listState={listState}
              value={picked}
              onChange={(next) =>
                setPicked(
                  selection === 'single' ? (next.length > 0 ? [next[next.length - 1]!] : []) : next,
                )
              }
              noun="device"
              emptyLabel={t('customize.assign.none')}
              showAll
              testId="customize-device-picker"
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {t('customize.picker.cancel')}
          </Button>
          <Button disabled={pickedCandidates.length === 0} onClick={confirm}>
            {confirmLabel(pickedCandidates.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
