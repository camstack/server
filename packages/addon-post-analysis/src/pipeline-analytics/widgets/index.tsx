/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- React-Query inferred types collapse to 'error' under bundle parserService context (Phase D widget consolidation, lint-clean in original packages). Phase E builder migration revisits. */
/**
 * Widget bundle entry — built into `dist/widgets.mjs` by
 * `vite.widgets.config.ts`. Each widget is a thin `WidgetProps` wrapper
 * around the data-shaped component sourced from this directory.
 *
 * The inner components were lifted verbatim from
 * `addon-admin-ui/src/components/shared/` as part of Phase C of the
 * addon-widgets system — admin-ui no longer imports them directly,
 * mounting goes through `<WidgetSlot widgetId="pipeline-analytics/<id>"
 * deviceId={…}/>` instead.
 */
import type { WidgetProps } from '@camstack/ui-library'
import { AudioHistoryChart } from './AudioHistoryChart'
import { AudioMetricsPanel } from './AudioMetricsPanel'
import { OccupancyHistoryChart } from './OccupancyHistoryChart'
import { MotionHistoryChart } from './MotionHistoryChart'
import { DetectionHistoryChart } from './DetectionHistoryChart'
import { OccupancyPanel } from './OccupancyPanel'
import { LiveStatsTab } from './LiveStatsTab'
import { useT } from '../../i18n/index.js'

/** Shared guard — every analytics widget needs a device id. */
function MissingDevice({ name }: { readonly name: string }) {
  const { t } = useT()
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
      {t('missingDevice', { name })}
    </div>
  )
}

function AudioHistoryChartWidget(props: WidgetProps) {
  if (props.deviceId === undefined) return <MissingDevice name="AudioHistoryChart" />
  return <AudioHistoryChart deviceId={props.deviceId} />
}

function AudioMetricsPanelWidget(props: WidgetProps) {
  if (props.deviceId === undefined) return <MissingDevice name="AudioMetricsPanel" />
  return <AudioMetricsPanel deviceId={props.deviceId} />
}

function OccupancyHistoryChartWidget(props: WidgetProps) {
  if (props.deviceId === undefined) return <MissingDevice name="OccupancyHistoryChart" />
  return <OccupancyHistoryChart deviceId={props.deviceId} />
}

function MotionHistoryChartWidget(props: WidgetProps) {
  if (props.deviceId === undefined) return <MissingDevice name="MotionHistoryChart" />
  return <MotionHistoryChart deviceId={props.deviceId} />
}

function DetectionHistoryChartWidget(props: WidgetProps) {
  if (props.deviceId === undefined) return <MissingDevice name="DetectionHistoryChart" />
  return <DetectionHistoryChart deviceId={props.deviceId} />
}

function LiveOccupancyPanelWidget(props: WidgetProps) {
  if (props.deviceId === undefined) return <MissingDevice name="LiveOccupancyPanel" />
  return <OccupancyPanel deviceId={props.deviceId} />
}

function LiveStatsWidget(props: WidgetProps) {
  if (props.deviceId === undefined) return <MissingDevice name="LiveStats" />
  return <LiveStatsTab deviceId={props.deviceId} />
}

export default {
  'audio-history-chart': AudioHistoryChartWidget,
  'audio-metrics-panel': AudioMetricsPanelWidget,
  'occupancy-history-chart': OccupancyHistoryChartWidget,
  'motion-history-chart': MotionHistoryChartWidget,
  'detection-history-chart': DetectionHistoryChartWidget,
  'live-occupancy-panel': LiveOccupancyPanelWidget,
  'live-stats': LiveStatsWidget,
}
