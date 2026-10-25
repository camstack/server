/**
 * What a camera's root-detector pick means for the steps of its pipeline.
 *
 * The pick (`CameraDetectionSource`) is the camera's stored `detectionSources`;
 * a camera runs AT MOST ONE root detector, so there is no "both":
 *
 *   `pipeline`  this node's own root step detects — every step applies
 *   `onboard`   the camera's own boxes ARE the root; the root step's inference
 *               never runs, the steps below it still run on crops cut from
 *               this node's decoded frames
 *   `none`      no root detector — nothing is detected, so every video step
 *               under the root is idle
 *
 * Pure: the Steps editor greys cells from {@link stepsSuppressedBySource} and
 * words the control from the functions here.
 */
import type { CameraDetectionSource } from '@camstack/types'
import type { StepTreeNode } from '@camstack/ui-library'
import i18n from '../../../i18n/index'

/** The root detector step of the video pipeline. */
export const ROOT_DETECTOR_STEP = 'object-detection'

type Geometry = 'boxed' | 'while-streaming' | 'flag-only' | 'unknown'

function subtreeIds(node: StepTreeNode): readonly string[] {
  return [node.addonId, ...node.children.flatMap(subtreeIds)]
}

/** The steps that do NOT run on this camera because of its root-detector pick. */
export function stepsSuppressedBySource(
  source: CameraDetectionSource,
  tree: readonly StepTreeNode[],
): ReadonlySet<string> {
  if (source === 'pipeline') return new Set()
  const root = findStep(tree, ROOT_DETECTOR_STEP)
  if (root === undefined) return new Set()
  return new Set(source === 'onboard' ? [root.addonId] : subtreeIds(root))
}

function findStep(tree: readonly StepTreeNode[], addonId: string): StepTreeNode | undefined {
  for (const node of tree) {
    if (node.addonId === addonId) return node
    const inside = findStep(node.children, addonId)
    if (inside !== undefined) return inside
  }
  return undefined
}

/** The badge a suppressed step carries in the matrix. */
export function suppressedBadgeLabel(source: CameraDetectionSource, addonId: string): string {
  if (source === 'onboard') return i18n.t('helpers.detectionSourceModel.badgeCameraAi')
  return addonId === ROOT_DETECTOR_STEP
    ? i18n.t('helpers.detectionSourceModel.badgeNoRoot')
    : i18n.t('helpers.detectionSourceModel.badgeIdle')
}

/** One sentence: what the current pick does to this pipeline. */
export function sourceExplanation(source: CameraDetectionSource): string {
  switch (source) {
    case 'pipeline':
      return i18n.t('helpers.detectionSourceModel.explainPipeline')
    case 'onboard':
      return i18n.t('helpers.detectionSourceModel.explainOnboard')
    case 'none':
      return i18n.t('helpers.detectionSourceModel.explainNone')
  }
}

/** What the camera's onboard detections carry, in words — empty when there is nothing to warn about. */
export function geometryNote(geometry: Geometry): string {
  switch (geometry) {
    case 'boxed':
      return ''
    case 'while-streaming':
      return i18n.t('helpers.detectionSourceModel.geometryWhileStreaming')
    case 'flag-only':
      return i18n.t('helpers.detectionSourceModel.geometryFlagOnly')
    case 'unknown':
      return i18n.t('helpers.detectionSourceModel.geometryUnknown')
  }
}

/** The text on the step badge's hover and in the panel notice of a suppressed step. */
export function suppressedStepNotice(source: CameraDetectionSource, addonId: string): string {
  if (source === 'onboard') {
    return i18n.t('helpers.detectionSourceModel.noticeOnboard')
  }
  return addonId === ROOT_DETECTOR_STEP
    ? i18n.t('helpers.detectionSourceModel.noticeNoRoot')
    : i18n.t('helpers.detectionSourceModel.noticeIdle')
}
