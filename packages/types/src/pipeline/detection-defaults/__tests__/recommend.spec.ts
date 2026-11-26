import { describe, expect, it } from 'vitest'
import {
  type DetectionDefaultsNodeFacts,
  recommendDetectionDefaults,
  resolveDetectionDefault,
} from '../index.js'

function node(
  over: Partial<DetectionDefaultsNodeFacts> & { nodeId: string },
): DetectionDefaultsNodeFacts {
  return { accelerator: 'intel-npu', decode4kMaxStreams: 8, cameras: 4, ...over }
}

describe('recommendDetectionDefaults (rule v1)', () => {
  it('no node serves cameras: no recommendation', () => {
    const r = recommendDetectionDefaults([node({ nodeId: 'a', cameras: 0 })])
    expect(r.detectionStreamProfile).toBeNull()
    expect(r.detectionFps).toBeNull()
    expect(r.reasons).toEqual([{ kind: 'no-serving-nodes' }])
  })

  it('(a) every serving node CPU-only: low stream, fps <= 5', () => {
    const r = recommendDetectionDefaults([
      node({ nodeId: 'a', accelerator: 'x86-cpu' }),
      node({ nodeId: 'b', accelerator: 'arm-cpu' }),
    ])
    expect(r.detectionStreamProfile).toBe('low')
    expect(r.detectionFps).toBeLessThanOrEqual(5)
    expect(r.reasons.some((x) => x.kind === 'cpu-only')).toBe(true)
  })

  it('accelerated node with enough 4K decode: high at 10 fps', () => {
    const r = recommendDetectionDefaults([node({ nodeId: 'a', decode4kMaxStreams: 4, cameras: 4 })])
    expect(r.detectionStreamProfile).toBe('high')
    expect(r.detectionFps).toBe(10)
  })

  it('(b) never high when 4K decode maxStreams < cameras served', () => {
    const r = recommendDetectionDefaults([node({ nodeId: 'a', decode4kMaxStreams: 3, cameras: 4 })])
    expect(r.detectionStreamProfile).toBe('mid')
    expect(r.reasons).toContainEqual({
      kind: 'decode-4k-below-cameras',
      nodeId: 'a',
      maxStreams: 3,
      cameras: 4,
    })
  })

  it('(c) mixed cluster is judged on the weakest serving node', () => {
    const r = recommendDetectionDefaults([
      node({ nodeId: 'strong' }),
      node({ nodeId: 'weak', accelerator: 'x86-cpu' }),
    ])
    expect(r.detectionStreamProfile).toBe('low')
    expect(r.detectionFps).toBe(5)
  })

  it('(c) a weak node serving NO camera is not judged', () => {
    const r = recommendDetectionDefaults([
      node({ nodeId: 'strong' }),
      node({ nodeId: 'idle-cpu', accelerator: 'x86-cpu', cameras: 0 }),
    ])
    expect(r.detectionStreamProfile).toBe('high')
    expect(r.detectionFps).toBe(10)
  })

  it('(d) unmeasured 4K decode: no profile recommendation, fps still known', () => {
    const r = recommendDetectionDefaults([node({ nodeId: 'a', decode4kMaxStreams: null })])
    expect(r.detectionStreamProfile).toBeNull()
    expect(r.detectionFps).toBe(10)
    expect(r.reasons).toContainEqual({
      kind: 'unknown',
      nodeId: 'a',
      dimension: 'stream-profile',
      missing: 'decode-4k',
    })
  })

  it('(d) unknown accelerator: neither dimension is guessed (never 0)', () => {
    const r = recommendDetectionDefaults([node({ nodeId: 'a', accelerator: null })])
    expect(r.detectionStreamProfile).toBeNull()
    expect(r.detectionFps).toBeNull()
  })

  it('(d) an unknown node does not hide that a known node already forces the floor', () => {
    const r = recommendDetectionDefaults([
      node({ nodeId: 'cpu', accelerator: 'x86-cpu' }),
      node({ nodeId: 'unk', accelerator: null }),
    ])
    expect(r.detectionStreamProfile).toBe('low')
    expect(r.detectionFps).toBe(5)
  })

  it('(d) an unknown node blocks a recommendation above the floor', () => {
    const r = recommendDetectionDefaults([
      node({ nodeId: 'ok' }),
      node({ nodeId: 'unk', accelerator: null }),
    ])
    expect(r.detectionStreamProfile).toBeNull()
    expect(r.detectionFps).toBeNull()
  })
})

describe('resolveDetectionDefault', () => {
  it('camera explicit > cluster > constant', () => {
    expect(resolveDetectionDefault('mid', 'low', 'high')).toBe('mid')
    expect(resolveDetectionDefault(undefined, 'low', 'high')).toBe('low')
    expect(resolveDetectionDefault(undefined, undefined, 'high')).toBe('high')
  })
})
