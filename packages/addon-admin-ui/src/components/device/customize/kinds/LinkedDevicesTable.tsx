/**
 * Linked devices (spec U7): the D648 `linked-devices` slot as a {@link DeviceList}
 * (generic mode, same chrome as alarm sensors) plus the shared DevicePicker
 * dialog. Tracked = on camera timeline only — notification stills follow the
 * link alone.
 */
import { type DeviceInfo, EXTENSION_HOST_DEVICE_TYPES } from '@camstack/types'
import {
  DeviceList,
  type DeviceListColumn,
  deviceTypeMetaOf,
  IconButton,
  Switch,
  TEXT_HINT,
  useDeviceExtensionListCandidates,
  useDeviceExtensionListSlots,
  useDeviceExtensionSetSlot,
  useUiText,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AssignmentSection } from '../assignments/AssignmentSection'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  candidateDetail,
} from '../assignments/assignment-candidates'
import { CustomizeDevicePickerDialog } from '../assignments/CustomizeDevicePickerDialog'
import { suggestedCount } from '../assignments/room-suggestions'
import { useRoomSuggestions } from '../assignments/use-room-suggestions'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import type { Known } from '../known'
import { useConfirmRemove } from '../use-confirm-remove'
import {
  type LinkedRow,
  type LinkedSlotValue,
  linkedCandidates,
  linkedRows,
  linkedSlotOf,
  orphanTrackedIds,
  withLinked,
  withoutLinked,
  withTracked,
} from './linked-devices-model'

export interface LinkedDevicesTableProps {
  readonly device: DeviceInfo
}

interface LinkedTableRow extends LinkedRow {
  readonly type: string | null
  readonly detail: string | null
  /** A stored opt-in whose device is no longer linked: shown to be untracked, never unlinked. */
  readonly orphan: boolean
}

function errorMessage(error: { readonly message: string } | null | undefined): string | null {
  return error === null || error === undefined ? null : error.message
}

