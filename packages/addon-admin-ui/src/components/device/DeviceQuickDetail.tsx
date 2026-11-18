/**
 * Host for the devices-table quick-detail modal.
 *
 * Mounted ONCE inside `BrowserRouter` (the device-page button navigates). Publishes `open(deviceId)` through ui-library's
 * `DeviceQuickDetailProvider`; every `<DeviceItem>` (Devices page,
 * Integration detail, nested Integrations expand, ChildrenList, …) opens it
 * on a row click from that context — call sites do not wire anything.
 *
 * Opens on the SAME device detail the viewer shows (`/embed/device/<id>`: the
 * `DeviceDetailModule` card in the bare frame — hero, consumables, and History
 * from the card's own History button), then the Overview device-info facts and
 * the Export form; name, room, role, tags and display are edited there and
 * saved together. The header's "Open device page" button is the one way to the
 * full page.
 */
import {
  Button,
  DeviceCardFrameProvider,
  DeviceContextProvider,
  DeviceQuickDetailProvider,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useDeviceLabelById,
  useDeviceManagerGetDevice,
} from '@camstack/ui-library'
import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DeviceInfoAdapter } from './overview-adapters/DeviceInfoAdapter'
import { DeviceHeroCard, type DeviceHeroCardDevice } from './hero/DeviceHeroCard'
import { QuickDetailSaveProvider, useQuickDetailSave } from './quick-detail-save'
import { DeviceAggregateSection } from './tabs/DeviceAggregateSection'
import { isDeviceExportSection } from './tabs/device-export-tab'

type QuickTabId = 'detail' | 'info' | 'export'

/**
 * The device card of the Detail tab. Every navigation the card starts (open
 * device, open camera, deep link) leaves through the modal's guarded `leaveTo`,
 * so unsaved edits are confirmed exactly as for "Open device page".
 */
function DetailCard({
  deviceId,
  device,
  name,
  onDrawn,
}: {
  readonly deviceId: number
  readonly device: DeviceHeroCardDevice | null | undefined
  readonly name: string
  readonly onDrawn: (drawn: boolean) => void
}): ReactNode {
  const save = useQuickDetailSave()
  return (
    <DeviceCardFrameProvider frame="bare">
      <DeviceHeroCard
        deviceId={deviceId}
        device={device}
        deviceName={name}
        legacyFallback={false}
        onDrawn={onDrawn}
        {...(save === null ? {} : { onNavigate: save.leaveTo })}
      />
    </DeviceCardFrameProvider>
  )
}

/** The one way from the modal to the device page; asks first over unsaved edits. */
function OpenDevicePageButton(): ReactNode {
  const { t } = useTranslation()
  const save = useQuickDetailSave()
  if (save === null) return null
  return (
    <Button type="button" variant="outline" size="sm" onClick={save.openDevicePage}>
      {t('deviceQuickDetail.openPage', 'Open device page')}
    </Button>
  )
}

function DeviceQuickDetailModal({
  deviceId,
  onClose,
}: {
  readonly deviceId: number
  readonly onClose: () => void
}): ReactNode {
  const { t } = useTranslation()
  const [pickedTab, setTab] = useState<QuickTabId>('detail')
  // Told by the card once it settled: false = the hero model covers nothing (a
  // camera, a device with no card), which the viewer shows as an empty card.
  const [drawn, setDrawn] = useState<boolean | null>(null)
  const detailEmpty = drawn === false
  const tab: QuickTabId = pickedTab === 'detail' && detailEmpty ? 'info' : pickedTab
  const { data: device } = useDeviceManagerGetDevice({ deviceId }, { enabled: deviceId > 0 })
  const deviceName = typeof device?.name === 'string' ? device.name : ''
  const name = useDeviceLabelById(
    deviceId,
    'full',
    deviceName.length > 0 ? deviceName : `#${String(deviceId)}`,
  )
  const deviceLocation = typeof device?.location === 'string' ? device.location : ''
  const tabs: readonly (readonly [QuickTabId, string])[] = [
    ...(detailEmpty
      ? []
      : [['detail', t('deviceQuickDetail.tabDetail', { defaultValue: 'Detail' })] as const]),
    ['info', t('deviceQuickDetail.tabInfo', { defaultValue: 'Device info' })],
    ['export', t('deviceQuickDetail.tabExport', { defaultValue: 'Export' })],
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="lg" scroll="body">
        <QuickDetailSaveProvider
          deviceId={deviceId}
          seed={
            device != null
              ? {
                  name: deviceName,
                  location: deviceLocation,
                  role: typeof device.role === 'string' ? device.role : null,
                  display: device.display,
                  tags: device.tags,
                }
              : null
          }
          onClose={onClose}
        >
          <DialogHeader>
            <div className="flex flex-wrap items-center justify-between gap-2 pr-8">
              <DialogTitle>{name}</DialogTitle>
              <OpenDevicePageButton />
            </div>
          </DialogHeader>
          <div className="mt-3 flex items-center gap-1 rounded-md bg-surface-hover p-0.5 w-fit">
            {tabs.map(([id, label]) => (
              // ui-check-ok: segmented tab strip, not an action button
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                  tab === id
                    ? 'bg-surface text-foreground shadow-sm'
                    : 'text-foreground-subtle hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <DialogBody className="mt-3">
            <DeviceContextProvider deviceId={deviceId} device={device ?? undefined}>
              {/* Kept mounted so an edit on one tab survives a switch to another. */}
              {tab === 'detail' ? (
                // Mounted only while shown, and never a stream: a camera has no card here.
                <DetailCard deviceId={deviceId} device={device} name={name} onDrawn={setDrawn} />
              ) : null}
              <div className={tab === 'info' ? undefined : 'hidden'}>
                <DeviceInfoAdapter />
              </div>
              <div className={tab === 'export' ? undefined : 'hidden'}>
                <DeviceAggregateSection deviceId={deviceId} sectionFilter={isDeviceExportSection} />
              </div>
            </DeviceContextProvider>
          </DialogBody>
        </QuickDetailSaveProvider>
      </DialogContent>
    </Dialog>
  )
}

export interface DeviceQuickDetailHostProps {
  readonly children: ReactNode
}

/** App-shell host: context for every DeviceItem + the modal when open. */
export function DeviceQuickDetailHost({ children }: DeviceQuickDetailHostProps): ReactNode {
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const open = useCallback((id: number) => setDeviceId(id), [])
  const close = useCallback(() => setDeviceId(null), [])

  return (
    <DeviceQuickDetailProvider open={open}>
      {children}
      {deviceId !== null ? <DeviceQuickDetailModal deviceId={deviceId} onClose={close} /> : null}
    </DeviceQuickDetailProvider>
  )
}
