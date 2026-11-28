/**
 * Custom Device quick body: the device the composition produces with its live
 * values, the sources it reads, its state, and the way to the device history.
 * The exporter shortcuts are the device's own export section.
 */
import {
  Badge,
  DeviceCardFrameProvider,
  DeviceContextProvider,
  useDeviceManagerGetDevice,
} from '@dominevo/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { DeviceHeroCard } from '../../../../components/device/hero/DeviceHeroCard'
import { DeviceAggregateSection } from '../../../../components/device/tabs/DeviceAggregateSection'
import { isDeviceExportSection } from '../../../../components/device/tabs/device-export-tab'
import { badgeVariantForTone } from '../../core-block-status'
import type { CompositionRow } from '../../composition-rows'
import { type QuickFact, QuickDeviceLink, QuickFacts, QuickSection } from '../QuickParts'

export interface CustomDeviceQuickBodyProps {
  readonly row: CompositionRow
}

/**
 * The Exporters tab: the device page's Export section for the produced device, unchanged,
 * mounted only while the tab is open. Before the device is reported there is nothing to show.
 */
export function CustomDeviceExporters({ row }: CustomDeviceQuickBodyProps): ReactNode {
  const { t } = useTranslation()
  const deviceId = row.reportedDeviceId
  const { data: device } = useDeviceManagerGetDevice(
    { deviceId: deviceId ?? 0 },
    { enabled: deviceId !== null && deviceId > 0 },
  )
  if (deviceId === null) {
    return (
      <p className="text-xs text-foreground-subtle">
        {t(
          'build.quickModal.exportersNeedDevice',
          'Exporters are available once the device is reported.',
        )}
      </p>
    )
  }
  return (
    <DeviceContextProvider deviceId={deviceId} device={device ?? undefined}>
      <DeviceAggregateSection deviceId={deviceId} sectionFilter={isDeviceExportSection} />
    </DeviceContextProvider>
  )
}

export function CustomDeviceQuickBody({ row }: CustomDeviceQuickBodyProps): ReactNode {
  const { t } = useTranslation()
  const deviceId = row.reportedDeviceId
  const { data: device } = useDeviceManagerGetDevice(
    { deviceId: deviceId ?? 0 },
    { enabled: deviceId !== null && deviceId > 0 },
  )
  const facts: QuickFact[] = [
    {
      key: t('build.quickModal.status', 'Status'),
      value: <Badge variant={badgeVariantForTone(row.state.tone)}>{row.state.label}</Badge>,
    },
    {
      key: t('build.quickModal.producesDevice', 'Device it produces'),
      value:
        deviceId === null ? (
          t('build.quickModal.deviceNotReported', 'Not reported yet')
        ) : (
          <QuickDeviceLink deviceId={deviceId} />
        ),
    },
    ...(row.type === null ? [] : [{ key: t('build.quickModal.type', 'Type'), value: row.type }]),
  ]
  return (
    <>
      <QuickSection title={t('build.quickModal.summary', 'Summary')}>
        <QuickFacts items={facts} />
        {row.state.reason !== null && (
          <p className="mt-2 text-xs text-danger">{row.state.reason}</p>
        )}
        {deviceId !== null && (
          <p className="mt-2 text-xs">
            <Link
              to={`/devices/${String(deviceId)}?tab=history`}
              className="text-primary hover:underline"
              data-testid="quick-device-history"
            >
              {t('build.quickModal.deviceHistory', 'Device history')}
            </Link>
          </p>
        )}
      </QuickSection>
      {deviceId !== null && (
        <QuickSection title={t('build.quickModal.liveValues', 'Live values')}>
          <DeviceContextProvider deviceId={deviceId} device={device ?? undefined}>
            <DeviceCardFrameProvider frame="bare" historyView={false}>
              <DeviceHeroCard
                deviceId={deviceId}
                device={device}
                deviceName={row.name}
                legacyFallback={false}
              />
            </DeviceCardFrameProvider>
          </DeviceContextProvider>
        </QuickSection>
      )}
      <QuickSection title={t('build.quickModal.sources', 'Sources')}>
        {row.sources.length === 0 ? (
          <p className="text-xs text-foreground-subtle">
            {t('build.quickModal.noSources', 'No sources')}
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {row.sources.map((source) => (
              <li key={source.key} className="flex items-center gap-2">
                {source.deviceId === null ? (
                  <span>{source.label}</span>
                ) : (
                  <QuickDeviceLink deviceId={source.deviceId} />
                )}
                {source.presence === 'missing' && (
                  <Badge variant="danger">{t('build.quickModal.missing', 'Missing')}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </QuickSection>
    </>
  )
}