export function LinkedDevicesTable({ device }: LinkedDevicesTableProps): ReactNode {
  const uiText = useUiText()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirmRemove = useConfirmRemove()
  const isHost = EXTENSION_HOST_DEVICE_TYPES.includes(device.type)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const slots = useDeviceExtensionListSlots({ deviceId: device.id }, { enabled: isHost })
  const read = linkedSlotOf({
    status: slots.status,
    data: slots.data,
    error: errorMessage(slots.error) === null ? null : { message: errorMessage(slots.error) ?? '' },
  })
  const slotRef = read.kind === 'present' ? read.slot.slotRef : ''
  const shownIds =
    read.kind === 'present'
      ? [
          ...linkedRows(read.slot, read.value).map((r) => r.deviceId),
          ...orphanTrackedIds(read.slot, read.value),
        ]
      : []
  const setSlot = useDeviceExtensionSetSlot()
  const fleet = useCandidateDevices(
    isHost && read.kind === 'present' && (picking || shownIds.length > 0),
  )
  // The room's suggestions are counted on the header, so the owner's candidates are read while it can add.
  const room = useRoomSuggestions(device.location, isHost && read.kind === 'present')
  const offered = useDeviceExtensionListCandidates(
    { deviceId: device.id, slotRef },
    { enabled: (picking || room !== null) && read.kind === 'present' },
  )
  if (!isHost || read.kind === 'absent') return null

  if (read.kind !== 'present') {
    return (
      <AssignmentSection
        id="linked"
        icon={Link2}
        title={t('customize.linked.title')}
        notices={
          read.kind === 'pending' ? (
            <p role="status" className="text-xs text-foreground-subtle">
              {t('customize.assign.checking')}
            </p>
          ) : (
            <p role="alert" className="text-xs text-warning break-words">
              {t('customize.assign.unknown', { reason: read.reason })}
            </p>
          )
        }
      >
        {null}
      </AssignmentSection>
    )
  }

  const value = read.value
  const fleetById = new Map<number, CandidateDevice>(
    fleet.kind === 'known' ? fleet.value.map((d) => [d.id, d]) : [],
  )
  const trackable = value.trackedDeviceIds !== undefined
  const named = (r: LinkedRow, orphan: boolean): LinkedTableRow => {
    const known = fleetById.get(r.deviceId)
    return {
      ...r,
      name: r.name ?? known?.name ?? null,
      type: known?.type ?? null,
      detail: known === undefined ? null : candidateDetail(known.integration, known.location),
      orphan,
    }
  }
  const rows: readonly LinkedTableRow[] = [
    ...linkedRows(read.slot, value).map((r) => named(r, false)),
    ...orphanTrackedIds(read.slot, value).map((deviceId) =>
      named({ deviceId, name: null, health: 'ok', implied: false, tracked: true }, true),
    ),
  ]
  const linkedIds = new Set(shownIds)

  const candidates: Known<readonly AssignmentCandidate[]> =
    fleet.kind === 'unknown'
      ? fleet
      : offered.status === 'error'
        ? {
            kind: 'unknown',
            reason: errorMessage(offered.error) ?? t('helpers.customize.requestFailed'),
          }
        : fleet.kind === 'pending' || offered.status === 'pending' || offered.data === undefined
          ? { kind: 'pending' }
          : {
              kind: 'known',
              value: linkedCandidates(offered.data.candidates, fleetById, linkedIds),
            }

  const write = async (next: LinkedSlotValue): Promise<void> => {
    if (busy) {
      setRefusal(t('customize.saveInFlight'))
      return
    }
    setBusy(true)
    setRefusal(null)
    try {
      await setSlot.mutateAsync({
        deviceId: device.id,
        slotRef: read.slot.slotRef,
        value: next,
      })
      await slots.refetch()
      await queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    } catch (err: unknown) {
      setRefusal(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const unlink = async (row: LinkedTableRow): Promise<void> => {
    const name = row.name ?? `#${row.deviceId}`
    if (await confirmRemove(t('customize.linked.removeWhat', { name }), false)) {
      await write(withoutLinked(value, row.deviceId))
    }
  }

  const columns: readonly DeviceListColumn<LinkedTableRow>[] = [
    {
      key: 'device',
      header: t('customize.linked.device'),
      cell: (r) => (
        <div className="flex flex-col min-w-0">
          <span className="truncate text-xs text-foreground">{r.name ?? `#${r.deviceId}`}</span>
          {r.detail !== null && (
            <span className="truncate text-[11px] text-foreground-subtle">{r.detail}</span>
          )}
          {r.orphan && (
            <span className="text-[11px] text-foreground-subtle">
              {t('customize.linked.notLinked')}
            </span>
          )}
          {r.health !== 'ok' && (
            <span role="alert" className="text-[11px] text-warning">
              {t(`customize.linked.health.${r.health}`)}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: t('customize.linked.type'),
      headerClassName: 'hidden sm:table-cell',
      cellClassName: 'hidden sm:table-cell text-xs text-foreground-subtle',
      cell: (r) => (r.type === null ? '—' : deviceTypeMetaOf(r.type, uiText).label),
    },
    {
      key: 'controls',
      header: t('customize.linked.controls'),
      headerClassName: 'hidden md:table-cell',
      cellClassName: 'hidden md:table-cell text-xs text-foreground-subtle',
      cell: (r) => (r.orphan ? '—' : t('customize.linked.yes')),
    },
    ...(trackable
      ? [
          {
            key: 'tracked',
            header: t('customize.linked.tracked'),
            cellClassName: 'text-right',
            headerClassName: 'text-right',
            cell: (r: LinkedTableRow) => (
              <Switch
                checked={r.tracked}
                disabled={busy}
                aria-label={t('customize.linked.trackFor', {
                  name: r.name ?? r.deviceId,
                })}
                onCheckedChange={(next) => void write(withTracked(value, r.deviceId, next))}
              />
            ),
          } satisfies DeviceListColumn<LinkedTableRow>,
        ]
      : []),
    {
      key: 'remove',
      header: '',
      cellClassName: 'text-right w-10',
      cell: (r) =>
        r.implied || r.orphan ? null : (
          <IconButton
            icon={X}
            variant="ghost"
            size="sm"
            aria-label={t('customize.assign.removeNamed', {
              name: r.name ?? r.deviceId,
            })}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              void unlink(r)
            }}
          />
        ),
    },
  ]

  return (
    <>
      <AssignmentSection
        id="linked"
        icon={Link2}
        title={t('customize.linked.title')}
        addLabel={t('customize.linked.add')}
        onAdd={busy ? undefined : () => setPicking(true)}
        {...(room === null
          ? {}
          : {
              suggestion: {
                count: suggestedCount(candidates, room, (c) => c.deviceId),
                location: room.location,
                onOpen: () => setPicking(true),
              },
            })}
        notices={
          <>
            {fleet.kind === 'unknown' && (
              <p role="alert" className="text-xs text-warning break-words">
                {t('customize.assign.devicesUnreadable', {
                  reason: fleet.reason,
                })}
              </p>
            )}
            {refusal !== null && (
              <p role="alert" className="text-xs text-danger break-words">
                {refusal}
              </p>
            )}
          </>
        }
      >
        <li className="list-none px-3 py-2 sm:px-4">
          {rows.length === 0 ? (
            <p className="text-[11px] text-foreground-subtle">{t('customize.assign.none')}</p>
          ) : (
            <DeviceList<LinkedTableRow>
              mode="generic"
              items={rows}
              getKey={(r) => String(r.deviceId)}
              getSearchText={(r) =>
                [r.name ?? '', r.detail ?? '', r.type ?? '', String(r.deviceId)].join(' ')
              }
              getFilterType={(r) =>
                r.type === null ? null : deviceTypeMetaOf(r.type, uiText).label
              }
              columns={columns}
              searchPlaceholder={t('customize.assign.search')}
              emptyLabel={t('customize.assign.none')}
            />
          )}
          {rows.some((r) => !r.orphan) && (
            <p className={`mt-2 ${TEXT_HINT}`}>{t('customize.linked.controlsAlways')}</p>
          )}
          {trackable && (
            <p className={`mt-0.5 ${TEXT_HINT}`}>{t('customize.linked.trackedHint')}</p>
          )}
        </li>
      </AssignmentSection>
      <CustomizeDevicePickerDialog
        open={picking}
        title={t('customize.linked.pickTitle')}
        selection="multi"
        candidates={candidates}
        room={room}
        confirmLabel={(count) => t('customize.assign.addCount', { count })}
        onConfirm={(picked) => {
          setPicking(false)
          void write(
            withLinked(
              value,
              picked.map((c) => c.deviceId),
            ),
          )
        }}
        onClose={() => setPicking(false)}
      />
    </>
  )
}
