/**
 * Linked devices (spec U7): the D648 `linked-devices` slot as a {@link DeviceList}
 * (generic mode, same chrome as alarm sensors) plus the shared DevicePicker
 * dialog. Tracked = on camera timeline only — notification stills follow the
 * link alone.
 */
import type { DeviceInfo } from '@camstack/types'
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
import { type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AssignmentSection } from '../assignments/AssignmentSection'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  candidateDetail,
} from '../assignments/assignment-candidates'
import { SourceSelectorDevicesDialog } from '../source-selector/SourceSelectorDevicesDialog'
import { suggestedCount } from '../assignments/room-suggestions'
import { useRoomSuggestions } from '../assignments/use-room-suggestions'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import type { Known } from '../known'
import { useDraftSection } from '../customize-draft'
import { useConfirmRemove } from '../use-confirm-remove'
import { LinkedNameCell } from './LinkedNameCell'
import {
  type LinkedRow,
  type LinkedSlotValue,
  linkedCandidates,
  linkedRows,
  linkedSlotOf,
  orphanTrackedIds,
  slotForValue,
  slotRelationOf,
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

/**
 * A camera lists the devices it links (the slot it hosts). A device a camera can
 * link has no table of its own: the cameras that link it are rows of the Customize
 * table (`LinkedCamerasRows`). A container is never a pick: nothing.
 */
export function LinkedDevicesTable({ device }: LinkedDevicesTableProps): ReactNode {
  const relation = slotRelationOf('linked-devices', device.type)
  if (relation === 'host') return <HostLinkedDevicesTable device={device} />
  return null
}

function HostLinkedDevicesTable({ device }: LinkedDevicesTableProps): ReactNode {
  const uiText = useUiText()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirmRemove = useConfirmRemove()
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  // The edited list, held until the tab's Save (planning#675); null = what the server holds.
  const [draft, setDraft] = useState<LinkedSlotValue | null>(null)
  const slots = useDeviceExtensionListSlots({ deviceId: device.id }, { enabled: true })
  const read = linkedSlotOf({
    status: slots.status,
    data: slots.data,
    error: errorMessage(slots.error) === null ? null : { message: errorMessage(slots.error) ?? '' },
  })
  const slotRef = read.kind === 'present' ? read.slot.slotRef : ''
  const shownSlot =
    read.kind === 'present' && draft !== null ? slotForValue(read.slot, draft, () => null) : null
  const shownIds =
    read.kind === 'present'
      ? [
          ...linkedRows(shownSlot ?? read.slot, draft ?? read.value).map((r) => r.deviceId),
          ...orphanTrackedIds(shownSlot ?? read.slot, draft ?? read.value),
        ]
      : []
  const setSlot = useDeviceExtensionSetSlot()
  const commitRef = useRef<() => Promise<string | null>>(async () => null)
  useDraftSection('linked-devices', {
    pendingCount: draft === null ? 0 : 1,
    save: () => commitRef.current(),
    discard: () => {
      setRefusal(null)
      setDraft(null)
    },
  })
  const fleet = useCandidateDevices(read.kind === 'present' && (picking || shownIds.length > 0))
  // The room's suggestions are counted on the header, so the owner's candidates are read while it can add.
  const room = useRoomSuggestions(device.location, read.kind === 'present')
  const offered = useDeviceExtensionListCandidates(
    { deviceId: device.id, slotRef },
    { enabled: (picking || room !== null) && read.kind === 'present' },
  )
  if (read.kind === 'absent') return null

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

  const value = draft ?? read.value
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
  const rowSlot =
    draft === null
      ? read.slot
      : slotForValue(read.slot, value, (id) => fleetById.get(id)?.name ?? null)
  const rows: readonly LinkedTableRow[] = [
    ...linkedRows(rowSlot, value).map((r) => named(r, false)),
    ...orphanTrackedIds(rowSlot, value).map((deviceId) =>
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

  const write = (next: LinkedSlotValue): void => setDraft(next)
  /** The one write: the stamp the slot was read at, then the refetch that hands the next write its own. */
  const commit = async (): Promise<string | null> => {
    if (draft === null) return null
    if (busy) return t('customize.saveInFlight')
    setBusy(true)
    try {
      await setSlot.mutateAsync({
        deviceId: device.id,
        slotRef: read.slot.slotRef,
        value: draft,
        expectedUpdatedAt: read.slot.updatedAt,
      })
      await slots.refetch()
      await queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
      setDraft(null)
      return null
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err)
    } finally {
      setBusy(false)
    }
  }
  commitRef.current = commit
  const unlink = async (row: LinkedTableRow): Promise<void> => {
    const name = row.name ?? `#${row.deviceId}`
    if (await confirmRemove(t('customize.linked.removeWhat', { name }), false)) {
      write(withoutLinked(value, row.deviceId))
    }
  }

  const columns: readonly DeviceListColumn<LinkedTableRow>[] = [
    {
      key: 'device',
      header: t('customize.linked.device'),
      cell: (r) => (
        <LinkedNameCell name={r.name} deviceId={r.deviceId} detail={r.detail}>
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
        </LinkedNameCell>
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
                onCheckedChange={(next) => write(withTracked(value, r.deviceId, next))}
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
      <SourceSelectorDevicesDialog
        open={picking}
        title={t('customize.linked.pickTitle')}
        selection="multi"
        candidates={candidates}
        room={room}
        confirmLabel={(count) => t('customize.assign.addCount', { count })}
        onConfirm={(picked) => {
          setPicking(false)
          write(
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
