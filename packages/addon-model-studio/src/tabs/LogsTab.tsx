/**
 * Logs — live ring of the model-studio addon.
 */
import { LogStream } from '@camstack/ui-library'

const MODEL_STUDIO_ADDON_ID = 'model-studio'

export function LogsTab() {
  return (
    <div className="space-y-3" data-testid="logs-tab">
      <LogStream
        addonId={MODEL_STUDIO_ADDON_ID}
        limit={200}
        maxHeight="max-h-[70vh]"
        showFilters
        showScope
      />
    </div>
  )
}
