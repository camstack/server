/**
 * Widget bundle entry — built into `dist/widgets.mjs` by
 * `vite.widgets.config.ts`. Default export is the `Record<stableId,
 * Component>` map the host's `WidgetRegistry` consumes.
 */
import { PipelineQuickStats } from './PipelineQuickStats'
import { ZoneEditor } from './ZoneEditor'

export default {
  'pipeline-quick-stats': PipelineQuickStats,
  'zone-editor': ZoneEditor,
}
