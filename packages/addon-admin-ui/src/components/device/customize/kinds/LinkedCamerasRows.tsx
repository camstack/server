/**
 * The linked-devices slot seen from the OTHER side (D648), as rows of the
 * Customize table: on a device a camera can link, the cameras that link it —
 * and only them — are lines of the one table, like the linked actions. Cameras
 * are added through the table's "+ Add" picker (the shared device picker: host
 * cameras not yet linked), never ticked for the operator (D356).
 *
 * Which cameras link this device is ONE read (`getLinkedDevicesBatch`), never a
 * row per camera. An add or a remove edits the tab's draft (planning#675, D1098):
 * nothing is written until Save. The camera's slot stays the one owner: Save is
 * a read-modify-write of THAT camera's slot from a read taken at Save (D49),
 * carrying that read's stamp, so a camera's other ids and its tracked opt-in
 * survive untouched. A camera whose write succeeded leaves the draft; one that
 * failed stays in it with its reason.
 */
import type { DeviceInfo } from '@dominevo/types'
import {
  deviceTypeMetaOf,
  IconButton,
  trpc,
  useDeviceExtensionSetSlot,
  useDeviceManagerGetLinkedDevicesBatch,
  useUiText,
} from '@dominevo/ui-library'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  candidateDetail,
} from '../assignments/assignment-candidates'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { useDraftSection } from '../customize-draft'
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
  /** Each linked camera's own slot, read ONCE for the whole table (the implied flag). */
  readonly slotOf: (cameraId: number) => LinkedSlotRead
  /** Is this camera's link only in the draft (added, not saved yet)? */
  readonly isPendingAdd: (cameraId: number) => boolean
  /** Drop a camera from this device's links in the draft (an unsaved add simply disappears). */
  readonly unlink: (cameraId: number) => void
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

  // The edits held until the tab's Save: cameras to link and cameras to unlink.
  const [added, setAdded] = useState<readonly number[]>([])
  const [removed, setRemoved] = useState<readonly number[]>([])

  const storedCameras: Known<readonly CandidateDevice[]> =
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
  // What the table shows: the stored links with the draft applied.
  const linkedCameras: Known<readonly CandidateDevice[]> =
    storedCameras.kind !== 'known'
      ? storedCameras
      : {
          kind: 'known',
          value: [
            ...storedCameras.value.filter((c) => !removed.includes(c.id)),
            ...cameras.filter(
              (c) => added.includes(c.id) && !storedCameras.value.some((s) => s.id === c.id),
            ),
          ],
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

  // ONE read for the table: every stored linked camera's own slot, for the implied flag
  // (a link the structure implies cannot be removed). A camera whose read failed is its own
  // `unknown`, never a failure of the others.
  const linkedCameraIds = storedCameras.kind === 'known' ? storedCameras.value.map((c) => c.id) : []
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

  /** One camera: its slot read fresh, this device toggled, written back whole with that read's stamp (D49). */
  const writeCamera = async (cameraId: number, link: boolean): Promise<string | null> => {
    const name = cameras.find((c) => c.id === cameraId)?.name ?? `#${String(cameraId)}`
    try {
      const rows = await utils.deviceExtension.listSlots.fetch(
        { deviceId: cameraId },
        { staleTime: 0 },
      )
      const read = linkedSlotOf({ status: 'success', data: rows, error: null })
      if (read.kind === 'unknown') return `${name}: ${read.reason}`
      if (read.kind !== 'present') return `${name}: ${t('customize.assign.none')}`
      await setSlot.mutateAsync({
        deviceId: cameraId,
        slotRef: read.slot.slotRef,
        value: withLinkToggled(read.value, device.id, link),
        expectedUpdatedAt: read.slot.updatedAt,
      })
      return null
    } catch (err: unknown) {
      return `${name}: ${messageOf(err)}`
    }
  }

  const commitRef = useRef<() => Promise<string | null>>(async () => null)
  /** Every pending camera, each its own write; the ones that landed leave the draft. */
  commitRef.current = async (): Promise<string | null> => {
    if (busy) return t('customize.saveInFlight')
    if (added.length + removed.length === 0) return null
    setBusy(true)
    const failures: string[] = []
    const written: number[] = []
    try {
      for (const [ids, link] of [
        [removed, false],
        [added, true],
      ] as const) {
        for (const id of ids) {
          const failure = await writeCamera(id, link)
          if (failure === null) written.push(id)
          else failures.push(failure)
        }
      }
      setAdded((prev) => prev.filter((id) => !written.includes(id)))
      setRemoved((prev) => prev.filter((id) => !written.includes(id)))
      await refresh(written)
    } finally {
      setBusy(false)
    }
    return failures.length === 0
      ? null
      : t('customize.linked.someFailed', { failures: failures.join('; ') })
  }
  useDraftSection('linked-cameras', {
    label: t('customize.table.section.linkedCameras'),
    pendingCount: added.length + removed.length,
    save: () => commitRef.current(),
    discard: () => {
      setAdded([])
      setRemoved([])
    },
  })

  const problem: LinkedCameraTableLine | null =
    linkedCameras.kind === 'unknown'
      ? {
          kind: 'cameraError',
          message:
            fleet.kind === 'unknown'
              ? t('customize.assign.devicesUnreadable', { reason: linkedCameras.reason })
              : t('customize.linked.camerasUnreadable', { reason: linkedCameras.reason }),
        }
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
    isPendingAdd: (cameraId) => added.includes(cameraId),
    unlink: (cameraId) => {
      if (added.includes(cameraId)) setAdded((prev) => prev.filter((id) => id !== cameraId))
      else setRemoved((prev) => (prev.includes(cameraId) ? prev : [...prev, cameraId]))
    },
    dialog: (
      <SourceSelectorDevicesDialog
        open={picking}
        title={t('customize.linked.pickCameraTitle')}
        selection="multi"
        candidates={candidates}
        confirmLabel={(count) => t('customize.assign.addCount', { count })}
        onConfirm={(picked) => {
          setPicking(false)
          const ids = picked.map((c) => c.deviceId)
          // Picking a camera whose removal is pending cancels the removal.
          setRemoved((prev) => prev.filter((id) => !ids.includes(id)))
          setAdded((prev) => [
            ...prev,
            ...ids.filter(
              (id) =>
                !prev.includes(id) &&
                !(storedCameras.kind === 'known' && storedCameras.value.some((c) => c.id === id)),
            ),
          ])
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

/** One linked camera's remove: asks first, then drops the link from the draft. */
function CameraUnlink({ camera, state }: CameraUnlinkProps): ReactNode {
  const { t } = useTranslation()
  const confirmRemove = useConfirmRemove()
  const pendingAdd = state.isPendingAdd(camera.id)
  const read = state.slotOf(camera.id)
  const implied =
    !pendingAdd &&
    read.kind === 'present' &&
    linksDevice(read.slot, read.value, state.device.id).implied
  const unlink = async (): Promise<void> => {
    if (state.busy) return
    const accepted = await confirmRemove(
      t('customize.linked.removeFromCamera', { camera: camera.name, device: state.device.name }),
      false,
    )
    if (accepted) state.unlink(camera.id)
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      {!implied && (
        <IconButton
          icon={X}
          variant="ghost"
          size="sm"
          aria-label={t('customize.assign.removeNamed', { name: camera.name })}
          disabled={state.busy || (!pendingAdd && read.kind !== 'present')}
          onClick={(e) => {
            e.stopPropagation()
            void unlink()
          }}
        />
      )}
      {!pendingAdd && read.kind === 'pending' && (
        <span role="status" className="text-[11px] text-foreground-subtle">
          {t('customize.assign.checking')}
        </span>
      )}
      {!pendingAdd && read.kind === 'unknown' && (
        <span role="alert" className="text-[11px] text-warning break-words text-right">
          {t('customize.assign.unknown', { reason: read.reason })}
        </span>
      )}
      {!pendingAdd && read.kind === 'absent' && (
        <span role="alert" className="text-[11px] text-warning break-words text-right">
          {t('customize.assign.unknown', { reason: t('customize.assign.none') })}
        </span>
      )}
      {implied && (
        <span className="text-[11px] text-foreground-subtle text-right">
          {t('customize.linked.impliedByStructure')}
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
