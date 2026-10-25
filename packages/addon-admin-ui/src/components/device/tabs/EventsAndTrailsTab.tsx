import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Bell, Footprints } from 'lucide-react'
import { CameraEventsTab } from '../../cameras/tabs/CameraEventsTab'
import { TracksTab } from './TracksTab'

interface EventsAndTrailsTabProps {
  /** Numeric device handle — passed verbatim to every downstream tab. */
  deviceId: number
}

const VIEWS = [
  { id: 'events', labelKey: 'common.events', icon: Bell },
  { id: 'tracks', labelKey: 'device.eventsAndTrailsTab.tracks', icon: Footprints },
] as const

type ViewId = (typeof VIEWS)[number]['id']

export function EventsAndTrailsTab({ deviceId }: EventsAndTrailsTabProps) {
  const { t } = useTranslation()
  const [activeView, setActiveView] = useState<ViewId>('events')
  const deviceIdReady = Number.isFinite(deviceId)

  return (
    <div className="flex flex-col gap-0 h-full">
      {/* View toggle */}
      <div className="flex items-center gap-1 mb-4">
        {VIEWS.map(({ id, labelKey, icon: Icon }) => {
          const isActive = activeView === id
          return (
            <button
              key={id}
              onClick={() => setActiveView(id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${
                isActive
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover border border-transparent'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(labelKey)}
            </button>
          )
        })}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!deviceIdReady && (
          <div className="text-[11px] text-foreground-subtle italic py-4 text-center">
            {t('device.eventsAndTrailsTab.notAvailable', { id: deviceId })}
          </div>
        )}
        {deviceIdReady && activeView === 'events' && <CameraEventsTab deviceId={deviceId} />}
        {deviceIdReady && activeView === 'tracks' && <TracksTab deviceId={deviceId} />}
      </div>
    </div>
  )
}
