/**
 * Linked devices (spec U7), as rows of the Customize table: the D648
 * `linked-devices` slot a host camera owns. Tracked = on camera timeline only —
 * notification stills follow the link alone. The list is edited in a local
 * draft (planning#675, D1098); Save writes the slot once, carrying the stamp it
 * was read at. Devices are added through the table's "+ Add" picker (the shared
 * device picker, with the room's suggestions), never ticked for the operator.
 */
import type { DeviceInfo } from '@dominevo/types'
import {
  Button,
  deviceTypeMetaOf,
  IconButton,
  Switch,
  useDeviceExtensionListCandidates,
  useDeviceExtensionListSlots,
  useDeviceExtensionSetSlot,
  useUiText,
} from '@dominevo/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Sparkles, X } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  candidateDetail,
} from '../assignments/assignment-candidates'
import { suggestedCount } from '../assignments/room-suggestions'
import { useRoomSuggestions } from '../assignments/use-room-suggestions'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { useDraftSection } from '../customize-draft'
import type { Known } from '../known'
import { SourceSelectorDevicesDialog } from '../source-selector/SourceSelectorDevicesDialog'
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

export interface LinkedDeviceTableRow extends LinkedRow {
  readonly type: string | null
  readonly detail: string | null
  /** A stored opt-in whose device is no longer linked: shown to be untracked, never unlinked. */
  readonly orphan: boolean
}

export type LinkedDeviceHint = 'controls' | 'tracked'

export type LinkedDeviceTableLine =
  | { readonly kind: 'deviceSection' }
  | { readonly kind: 'devicePending' }
  | { readonly kind: 'deviceEmpty' }
  | { readonly kind: 'deviceNotice'; readonly message: string }
  | { readonly kind: 'deviceEntry'; readonly row: LinkedDeviceTableRow }
  | { readonly kind: 'deviceHint'; readonly hint: LinkedDeviceHint }

export function isLinkedDeviceLine(line: { readonly kind: string }): line is LinkedDeviceTableLine {
  return (
    line.kind === 'deviceSection' ||
    line.kind === 'devicePending' ||
    line.kind === 'deviceEmpty' ||
    line.kind === 'deviceNotice' ||
    line.kind === 'deviceEntry' ||
    line.kind === 'deviceHint'
  )
}

export interface LinkedDevicesState {
  /** Nothing while the device hosts no slot or its slot is absent. */
  readonly lines: readonly LinkedDeviceTableLine[]
  /** The slot is read and not being saved: "+ Add" offers a device. */
  readonly canAdd: boolean
  readonly busy: boolean
  /** The slot carries a tracked opt-in: each row offers its switch. */
  readonly trackable: boolean
  /** The room's suggestions among the offered devices, drawn on the section line. */
  readonly suggestion: { readonly count: number; readonly location: string } | null
  readonly openPicker: () => void
  readonly setTracked: (deviceId: number, tracked: boolean) => void
  /** Asks first, then drops the device from the draft. */
  readonly unlink: (row: LinkedDeviceTableRow) => void
  readonly dialog: ReactNode
}

/** Does a device host the linked-devices slot (a camera lists the devices it links)? */
export function hostsLinkedDevices(deviceType: string): boolean {
  return slotRelationOf('linked-devices', deviceType) === 'host'
}

function errorMessage(error: { readonly message: string } | null | undefined): string | null {
  return error === null || error === undefined ? null : error.message
}

