/**
 * What one frame owes the packages scene path (D931).
 *
 * Options off: the sightings are unchanged and there is nothing to fetch.
 * Scene difference on: a model box whose center sits in that zone is not
 * the gate. Confirm-with-LLM still wants the same native crop pair.
 */

import type { FrameHandle } from '@camstack/types'
import type { StationaryBbox } from '../stationary/stationary-types.js'
import type { PackageSighting } from './package-stillness-tracker.js'
import type { PackageSceneOccluder } from './package-scene-diff.js'
import type { PackageSceneModelBox } from './package-scene-step.js'
import {
  packageZoneCropRect,
  type PackageReferenceZone,
  type PackageZoneCropRect,
} from './package-reference-area.js'
import {
  isDelivererInPackageZone,
  packageRuleZoneIds,
  type PackageOptionRule,
} from './package-zone-activity.js'

export interface PackageSceneTrack {
  readonly className: string
  readonly zones: readonly string[]
  readonly bbox: StationaryBbox
}

export interface PackageScenePlanInput {
  readonly rules: readonly PackageOptionRule[]
  readonly zones: readonly PackageReferenceZone[]
  readonly sightings: readonly PackageSighting[]
  readonly tracked: readonly PackageSceneTrack[]
  readonly frameWidth: number
  readonly frameHeight: number
  readonly frameHandle: FrameHandle | null
  readonly timestamp: number
  readonly minAreaFrac: number
  readonly modelBoxes: readonly PackageSceneModelBox[]
}

export interface PackageSceneNote {
  readonly deviceId: number
  readonly timestamp: number
  readonly detectBySceneDifference: boolean
  readonly confirmWithLlm: boolean
  readonly personInZone: boolean
  readonly frameWidth: number
  readonly frameHeight: number
  readonly minAreaFrac: number
  readonly frameHandle: FrameHandle | null
  readonly crop: PackageZoneCropRect | null
  readonly occluders: readonly PackageSceneOccluder[]
  readonly modelBoxes: readonly PackageSceneModelBox[]
}

export interface PackageScenePlan {
  readonly sightings: readonly PackageSighting[]
  readonly note: PackageSceneNote | null
}

export function planPackageSceneFrame(
  deviceId: number,
  input: PackageScenePlanInput,
): PackageScenePlan {
  const sceneZones = packageRuleZoneIds(input.rules, 'detectBySceneDifference')
  const llmZones = packageRuleZoneIds(input.rules, 'confirmWithLlm')
  if (sceneZones.size === 0 && llmZones.size === 0) {
    return { sightings: input.sightings, note: null }
  }
  const opted = unionIds(sceneZones, llmZones)
  const cropZones = sceneZones.size > 0 ? sceneZones : llmZones
  const crop = packageZoneCropRect({
    zones: input.zones,
    packageZoneIds: cropZones,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
  })
  const sceneRect =
    sceneZones.size === 0
      ? null
      : packageZoneCropRect({
          zones: input.zones,
          packageZoneIds: sceneZones,
          frameWidth: input.frameWidth,
          frameHeight: input.frameHeight,
        })
  return {
    sightings: sceneRect === null ? input.sightings : withoutSceneCenters(input, sceneRect),
    note: {
      deviceId,
      timestamp: input.timestamp,
      detectBySceneDifference: sceneZones.size > 0,
      confirmWithLlm: llmZones.size > 0,
      personInZone: personInside(input.tracked, opted),
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      minAreaFrac: input.minAreaFrac,
      frameHandle: input.frameHandle,
      crop,
      occluders: occludersOf(input.tracked),
      modelBoxes: input.modelBoxes,
    },
  }
}

function unionIds(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  const ids = new Set<string>(a)
  for (const id of b) ids.add(id)
  return ids
}

function personInside(tracked: readonly PackageSceneTrack[], zones: ReadonlySet<string>): boolean {
  for (const track of tracked) {
    if (track.className !== 'person') continue
    if (isDelivererInPackageZone(track.zones, zones)) return true
  }
  return false
}

function occludersOf(tracked: readonly PackageSceneTrack[]): readonly PackageSceneOccluder[] {
  const out: PackageSceneOccluder[] = []
  for (const track of tracked) {
    if (track.className === 'person') out.push({ className: 'person', bbox: track.bbox })
    if (track.className === 'vehicle') out.push({ className: 'vehicle', bbox: track.bbox })
  }
  return out
}

function withoutSceneCenters(
  input: PackageScenePlanInput,
  rect: PackageZoneCropRect,
): readonly PackageSighting[] {
  if (input.frameWidth <= 0 || input.frameHeight <= 0) return input.sightings
  return input.sightings.filter((sighting) => !centerInside(sighting.bbox, rect, input))
}

function centerInside(
  bbox: StationaryBbox,
  rect: PackageZoneCropRect,
  input: PackageScenePlanInput,
): boolean {
  const cx = (bbox.x + bbox.w / 2) / input.frameWidth
  const cy = (bbox.y + bbox.h / 2) / input.frameHeight
  return cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h
}
