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

function enrichedEvent(deviceId: number, timestamp: number = Date.now()) {
  return {
    source: { type: 'addon', id: 'pipeline-analytics' },
    data: { deviceId, timestamp, frameWidth: 640, frameHeight: 360, detections: [ROOT, FACE] },
  }
}

function rawEvent(
  deviceId: number,
  opts: { timestamp?: number; detections?: unknown[]; width?: number; height?: number } = {},
) {
  return {
    source: { id: deviceId },
    data: {
      frame: {
        width: opts.width ?? 640,
        height: opts.height ?? 360,
        ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
        detections: opts.detections ?? [ROOT],
      },
    },
  }
}

// Shape emitted by an OLD post-analysis (pre two-plane) on the SAME
// category/envelope: entries carry trackId/className/bbox{x,y,w,h}, no `kind`.
function legacyEnrichedEvent(deviceId: number) {
  return {
    source: { type: 'addon', id: 'pipeline-analytics' },
    data: {
      deviceId,
      timestamp: Date.now(),
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

const ENRICHED = 'pipeline-analytics.frame-tracked'
const RAW = 'detection.result'

describe('useDeviceDetections — raw roots + enriched extras', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ignores enriched frames for other devices', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get(ENRICHED)!(enrichedEvent(7)))
    expect(result.current.detection).toBeNull()
  })

  it('does not draw enriched root boxes (extras with no raw root are the details only)', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get(ENRICHED)!(enrichedEvent(9)))
    const dets = result.current.detection?.detections ?? []
    expect(dets.map((d) => d.id)).toEqual(['detail-t1-face'])
  })

  it('draws a raw frame immediately, even right after an enriched event', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get(ENRICHED)!(enrichedEvent(9)))
    act(() => handlers.get(RAW)!(rawEvent(9)))
    expect(result.current.detection?.detections.map((d) => d.id)).toEqual(['d1', 'detail-t1-face'])
  })

  it('attaches a face to the raw root by trackId, taking identity labels and re-parenting', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    const rawRoot = {
      ...ROOT,
      id: 'raw-77',
      track: { trackId: 'T7' },
      bbox: { x: 300, y: 200, width: 50, height: 100 },
    }
    const enrRoot = { ...ROOT, track: { trackId: 'T7' }, labels: [{ label: 'Alice', score: 0.9 }] }
    act(() => handlers.get(RAW)!(rawEvent(9, { detections: [rawRoot] })))
    act(() =>
      handlers.get(ENRICHED)!({
        ...enrichedEvent(9),
        data: { ...enrichedEvent(9).data, detections: [enrRoot, FACE] },
      }),
    )
    const dets = result.current.detection!.detections
    expect(dets).toHaveLength(2)
    expect(dets[0]!.id).toBe('raw-77')
    expect(dets[0]!.labels.map((l) => l.label)).toEqual(['Alice'])
    expect(dets[1]!.parentId).toBe('raw-77')
  })

  it('attaches a face to the raw root by IoU when there is no trackId', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    const rawRoot = { ...ROOT, id: 'raw-1', bbox: { x: 2, y: 2, width: 50, height: 100 } }
    act(() => handlers.get(RAW)!(rawEvent(9, { detections: [rawRoot] })))
    act(() => handlers.get(ENRICHED)!(enrichedEvent(9)))
    const dets = result.current.detection!.detections
    expect(dets.map((d) => d.id)).toEqual(['raw-1', 'detail-t1-face'])
    expect(dets[1]!.parentId).toBe('raw-1')
  })

  it('draws an unmatched extra standalone, scaled to the raw frame size', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    const far = { ...ROOT, id: 'far', bbox: { x: 500, y: 300, width: 50, height: 50 } }
    act(() => handlers.get(RAW)!(rawEvent(9, { detections: [far], width: 1280, height: 720 })))
    act(() => handlers.get(ENRICHED)!(enrichedEvent(9)))
    const dets = result.current.detection!.detections
    expect(dets).toHaveLength(2)
    expect(dets[1]!.id).toBe('detail-t1-face')
    expect(dets[1]!.bbox).toEqual({ x: 20, y: 10, width: 30, height: 40 })
    expect(result.current.detection!.frameWidth).toBe(1280)
  })

  it('skips a raw frame older than 1000 ms', () => {
    vi.setSystemTime(100_000)
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get(RAW)!(rawEvent(9, { timestamp: 98_900 })))
    expect(result.current.detection).toBeNull()
    act(() => handlers.get(RAW)!(rawEvent(9, { timestamp: 99_500 })))
    expect(result.current.detection).not.toBeNull()
  })

  it('skips an enriched frame older than 1000 ms', () => {
    vi.setSystemTime(100_000)
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get(ENRICHED)!(enrichedEvent(9, 98_900)))
    expect(result.current.detection).toBeNull()
  })

  it('ignores a legacy (pre-kind) frame-tracked payload', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get(ENRICHED)!(legacyEnrichedEvent(9)))
    expect(result.current.detection).toBeNull()
  })

  it('drops an out-of-order raw frame older than the newest already shown', () => {
    vi.setSystemTime(100_000)
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    const fire = handlers.get(RAW)!
    act(() => fire(rawEvent(9, { timestamp: 99_900 })))
    const shown = result.current.detection
    act(() => fire(rawEvent(9, { timestamp: 99_500, detections: [ROOT, ROOT] })))
    expect(result.current.detection).toBe(shown)
  })

  it('drops an out-of-order enriched frame older than the newest already shown', () => {
    vi.setSystemTime(100_000)
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    const fire = handlers.get(ENRICHED)!
    act(() => fire(enrichedEvent(9, 99_900)))
    const shown = result.current.detection
    act(() => fire(enrichedEvent(9, 99_500)))
    expect(result.current.detection).toBe(shown)
  })

  it('fades raw by frame age: a frame 300 ms old at arrival is gone 500 ms later', () => {
    vi.setSystemTime(100_000)
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get(RAW)!(rawEvent(9, { timestamp: 99_700 })))
    act(() => vi.advanceTimersByTime(450))
    expect(result.current.detection).not.toBeNull()
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.detection).toBeNull()
  })

  it('extras keep their own fade: the face persists across raw frames, then drops while the root stays', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result } = renderHook(() => useDeviceDetections(trpc, 9))
    act(() => handlers.get(RAW)!(rawEvent(9)))
    act(() => handlers.get(ENRICHED)!(enrichedEvent(9)))
    act(() => vi.advanceTimersByTime(400))
    act(() => handlers.get(RAW)!(rawEvent(9)))
    expect(result.current.detection?.detections).toHaveLength(2)
    act(() => vi.advanceTimersByTime(450)) // extras 850 ms old; raw 450 ms old
    expect(result.current.detection?.detections.map((d) => d.id)).toEqual(['d1'])
  })

  it('resets on device change', () => {
    const { handlers, trpc } = makeFakeTrpc()
    const { result, rerender } = renderHook(({ deviceId }) => useDeviceDetections(trpc, deviceId), {
      initialProps: { deviceId: 9 },
    })
    act(() => handlers.get(RAW)!(rawEvent(9)))
    act(() => handlers.get(ENRICHED)!(enrichedEvent(9)))
    rerender({ deviceId: 11 })
    act(() => handlers.get(RAW)!(rawEvent(11)))
    expect(result.current.detection?.detections.map((d) => d.id)).toEqual(['d1'])
  })
})
