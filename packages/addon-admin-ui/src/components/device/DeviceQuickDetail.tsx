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
 * the Export form; name, room and role are edited in the first section and saved together. The header's "Open device page" button is the one way to the
 * full page.
 */
import {
  ActuationHistory,
  Button,
  DeviceCardFrameProvider,
  DeviceHistoryView,
  DeviceContextProvider,
  Tabs,
  TabsList,
  TabsTrigger,
  DeviceQuickDetailProvider,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useCapabilityPresence,
  useDeviceLabelById,
  useDeviceManagerGetBindings,
  useDeviceManagerGetDevice,
  useDeviceSeriesList,
} from '@dominevo/ui-library'
import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DeviceWebInterfaceCard } from './DeviceWebInterfaceCard'
import { useAuth } from '../../contexts/auth-context'
import { IdentityRow } from './customize/IdentityRow'
import { DeviceInfoAdapter } from './overview-adapters/DeviceInfoAdapter'
import { DeviceHeroCard, type DeviceHeroCardDevice } from './hero/DeviceHeroCard'
import { QuickDetailSaveProvider, useQuickDetailSave } from './quick-detail-save'
import { DeviceAggregateSection } from './tabs/DeviceAggregateSection'
import { actionsTabVisible, DEVICE_TRANSITIONS_CAP } from './actions-tab'
import { historyTabVisible } from './history-tab'
import { isDeviceExportSection } from './tabs/device-export-tab'

type QuickTabId = 'history' | 'actions' | 'info' | 'export'

/**
 * The device card of the Detail tab. Every navigation the card starts (open
 * device, open camera, deep link) leaves through the modal's guarded `leaveTo`,
 * so unsaved edits are confirmed exactly as for "Open device page". The card
 * fills the modal's body, so its History / detail views scroll in their own
 * region; a card taller than the body overflows it and the body is the one
 * region that scrolls (the body keeps its own `overflow-y-auto`).
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
    // History and Actions are tabs of this modal, so the card does not open its own view.
    <DeviceCardFrameProvider frame="bare" fill historyView={false}>
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
  const [pickedTab, setTab] = useState<QuickTabId>('info')
  // Told by the card once it settled: false = the hero model covers nothing (a
  // camera, a device with no card), which the viewer shows as an empty card.
  // The card stays mounted so `drawn` is learned at open; it takes room only
  // once it reported something to show.
  const [drawn, setDrawn] = useState<boolean | null>(null)
  const { user } = useAuth()
  const series = useDeviceSeriesList(deviceId)
  const hasHistory = historyTabVisible(series.presence, series.list)
  const transitions = useCapabilityPresence(DEVICE_TRANSITIONS_CAP)
  const bindings = useDeviceManagerGetBindings({ deviceId }, { enabled: deviceId > 0 })
  const hasActions = actionsTabVisible(transitions, {
    status: bindings.status,
    entries: bindings.data?.entries ?? [],
  })
  const tab: QuickTabId =
    (pickedTab === 'history' && !hasHistory) || (pickedTab === 'actions' && !hasActions)
      ? 'info'
      : pickedTab
  const { data: device } = useDeviceManagerGetDevice({ deviceId }, { enabled: deviceId > 0 })
  const deviceName = typeof device?.name === 'string' ? device.name : ''
  const name = useDeviceLabelById(
    deviceId,
    'full',
    deviceName.length > 0 ? deviceName : `#${String(deviceId)}`,
  )
  const deviceLocation = typeof device?.location === 'string' ? device.location : ''
  const tabs: readonly (readonly [QuickTabId, string])[] = [
    ['info', t('deviceQuickDetail.tabInfo', { defaultValue: 'Device info' })],
    ...(hasHistory
      ? [['history', t('deviceQuickDetail.tabHistory', { defaultValue: 'History' })] as const]
      : []),
    ...(hasActions
      ? [['actions', t('deviceQuickDetail.tabActions', { defaultValue: 'Actions' })] as const]
      : []),
    ['export', t('deviceQuickDetail.tabExport', { defaultValue: 'Export' })],
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* A tall dialog: the History view gets the room. Exactly one region scrolls. */}
      <DialogContent width="lg" scroll="body" className="md:h-[85dvh]">
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
          <Tabs
            appearance="pills"
            value={tab}
            onValueChange={(id) => setTab(tabs.find(([known]) => known === id)?.[0] ?? tab)}
            className="mt-3"
          >
            <TabsList>
              {tabs.map(([id, label]) => (
                <TabsTrigger key={id} value={id}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <DialogBody className="mt-3">
            <DeviceContextProvider deviceId={deviceId} device={device ?? undefined}>
              {/* Kept mounted so an edit on one tab survives a switch to another. */}
              {/* Never a stream: a camera has no card here. */}
              <div className={tab === 'info' ? 'flex flex-col gap-3' : 'hidden'}>
                <div className={drawn === true ? 'h-[26rem] min-h-0' : 'hidden'}>
                  <DetailCard deviceId={deviceId} device={device} name={name} onDrawn={setDrawn} />
                </div>
                {device != null ? (
                  <IdentityRow device={device} basic readOnly={user?.isAdmin !== true} />
                ) : null}
                <DeviceWebInterfaceCard deviceId={deviceId} />
                <DeviceInfoAdapter />
              </div>
              {tab === 'history' ? <DeviceHistoryView deviceId={deviceId} /> : null}
              {tab === 'actions' ? <ActuationHistory deviceId={deviceId} /> : null}
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