export function useLinkedDevices(device: DeviceInfo): LinkedDevicesState {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirmRemove = useConfirmRemove()
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
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
    label: t('customize.linked.title'),
    pendingCount: draft === null ? 0 : 1,
    save: () => commitRef.current(),
    discard: () => setDraft(null),
  })
  const fleet = useCandidateDevices(read.kind === 'present' && (picking || shownIds.length > 0))
  // The room's suggestions are counted on the section line, so the owner's candidates are read while it can add.
  const room = useRoomSuggestions(device.location, read.kind === 'present')
  const offered = useDeviceExtensionListCandidates(
    { deviceId: device.id, slotRef },
    { enabled: (picking || room !== null) && read.kind === 'present' },
  )
  const fleetById = new Map<number, CandidateDevice>(
    fleet.kind === 'known' ? fleet.value.map((d) => [d.id, d]) : [],
  )
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

  const value = read.kind === 'present' ? (draft ?? read.value) : null
  const trackable = value?.trackedDeviceIds !== undefined
  const named = (r: LinkedRow, orphan: boolean): LinkedDeviceTableRow => {
    const known = fleetById.get(r.deviceId)
    return {
      ...r,
      name: r.name ?? known?.name ?? null,
      type: known?.type ?? null,
      detail: known === undefined ? null : candidateDetail(known.integration, known.location),
      orphan,
    }
  }
  const rows: readonly LinkedDeviceTableRow[] =
    read.kind === 'present' && value !== null
      ? (() => {
          const rowSlot =
            draft === null
              ? read.slot
              : slotForValue(read.slot, value, (id) => fleetById.get(id)?.name ?? null)
          return [
            ...linkedRows(rowSlot, value).map((r) => named(r, false)),
            ...orphanTrackedIds(rowSlot, value).map((deviceId) =>
              named({ deviceId, name: null, health: 'ok', implied: false, tracked: true }, true),
            ),
          ]
        })()
      : []

  /** The one write: the stamp the slot was read at, then the refetch that hands the next write its own. */
  commitRef.current = async (): Promise<string | null> => {
    if (draft === null || read.kind !== 'present') return null
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

  const lines: readonly LinkedDeviceTableLine[] =
    read.kind === 'absent'
      ? []
      : read.kind === 'pending'
        ? [{ kind: 'deviceSection' }, { kind: 'devicePending' }]
        : read.kind === 'unknown'
          ? [
              { kind: 'deviceSection' },
              {
                kind: 'deviceNotice',
                message: t('customize.assign.unknown', { reason: read.reason }),
              },
            ]
          : [
              { kind: 'deviceSection' },
              ...(fleet.kind === 'unknown'
                ? [
                    {
                      kind: 'deviceNotice' as const,
                      message: t('customize.assign.devicesUnreadable', { reason: fleet.reason }),
                    },
                  ]
                : []),
              ...(rows.length === 0
                ? [{ kind: 'deviceEmpty' as const }]
                : rows.map((row) => ({ kind: 'deviceEntry' as const, row }))),
              ...(rows.some((r) => !r.orphan)
                ? [{ kind: 'deviceHint' as const, hint: 'controls' as const }]
                : []),
              ...(trackable ? [{ kind: 'deviceHint' as const, hint: 'tracked' as const }] : []),
            ]

  const canAdd = read.kind === 'present' && !busy
  return {
    lines,
    canAdd,
    busy,
    trackable,
    suggestion:
      room === null
        ? null
        : {
            count: suggestedCount(candidates, room, (c) => c.deviceId),
            location: room.location,
          },
    openPicker: () => setPicking(true),
    setTracked: (deviceId, tracked) => {
      if (value !== null) setDraft(withTracked(value, deviceId, tracked))
    },
    unlink: (row) => {
      if (value === null) return
      const name = row.name ?? `#${row.deviceId}`
      void confirmRemove(t('customize.linked.removeWhat', { name }), false).then((accepted) => {
        if (accepted) setDraft(withoutLinked(value, row.deviceId))
      })
    },
    dialog: (
      <SourceSelectorDevicesDialog
        open={picking}
        title={t('customize.linked.pickTitle')}
        selection="multi"
        candidates={candidates}
        room={room}
        confirmLabel={(count) => t('customize.assign.addCount', { count })}
        onConfirm={(picked) => {
          setPicking(false)
          if (value !== null) {
            setDraft(
              withLinked(
                value,
                picked.map((c) => c.deviceId),
              ),
            )
          }
        }}
        onClose={() => setPicking(false)}
      />
    ),
  }
}

