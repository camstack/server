/**
 * Cluster → Pipeline — the detection step tree of the whole cluster, drawn
 * with the same matrix component as a node's step tree, and each switchable
 * step's CLUSTER mode (off / on / opt-in) under its name. The node page carries
 * the node switches and the accelerator switches of the same steps.
 *
 * The tree comes from the executor catalog and the modes from the one
 * `use-step-switches` answer; neither is copied here. Until the catalog
 * answers the tab says so — an unanswered query is not an empty tree.
 */
import { useMemo, useState } from 'react'
import {
  buildStepTreeFromSchema,
  DeviceStepMatrix,
  ErrorBox,
  Skeleton,
  TEXT_HINT,
  usePipelineExecutorGetSchema,
} from '@dominevo/ui-library'
import type { StepTreeNode } from '@dominevo/ui-library'
import { useTranslation } from 'react-i18next'
import {
  ClusterStepRowAction,
  stepParents,
  StepSwitchNotices,
} from '../step-switches/StepSwitchRowActions'
import type { StepSwitchRow } from '../step-switches/step-switches-model'
import { useStepSwitches, useStepSwitchWriters } from '../step-switches/use-step-switches'

/** Names of the matrix steps the catalog tree has no row for — their cluster mode has no control here. */
function stepsOutsideTree(
  rows: readonly StepSwitchRow[],
  tree: readonly StepTreeNode[],
): readonly string[] {
  const inTree = new Set<string>()
  const walk = (node: StepTreeNode): void => {
    inTree.add(node.addonId)
    node.children.forEach(walk)
  }
  tree.forEach(walk)
  return rows.filter((r) => !inTree.has(r.stepId)).map((r) => r.name)
}

export function ClusterPipelineTab() {
  const { t } = useTranslation()
  const schemaQuery = usePipelineExecutorGetSchema(undefined, {
    refetchOnMount: 'always',
  })
  const view = useStepSwitches(t('pipeline.stepSwitches.loadFailed', 'Step switches did not load'))
  const writers = useStepSwitchWriters(
    t('pipeline.stepSwitches.writeFailed', 'The change was not saved'),
  )
  const [fallbackNodeId, setFallbackNodeId] = useState<string | null>(null)
  const schema = schemaQuery.data ?? null
  const tree = useMemo(() => (schema === null ? [] : buildStepTreeFromSchema(schema)), [schema])
  const parents = useMemo(() => stepParents(tree), [tree])
  const missingSteps = useMemo(
    () => (view.status === 'ready' && schema !== null ? stepsOutsideTree(view.rows, tree) : []),
    [view, schema, tree],
  )

  return (
    <div className="space-y-2">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-foreground">
          {t('pipeline.clusterPipelineTab.title', 'Pipeline steps')}
        </h3>
        <p className={TEXT_HINT}>
          {t(
            'pipeline.clusterPipelineTab.hint',
            'Off turns a step off for every camera. On runs it unless a camera turns it off. Opt-in runs it only on cameras that turn it on. A node or accelerator switch can still turn it off below that — those are on the node page.',
          )}
        </p>
      </div>
      <StepSwitchNotices view={view} writers={writers} />
      {schemaQuery.isError && (
        <ErrorBox
          title={t('pipeline.clusterPipelineTab.catalogFailed', 'The step catalog did not load')}
          message={schemaQuery.error.message}
        />
      )}
      {schemaQuery.isLoading && <Skeleton className="h-24 w-full" />}
      {schema !== null && tree.length === 0 && (
        <p className={TEXT_HINT}>
          {t('pipeline.clusterPipelineTab.noSteps', 'The catalog reports no pipeline steps.')}
        </p>
      )}
      {tree.length > 0 && (
        <DeviceStepMatrix
          tree={tree}
          agents={[]}
          label={t('pipeline.clusterPipelineTab.label', 'Pipeline steps')}
          getCellState={() => ({ kind: 'na' })}
          onCellClick={() => undefined}
          selectedCell={null}
          fallbackNodeId={fallbackNodeId}
          onFallbackNodeChange={setFallbackNodeId}
          stepAction={(addonId) => (
            <ClusterStepRowAction
              addonId={addonId}
              parents={parents}
              view={view}
              writers={writers}
            />
          )}
        />
      )}
      {missingSteps.length > 0 && (
        <p className={TEXT_HINT} data-testid="uncontrolled-steps">
          {t(
            'pipeline.clusterPipelineTab.missingSteps',
            'Not in this tree, so their cluster mode cannot be set here: {{steps}}.',
            { steps: missingSteps.join(', ') },
          )}
        </p>
      )}
    </div>
  )
}
