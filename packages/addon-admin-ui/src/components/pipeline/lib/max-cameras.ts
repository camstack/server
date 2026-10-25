/**
 * Shared max-cameras UI model for the pipeline page.
 *
 * Holds the single nullable-slider descriptor reused by both the per-node
 * Pipeline tab (T1) and the cluster-wide bulk-set card (T3), plus the pure
 * bulk-set summary/plan model (T2). Keeping the descriptor in one place
 * guarantees the per-node and cluster controls render identically.
 */
import type { ConfigSliderField } from '@camstack/types'
import i18n from '../../../i18n/index'

/** Generous ceiling for the slider track — the cap itself accepts any positive int. */
export const MAX_CAMERAS_SLIDER_MAX = 64

/**
 * Nullable slider descriptor: `null` renders the dashed "Unlimited — click to
 * set manually" state and emits `null` on reset, matching the cap's
 * `maxCameras: null | number` contract (null/0 both mean unlimited).
 */
export const maxCamerasField: ConfigSliderField = {
  key: 'maxCameras',
  type: 'slider',
  get label() {
    return i18n.t('helpers.maxCameras.label')
  },
  get description() {
    return i18n.t('helpers.maxCameras.description')
  },
  min: 1,
  max: MAX_CAMERAS_SLIDER_MAX,
  step: 1,
  showValue: true,
  showStepper: true,
  nullable: true,
  get nullLabel() {
    return i18n.t('helpers.maxCameras.unlimited')
  },
}

// ---------------------------------------------------------------------------
// Cluster bulk-set model (pure, immutable)
// ---------------------------------------------------------------------------

/** One node's persisted cap. `null` = Unlimited. */
export interface AgentMaxCameras {
  readonly agentNodeId: string
  readonly maxCameras: number | null
}

/**
 * Cluster-wide view of every node's cap, used to seed the bulk-set slider:
 * `uniform` → drive the slider to that value; `mixed` → show a "values differ"
 * caption listing `perNode`; `empty` → no nodes configured yet.
 */
export type MaxCamerasSummary =
  | { readonly kind: 'uniform'; readonly value: number | null }
  | { readonly kind: 'mixed'; readonly perNode: readonly AgentMaxCameras[] }
  | { readonly kind: 'empty' }

export function summarizeMaxCameras(settings: readonly AgentMaxCameras[]): MaxCamerasSummary {
  if (settings.length === 0) return { kind: 'empty' }
  const first = settings[0].maxCameras
  const allSame = settings.every((s) => s.maxCameras === first)
  if (allSame) return { kind: 'uniform', value: first }
  return { kind: 'mixed', perNode: settings }
}

/**
 * The minimal mutation set for an Apply: node ids whose CURRENT cap differs
 * from `target`. `allNodeIds` (from topology) is authoritative — `settings`
 * only carries nodes with an existing row, so a never-configured node counts
 * as `current = null` and still receives the write when `target` differs.
 * Settings rows for nodes absent from topology (offline/stale) are ignored.
 */
export function bulkSetPlan(
  settings: readonly AgentMaxCameras[],
  allNodeIds: readonly string[],
  target: number | null,
): readonly string[] {
  const currentById = new Map(settings.map((s) => [s.agentNodeId, s.maxCameras]))
  return allNodeIds.filter((id) => (currentById.get(id) ?? null) !== target)
}
