/**
 * <DeviceWebInterfaceCard> — the base card that opens a device's own web
 * interface (or the integration page that manages it).
 *
 * Same answer as the device page's header button, from the one hook
 * (`useDeviceAdminLink`): the card draws nothing when the device has no page,
 * while the answer has not arrived, when the caller may not ask, or when a
 * device-hosted page belongs to a device that is offline. Never a disabled
 * control (D62).
 */
import { Button, SectionCard, useDeviceAdminLink, useSystem } from '@dominevo/ui-library'
import { ExternalLink, Globe } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface DeviceWebInterfaceCardProps {
  readonly deviceId: number
}

export function DeviceWebInterfaceCard({ deviceId }: DeviceWebInterfaceCardProps): ReactNode {
  const { t } = useTranslation()
  const system = useSystem()
  const link = useDeviceAdminLink(system.trpcClient, deviceId)
  if (link === null) return null
  return (
    <SectionCard
      headingId={`device-web-interface-${String(deviceId)}`}
      title={t('device.webInterface.title', 'Web interface')}
      icon={Globe}
      testId="device-web-interface-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-4">
        <div className="min-w-0 text-xs">
          <div className="font-medium text-foreground">{link.label}</div>
          <div className="break-all text-foreground-muted">{link.host}</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          {t('device.webInterface.open', 'Open')}
        </Button>
      </div>
    </SectionCard>
  )
}
