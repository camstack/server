import { Bell } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function EventsTab() {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          {t('device.eventsTab.eventTimeline', 'Event Timeline')}
        </h2>
        <span className="inline-flex items-center gap-1 rounded-full bg-foreground-subtle/10 px-2 py-0.5 text-[10px] text-foreground-subtle">
          {t('device.eventsTab.0Events', '0 events')}
        </span>
      </div>
      <div className="flex flex-col items-center justify-center py-16 text-foreground-subtle">
        <Bell className="h-8 w-8 mb-3 opacity-30" />
        <p className="text-sm">{t('device.eventsTab.noEvents', 'No events')}</p>
        <p className="text-xs mt-1 opacity-70">
          {t(
            'device.eventsTab.deviceEventsWillAppearHere',
            'Device events will appear here as they occur',
          )}
        </p>
      </div>
    </div>
  )
}
