/**
 * LiveStatsTab — content for the `live-stats` widget (the camera's
 * Analytics tab). Owned by pipeline-analytics (the `audio-metrics` +
 * `zone-analytics` caps).
 *
 * Top: the LIVE cards (occupancy now, audio now) — not history. Below: the
 * last 24 hours of the camera's recorded series through the library's
 * `DeviceHistoryView` — the SAME component as the device page's History tab
 * (D899), so motion, audio level and the zone × class occupancy this addon
 * records into device-history are drawn once, one way. The detection
 * histogram stays its own widget: per-class object counts are events this
 * addon keeps, not a device-history series.
 */
import { DeviceHistoryView, GRID_GAP, STACK_GAP, WidgetSlot } from '@camstack/ui-library'

interface LiveStatsTabProps {
  readonly deviceId: number
}

export function LiveStatsTab({ deviceId }: LiveStatsTabProps) {
  // Mounted as a chromeless single-widget section under the already-labelled
  // tab, so it renders no redundant title.
  return (
    <div className={STACK_GAP}>
      <div
        className={`grid ${GRID_GAP}`}
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' }}
      >
        <WidgetSlot
          widgetId="pipeline-analytics/live-occupancy-panel"
          host="device-tab"
          deviceId={deviceId}
        />
        <WidgetSlot
          widgetId="pipeline-analytics/audio-metrics-panel"
          host="device-tab"
          deviceId={deviceId}
        />
      </div>
      <DeviceHistoryView deviceId={deviceId} fixedWindow="24h" />
      <WidgetSlot
        widgetId="pipeline-analytics/detection-history-chart"
        host="device-tab"
        deviceId={deviceId}
      />
    </div>
  )
}
