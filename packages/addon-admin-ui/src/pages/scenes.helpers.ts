/**
 * Pure row assembly for the Scenes page.
 *
 * The page's whole reason to exist is that a scene is a question about the
 * PROPERTY, not about a camera: "which of my scenes have tripped" cannot be
 * asked one camera at a time. So the cross-camera flattening and, more
 * importantly, the ORDER live here where they can be tested — the order is the
 * answer to that question, and a page that sorts alphabetically buries the one
 * row the operator opened it for.
 */

import type { SceneMonitor } from '@camstack/types'

export interface SceneCamera {
  readonly deviceId: number
  readonly deviceName: string
}

export interface SceneRow {
  readonly deviceId: number
  readonly deviceName: string
  readonly monitor: SceneMonitor
}

/** Per-camera `listScenes` results, tagged with the camera they came from. */
export interface SceneCameraResult {
  readonly deviceId: number
  readonly monitors: readonly SceneMonitor[]
}

/**
 * Sort rank, lowest first. Deliberately NOT alphabetical:
 *
 *   0. latched — the operator asked to be told, and the latch outlives the live
 *      state. This is the row the page was opened for.
 *   1. live divergence that has not latched (an `emit: 'live'` scene).
 *   2. armed but unable to judge — `unknown` is a REAL state here, not a
 *      loading spinner, and it is the one that silently rots (a scene with only
 *      a daylight reference stops answering after sunset).
 *   3. not armed yet — configured, never captured, therefore doing nothing.
 *   4. normal.
 *
 * Ranks 2 and 3 sit ABOVE normal on purpose: both mean "this scene is not
 * working", and this feature's failure mode is silence that reads as "nothing
 * has happened".
 */
export function sceneRank(monitor: SceneMonitor): number {
  if (monitor.states.length === 0) return 3
  if (monitor.latched) return 0
  if (monitor.verdict === 'diverged') return 1
  if (monitor.verdict === 'unknown') return 2
  return 4
}

/**
 * The instant a row last changed its mind, or `null` if it never has.
 *
 * `lastCheckedAt` is deliberately not a candidate: a scene that has been Normal
 * for a week is checked every 60 s, and showing that as "last transition" would
 * make every row look like it just moved.
 */
export function lastTransitionAt(monitor: SceneMonitor): number | null {
  const candidates = [monitor.divergedAt, monitor.restoredAt].filter(
    (t): t is number => typeof t === 'number',
  )
  return candidates.length === 0 ? null : Math.max(...candidates)
}

/**
 * Flatten per-camera results into one ordered list.
 *
 * Cameras with no scenes contribute no rows — they are not "empty rows", they
 * are simply not part of this page. A camera that failed to answer contributes
 * none either, and the caller reports that separately rather than letting a
 * failed read look like "no scenes configured".
 */
export function buildSceneRows(
  cameras: readonly SceneCamera[],
  results: readonly SceneCameraResult[],
): readonly SceneRow[] {
  const nameById = new Map(cameras.map((c) => [c.deviceId, c.deviceName]))
  const rows: SceneRow[] = []
  for (const result of results) {
    for (const monitor of result.monitors) {
      rows.push({
        deviceId: result.deviceId,
        deviceName: nameById.get(result.deviceId) ?? `Camera ${result.deviceId}`,
        monitor,
      })
    }
  }
  return rows.toSorted((a, b) => {
    const rank = sceneRank(a.monitor) - sceneRank(b.monitor)
    if (rank !== 0) return rank
    // Most recently moved first inside a rank — a row that has never moved
    // sorts last rather than first, which `-1` would get backwards.
    const at = lastTransitionAt(a.monitor) ?? -1
    const bt = lastTransitionAt(b.monitor) ?? -1
    if (at !== bt) return bt - at
    const byCamera = a.deviceName.localeCompare(b.deviceName)
    return byCamera !== 0 ? byCamera : a.monitor.label.localeCompare(b.monitor.label)
  })
}

/** How many conditions this scene can actually judge, out of those it has met. */
export function coverageCount(monitor: SceneMonitor): number {
  return monitor.coveredConditions.length
}
