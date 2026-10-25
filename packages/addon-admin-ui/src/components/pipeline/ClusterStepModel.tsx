/**
 * ClusterStepModel — the step settings panel's READ-ONLY model section for a
 * CLUSTER-scoped step (face embedding, CLIP embedding).
 *
 * Both write into a single shared vector index, where a second encoder does
 * not weaken the ranking, it destroys it — so the model is ONE row for the
 * whole cluster (`pipeline-orchestrator` global settings). The inspector shows
 * it, and links to the one place it is edited (Cluster → Settings →
 * Faces & recognition / Semantic search); it is never a second editor of that row.
 *
 * ## Why the step is still shown here at all
 *
 * Because hiding it is worse. An operator configuring a node or a camera looks
 * at this list; a step silently missing from it reads as "not available here",
 * which is exactly the wrong conclusion. It stays, with the badge saying who
 * owns it (D62: a surface stores nothing of its own and names the authority).
 */
import { Link } from 'react-router-dom'
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  type ClusterModelScopedStep,
  pickClusterStepModels,
} from '@camstack/types'
import { TEXT_HINT, useAddonSettingsGetGlobalSettings } from '@camstack/ui-library'
import { clusterStepSettingsHref } from './pipeline-links'
import { Trans, useTranslation } from 'react-i18next'

/** The addon whose GLOBAL settings hold the row. Same constant the runner reads. */
const CLUSTER_MODEL_OWNER_ADDON_ID = 'pipeline-orchestrator'

/** The catalog entry for a cluster-scoped step, or null when it is node-scoped. */
export function clusterScopedStep(addonId: string): ClusterModelScopedStep | null {
  return CLUSTER_MODEL_SCOPED_STEPS.find((s) => s.stepId === addonId) ?? null
}

interface ClusterStepModelProps {
  readonly step: ClusterModelScopedStep
  /** The viewed accelerator's engine format, to warn when it ships no build of the choice. */
  readonly engineFormat: string
  /** Model ids that format can actually run, from the live catalog schema. */
  readonly runnableModelIds: readonly string[]
}

export function ClusterStepModel({ step, engineFormat, runnableModelIds }: ClusterStepModelProps) {
  const { t } = useTranslation()
  const { data: settings } = useAddonSettingsGetGlobalSettings({
    addonId: CLUSTER_MODEL_OWNER_ADDON_ID,
  })
  const current = pickClusterStepModels(settings ?? null)[step.stepId] ?? step.defaultModelId
  const label = step.options.find((o) => o.id === current)?.label ?? current
  // A refusal, not a substitution: the node runs nothing for this step rather
  // than a different encoder, so the operator has to see it here.
  const unservableHere = runnableModelIds.length > 0 && !runnableModelIds.includes(current)

  return (
    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-foreground">{step.label}</span>
        <span className="font-mono text-foreground">{label}</span>
        <span
          title={t(
            'pipeline.clusterStepModel.oneValueForTheWhole',
            'One value for the whole cluster — this step writes into a shared vector index, where two encoders make similarity scores meaningless.',
          )}
          className="rounded border border-primary/40 bg-primary/10 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-primary"
        >
          {t('pipeline.clusterStepModel.clusterWide')}
        </span>
        <Link
          to={clusterStepSettingsHref(step.stepId)}
          className="ml-auto text-[11px] text-primary hover:underline"
        >
          {t('pipeline.clusterStepModel.changeInClusterSettings', 'Change in Cluster → Settings ›')}
        </Link>
      </div>
      <p className={TEXT_HINT}>
        {t(
          'pipeline.clusterStepModel.oneModelForEveryNode',
          'One model for every node and camera:',
        )}{' '}
        {t('pipeline.clusterStepModel.indexNote', { index: step.indexName })}
      </p>
      {unservableHere && (
        <p className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] leading-snug text-warning">
          <Trans
            i18nKey="pipeline.clusterStepModel.noBuild"
            values={{ engine: engineFormat, model: current, index: step.indexName }}
            components={{ b: <b /> }}
          />
        </p>
      )}
    </div>
  )
}
