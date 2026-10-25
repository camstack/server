/**
 * ZoneEditor — `zone-editor` widget. Owned by addon-pipeline-orchestrator
 * (the cap surface for `zones` + `zone-rules`).
 *
 * Wraps the `ZonesTab` content (canvas + zone list + form + rules
 * editors) into the `WidgetProps` contract. `<WidgetSlot widgetId=
 * "pipeline-orchestrator/zone-editor" deviceId={…}/>` mounts it from a
 * form contribution (`fieldType: 'widget'`) or a top-tab section.
 *
 * Replaces the legacy bespoke `'zone-editor'` field type in admin-ui's
 * CustomFieldRenderersProvider — the operator-facing surface is
 * unchanged but the React code lives alongside the addon that owns
 * the `zones` cap.
 */
import type { WidgetProps } from '@camstack/ui-library'
import { useT } from '../i18n/index.js'
import { ZonesTab } from './ZonesTab'

export function ZoneEditor(props: WidgetProps) {
  const { t } = useT()
  if (props.deviceId === undefined) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        {t('zoneEditor.requiresDevice')}
      </div>
    )
  }
  return <ZonesTab deviceId={props.deviceId} />
}
