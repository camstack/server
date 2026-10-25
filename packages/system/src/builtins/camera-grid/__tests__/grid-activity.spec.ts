/**
 * The grid speaking a camera's language about itself.
 *
 * The viewer lights a camera from three bus categories filtered by `deviceId`.
 * A grid IS a camera, so it answers the same three about its own id and the app
 * needs no change at all. The operator's rules: motion if at least one source
 * has it, and the loudest source's level for audio.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  EventCategory,
  type FrameResult,
  type IEventBus,
  type IScopedLogger,
} from '@camstack/types'
import { GridActivityForwarder, type GridActivityTarget } from '../grid-activity.js'

const GRID_ID = 900
const A = 592
const B = 618
const T0 = 1_700_000_000_000

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Emitted {
  readonly category: string
  readonly data: Record<string, unknown>
}

function harness(cells?: readonly { deviceId: number; source: unknown; cell: unknown }[]) {
  const emitted: Emitted[] = []
  const eventBus = {
    emit: (event: { category: string; data: Record<string, unknown> }) => {
      emitted.push({ category: event.category, data: event.data })
    },
    subscribe: vi.fn(),
  } as unknown as IEventBus
  const full = { x: 0, y: 0, width: 1, height: 1 }
  const layout = cells ?? [
    { deviceId: A, source: full, cell: { x: 0, y: 0, width: 0.5, height: 1 } },
    { deviceId: B, source: full, cell: { x: 0.5, y: 0, width: 0.5, height: 1 } },
  ]
  const grid: GridActivityTarget = {
    deviceId: GRID_ID,
    canvas: { width: 1920, height: 1080 },
    cellsForSource: (id) =>
      layout
        .filter((c) => c.deviceId === id)
        .map((c) => ({
          source: c.source as { x: number; y: number; width: number; height: number },
          cell: c.cell as { x: number; y: number; width: number; height: number },
        })),
    sourceDeviceIds: [...new Set(layout.map((c) => c.deviceId))],
  }
  const forwarder = new GridActivityForwarder({
    eventBus,
    logger: silentLogger(),
    addonId: 'camera-grid',
    gridsForSource: (id) => (grid.sourceDeviceIds.includes(id) ? [grid] : []),
    now: () => T0,
  })
  return { forwarder, emitted }
}

describe('motion', () => {
  it('announces the grid as moving when the FIRST source starts', () => {
    const { forwarder, emitted } = harness()
    forwarder.onSourceMotion(A, true, T0)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.category).toBe(EventCategory.MotionOnMotionChanged)
    expect(emitted[0]?.data).toMatchObject({ deviceId: GRID_ID, detected: true })
  })

  it('says nothing when a SECOND source starts — an edge, not a heartbeat', () => {
    const { forwarder, emitted } = harness()
    forwarder.onSourceMotion(A, true, T0)
    forwarder.onSourceMotion(B, true, T0 + 100)
    expect(emitted).toHaveLength(1)
  })

  it('stays moving while one source still is, and clears only with the last', () => {
    const { forwarder, emitted } = harness()
    forwarder.onSourceMotion(A, true, T0)
    forwarder.onSourceMotion(B, true, T0 + 100)
    forwarder.onSourceMotion(A, false, T0 + 200)
    expect(emitted).toHaveLength(1)
    forwarder.onSourceMotion(B, false, T0 + 300)
    expect(emitted).toHaveLength(2)
    expect(emitted[1]?.data).toMatchObject({ deviceId: GRID_ID, detected: false })
  })

  it('answers getStatus from the same mirror the events came out of', () => {
    const { forwarder } = harness()
    forwarder.onSourceMotion(A, true, T0)
    expect(forwarder.motionStatusFor(GRID_ID, T0).detected).toBe(true)
    expect(forwarder.motionStatusFor(GRID_ID, T0).lastDetectedAt).toBe(T0)
  })

  it('knows nothing about a device that is not a grid — false, not a throw', () => {
    const { forwarder } = harness()
    expect(forwarder.motionStatusFor(12345, T0)).toEqual({ detected: false, lastDetectedAt: null })
  })
})

describe('audio', () => {
  it('reports the LOUDEST source, not the most recent one', () => {
    const { forwarder, emitted } = harness()
    forwarder.onSourceAudio(A, -20, T0)
    forwarder.onSourceAudio(B, -50, T0)
    const levels = emitted.map((e) => (e.data.frame as { level: { dbfs: number } }).level.dbfs)
    expect(emitted[0]?.category).toBe(EventCategory.PipelineAudioInferenceResult)
    expect(levels).toEqual([-20, -20])
  })
})

function frameWith(deviceId: number): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f1',
    deviceId,
    timestamp: T0,
    width: 640,
    height: 360,
    detections: [
      {
        kind: 'first-level',
        id: 'd1',
        label: 'person',
        score: 0.9,
        bbox: { x: 0, y: 0, width: 640, height: 360 },
      },
    ],
  } as unknown as FrameResult
}

describe('detection', () => {
  it('re-addresses the box to the CANVAS, because the viewer draws it there', () => {
    const { forwarder, emitted } = harness()
    forwarder.onSourceDetections(frameWith(A))
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.category).toBe(EventCategory.DetectionResult)
    const frame = emitted[0]?.data.frame as FrameResult
    expect(frame.deviceId).toBe(GRID_ID)
    expect(frame.width).toBe(1920)
    // Left half of a 1920x1080 canvas.
    expect(frame.detections[0]?.bbox).toEqual({ x: 0, y: 0, width: 960, height: 1080 })
  })

  it('gives the composed frame its OWN id — two grids must not claim one frame', () => {
    const { forwarder, emitted } = harness()
    forwarder.onSourceDetections(frameWith(A))
    const frame = emitted[0]?.data.frame as FrameResult | undefined
    expect(frame?.frameId).not.toBe('f1')
  })

  it('says nothing for a camera this grid does not show', () => {
    const { forwarder, emitted } = harness()
    forwarder.onSourceDetections(frameWith(4242))
    expect(emitted).toHaveLength(0)
  })
})
