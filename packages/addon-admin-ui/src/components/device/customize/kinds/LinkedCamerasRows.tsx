/**
 * The linked-devices slot seen from the OTHER side (D648), as rows of the
 * Customize table: on a device a camera can link, the cameras that link it —
 * and only them — are lines of the one table, like the linked actions. Cameras
 * are added through the table's "+ Add" picker (the shared device picker: host
 * cameras not yet linked), never ticked for the operator (D356).
 *
 * Which cameras link this device is ONE read (`getLinkedDevicesBatch`), never a
 * row per camera. The camera's slot stays the one owner: every add and remove
 * is a read-modify-write of THAT camera's slot from what it was just read
 * (D49), refused while that read is pending or failed (D315), so a camera's
 * other ids and its tracked opt-in survive untouched.
 */
import type { DeviceInfo } from '@camstack/types'
import {
  deviceTypeMetaOf,
  IconButton,
  trpc,
  useDeviceExtensionSetSlot,
  useDeviceManagerGetLinkedDevicesBatch,
  useUiText,
} from '@camstack/ui-library'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  candidateDetail,
} from '../assignments/assignment-candidates'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import type { Known } from '../known'
import { SourceSelectorDevicesDialog } from '../source-selector/SourceSelectorDevicesDialog'
import { useConfirmRemove } from '../use-confirm-remove'
import { LinkedNameCell } from './LinkedNameCell'
import {
  type LinkedSlotRead,
  linksDevice,
  linkedSlotOf,
  slotRelationOf,
  withLinkToggled,
} from './linked-devices-model'

export type LinkedCameraTableLine =
  | { readonly kind: 'cameraSection' }
  | { readonly kind: 'cameraPending' }
  | { readonly kind: 'cameraError'; readonly message: string }
  | { readonly kind: 'cameraEntry'; readonly camera: CandidateDevice }

export function isLinkedCameraLine(line: { readonly kind: string }): line is LinkedCameraTableLine {
  return (
    line.kind === 'cameraSection' ||
    line.kind === 'cameraPending' ||
    line.kind === 'cameraError' ||
    line.kind === 'cameraEntry'
  )
}

export interface LinkedCamerasState {
  readonly device: DeviceInfo
  /** The lines to list: nothing while no camera links this device and nothing went wrong. */
  readonly lines: readonly LinkedCameraTableLine[]
  /** Some host camera does not link this device yet: "+ Add" offers it. */
  readonly canAdd: boolean
  readonly busy: boolean
  readonly openPicker: () => void
  /** Each linked camera's own slot, read ONCE for the whole table (the remove path). */
  readonly slotOf: (cameraId: number) => LinkedSlotRead
  /** Re-read which cameras link this device, after these cameras' own slots were written. */
  readonly refresh: (written: readonly number[]) => Promise<void>
  readonly dialog: ReactNode
}

/** Does a device get the "linked cameras" rows: a camera can link it, but it hosts no slot itself. */
export function hasLinkedCameras(deviceType: string): boolean {
  return slotRelationOf('linked-devices', deviceType) === 'guest'
}

