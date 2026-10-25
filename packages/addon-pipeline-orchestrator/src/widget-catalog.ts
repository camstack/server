/**
 * Widget descriptor catalog for `addon-widgets-source.listWidgets`.
 *
 * Pipeline-orchestrator owns the detection-state surface, so the per-camera
 * "Pipeline quick stats" KPI block + the zone editor live here. Admin-ui's
 * `<WidgetRegistryProvider>` imports
 * `/api/addon-widgets/pipeline-orchestrator/widgets.mjs?v=<mtime>`;
 * `<WidgetSlot widgetId="pipeline-orchestrator/pipeline-quick-stats"/>`
 * mounts it from form contributions or dashboard layouts.
 *
 * Extracted verbatim from `index.ts` (S1 refactor slice — zero behavior
 * change).
 */
import type { WidgetMetadata } from '@camstack/types'

export const pipelineOrchestratorWidgets: readonly WidgetMetadata[] = [
  {
    tab: 'device-tab',
    label: 'Pipeline Quick Stats',
    preAuth: false,
    kind: 'remote' as const,
    remote: {
      remoteName: 'addon_pipeline_orchestrator_widgets',
      exposedModule: './widgets',
      componentKey: 'pipeline-quick-stats',
    },
    stableId: 'pipeline-quick-stats',
    description: 'Phase / Detection FPS / Inference / Active Tracks tile row.',
    icon: 'activity',
    bundle: 'remoteEntry.js',
    hosts: ['device-tab', 'dashboard'] as const,
    requires: { deviceContext: true, integrationContext: false },
    defaultSize: 'md' as const,
    allowedSizes: ['sm', 'md', 'lg'] as const,
    defaultColumns: 6,
    defaultRows: 1,
  },
  {
    tab: 'device-tab',
    label: 'Zone Editor',
    preAuth: false,
    kind: 'remote' as const,
    remote: {
      remoteName: 'addon_pipeline_orchestrator_widgets',
      exposedModule: './widgets',
      componentKey: 'zone-editor',
    },
    stableId: 'zone-editor',
    description: 'Polygon / tripwire CRUD + per-stage rule editor.',
    icon: 'shapes',
    bundle: 'remoteEntry.js',
    hosts: ['device-tab'] as const,
    requires: { deviceContext: true, integrationContext: false },
    defaultSize: 'xl' as const,
    allowedSizes: ['lg', 'xl'] as const,
    defaultColumns: 12,
    defaultRows: 4,
  },
]
