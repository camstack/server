/**
 * Per-camera native crops for a packages rule (D931).
 *
 * One episode per device. The frame path calls `note` and returns; the crop
 * arrives later and, when scene difference is on, opens candidates in
 * PackageStillnessTracker. A downscaled preview is logged and dropped.
 */

import type { IScopedLogger } from '@camstack/types'
import type { StationaryBbox } from '../stationary/stationary-types.js'
import {
  PACKAGE_SCENE_DIFF_LOOK_GAP_MS,
  PACKAGE_SCENE_DIFF_SETTLE_MS,
  type PackageSceneOccluder,
  type PackageSceneRejection,
} from './package-scene-diff.js'
import {
  fetchPackageSceneCrop,
  type PackageSceneCropFetch,
  type PackageSceneNativeQuery,
} from './package-scene-fetch.js'
import type { PackageSceneNote } from './package-scene-plan.js'
import { stepPackageScene, type PackageSceneState } from './package-scene-step.js'
import type { PackageSighting } from './package-stillness-tracker.js'

export interface PackageSceneDelivery {
  readonly deviceId: number
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  readonly sightings: readonly PackageSighting[]
}

export interface PackageSceneCrops {
  readonly beforeJpeg?: Uint8Array
  readonly afterJpeg?: Uint8Array
}

interface Episode {
  readonly scene: PackageSceneState | null
  readonly jpegPhase: 'clear' | 'person' | 'settling'
  readonly leftAt: number | null
  readonly beforeJpeg?: Uint8Array
  readonly afterJpeg?: Uint8Array
  readonly held: boolean
  readonly inflight: boolean
  readonly lastFetchAt: number
  readonly logged: ReadonlySet<string>
}

const EMPTY: Episode = {
  scene: null,
  jpegPhase: 'clear',
  leftAt: null,
  held: false,
  inflight: false,
  lastFetchAt: 0,
  logged: new Set(),
}

export class PackageSceneCoordinator {
  private readonly episodes = new Map<number, Episode>()

  constructor(
    private readonly deps: {
      readonly query: PackageSceneNativeQuery
      readonly logger: IScopedLogger
      readonly onSightings: (delivery: PackageSceneDelivery) => void
    },
  ) {}

  note(input: PackageSceneNote): void {
    const prev = this.episodes.get(input.deviceId) ?? EMPTY
    const next = input.detectBySceneDifference
      ? this.stepClear(prev, input)
      : this.stepJpeg(prev, input)
    if (input.crop === null || input.frameHandle === null) {
      this.logOnce(input.deviceId, next, 'miss', 'package scene crop missed — no candidate', {
        reason: input.crop === null ? 'no-geometry' : 'no-handle',
      })
      return
    }
    this.episodes.set(input.deviceId, next)
    if (!cropDue(next, input)) return
    this.episodes.set(input.deviceId, { ...next, inflight: true, lastFetchAt: input.timestamp })
    void this.fetch(input)
  }

  cropsFor(deviceId: number): PackageSceneCrops {
    const episode = this.episodes.get(deviceId)
    if (episode === undefined) return {}
    const before = episode.scene?.beforeJpeg ?? episode.beforeJpeg
    const after = episode.scene?.afterJpeg ?? episode.afterJpeg
    return {
      ...(before !== undefined ? { beforeJpeg: before } : {}),
      ...(after !== undefined ? { afterJpeg: after } : {}),
    }
  }

  forget(deviceId: number): void {
    this.episodes.delete(deviceId)
  }

  private stepClear(prev: Episode, input: PackageSceneNote): Episode {
    const stepped = stepPackageScene({
      deviceId: input.deviceId,
      timestamp: input.timestamp,
      detectBySceneDifference: true,
      personInZone: input.personInZone,
      crop: null,
      cropOrigin: originOf(input),
      cropSizeInFrame: spanOf(input),
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      minAreaFrac: input.minAreaFrac,
      occluders: [],
      modelBoxes: input.modelBoxes,
      state: prev.scene,
    })
    this.logRejections(input.deviceId, prev.logged, stepped.rejections)
    const logged = nextLogged(
      prev.logged,
      stepped.rejections.map((r) => r.reason),
    )
    return { ...prev, scene: stepped.state, logged }
  }

