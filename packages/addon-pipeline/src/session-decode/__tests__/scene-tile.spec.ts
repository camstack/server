import { describe, expect, it } from 'vitest'
import type { ResolvedRegion } from '../crop-geometry.js'
import { selectTileForRect } from '../native-tile-geometry.js'
import { type NativeTile, NativeTileStore } from '../native-tile-store.js'
import {
  isSceneRegion,
  partitionSceneTile,
  planFrameCuts,
  SCENE_TILE_BBOX,
  selectRetainedTile,
} from '../scene-tile.js'

const region = (left: number, top: number, width: number, height: number): ResolvedRegion => ({
  left,
  top,
  width,
  height,
})

const tile = (at: ResolvedRegion, bytes = 100): NativeTile => ({
  region: at,
  bytes: new Uint8Array(bytes),
})

const FRAME_W = 3840
const FRAME_H = 2160

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('planFrameCuts', () => {
  const SUBJECT = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }

  it('appends the full-frame rectangle when the scene rung is enabled', () => {
    const plan = planFrameCuts([SUBJECT], { sceneEnabled: true, hasDetections: true })
    expect(plan.scene).toBe(true)
    expect(plan.bboxes).toHaveLength(2)
    expect(plan.bboxes[1]).toEqual(SCENE_TILE_BBOX)
  })

  it('leaves the cut list untouched when the scene rung is disabled', () => {
    const plan = planFrameCuts([SUBJECT], { sceneEnabled: false, hasDetections: true })
    expect(plan.scene).toBe(false)
    expect(plan.bboxes).toEqual([SUBJECT])
  })

  // The asymmetry that makes this tier affordable: a frame nobody detected
  // anything on leaves NOTHING behind, scene tile included. The keyFrame path
  // only ever names a frame that carried a best detection.
  it('never cuts a scene tile for a frame that detected nothing', () => {
    const plan = planFrameCuts([], { sceneEnabled: true, hasDetections: false })
    expect(plan.scene).toBe(false)
    expect(plan.bboxes).toEqual([])
  })

  // Two independent operator knobs. `tileBudgetMb: 0` empties the subject list
  // and must NOT take the scene rung down with it — that would be one slider
  // secretly gating another, and the key frames would vanish with no setting
  // saying so.
  it('still cuts the scene when the SUBJECT store is off', () => {
    const plan = planFrameCuts([], { sceneEnabled: true, hasDetections: true })
    expect(plan.scene).toBe(true)
    expect(plan.bboxes).toEqual([SCENE_TILE_BBOX])
  })
})

describe('isSceneRegion', () => {
  it('recognises the whole frame', () => {
    expect(isSceneRegion(region(0, 0, FRAME_W, FRAME_H), FRAME_W, FRAME_H)).toBe(true)
  })

  it('rejects a subject rectangle', () => {
    expect(isSceneRegion(region(100, 100, 400, 400), FRAME_W, FRAME_H)).toBe(false)
  })

  // A freed node-av frame reports 0x0. Classifying anything against those
  // dimensions would file every subject tile as the scene.
  it('is false for unknown frame dimensions', () => {
    expect(isSceneRegion(region(0, 0, 0, 0), 0, 0)).toBe(false)
  })
})

describe('partitionSceneTile', () => {
  it('splits the scene tile out of the cut result', () => {
    const subject = tile(region(100, 100, 400, 400))
    const scene = tile(region(0, 0, FRAME_W, FRAME_H), 2_000)
    const split = partitionSceneTile([subject, scene], FRAME_W, FRAME_H)
    expect(split.subjects).toEqual([subject])
    expect(split.scene).toBe(scene)
  })

  it('reports no scene tile when none was cut', () => {
    const subject = tile(region(100, 100, 400, 400))
    const split = partitionSceneTile([subject], FRAME_W, FRAME_H)
    expect(split.subjects).toEqual([subject])
    expect(split.scene).toBeNull()
  })

  // A padded subject that already spans the frame IS the scene; keeping the
  // FIRST one and leaving the rest as subjects means the two stores never hold
  // the same pixels twice.
  it('claims only the first frame-spanning tile', () => {
    const first = tile(region(0, 0, FRAME_W, FRAME_H))
    const second = tile(region(0, 0, FRAME_W, FRAME_H))
    const split = partitionSceneTile([first, second], FRAME_W, FRAME_H)
    expect(split.scene).toBe(first)
    expect(split.subjects).toEqual([second])
  })
})

