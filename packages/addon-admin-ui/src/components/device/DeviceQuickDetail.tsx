/**
 * Host for the devices-table quick-detail modal.
 *
 * Mounted ONCE inside `BrowserRouter` (the modal's detail `<Link>` needs a
 * router basename). Publishes `open(deviceId)` through ui-library's
 * `DeviceQuickDetailProvider`; every `<DeviceItem>` (Devices page,
 * Integration detail, nested Integrations expand, ChildrenList, …) draws
 * the glyph from that context — call sites do not wire the button.
 *
 * Body reuses Overview / Export primitives (Device Info, Display, Export).
 * History is its own tab, shown only after listSeries answers with a series.
 */
import {
  DeviceContextProvider,
  DeviceQuickDetailProvider,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useDeviceManagerGetDevice,
  useDeviceSeriesList,
} from '@camstack/ui-library'
import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DeviceQuickHistory } from './DeviceQuickHistory'
import { historyTabVisible } from './history-tab'
import { DeviceInfoAdapter } from './overview-adapters/DeviceInfoAdapter'
import { QuickDetailSaveProvider } from './quick-detail-save'
import { DeviceAggregateSection } from './tabs/DeviceAggregateSection'
import { isDeviceExportSection } from './tabs/device-export-tab'
import { DisplaySection } from './tabs/DisplaySection'

type QuickTabId = 'info' | 'display' | 'export' | 'history'

function DeviceQuickDetailModal({
  deviceId,
  onClose,
}: {
  readonly deviceId: number
  readonly onClose: () => void
}): ReactNode {
  const { t } = useTranslation()
  const [tab, setTab] = useState<QuickTabId>('info')
  const { data: device } = useDeviceManagerGetDevice({ deviceId }, { enabled: deviceId > 0 })
  const series = useDeviceSeriesList(deviceId)
  const showHistory = historyTabVisible(series.presence, series.list)
  const visibleTab: QuickTabId = tab === 'history' && !showHistory ? 'info' : tab
  const name =
    typeof device?.name === 'string' && device.name.length > 0
      ? device.name
      : `#${String(deviceId)}`
  const deviceName = typeof device?.name === 'string' ? device.name : ''
  const deviceLocation = typeof device?.location === 'string' ? device.location : ''
  const tabs: readonly (readonly [QuickTabId, string])[] = [
    ['info', t('deviceQuickDetail.tabInfo', { defaultValue: 'Device info' })],
    ['display', t('deviceQuickDetail.tabDisplay', { defaultValue: 'Display' })],
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
          deviceName={deviceName}
          deviceLocation={deviceLocation}
          deviceReady={device != null}
          onClose={onClose}
        >
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
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
              <div className={visibleTab === 'info' ? undefined : 'hidden'}>
                <DeviceInfoAdapter />
              </div>
              <div className={visibleTab === 'display' ? undefined : 'hidden'}>
                <DisplaySection deviceId={deviceId} />
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
