/**
 * Camera links — one room's cameras with the devices each one is LINKED to.
 *
 * A read-only overview in the visual style of the room card: the data is the
 * `linked-devices` slot the camera's Customize page edits (D648/D655), read
 * per camera, so what is listed here is exactly what that page lists. Editing
 * stays there ("Edit links"); the one write on this page is the quick "Add"
 * that opens the multi-select picker and writes the picked ids through the
 * same slot (D356: only what the operator picked, never an automatic link).
 */
import type { ExtensionCandidate } from '@camstack/types'
import {
  Button,
  DataTable,
  DeviceName,
  SECTION_CARD,
  SECTION_HEADER,
  useDeviceExtensionListCandidates,
  useDeviceExtensionListSlots,
  useDeviceExtensionSetSlot,
  useDeviceLabel,
  type DataColumn,
  type PickerItem,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Link2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import {
  type LinkedRow,
  linkedRows,
  linkedSlotOf,
  withLinked,
} from '../../components/device/customize/kinds/linked-devices-model'
import { customizePath } from '../../lib/customization-routes'
import { DeviceTypeIcon, LabeledStatusDot } from './device-glyphs'
import { QuickAddDevicesDialog } from './QuickAddDevicesDialog'
import { siteDeviceFields, type SiteDevice } from './site-locations'

export interface CameraLinksSectionProps {
  readonly room: string | null
  /** The cameras assigned to the room. */
  readonly cameras: readonly SiteDevice[]
  /** The whole fleet, to name a linked device and show its type and state. */
  readonly fleet: readonly SiteDevice[]
}

export function CameraLinksSection({ room, cameras, fleet }: CameraLinksSectionProps) {
  const { t } = useTranslation()
  const byId = useMemo(() => new Map(fleet.map((d) => [d.id, d])), [fleet])
  if (room === null) {
    return <p className="text-xs text-foreground-subtle">{t('locations.links.noRoom')}</p>
  }
  return (
    <div className="flex flex-col gap-3" data-testid="camera-links-section">
      {cameras.length === 0 ? (
        <p className="text-xs text-foreground-subtle" data-testid="camera-links-empty">
          {t('locations.links.noCameras', { room })}
        </p>
      ) : (
        cameras.map((camera) => <CameraLinksBlock key={camera.id} camera={camera} byId={byId} />)
      )}
    </div>
  )
}

interface CameraLinksBlockProps {
  readonly camera: SiteDevice
  readonly byId: ReadonlyMap<number, SiteDevice>
}

function candidateItem(c: ExtensionCandidate): PickerItem<number> {
  return {
    id: c.deviceId,
    name: c.name,
    type: c.type,
    location: c.location,
  }
}

function CameraLinksBlock({ camera, byId }: CameraLinksBlockProps) {
  const { t } = useTranslation()
  const cameraLabel = useDeviceLabel(siteDeviceFields(camera), 'full')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [picking, setPicking] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const slots = useDeviceExtensionListSlots({ deviceId: camera.id })
  const read = linkedSlotOf({
    status: slots.status,
    data: slots.data,
    error: slots.error === null || slots.error === undefined ? null : slots.error,
  })
  const setSlot = useDeviceExtensionSetSlot()
  const present = read.kind === 'present' ? read : null
  const offered = useDeviceExtensionListCandidates(
    { deviceId: camera.id, slotRef: present?.slot.slotRef ?? '' },
    { enabled: picking && present !== null },
  )
  const rows: readonly LinkedRow[] = present === null ? [] : linkedRows(present.slot, present.value)
  const linkedIds = rows.map((r) => r.deviceId)

  const fromOwner = (offered.data?.candidates ?? []).map(candidateItem)
  const offeredIds = new Set(fromOwner.map((i) => i.id))
  // A linked device the owner no longer offers is still drawn, checked.
  const linkedOnly = linkedIds
    .filter((id) => !offeredIds.has(id))
    .map((id): PickerItem<number> => {
      const d = byId.get(id)
      return {
        id,
        name: d?.name ?? `#${String(id)}`,
        ...(d !== undefined ? { type: d.type, location: d.location } : {}),
      }
    })
  const items: readonly PickerItem<number>[] = [...fromOwner, ...linkedOnly]

  const suggestedIds = (offered.data?.candidates ?? [])
    .filter((c) => c.suggested)
    .map((c) => c.deviceId)

  const add = async (ids: readonly number[]): Promise<void> => {
    if (present === null) return
    setRefusal(null)
    try {
      await setSlot.mutateAsync({
        deviceId: camera.id,
        slotRef: present.slot.slotRef,
        value: withLinked(present.value, ids),
      })
      await slots.refetch()
      await queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
      setPicking(false)
    } catch (err: unknown) {
      setRefusal(err instanceof Error ? err.message : String(err))
    }
  }

  const columns: readonly DataColumn<LinkedRow>[] = [
    {
      key: 'device',
      header: t('locations.columns.device'),
      notSortableReason: t('locations.columns.noSort'),
      render: (row) => {
        const device = byId.get(row.deviceId)
        const name = row.name ?? device?.name ?? `#${String(row.deviceId)}`
        return (
          <span className="flex items-center gap-1.5">
            {device !== undefined && <DeviceTypeIcon type={device.type} />}
            <Link
              to={`/devices/${String(row.deviceId)}`}
              className="min-w-0 truncate text-xs text-foreground hover:underline"
            >
              {device !== undefined ? (
                <DeviceName device={siteDeviceFields(device)} form="compact" />
              ) : (
                name
              )}
            </Link>
            {row.implied && (
              <span className="text-[10px] text-foreground-subtle">
                {t('locations.links.implied')}
              </span>
            )}
          </span>
        )
      },
    },
    {
      key: 'type',
      header: t('locations.columns.type'),
      notSortableReason: t('locations.columns.noSort'),
      render: (row) => (
        <span className="text-xs text-foreground-muted">{byId.get(row.deviceId)?.type ?? '—'}</span>
      ),
    },
    {
      key: 'status',
      header: t('locations.columns.status'),
      notSortableReason: t('locations.columns.noSort'),
      render: (row) => {
        const device = byId.get(row.deviceId)
        return device === undefined ? (
          <span className="text-xs text-foreground-subtle">—</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <LabeledStatusDot device={device} />
            <span className="text-xs text-foreground-muted">
              {device.online ? t('common.online') : t('common.offline')}
            </span>
          </span>
        )
      },
    },
  ]

  return (
    <section
      className={`min-w-0 ${SECTION_CARD}`}
      data-testid={`camera-links-${String(camera.id)}`}
    >
      <header className={`${SECTION_HEADER} flex min-h-9 items-center gap-1.5`}>
        <DeviceTypeIcon type={camera.type} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          <DeviceName device={siteDeviceFields(camera)} form="full" />
        </h2>
        <Button variant="ghost" size="sm" onClick={() => navigate(customizePath(camera.id))}>
          <Link2 className="h-3.5 w-3.5" aria-hidden />
          {t('locations.links.edit')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={present === null}
          onClick={() => setPicking(true)}
          aria-label={t('locations.links.addNamed', { camera: cameraLabel })}
        >
          {t('locations.room.add')}
        </Button>
      </header>
      {read.kind === 'pending' && (
        <p role="status" className="px-3 py-3 text-xs text-foreground-subtle sm:px-4">
          {t('locations.links.loading')}
        </p>
      )}
      {read.kind === 'unknown' && (
        <p role="alert" className="px-3 py-3 text-xs text-warning sm:px-4">
          {t('locations.links.unreadable', { reason: read.reason })}
        </p>
      )}
      {read.kind === 'absent' && (
        <p className="px-3 py-3 text-xs text-foreground-subtle sm:px-4">
          {t('locations.links.unsupported')}
        </p>
      )}
      {refusal !== null && (
        <p role="alert" className="px-3 pt-2 text-xs text-danger break-words sm:px-4">
          {refusal}
        </p>
      )}
      {present !== null &&
        (rows.length === 0 ? (
          <p className="px-3 py-3 text-xs text-foreground-subtle sm:px-4">
            {t('locations.links.none')}
          </p>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => String(row.deviceId)}
            bordered={false}
            minWidthPx={360}
          />
        ))}
      <QuickAddDevicesDialog
        open={picking}
        title={t('locations.links.pickTitle', { camera: cameraLabel })}
        items={items}
        listState={
          offered.status === 'error'
            ? 'failed'
            : offered.data === undefined
              ? 'pending'
              : 'answered'
        }
        lockedIds={linkedIds}
        lockedNote={t('locations.links.alreadyLinked')}
        suggestions={
          camera.location === null
            ? null
            : {
                heading: t('locations.links.suggested', { room: camera.location }),
                ids: suggestedIds,
              }
        }
        busy={setSlot.isPending}
        onConfirm={(ids) => void add(ids)}
        onClose={() => setPicking(false)}
      />
    </section>
  )
}