  private stepJpeg(prev: Episode, input: PackageSceneNote): Episode {
    if (!input.confirmWithLlm) return prev
    if (input.personInZone) {
      return { ...prev, jpegPhase: 'person', leftAt: null, afterJpeg: undefined, held: false }
    }
    if (prev.jpegPhase === 'person') {
      return { ...prev, jpegPhase: 'settling', leftAt: input.timestamp }
    }
    return prev
  }

  private async fetch(input: PackageSceneNote): Promise<void> {
    const crop = input.crop
    const handle = input.frameHandle
    if (crop === null || handle === null) {
      this.finish(input.deviceId, { kind: 'miss', reason: 'no-geometry' }, input)
      return
    }
    const fetched = await fetchPackageSceneCrop(this.deps.query, {
      deviceId: input.deviceId,
      handle,
      bbox: crop,
    })
    this.finish(input.deviceId, fetched, input)
  }

  private finish(deviceId: number, fetched: PackageSceneCropFetch, input: PackageSceneNote): void {
    const prev = this.episodes.get(deviceId) ?? EMPTY
    const idle = { ...prev, inflight: false }
    if (fetched.kind === 'preview') {
      this.logOnce(deviceId, idle, 'preview', 'package scene crop refused — downscaled preview')
      return
    }
    if (fetched.kind === 'miss') {
      this.logOnce(deviceId, idle, 'miss', 'package scene crop missed — no candidate', {
        reason: fetched.reason,
      })
      return
    }
    if (input.detectBySceneDifference) {
      this.applyScene(deviceId, idle, fetched, input)
      return
    }
    this.applyJpeg(deviceId, idle, fetched.jpeg, input)
  }

  private applyScene(
    deviceId: number,
    prev: Episode,
    fetched: Extract<PackageSceneCropFetch, { kind: 'ok' }>,
    input: PackageSceneNote,
  ): void {
    if (prev.scene?.phase === 'person') {
      this.episodes.set(deviceId, { ...prev, logged: clearFetchLogs(prev.logged) })
      return
    }
    const crop = { width: fetched.width, height: fetched.height, luma: fetched.luma }
    const stepped = stepPackageScene({
      deviceId,
      timestamp: input.timestamp,
      detectBySceneDifference: true,
      personInZone: false,
      crop,
      cropJpeg: fetched.jpeg,
      cropOrigin: originOf(input),
      cropSizeInFrame: spanOf(input),
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      minAreaFrac: input.minAreaFrac,
      occluders: toCropOccluders(input, fetched.width, fetched.height),
      modelBoxes: input.modelBoxes,
      state: prev.scene,
    })
    this.logRejections(deviceId, prev.logged, stepped.rejections)
    this.episodes.set(deviceId, {
      ...prev,
      scene: stepped.state,
      logged: nextLogged(
        clearFetchLogs(prev.logged),
        stepped.rejections.map((r) => r.reason),
      ),
    })
    if (stepped.sightings.length === 0) return
    this.deps.onSightings({
      deviceId,
      timestamp: input.timestamp,
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      sightings: stepped.sightings,
    })
  }

  private applyJpeg(
    deviceId: number,
    prev: Episode,
    jpeg: Uint8Array,
    input: PackageSceneNote,
  ): void {
    const settled =
      prev.jpegPhase === 'settling' &&
      prev.leftAt !== null &&
      input.timestamp - prev.leftAt >= PACKAGE_SCENE_DIFF_SETTLE_MS
    if (settled) {
      this.episodes.set(deviceId, {
        ...prev,
        jpegPhase: 'clear',
        afterJpeg: jpeg,
        held: true,
        logged: clearFetchLogs(prev.logged),
      })
      return
    }
    if (prev.held) {
      this.episodes.set(deviceId, { ...prev, logged: clearFetchLogs(prev.logged) })
      return
    }
    this.episodes.set(deviceId, {
      ...prev,
      beforeJpeg: jpeg,
      logged: clearFetchLogs(prev.logged),
    })
  }