const LINKED_SLOTS_KEY = 'linkedCameraSlots'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useLinkedCameras(device: DeviceInfo): LinkedCamerasState {
  const { t } = useTranslation()
  const uiText = useUiText()
  const queryClient = useQueryClient()
  const utils = trpc.useUtils()
  const setSlot = useDeviceExtensionSetSlot()
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const fleet = useCandidateDevices(true)
  const cameras: readonly CandidateDevice[] =
    fleet.kind === 'known'
      ? fleet.value.filter((d) => slotRelationOf('linked-devices', d.type) === 'host')
      : []
  // ONE read for every camera's resolved linked set: which of them link this device.
  const linkage = useDeviceManagerGetLinkedDevicesBatch(
    { deviceIds: cameras.map((c) => c.id) },
    { enabled: fleet.kind === 'known' && cameras.length > 0 },
  )

  const linkedCameras: Known<readonly CandidateDevice[]> =
    fleet.kind !== 'known'
      ? fleet
      : cameras.length === 0
        ? { kind: 'known', value: [] }
        : linkage.status === 'error'
          ? { kind: 'unknown', reason: linkage.error.message }
          : linkage.data === undefined
            ? { kind: 'pending' }
            : {
                kind: 'known',
                value: cameras.filter((c) =>
                  linkage.data.some(
                    (row) =>
                      row.deviceId === c.id && row.devices.some((d) => d.deviceId === device.id),
                  ),
                ),
              }

  const linkedIds = new Set(
    linkedCameras.kind === 'known' ? linkedCameras.value.map((c) => c.id) : [],
  )
  const candidates: Known<readonly AssignmentCandidate[]> =
    linkedCameras.kind !== 'known'
      ? linkedCameras
      : {
          kind: 'known',
          value: cameras
            .filter((c) => !linkedIds.has(c.id))
            .map((c) => ({
              deviceId: c.id,
              ref: { addonId: c.addonId, stableId: c.stableId },
              name: c.name,
              detail: candidateDetail(c.integration, c.location),
              meta: deviceTypeMetaOf(c.type, uiText).label,
              caps: [],
              value: null,
            })),
        }

  // ONE read for the table: every linked camera's own slot, for the remove path
  // (the implied flag and the write base). A camera whose read failed is its own
  // `unknown`, never a failure of the others.
  const linkedCameraIds = linkedCameras.kind === 'known' ? linkedCameras.value.map((c) => c.id) : []
  const slotReads = useQuery({
    queryKey: [LINKED_SLOTS_KEY, device.id, linkedCameraIds.join(',')],
    enabled: linkedCameraIds.length > 0,
    queryFn: async (): Promise<ReadonlyMap<number, LinkedSlotRead>> => {
      const entries = await Promise.all(
        linkedCameraIds.map(async (id): Promise<readonly [number, LinkedSlotRead]> => {
          try {
            const rows = await utils.deviceExtension.listSlots.fetch(
              { deviceId: id },
              { staleTime: 0 },
            )
            return [id, linkedSlotOf({ status: 'success', data: rows, error: null })]
          } catch (err: unknown) {
            return [id, { kind: 'unknown', reason: messageOf(err) }]
          }
        }),
      )
      return new Map(entries)
    },
  })
  const slotOf = (cameraId: number): LinkedSlotRead =>
    slotReads.data?.get(cameraId) ?? { kind: 'pending' }

  // Only what a camera's write touched: its own slot reads and this table's own
  // reads — never the whole deviceManager tree.
  const refresh = async (written: readonly number[]): Promise<void> => {
    await Promise.all([
      ...written.map((deviceId) => utils.deviceExtension.listSlots.invalidate({ deviceId })),
      queryClient.invalidateQueries({ queryKey: [LINKED_SLOTS_KEY, device.id] }),
      linkage.refetch(),
    ])
  }

  /** Each picked camera: its slot read fresh, this device added, written back whole (D49). */
  const addCameras = async (picked: readonly AssignmentCandidate[]): Promise<void> => {
    if (busy) {
      setRefusal(t('customize.saveInFlight'))
      return
    }
    setBusy(true)
    setRefusal(null)
    const failures: string[] = []
    for (const camera of picked) {
      try {
        const rows = await utils.deviceExtension.listSlots.fetch(
          { deviceId: camera.deviceId },
          { staleTime: 0 },
        )
        const read = linkedSlotOf({ status: 'success', data: rows, error: null })
        if (read.kind === 'unknown') {
          failures.push(`${camera.name}: ${read.reason}`)
          continue
        }
        if (read.kind !== 'present') {
          failures.push(`${camera.name}: ${t('customize.assign.none')}`)
          continue
        }
        await setSlot.mutateAsync({
          deviceId: camera.deviceId,
          slotRef: read.slot.slotRef,
          value: withLinkToggled(read.value, device.id, true),
          expectedUpdatedAt: read.slot.updatedAt,
        })
      } catch (err: unknown) {
        failures.push(`${camera.name}: ${messageOf(err)}`)
      }
    }
    if (failures.length > 0) {
      setRefusal(t('customize.linked.someFailed', { failures: failures.join('; ') }))
    }
    try {
      await refresh(picked.map((c) => c.deviceId))
    } finally {
      setBusy(false)
    }
  }

  const problem: LinkedCameraTableLine | null =
    linkedCameras.kind === 'unknown'
      ? {
          kind: 'cameraError',
          message:
            fleet.kind === 'unknown'
              ? t('customize.assign.devicesUnreadable', { reason: linkedCameras.reason })
              : t('customize.linked.camerasUnreadable', { reason: linkedCameras.reason }),
        }
      : refusal !== null
        ? { kind: 'cameraError', message: refusal }
        : null
  const entries: readonly LinkedCameraTableLine[] =
    linkedCameras.kind === 'known'
      ? linkedCameras.value.map((camera) => ({ kind: 'cameraEntry' as const, camera }))
      : linkedCameras.kind === 'pending'
        ? [{ kind: 'cameraPending' }]
        : []
  const lines: readonly LinkedCameraTableLine[] =
    entries.length === 0 && problem === null
      ? []
      : [{ kind: 'cameraSection' }, ...entries, ...(problem === null ? [] : [problem])]

  return {
    device,
    lines,
    canAdd: candidates.kind === 'known' && candidates.value.length > 0,
    busy,
    openPicker: () => setPicking(true),
    slotOf,
    refresh,
    dialog: (
      <SourceSelectorDevicesDialog
        open={picking}
        title={t('customize.linked.pickCameraTitle')}
        selection="multi"
        candidates={candidates}
        confirmLabel={(count) => t('customize.assign.addCount', { count })}
        onConfirm={(picked) => {
          setPicking(false)
          void addCameras(picked)
        }}
        onClose={() => setPicking(false)}
      />
    ),
  }
}