function Muted({ children }: { readonly children: ReactNode }): ReactNode {
  return <span className="text-xs text-foreground-subtle">{children}</span>
}

export function LinkedDeviceItem({ line }: { readonly line: LinkedDeviceTableLine }): ReactNode {
  const { t } = useTranslation()
  switch (line.kind) {
    case 'deviceSection':
      return (
        <span className="text-[11px] font-medium uppercase tracking-wide text-foreground-muted">
          {t('customize.table.section.linked')}
        </span>
      )
    case 'devicePending':
      return (
        <span role="status" className="text-xs text-foreground-subtle">
          {t('customize.assign.checking')}
        </span>
      )
    case 'deviceEmpty':
      return <Muted>{t('customize.assign.none')}</Muted>
    case 'deviceNotice':
      return (
        <span role="alert" className="text-xs text-warning break-words">
          {line.message}
        </span>
      )
    case 'deviceHint':
      return (
        <span className="text-[11px] text-foreground-muted">
          {line.hint === 'controls'
            ? t('customize.linked.controlsAlways')
            : t('customize.linked.trackedHint')}
        </span>
      )
    case 'deviceEntry':
      return (
        <LinkedNameCell name={line.row.name} deviceId={line.row.deviceId} detail={line.row.detail}>
          {line.row.orphan && (
            <span className="text-[11px] text-foreground-subtle">
              {t('customize.linked.notLinked')}
            </span>
          )}
          <span
            className="text-[11px] text-foreground-subtle"
            data-testid={`linked-controls-${line.row.deviceId}`}
          >
            {t('customize.linked.controls')}: {line.row.orphan ? '—' : t('customize.linked.yes')}
          </span>
          {line.row.health !== 'ok' && (
            <span role="alert" className="text-[11px] text-warning">
              {t(`customize.linked.health.${line.row.health}`)}
            </span>
          )}
        </LinkedNameCell>
      )
  }
}

export function LinkedDeviceValue({ line }: { readonly line: LinkedDeviceTableLine }): ReactNode {
  const uiText = useUiText()
  if (line.kind !== 'deviceEntry') return null
  return (
    <Muted>{line.row.type === null ? '—' : deviceTypeMetaOf(line.row.type, uiText).label}</Muted>
  )
}

export function LinkedDeviceSource({
  line,
  state,
}: {
  readonly line: LinkedDeviceTableLine
  readonly state: LinkedDevicesState
}): ReactNode {
  const { t } = useTranslation()
  if (line.kind !== 'deviceEntry' || !state.trackable) return null
  const { row } = line
  return (
    <label className="flex items-center gap-2 text-[11px] text-foreground-muted">
      {t('customize.linked.tracked')}
      <Switch
        checked={row.tracked}
        disabled={state.busy}
        aria-label={t('customize.linked.trackFor', { name: row.name ?? row.deviceId })}
        onCheckedChange={(next) => state.setTracked(row.deviceId, next)}
      />
    </label>
  )
}

export function LinkedDeviceButtons({
  line,
  state,
}: {
  readonly line: LinkedDeviceTableLine
  readonly state: LinkedDevicesState
}): ReactNode {
  const { t } = useTranslation()
  if (line.kind === 'deviceSection') {
    const suggestion = state.suggestion
    if (!state.canAdd || suggestion === null || suggestion.count === 0) return null
    return (
      <Button variant="ghost" size="sm" onClick={state.openPicker}>
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        {t('customize.suggest.hint', { count: suggestion.count, location: suggestion.location })}
      </Button>
    )
  }
  if (line.kind !== 'deviceEntry') return null
  const { row } = line
  if (row.implied || row.orphan) return null
  return (
    <IconButton
      icon={X}
      variant="ghost"
      size="sm"
      aria-label={t('customize.assign.removeNamed', { name: row.name ?? row.deviceId })}
      disabled={state.busy}
      onClick={(e) => {
        e.stopPropagation()
        state.unlink(row)
      }}
    />
  )
}
