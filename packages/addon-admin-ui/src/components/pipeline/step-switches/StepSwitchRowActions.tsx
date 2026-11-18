/**
 * What a step tree draws under a step's name, for the node tree and the cluster
 * tree alike: the step's switch when the matrix has a row for it, a muted
 * "off with <parent>" when a switchable ancestor is off, and nothing for any
 * other step. The matrix is the one `use-step-switches` answer — a pending or
 * failed matrix draws nothing here (the notices say so), never an "off".
 */
import { ErrorBox } from '@camstack/ui-library'
import type { StepTreeNode } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { ClusterStepModeControl } from './ClusterStepModeControl'
import { NodeStepSwitchControl } from './NodeStepSwitchControl'
import { findNode, nodeEffect, type StepSwitchRow } from './step-switches-model'
import type { StepSwitchesView, StepSwitchWriters } from './use-step-switches'

/** Step id → the step that feeds it, for every non-root step of the tree. */
export type StepParents = ReadonlyMap<string, StepTreeNode>

export function stepParents(tree: readonly StepTreeNode[]): StepParents {
  const out = new Map<string, StepTreeNode>()
  const walk = (node: StepTreeNode): void => {
    for (const child of node.children) {
      out.set(child.addonId, node)
      walk(child)
    }
  }
  tree.forEach(walk)
  return out
}

function rowOf(view: StepSwitchesView, stepId: string): StepSwitchRow | undefined {
  return view.status === 'ready' ? view.rows.find((r) => r.stepId === stepId) : undefined
}

/** The nearest ancestor of `stepId` that has a switch row, when that row is off by `isOff`. */
function offAncestor(
  view: StepSwitchesView,
  parents: StepParents,
  stepId: string,
  isOff: (row: StepSwitchRow) => boolean,
): StepTreeNode | null {
  for (let at = parents.get(stepId); at !== undefined; at = parents.get(at.addonId)) {
    const row = rowOf(view, at.addonId)
    if (row !== undefined) return isOff(row) ? at : null
  }
  return null
}

function OffWithParent({ parent }: { readonly parent: StepTreeNode }) {
  const { t } = useTranslation()
  return (
    <span className="text-[11px] text-foreground-muted" data-testid="off-with-parent">
      {t('pipeline.stepSwitches.offWithParent', 'Off with {{parent}}', {
        parent: parent.addonName,
      })}
    </span>
  )
}

interface NodeStepRowActionProps {
  readonly addonId: string
  readonly nodeId: string
  readonly parents: StepParents
  readonly view: StepSwitchesView
  readonly writers: StepSwitchWriters
}

export function NodeStepRowAction({
  addonId,
  nodeId,
  parents,
  view,
  writers,
}: NodeStepRowActionProps) {
  const row = rowOf(view, addonId)
  if (row !== undefined) {
    return <NodeStepSwitchControl row={row} nodeId={nodeId} writers={writers} />
  }
  const parent = offAncestor(view, parents, addonId, (r) => {
    const node = findNode(r, nodeId)
    return node !== undefined && nodeEffect(node).state === 'off'
  })
  return parent === null ? null : <OffWithParent parent={parent} />
}

interface ClusterStepRowActionProps {
  readonly addonId: string
  readonly parents: StepParents
  readonly view: StepSwitchesView
  readonly writers: StepSwitchWriters
}

export function ClusterStepRowAction({
  addonId,
  parents,
  view,
  writers,
}: ClusterStepRowActionProps) {
  const row = rowOf(view, addonId)
  if (row !== undefined) return <ClusterStepModeControl row={row} writers={writers} />
  const parent = offAncestor(view, parents, addonId, (r) => r.effectiveMode === 'off')
  return parent === null ? null : <OffWithParent parent={parent} />
}

interface StepSwitchNoticesProps {
  readonly view: StepSwitchesView
  readonly writers: StepSwitchWriters
}

/** A matrix that failed to load and a write that failed; a pending matrix says nothing. */
export function StepSwitchNotices({ view, writers }: StepSwitchNoticesProps) {
  const { t } = useTranslation()
  return (
    <>
      {view.status === 'error' && (
        <ErrorBox
          title={t('pipeline.stepSwitches.loadFailed', 'Step switches did not load')}
          message={view.message}
        />
      )}
      {writers.error !== null && (
        <ErrorBox
          title={t('pipeline.stepSwitches.writeFailed', 'The change was not saved')}
          message={writers.error}
        />
      )}
    </>
  )
}
