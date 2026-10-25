/**
 * Widget bundle contribution (S7) — pure static manifest. Analytics owns the
 * audio-metrics + zone-analytics caps, so the per-camera live charts (audio
 * dBFS, occupancy, motion histogram, detection histogram) and the live panels
 * (audio metrics card, occupancy panel) ship from this addon's bundle.
 * Admin-ui's <WidgetRegistryProvider> imports
 * /api/addon-widgets/pipeline-analytics/widgets.mjs?v=<mtime>;
 * <WidgetSlot widgetId="pipeline-analytics/<stableId>" deviceId={…}/> mounts
 * each one.
 */
import type { IAddonWidgetsSourceProvider } from '@camstack/types'

/** The remote-module coordinates shared by every analytics widget. */
const REMOTE_NAME = 'addon_pipeline_analytics_widgets'
const EXPOSED_MODULE = './widgets'

export function createAnalyticsWidgetsProvider(): IAddonWidgetsSourceProvider {
  return {
    listWidgets: async () => [
      {
        tab: 'device-tab',
        label: 'Audio Level History',
        kind: 'remote' as const,
        remote: {
          remoteName: REMOTE_NAME,
          exposedModule: EXPOSED_MODULE,
          componentKey: 'audio-history-chart',
        },
        // Analytics widgets read device data — never mounted pre-auth.
        preAuth: false,
        stableId: 'audio-history-chart',
        description: 'Sparkline of audio dBFS over a configurable window with class hits.',
        icon: 'activity',
        bundle: 'remoteEntry.js',
        hosts: ['device-tab', 'dashboard'] as const,
        requires: { deviceContext: true, integrationContext: false },
        defaultSize: 'lg' as const,
        allowedSizes: ['md', 'lg', 'xl'] as const,
        defaultColumns: 12,
        defaultRows: 2,
      },
      {
        tab: 'device-tab',
        label: 'Audio Metrics',
        kind: 'remote' as const,
        remote: {
          remoteName: REMOTE_NAME,
          exposedModule: EXPOSED_MODULE,
          componentKey: 'audio-metrics-panel',
        },
        // Analytics widgets read device data — never mounted pre-auth.
        preAuth: false,
        stableId: 'audio-metrics-panel',
        description: 'Live dBFS + dominant class + per-class summary card.',
        icon: 'mic',
        bundle: 'remoteEntry.js',
        hosts: ['device-tab', 'dashboard'] as const,
        requires: { deviceContext: true, integrationContext: false },
        defaultSize: 'md' as const,
        allowedSizes: ['sm', 'md', 'lg'] as const,
        defaultColumns: 6,
        defaultRows: 2,
      },
      {
        tab: 'device-tab',
        label: 'Occupancy History',
        kind: 'remote' as const,
        remote: {
          remoteName: REMOTE_NAME,
          exposedModule: EXPOSED_MODULE,
          componentKey: 'occupancy-history-chart',
        },
        // Analytics widgets read device data — never mounted pre-auth.
        preAuth: false,
        stableId: 'occupancy-history-chart',
        description: 'Frame-wide tracked-object count over time.',
        icon: 'users',
        bundle: 'remoteEntry.js',
        hosts: ['device-tab', 'dashboard'] as const,
        requires: { deviceContext: true, integrationContext: false },
        defaultSize: 'lg' as const,
        allowedSizes: ['md', 'lg', 'xl'] as const,
        defaultColumns: 12,
        defaultRows: 2,
      },
      {
        tab: 'device-tab',
        label: 'Motion History',
        kind: 'remote' as const,
        remote: {
          remoteName: REMOTE_NAME,
          exposedModule: EXPOSED_MODULE,
          componentKey: 'motion-history-chart',
        },
        // Analytics widgets read device data — never mounted pre-auth.
        preAuth: false,
        stableId: 'motion-history-chart',
        description: 'Histogram of motion events over a configurable window.',
        icon: 'activity',
        bundle: 'remoteEntry.js',
        hosts: ['device-tab', 'dashboard'] as const,
        requires: { deviceContext: true, integrationContext: false },
        defaultSize: 'lg' as const,
        allowedSizes: ['md', 'lg', 'xl'] as const,
        defaultColumns: 12,
        defaultRows: 2,
      },
      {
        tab: 'device-tab',
        label: 'Detection History',
        kind: 'remote' as const,
        remote: {
          remoteName: REMOTE_NAME,
          exposedModule: EXPOSED_MODULE,
          componentKey: 'detection-history-chart',
        },
        // Analytics widgets read device data — never mounted pre-auth.
        preAuth: false,
        stableId: 'detection-history-chart',
        description: 'Stacked-by-class histogram of object detections.',
        icon: 'eye',
        bundle: 'remoteEntry.js',
        hosts: ['device-tab', 'dashboard'] as const,
        requires: { deviceContext: true, integrationContext: false },
        defaultSize: 'lg' as const,
        allowedSizes: ['md', 'lg', 'xl'] as const,
        defaultColumns: 12,
        defaultRows: 2,
      },
      {
        tab: 'device-tab',
        label: 'Live Occupancy',
        kind: 'remote' as const,
        remote: {
          remoteName: REMOTE_NAME,
          exposedModule: EXPOSED_MODULE,
          componentKey: 'live-occupancy-panel',
        },
        // Analytics widgets read device data — never mounted pre-auth.
        preAuth: false,
        stableId: 'live-occupancy-panel',
        description: 'Per-zone breakdown + frame-wide aggregate (no polling).',
        icon: 'layers',
        bundle: 'remoteEntry.js',
        hosts: ['device-tab', 'dashboard'] as const,
        requires: { deviceContext: true, integrationContext: false },
        defaultSize: 'md' as const,
        allowedSizes: ['sm', 'md', 'lg'] as const,
        defaultColumns: 6,
        defaultRows: 2,
      },
      {
        tab: 'device-tab',
        label: 'Live Stats',
        kind: 'remote' as const,
        remote: {
          remoteName: REMOTE_NAME,
          exposedModule: EXPOSED_MODULE,
          componentKey: 'live-stats',
        },
        // Analytics widgets read device data — never mounted pre-auth.
        preAuth: false,
        stableId: 'live-stats',
        description:
          'Aggregated live-telemetry tab — occupancy, audio metrics, and the audio/occupancy/motion/detection history charts in one layout.',
        icon: 'activity',
        bundle: 'remoteEntry.js',
        hosts: ['device-tab'] as const,
        requires: { deviceContext: true, integrationContext: false },
        defaultSize: 'xl' as const,
        allowedSizes: ['lg', 'xl'] as const,
        defaultColumns: 12,
        defaultRows: 6,
      },
    ],
  }
}
