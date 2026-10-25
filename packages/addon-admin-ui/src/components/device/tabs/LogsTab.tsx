import { useTranslation } from 'react-i18next'
import { LogStream } from '@camstack/ui-library'

interface LogsTabProps {
  readonly deviceId: number
}

export function LogsTab({ deviceId }: LogsTabProps) {
  const { t } = useTranslation()
  if (!Number.isFinite(deviceId)) {
    return (
      <div className="rounded-lg border border-border bg-surface overflow-hidden px-4 py-3 text-[11px] text-foreground-subtle italic">
        {t('device.logsTab.notAvailable', { id: deviceId })}
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <LogStream
        deviceId={deviceId}
        limit={200}
        maxHeight="max-h-[calc(100vh-400px)]"
        showScope
        showFilters={false}
        showSourceSelect
      />
    </div>
  )
}