function Muted({ children }: { readonly children: ReactNode }): ReactNode {
  return <span className="text-xs text-foreground-subtle">{children}</span>
}

export function LinkedCameraItem({ line }: { readonly line: LinkedCameraTableLine }): ReactNode {
  const { t } = useTranslation()
  switch (line.kind) {
    case 'cameraSection':
      return (
        <span
          className="text-[11px] font-medium uppercase tracking-wide text-foreground-muted"
          title={t('customize.linked.reverseHint')}
        >
          {t('customize.table.section.linkedCameras')}
        </span>
      )
    case 'cameraPending':
      return (
        <span role="status" className="text-xs text-foreground-subtle">
          {t('customize.assign.checking')}
        </span>
      )
    case 'cameraError':
      return (
        <span role="alert" className="text-xs text-danger break-words">
          {line.message}
        </span>
      )
    case 'cameraEntry':
      return (
        <LinkedNameCell
          name={line.camera.name}
          deviceId={line.camera.id}
          detail={null}
          to={`/devices/${String(line.camera.id)}`}
        />
      )
  }
}

export function LinkedCameraValue({ line }: { readonly line: LinkedCameraTableLine }): ReactNode {
  if (line.kind !== 'cameraEntry') return null
  const detail = candidateDetail(line.camera.integration, line.camera.location)
  return <Muted>{detail ?? '—'}</Muted>
}

interface CameraUnlinkProps {
  readonly camera: CandidateDevice
  readonly state: LinkedCamerasState
}

/** One linked camera's remove: its slot is read fresh AFTER the confirm and written back whole without this device. */
function CameraUnlink({ camera, state }: CameraUnlinkProps): ReactNode {
  const { t } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const utils = trpc.useUtils()
  const setSlot = useDeviceExtensionSetSlot()
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const read = state.slotOf(camera.id)
  const implied =
    read.kind === 'present' && linksDevice(read.slot, read.value, state.device.id).implied
  // D49: the table's read only gates the button and shows the implied flag; the
  // WRITE is built from a read taken after the confirm, so a link another
  // operator added while the dialog was open survives, and the write carries
  // that read's stamp, so one made between the read and the write is refused.
  const unlink = async (): Promise<void> => {
    if (read.kind !== 'present' || busy) return
    const accepted = await confirmRemove(
      t('customize.linked.removeFromCamera', { camera: camera.name, device: state.device.name }),
      false,
    )
    if (!accepted) return
    setBusy(true)
    setRefusal(null)
    try {
      const rows = await utils.deviceExtension.listSlots.fetch(
        { deviceId: camera.id },
        { staleTime: 0 },
      )
      const fresh = linkedSlotOf({ status: 'success', data: rows, error: null })
      if (fresh.kind === 'unknown') throw new Error(fresh.reason)
      if (fresh.kind !== 'present') throw new Error(t('customize.assign.none'))
      await setSlot.mutateAsync({
        deviceId: camera.id,
        slotRef: fresh.slot.slotRef,
        value: withLinkToggled(fresh.value, state.device.id, false),
        expectedUpdatedAt: fresh.slot.updatedAt,
      })
      await state.refresh([camera.id])
    } catch (err: unknown) {
      setRefusal(messageOf(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      {!implied && (
        <IconButton
          icon={X}
          variant="ghost"
          size="sm"
          aria-label={t('customize.assign.removeNamed', { name: camera.name })}
          disabled={read.kind !== 'present' || busy}
          onClick={(e) => {
            e.stopPropagation()
            void unlink()
          }}
        />
      )}
      {read.kind === 'pending' && (
        <span role="status" className="text-[11px] text-foreground-subtle">
          {t('customize.assign.checking')}
        </span>
      )}
      {read.kind === 'unknown' && (
        <span role="alert" className="text-[11px] text-warning break-words text-right">
          {t('customize.assign.unknown', { reason: read.reason })}
        </span>
      )}
      {read.kind === 'absent' && (
        <span role="alert" className="text-[11px] text-warning break-words text-right">
          {t('customize.assign.unknown', { reason: t('customize.assign.none') })}
        </span>
      )}
      {implied && (
        <span className="text-[11px] text-foreground-subtle text-right">
          {t('customize.linked.impliedByStructure')}
        </span>
      )}
      {refusal !== null && (
        <span role="alert" className="text-[11px] text-danger break-words text-right">
          {refusal}
        </span>
      )}
    </div>
  )
}

export function LinkedCameraButtons({
  line,
  state,
}: {
  readonly line: LinkedCameraTableLine
  readonly state: LinkedCamerasState
}): ReactNode {
  if (line.kind !== 'cameraEntry') return null
  return <CameraUnlink camera={line.camera} state={state} />
}
