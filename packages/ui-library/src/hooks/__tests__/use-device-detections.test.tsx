// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeviceDetections } from '../use-device-detections'

type Handler = (event: unknown) => void

function makeFakeTrpc() {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    trpc: {
      live: {
        onEvent: {
          subscribe: (input: { category: string }, opts: { onData: Handler }) => {
            handlers.set(input.category, opts.onData)
            return { unsubscribe: () => handlers.delete(input.category) }
          },
        },
      },
    },
  }
}

const ROOT = {
  id: 'd1',
  kind: 'first-level',
  macroClass: 'person',
  score: 0.9,
  labels: [],
  bbox: { x: 0, y: 0, width: 50, height: 100 },
}
const FACE = {
  id: 'detail-t1-face',
  kind: 'detail',
  macroClass: 'face',
  parentId: 'd1',
  score: 0.8,
  labels: [{ label: 'Alice', score: 0.8 }],
  bbox: { x: 10, y: 5, width: 15, height: 20 },
}

function enrichedEvent(deviceId: number) {
  return {
    source: { type: 'addon', id: 'pipeline-analytics' },
    data: { deviceId, timestamp: 1, frameWidth: 640, frameHeight: 360, detections: [ROOT, FACE] },
  }
}

function rawEvent(deviceId: number) {
  return {
    source: { id: deviceId },
    data: { frame: { width: 640, height: 360, detections: [ROOT] } },
  }
}

// Shape emitted by an OLD post-analysis (pre two-plane) on the SAME
// category/envelope: entries carry trackId/className/bbox{x,y,w,h}, no `kind`.
function legacyEnrichedEvent(deviceId: number) {
  return {
    source: { type: 'addon', id: 'pipeline-analytics' },
    data: {
      deviceId,
      timestamp: 1,
      frameWidth: 640,
      frameHeight: 360,
      detections: [
        {
          trackId: 't1',
          className: 'person',
          bbox: { x: 0, y: 0, w: 50, h: 100 },
        },
      ],
    },
  }
}

describe('useDeviceDetections — frame-tracked enrichment', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('feeds DetectionState from pipeline-analytics.frame-tracked (match on data.deviceId)', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get('pipeline-analytics.frame-tracked')!(enrichedEvent(9)))
    expect(result.current.detection?.detections).toHaveLength(2)
    expect(result.current.detection?.frameWidth).toBe(640)
  })

  it('ignores enriched frames for other devices', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get('pipeline-analytics.frame-tracked')!(enrichedEvent(7)))
    expect(result.current.detection).toBeNull()
  })

  it('suppresses raw detection.result while enriched frames are fresh, accepts once the enriched display fades', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get('pipeline-analytics.frame-tracked')!(enrichedEvent(9)))
    act(() => handlers.get('detection.result')!(rawEvent(9)))
    expect(result.current.detection?.detections).toHaveLength(2) // still enriched
    act(() => vi.advanceTimersByTime(900)) // past DETECTION_FADE_MS: display faded AND suppression lifted together
    expect(result.current.detection).toBeNull() // faded
    act(() => handlers.get('detection.result')!(rawEvent(9)))
    expect(result.current.detection?.detections).toHaveLength(1) // raw accepted — no blank gap
  })

  it('ignores a legacy (pre-kind) frame-tracked payload and still accepts a following raw frame', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get('pipeline-analytics.frame-tracked')!(legacyEnrichedEvent(9)))
    expect(result.current.detection).toBeNull() // state unchanged — legacy shape rejected
    act(() => handlers.get('detection.result')!(rawEvent(9)))
    expect(result.current.detection?.detections).toHaveLength(1) // raw immediately accepted, no suppression stamped
  })

  it('resets the enriched-suppression window on device change so the new device accepts raw frames immediately', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result, rerender } = renderHook(({ deviceId }) => useDeviceDetections(trpc, deviceId), {
      initialProps: { deviceId: 9 },
    })
    act(() => handlers.get('pipeline-analytics.frame-tracked')!(enrichedEvent(9)))
    expect(result.current.detection?.detections).toHaveLength(2)

    rerender({ deviceId: 11 })
    act(() => handlers.get('detection.result')!(rawEvent(11)))
    expect(result.current.detection?.detections).toHaveLength(1) // raw accepted immediately for the new device
  })
})
