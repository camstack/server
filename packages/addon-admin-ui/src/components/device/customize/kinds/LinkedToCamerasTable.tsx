/**
 * The linked-devices table seen from the OTHER side (D648): on a device a
 * camera can link, Customize lists the cameras — and only them — and a tick
 * means "this device is in that camera's linked set". The camera's slot stays
 * the one owner: every tick is a read-modify-write of THAT camera's slot from
 * what it just read (D49), refused while the read is pending or failed (D315),
 * so a camera's other ids and its tracked opt-in survive untouched. Nothing is
 * ever ticked for the operator (D356).
 */
import type { DeviceInfo } from '@camstack/types'
import {
  DeviceList,
  type DeviceListColumn,
  Switch,
  TEXT_HINT,
  useDeviceExtensionListSlots,
  useDeviceExtensionSetSlot,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Link2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AssignmentSection } from '../assignments/AssignmentSection'
import { type CandidateDevice, candidateDetail } from '../assignments/assignment-candidates'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { LinkedNameCell } from './LinkedNameCell'
import { linksDevice, linkedSlotOf, slotRelationOf, withLinkToggled } from './linked-devices-model'

export interface LinkedToCamerasTableProps {
  readonly device: DeviceInfo
}

interface CameraLinkSwitchProps {
  readonly camera: CandidateDevice
  readonly deviceId: number
}

/** One camera's tick: reads the camera's own slot, writes it back whole with this device toggled. */
function CameraLinkSwitch({ camera, deviceId }: CameraLinkSwitchProps): ReactNode {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const slots = useDeviceExtensionListSlots({ deviceId: camera.id })
  const setSlot = useDeviceExtensionSetSlot()
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const read = linkedSlotOf({
    status: slots.status,
    data: slots.data,
    error:
      slots.error === null || slots.error === undefined ? null : { message: slots.error.message },
  })
  const state = read.kind === 'present' ? linksDevice(read.slot, read.value, deviceId) : null
  // D49: the write is built from this read, so a read still refreshing (another
  // tab or admin may have changed the camera's list) must not be written back.
  const refreshing = slots.isFetching
  const toggle = async (next: boolean): Promise<void> => {
    if (read.kind !== 'present' || busy || refreshing) return
    setBusy(true)
    setRefusal(null)
    try {
      await setSlot.mutateAsync({
        deviceId: camera.id,
        slotRef: read.slot.slotRef,
        value: withLinkToggled(read.value, deviceId, next),
      })
      await slots.refetch()
      await queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    } catch (err: unknown) {
      setRefusal(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Switch
        checked={state?.linked ?? false}
        disabled={read.kind !== 'present' || busy || refreshing || state?.implied === true}
        aria-label={t('customize.linked.linkTo', { name: camera.name })}
        onCheckedChange={(next) => void toggle(next)}
      />
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
          {t('customize.assign.unknown', {
            reason: t('customize.assign.none'),
          })}
        </span>
      )}
      {state?.implied === true && (
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

export function LinkedToCamerasTable({ device }: LinkedToCamerasTableProps): ReactNode {
  const { t } = useTranslation()
  const fleet = useCandidateDevices(true)
  const cameras =
    fleet.kind === 'known'
      ? fleet.value.filter((d) => slotRelationOf('linked-devices', d.type) === 'host')
      : []
  const columns: readonly DeviceListColumn<CandidateDevice>[] = [
    {
      key: 'camera',
      header: t('customize.linked.camera'),
      cell: (c) => (
        <LinkedNameCell
          name={c.name}
          deviceId={c.id}
          detail={candidateDetail(c.integration, c.location)}
        />
      ),
    },
    {
      key: 'linked',
      header: t('customize.linked.linkedColumn'),
      cellClassName: 'text-right',
      headerClassName: 'text-right',
      cell: (c) => <CameraLinkSwitch camera={c} deviceId={device.id} />,
    },
  ]
  return (
    <AssignmentSection
      id="linked"
      icon={Link2}
      title={t('customize.linked.reverseTitle')}
      notices={
        fleet.kind === 'pending' ? (
          <p role="status" className="text-xs text-foreground-subtle">
            {t('customize.assign.checking')}
          </p>
        ) : fleet.kind === 'unknown' ? (
          <p role="alert" className="text-xs text-warning break-words">
            {t('customize.assign.devicesUnreadable', { reason: fleet.reason })}
          </p>
        ) : null
      }
    >
      {fleet.kind === 'known' && (
        <li className="list-none px-3 py-2 sm:px-4">
          {cameras.length === 0 ? (
            <p className="text-[11px] text-foreground-subtle">{t('customize.linked.noCameras')}</p>
          ) : (
            <DeviceList<CandidateDevice>
              mode="generic"
              items={cameras}
              getKey={(c) => String(c.id)}
              getSearchText={(c) => [c.name, c.location ?? '', String(c.id)].join(' ')}
              columns={columns}
              searchPlaceholder={t('customize.assign.search')}
              emptyLabel={t('customize.linked.noCameras')}
            />
          )}
          <p className={`mt-2 ${TEXT_HINT}`}>{t('customize.linked.reverseHint')}</p>
        </li>
      )}
    </AssignmentSection>
  )
}
