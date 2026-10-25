/**
 * Links INTO the Pipeline page's cluster tabs. The tab lives in `?ctab=` and a
 * settings section in `?section=` (scrolled into view on arrival), so a pointer
 * like "these knobs live in Cluster → Settings → Faces & recognition" is a link
 * that lands there, not a sentence the operator has to follow by hand.
 */
import { CLUSTER_NODE_ID } from '../../pages/Pipeline'
import { ACCELERATOR_PARAM, STEP_PARAM } from '../../lib/step-url-selection'
import { NODE_TAB_PARAM } from './NodeDetail'
import type { PIPELINE_NODE_EXTRA_TAB_IDS } from './pipeline-node-extra-tabs'
import { settingsSectionForStep } from './tabs/cluster-settings-sections'

export const CLUSTER_TAB_PARAM = 'ctab'
export const CLUSTER_SECTION_PARAM = 'section'

export function clusterTabHref(tab: string, section?: string): string {
  const params = new URLSearchParams({
    view: 'nodes',
    node: CLUSTER_NODE_ID,
    [CLUSTER_TAB_PARAM]: tab,
  })
  if (section !== undefined) params.set(CLUSTER_SECTION_PARAM, section)
  return `/system/pipeline?${params.toString()}`
}

// Functions, not constants: `pages/Pipeline` imports this module's consumers,
// so reading `CLUSTER_NODE_ID` at module load would hit the cycle.

/**
 * Cluster → Settings, on the card where a cluster-scoped step's encoder and
 * knobs are edited: Faces & recognition, or Semantic search for CLIP.
 */
export function clusterStepSettingsHref(stepId: string): string {
  return clusterTabHref('settings', settingsSectionForStep(stepId))
}

/** Cluster → Load balancing (accelerators, shares, caps). */
export function loadBalancingHref(): string {
  return clusterTabHref('load-balancing')
}

/** The node tab that hosts the step matrix (`NodeStepInspector`). */
const NODE_PIPELINE_TAB: (typeof PIPELINE_NODE_EXTRA_TAB_IDS)[number] = 'tree'

/**
 * One node's Pipeline tab with the step open on one accelerator: the cell
 * where that accelerator's model for the step is set (D927). A camera's
 * read-only model row links here — a camera never chooses a model itself.
 */
export function nodeStepModelHref(nodeId: string, stepId: string, acceleratorId: string): string {
  const params = new URLSearchParams({
    view: 'nodes',
    node: nodeId,
    [NODE_TAB_PARAM]: NODE_PIPELINE_TAB,
    [STEP_PARAM]: stepId,
    [ACCELERATOR_PARAM]: acceleratorId,
  })
  return `/system/pipeline?${params.toString()}`
}
