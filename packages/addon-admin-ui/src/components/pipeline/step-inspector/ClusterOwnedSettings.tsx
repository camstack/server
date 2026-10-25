/**
 * The knobs of a step that the CLUSTER owns (`clusterStepSettingFieldsFor` —
 * the face-embedding minimum face size, …): shown read-only in the inspector,
 * with their value, and a link that lands on the one place they are edited.
 * They are not editable per node or per camera on purpose: both encoders fill
 * one shared index, and two admission policies would fill it inconsistently.
 */
import { Link } from 'react-router-dom'
import { clusterStepSettingFieldsFor, pickClusterStepSettings } from '@camstack/types'
import {
  SETTING_ROW,
  SETTING_ROW_LABEL,
  SETTING_ROW_VALUE,
  TEXT_HINT,
  TEXT_SECTION_LABEL,
  useAddonSettingsGetGlobalSettings,
} from '@camstack/ui-library'
import { clusterStepSettingsHref } from '../pipeline-links'
import { useTranslation } from 'react-i18next'

const OWNER_ADDON_ID = 'pipeline-orchestrator'

export function ClusterOwnedSettings({
  addonId,
  highlightLabel,
}: {
  readonly addonId: string
  /** A search hit on one of these labels — highlighted. */
  readonly highlightLabel?: string | null
}) {
  const { t } = useTranslation()
  const fields = clusterStepSettingFieldsFor(addonId)
  const { data } = useAddonSettingsGetGlobalSettings({ addonId: OWNER_ADDON_ID })
  if (fields.length === 0) return null
  const values = pickClusterStepSettings(data ?? null)[addonId] ?? {}
  return (
    <section
      className="space-y-1.5 border-t border-border/60 pt-3"
      aria-label={t(
        'stepInspector.clusterOwnedSettings.clusterWideSettings',
        'Cluster-wide settings',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={TEXT_SECTION_LABEL}>
          {t('stepInspector.clusterOwnedSettings.clusterWideSettings', 'Cluster-wide settings')}
        </h3>
        <Link
          to={clusterStepSettingsHref(addonId)}
          className="ml-auto text-[11px] text-primary hover:underline"
        >
          {t(
            'stepInspector.clusterOwnedSettings.editInClusterSettings',
            'Edit in Cluster → Settings ›',
          )}
        </Link>
      </div>
      {fields.map((field) => (
        <div
          key={field.key}
          className={`${SETTING_ROW} rounded px-2 ${highlightLabel === field.label ? 'bg-primary/5 ring-1 ring-primary/40' : ''}`}
        >
          <span className={SETTING_ROW_LABEL}>{field.label}</span>
          <span className={SETTING_ROW_VALUE}>
            <span className="font-mono text-xs text-foreground">
              {String(values[field.key] ?? field.default)}
            </span>
          </span>
        </div>
      ))}
      <p className={TEXT_HINT}>
        {t(
          'stepInspector.clusterOwnedSettings.oneValueForEveryNode',
          'One value for every node and camera — this step writes into a shared index.',
        )}
      </p>
    </section>
  )
}