  private logRejections(
    deviceId: number,
    logged: ReadonlySet<string>,
    rejections: readonly PackageSceneRejection[],
  ): void {
    const seen = new Set<string>()
    for (const rejection of rejections) {
      if (logged.has(rejection.reason) || seen.has(rejection.reason)) continue
      seen.add(rejection.reason)
      this.deps.logger.info(`package scene blob dropped — ${rejection.reason}`, {
        tags: { deviceId },
        meta: {
          reason: rejection.reason,
          ...(rejection.areaFrac !== undefined
            ? { areaFrac: Number(rejection.areaFrac.toFixed(5)) }
            : {}),
        },
      })
    }
  }

  private logOnce(
    deviceId: number,
    episode: Episode,
    key: string,
    message: string,
    meta?: Readonly<Record<string, unknown>>,
  ): void {
    if (episode.logged.has(key)) {
      this.episodes.set(deviceId, episode)
      return
    }
    this.deps.logger.info(message, { tags: { deviceId }, ...(meta !== undefined ? { meta } : {}) })
    const logged = new Set(episode.logged)
    logged.add(key)
    this.episodes.set(deviceId, { ...episode, logged })
  }
}

function cropDue(episode: Episode, input: PackageSceneNote): boolean {
  if (input.crop === null || input.frameHandle === null) return false
  if (episode.inflight) return false
  if (input.personInZone) return false
  if (episode.held && !input.detectBySceneDifference) return false
  const phase = input.detectBySceneDifference
    ? (episode.scene?.phase ?? 'clear')
    : episode.jpegPhase
  if (phase === 'person') return false
  if (
    episode.lastFetchAt !== 0 &&
    input.timestamp - episode.lastFetchAt < PACKAGE_SCENE_DIFF_LOOK_GAP_MS
  ) {
    return false
  }
  if (phase === 'settling') {
    const left = input.detectBySceneDifference ? episode.scene?.leftAt : episode.leftAt
    if (left === null || left === undefined) return false
    if (input.timestamp - left < PACKAGE_SCENE_DIFF_SETTLE_MS) return false
  }
  return true
}

function originOf(input: PackageSceneNote): { readonly x: number; readonly y: number } {
  const crop = input.crop
  if (crop === null) return { x: 0, y: 0 }
  return { x: crop.x * input.frameWidth, y: crop.y * input.frameHeight }
}

function spanOf(input: PackageSceneNote): { readonly w: number; readonly h: number } {
  const crop = input.crop
  if (crop === null) return { w: input.frameWidth, h: input.frameHeight }
  return { w: crop.w * input.frameWidth, h: crop.h * input.frameHeight }
}

function toCropOccluders(
  input: PackageSceneNote,
  width: number,
  height: number,
): readonly PackageSceneOccluder[] {
  const origin = originOf(input)
  const span = spanOf(input)
  return input.occluders.map((occluder) => ({
    className: occluder.className,
    bbox: toCropPixels(occluder.bbox, origin, span, width, height),
  }))
}

function toCropPixels(
  box: StationaryBbox,
  origin: { readonly x: number; readonly y: number },
  span: { readonly w: number; readonly h: number },
  width: number,
  height: number,
): StationaryBbox {
  const scaleX = width > 0 ? span.w / width : 1
  const scaleY = height > 0 ? span.h / height : 1
  return {
    x: scaleX === 0 ? box.x : (box.x - origin.x) / scaleX,
    y: scaleY === 0 ? box.y : (box.y - origin.y) / scaleY,
    w: scaleX === 0 ? box.w : box.w / scaleX,
    h: scaleY === 0 ? box.h : box.h / scaleY,
  }
}

function nextLogged(
  previous: ReadonlySet<string>,
  reasons: readonly string[],
): ReadonlySet<string> {
  const next = new Set<string>()
  for (const reason of reasons) next.add(reason)
  for (const key of previous) {
    if (key === 'preview' || key === 'miss') next.add(key)
  }
  return next
}

function clearFetchLogs(previous: ReadonlySet<string>): ReadonlySet<string> {
  const next = new Set<string>()
  for (const key of previous) {
    if (key === 'preview' || key === 'miss') continue
    next.add(key)
  }
  return next
}