// The rung the keyFrame path was missing. `selectTileForRect` is strict
// containment, so a full-frame rectangle can be answered by a frame-spanning
// tile and by nothing else — which is exactly why 95.7% of key-frame captures
// missed once the hold ended.
describe('selectRetainedTile', () => {
  const FULL = region(0, 0, FRAME_W, FRAME_H)

  it('a subject tile alone cannot answer the full-frame rectangle', () => {
    const subjects = [tile(region(100, 100, 400, 400))]
    expect(selectTileForRect(subjects, FULL)).toBeNull()
    expect(selectRetainedTile(subjects, [], FULL)).toBeNull()
  })

  it('the scene tile answers it', () => {
    const scene = tile(FULL)
    const served = selectRetainedTile([tile(region(100, 100, 400, 400))], [scene], FULL)
    expect(served?.source).toBe('scene')
    expect(served?.tile).toBe(scene)
    expect(served?.local).toEqual({ left: 0, top: 0, width: FRAME_W, height: FRAME_H })
  })

  // Both rungs are native-resolution, so either would be HONEST. The order is
  // about cost: a scene tile is ~20× a subject tile, and an ordinary face crop
  // must not be re-extracted from the big raster just because it also fits.
  it('prefers the subject tile when both contain the rectangle', () => {
    const subject = tile(region(100, 100, 400, 400))
    const scene = tile(FULL)
    const served = selectRetainedTile([subject], [scene], region(150, 150, 100, 100))
    expect(served?.source).toBe('subject')
    expect(served?.tile).toBe(subject)
  })

  // A rectangle no rung contains is a MISS, never a clamp into the nearest
  // tile — that would enrich a different part of the scene and error nowhere.
  it('is a miss, not a clamp, when nothing contains the rectangle', () => {
    const scenes = [tile(region(0, 0, 640, 360))]
    expect(selectRetainedTile([], scenes, FULL)).toBeNull()
  })
})

describe('the scene store', () => {
  // The operator's cap: a scene tile whose track never closes must not hold
  // RAM forever. The expiry is the store's own TTL, not the track's lifetime.
  it('expires on its own clock even if nothing ever asks for it', () => {
    const clock = fakeClock()
    const store = new NativeTileStore({ budgetBytes: 8_000_000, ttlMs: 30_000, now: clock.now })
    store.put(1, [tile(region(0, 0, FRAME_W, FRAME_H), 2_000_000)])
    clock.advance(10_000)
    expect(store.get(1)).toHaveLength(1)
    clock.advance(20_001)
    expect(store.get(1)).toEqual([])
    expect(store.totalBytes).toBe(0)
  })

  // Budget exhaustion drops the OLDEST scene, never the newest: a late request
  // is p50 367 ms old, so the newest tile is the one most likely to be asked
  // for. And every drop is COUNTED — a rung that silently forgets a key frame
  // is the failure this whole change exists to remove.
  it('evicts oldest-first under budget pressure and counts every drop', () => {
    const store = new NativeTileStore({ budgetBytes: 2_500, ttlMs: 30_000 })
    store.put(1, [tile(region(0, 0, FRAME_W, FRAME_H), 1_000)])
    store.put(2, [tile(region(0, 0, FRAME_W, FRAME_H), 1_000)])
    expect(store.evictedCount).toBe(0)
    store.put(3, [tile(region(0, 0, FRAME_W, FRAME_H), 1_000)])
    expect(store.get(1)).toEqual([])
    expect(store.get(3)).toHaveLength(1)
    expect(store.evictedCount).toBe(1)
  })

  // Two stores, so the arithmetic that starves one can never reach the other.
  // The face/plate path lives on subject tiles and must not pay for a keyFrame.
  it('cannot evict a subject tile — the budgets are separate stores', () => {
    const subjects = new NativeTileStore({ budgetBytes: 10_000, ttlMs: 30_000 })
    const scenes = new NativeTileStore({ budgetBytes: 1_500, ttlMs: 30_000 })
    subjects.put(1, [tile(region(100, 100, 400, 400), 900)])
    scenes.put(1, [tile(region(0, 0, FRAME_W, FRAME_H), 1_000)])
    scenes.put(2, [tile(region(0, 0, FRAME_W, FRAME_H), 1_000)])
    expect(scenes.evictedCount).toBe(1)
    expect(subjects.get(1)).toHaveLength(1)
    expect(subjects.evictedCount).toBe(0)
  })

  it('a zero budget disables the rung outright', () => {
    const store = new NativeTileStore({ budgetBytes: 0, ttlMs: 30_000 })
    expect(store.enabled).toBe(false)
    expect(store.put(1, [tile(region(0, 0, FRAME_W, FRAME_H))])).toBe(false)
  })
})
