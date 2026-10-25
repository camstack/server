/**
 * The day/night flag of a retrain frame (D785).
 *
 * The pipeline already decides "is it night here" for the scene monitor, in
 * layers (`scene/condition-resolver.ts`): the frame's own chroma first (an IR
 * frame is chromatically flat — the IR-cut is out, whatever the hour), then
 * the sun at the SITE's coordinates, then a coarse UTC clock. The export
 * reuses that resolver rather than inventing a second rule, and records which
 * layer answered.
 *
 * The time it asks about is the frame's CAPTURE time. A copy taken before
 * D785 has no capture time: its condition is unknown unless its pixels prove
 * IR. It is never resolved at the selection time, which is when the operator
 * clicked, not when the camera saw.
 */
import type { SceneCondition } from '@camstack/types'
import {
  type ConditionSource,
  type Coordinates,
  resolveConditionDetailed,
} from '../scene/condition-resolver.js'

export interface RetrainFrameLighting {
  readonly condition: SceneCondition
  /** `night` or `ir`. Twilight counts as day, as the tracking tapes do. */
  readonly night: boolean
  readonly source: ConditionSource
}

export interface RetrainLightingInput {
  /** When the camera captured the frame (epoch ms). */
  readonly capturedAt?: number
  /** Mean channel spread of the frame, measured at copy time. */
  readonly chromaSpread?: number
  /** The site's coordinates, `null` when the hub has none. */
  readonly coordinates: Coordinates | null
}

function isNight(condition: SceneCondition): boolean {
  return condition === 'night' || condition === 'ir'
}

export function retrainFrameLighting(input: RetrainLightingInput): RetrainFrameLighting | null {
  if (input.capturedAt === undefined) {
    // Only the pixels can still answer, and only when they prove IR: a colour
    // frame with no date may be daylight or a floodlit night.
    const measured = resolveConditionDetailed({
      ...(input.chromaSpread !== undefined ? { chromaSpread: input.chromaSpread } : {}),
      now: new Date(0),
    })
    return measured.source === 'ir-chroma'
      ? { condition: measured.condition, night: true, source: measured.source }
      : null
  }
  const resolved = resolveConditionDetailed({
    ...(input.chromaSpread !== undefined ? { chromaSpread: input.chromaSpread } : {}),
    ...(input.coordinates !== null ? { coordinates: input.coordinates } : {}),
    now: new Date(input.capturedAt),
  })
  return { ...resolved, night: isNight(resolved.condition) }
}
