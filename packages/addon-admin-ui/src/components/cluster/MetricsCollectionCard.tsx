/**
 * Nodes → "Metrics collection — all nodes": the metrics provider's cluster
 * settings (sampling interval, load-history cadence and retention). One value
 * for every node, so it sits under the node detail rather than inside it
 * (#578: the page that shows the load owns the knobs that collect it).
 */
import { Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  AddonScopedSettingsForm,
  SECTION_BODY,
  SectionCard,
  TEXT_HINT,
  useSystem,
} from '@camstack/ui-library'

const METRICS_ADDON_ID = 'metrics-native'
const METRICS_CAP = 'metrics-provider'

export function MetricsCollectionCard() {
  const { t } = useTranslation()
  const system = useSystem()
  return (
    <SectionCard
      headingId="cluster-metrics-collection"
      icon={Gauge}
      title={t('cluster.metricsSettings.title', 'Metrics collection — all nodes')}
    >
      <div className={`${SECTION_BODY} space-y-3`}>
        <p className={TEXT_HINT}>
          {t(
            'cluster.metricsSettings.hint',
            'How often every node samples its CPU, memory and load, and how long the load history is kept.',
          )}
        </p>
        <AddonScopedSettingsForm
          trpc={system.trpcClient}
          addonId={METRICS_ADDON_ID}
          cap={METRICS_CAP}
          scope="cluster"
          bare
        />
      </div>
    </SectionCard>
  )
}
