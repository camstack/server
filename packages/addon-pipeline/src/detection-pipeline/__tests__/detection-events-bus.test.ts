/**
 * Detection Events Bus — Unit Tests
 *
 * Validates the real-time detection event flow through the EventBus.
 * No real inference — all pipeline/provider interactions are mocked.
 * Tests verify correct event emission, payload shape, and subscriber filtering.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventCategory } from '@camstack/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventBusEvent {
  id: string
  timestamp: Date
  source: { type: string; id: string }
  category: string
  data: Record<string, unknown>
}

interface PipelineExecutionTrace {
  traceId: string
  deviceId: string
  timestamp: number
  frameSize: { width: number; height: number }
  engineRuntime: string
  steps: Array<{
    stepId: string
    modelId: string
    slot: string
    postprocessor: string
    preprocessMs: number
    inferenceMs: number
    postprocessMs: number
    totalMs: number
    inputType: 'full-frame' | 'crop-roi'
    inputSize: { width: number; height: number }
    outputKind: string
    outputCount: number
    topResult?: string
  }>
  totalMs: number
  detectionCount: number
}

// ---------------------------------------------------------------------------
// MockEventBus
// ---------------------------------------------------------------------------

class MockEventBus {
  private events: EventBusEvent[] = []
  private subscribers: Array<{
    filter: { category?: string }
    callback: (event: EventBusEvent) => void
  }> = []

  emit(event: EventBusEvent): void {
    this.events.push(event)
    for (const sub of this.subscribers) {
      if (!sub.filter.category || sub.filter.category === event.category) {
        sub.callback(event)
      }
    }
  }

  subscribe(filter: { category?: string }, callback: (event: EventBusEvent) => void): () => void {
    const sub = { filter, callback }
    this.subscribers.push(sub)
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== sub)
    }
  }

  getEmitted(): readonly EventBusEvent[] {
    return [...this.events]
  }

  clear(): void {
    this.events = []
    this.subscribers = []
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  category: string,
  data: Record<string, unknown>,
  source: { type: string; id: string } = { type: 'detection-pipeline', id: 'pipeline-0' },
): EventBusEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    source,
    category,
    data,
  }
}

function fakeTrace(overrides: Partial<PipelineExecutionTrace> = {}): PipelineExecutionTrace {
  return {
    traceId: 'trace-001',
    deviceId: 'cam-front-door',
    timestamp: Date.now(),
    frameSize: { width: 1920, height: 1080 },
    engineRuntime: 'python+coreml',
    steps: [
      {
        stepId: 'object-detect',
        modelId: 'yolov8n',
        slot: 'primary',
        postprocessor: 'nms-bbox',
        preprocessMs: 2.1,
        inferenceMs: 12.4,
        postprocessMs: 1.3,
        totalMs: 15.8,
        inputType: 'full-frame',
        inputSize: { width: 640, height: 640 },
        outputKind: 'bbox',
        outputCount: 3,
        topResult: 'person',
      },
    ],
    totalMs: 15.8,
    detectionCount: 3,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Detection EventBus flow', () => {
  let bus: MockEventBus

  beforeEach(() => {
    bus = new MockEventBus()
  })

  // -----------------------------------------------------------------------
  // 1. Pipeline trace -> typed EventBus emission
  // -----------------------------------------------------------------------
  describe('pipeline trace emission', () => {
    it('emits a pipeline.trace event with the trace as the typed payload', () => {
      const trace = fakeTrace()

      // The provider emits the trace directly under EventCategory.PipelineTrace.
      // The trace itself is the data payload — no wrapping object.
      bus.emit(
        makeEvent(EventCategory.PipelineTrace, trace as unknown as Record<string, unknown>, {
          type: 'device',
          id: trace.deviceId,
        }),
      )

      const emitted = bus.getEmitted()
      expect(emitted).toHaveLength(1)
      expect(emitted[0]!.category).toBe(EventCategory.PipelineTrace)
      expect(emitted[0]!.source.id).toBe('cam-front-door')

      const emittedTrace = emitted[0]!.data as unknown as PipelineExecutionTrace
      expect(emittedTrace.traceId).toBe('trace-001')
      expect(emittedTrace.deviceId).toBe('cam-front-door')
      expect(emittedTrace.steps).toHaveLength(1)
      expect(emittedTrace.steps[0]!.stepId).toBe('object-detect')
      expect(emittedTrace.totalMs).toBe(15.8)
      expect(emittedTrace.detectionCount).toBe(3)
    })
  })

  // -----------------------------------------------------------------------
  // 2. Detection result events
  // -----------------------------------------------------------------------
  describe('detection result events', () => {
    it('emits detection result with correct payload shape', () => {
      const pipelineResult = {
        detections: [
          { label: 'person', confidence: 0.92, bbox: [100, 200, 300, 400] },
          { label: 'car', confidence: 0.87, bbox: [500, 100, 700, 300] },
        ],
        stepResults: [],
      }

      bus.emit(
        makeEvent(EventCategory.DetectionResult, {
          pipelineResult,
          analysisResults: [],
          frameWidth: 1920,
          frameHeight: 1080,
        }),
      )

      const emitted = bus.getEmitted()
      expect(emitted).toHaveLength(1)

      const ev = emitted[0]!
      expect(ev.category).toBe(EventCategory.DetectionResult)
      expect(ev.data.frameWidth).toBe(1920)
      expect(ev.data.frameHeight).toBe(1080)
      expect(ev.data.pipelineResult).toBeDefined()
      expect(ev.data.analysisResults).toEqual([])

      const result = ev.data.pipelineResult as typeof pipelineResult
      expect(result.detections).toHaveLength(2)
      expect(result.detections[0]!.label).toBe('person')
    })
  })

  // -----------------------------------------------------------------------
  // 3. Motion raw events
  // -----------------------------------------------------------------------
  describe('motion raw events', () => {
    it('emits motion.raw with correct structure', () => {
      const motionData = {
        type: 'motion.raw',
        deviceId: 'cam-backyard',
        boxes: [
          { bbox: [10, 20, 100, 150], changeScore: 0.78 },
          { bbox: [200, 50, 350, 180], changeScore: 0.45 },
        ],
        frameWidth: 1280,
        frameHeight: 720,
      }

      bus.emit(makeEvent(EventCategory.DetectionRaw, motionData))

      const emitted = bus.getEmitted()
      expect(emitted).toHaveLength(1)

      const ev = emitted[0]!
      expect(ev.category).toBe(EventCategory.DetectionRaw)
      expect(ev.data.type).toBe('motion.raw')
      expect(ev.data.deviceId).toBe('cam-backyard')
      expect(ev.data.frameWidth).toBe(1280)
      expect(ev.data.frameHeight).toBe(720)

      const boxes = ev.data.boxes as Array<{ bbox: number[]; changeScore: number }>
      expect(boxes).toHaveLength(2)
      expect(boxes[0]!.bbox).toEqual([10, 20, 100, 150])
      expect(boxes[0]!.changeScore).toBe(0.78)
      expect(boxes[1]!.changeScore).toBe(0.45)
    })
  })

  // -----------------------------------------------------------------------
  // 4. Event filtering
  // -----------------------------------------------------------------------
  describe('event filtering', () => {
    it('delivers only matching events to category-filtered subscribers', () => {
      const detectionEvents: EventBusEvent[] = []
      const motionEvents: EventBusEvent[] = []

      bus.subscribe({ category: EventCategory.DetectionResult }, (ev) => {
        detectionEvents.push(ev)
      })
      bus.subscribe({ category: EventCategory.MotionAnalysis }, (ev) => {
        motionEvents.push(ev)
      })

      bus.emit(
        makeEvent(EventCategory.DetectionResult, {
          pipelineResult: {},
          frameWidth: 1920,
          frameHeight: 1080,
        }),
      )
      bus.emit(
        makeEvent(EventCategory.MotionAnalysis, { regions: [{ x: 0, y: 0, w: 100, h: 100 }] }),
      )
      bus.emit(makeEvent(EventCategory.DetectionRaw, { type: 'motion.raw', deviceId: 'cam-1' }))
      bus.emit(
        makeEvent(EventCategory.DetectionResult, {
          pipelineResult: {},
          frameWidth: 640,
          frameHeight: 480,
        }),
      )

      expect(detectionEvents).toHaveLength(2)
      expect(motionEvents).toHaveLength(1)
      expect(motionEvents[0]!.data.regions).toBeDefined()
    })

    it('delivers all events to unfiltered subscribers', () => {
      const allEvents: EventBusEvent[] = []

      bus.subscribe({}, (ev) => {
        allEvents.push(ev)
      })

      bus.emit(makeEvent(EventCategory.DetectionResult, { pipelineResult: {} }))
      bus.emit(makeEvent(EventCategory.DetectionRaw, { type: 'motion.raw' }))
      bus.emit(makeEvent(EventCategory.ModelDownloadProgress, { modelId: 'yolo', progress: 0.5 }))

      expect(allEvents).toHaveLength(3)
    })

    it('stops delivering after unsubscribe', () => {
      const received: EventBusEvent[] = []
      const unsubscribe = bus.subscribe({ category: EventCategory.DetectionResult }, (ev) => {
        received.push(ev)
      })

      bus.emit(makeEvent(EventCategory.DetectionResult, { before: true }))
      expect(received).toHaveLength(1)

      unsubscribe()

      bus.emit(makeEvent(EventCategory.DetectionResult, { after: true }))
      expect(received).toHaveLength(1)
    })
  })

  // Benchmark progress event tests removed — benchmark moved to
  // `@camstack/addon-benchmark` (2026-04-14) and is no longer part of
  // the core event taxonomy.
})
