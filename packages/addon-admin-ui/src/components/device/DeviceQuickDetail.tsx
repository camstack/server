/**
 * Host for the devices-table quick-detail modal.
 *
 * Mounted ONCE inside `BrowserRouter` (the device-page button navigates). Publishes `open(deviceId)` through ui-library's
 * `DeviceQuickDetailProvider`; every `<DeviceItem>` (Devices page,
 * Integration detail, nested Integrations expand, ChildrenList, …) opens it
 * on a row click from that context — call sites do not wire anything.
 *
 * Opens on the live detail card the device page shows at its top (the
 * default tab), then the Overview device-info facts and the Export form. Name, room
 * and display are edited on the full page's Customize tab. History is its
 * own tab, shown only after listSeries answers with a series.
 */
import {
  Button,
  DeviceContextProvider,
  DeviceQuickDetailProvider,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useDeviceLabelById,
  useDeviceManagerGetDevice,
  useDeviceSeriesList,
} from '@camstack/ui-library'
import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DeviceQuickHistory } from './DeviceQuickHistory'
import { historyTabVisible } from './history-tab'
import { DeviceInfoAdapter } from './overview-adapters/DeviceInfoAdapter'
import { DeviceHeroCard } from './hero/DeviceHeroCard'
import { QuickDetailSaveProvider, useQuickDetailSave } from './quick-detail-save'
import { DeviceAggregateSection } from './tabs/DeviceAggregateSection'
import { isDeviceExportSection } from './tabs/device-export-tab'

type QuickTabId = 'detail' | 'info' | 'export' | 'history'

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
  const [tab, setTab] = useState<QuickTabId>('detail')
  const { data: device } = useDeviceManagerGetDevice({ deviceId }, { enabled: deviceId > 0 })
  const series = useDeviceSeriesList(deviceId)
  const showHistory = historyTabVisible(series.presence, series.list)
  const visibleTab: QuickTabId = tab === 'history' && !showHistory ? 'detail' : tab
  const deviceName = typeof device?.name === 'string' ? device.name : ''
  const name = useDeviceLabelById(
    deviceId,
    'full',
    deviceName.length > 0 ? deviceName : `#${String(deviceId)}`,
  )
  const deviceLocation = typeof device?.location === 'string' ? device.location : ''
  const tabs: readonly (readonly [QuickTabId, string])[] = [
    ['detail', t('deviceQuickDetail.tabDetail', { defaultValue: 'Detail' })],
    ['info', t('deviceQuickDetail.tabInfo', { defaultValue: 'Device info' })],
    ['export', t('deviceQuickDetail.tabExport', { defaultValue: 'Export' })],
    ...(showHistory
      ? [['history', t('deviceQuickDetail.tabHistory', { defaultValue: 'History' })] as const]
      : []),
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
                  visibleTab === id
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
              {visibleTab === 'detail' ? (
                // Mounted only while shown: a camera's stream must not play behind a tab.
                <DeviceHeroCard
                  deviceId={deviceId}
                  device={device}
                  deviceName={name}
                  onNavigated={onClose}
                />
              ) : null}
              <div className={visibleTab === 'info' ? undefined : 'hidden'}>
                <DeviceInfoAdapter />
              </div>
              <div className={visibleTab === 'export' ? undefined : 'hidden'}>
                <DeviceAggregateSection deviceId={deviceId} sectionFilter={isDeviceExportSection} />
              </div>
              {showHistory ? (
                <div className={visibleTab === 'history' ? undefined : 'hidden'}>
                  <DeviceQuickHistory deviceId={deviceId} />
                </div>
              ) : null}
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
