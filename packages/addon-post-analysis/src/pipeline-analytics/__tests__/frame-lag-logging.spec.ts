/**
 * The WIRING half of the starved-vs-waiting instrument.
 *
 * `frame-lag-observer.spec.ts` proves the throttle and the arithmetic. This
 * spec proves the addon actually CONSULTS it — the failure mode this repo has
 * shipped twice is a correct decision function nobody called, which a unit
 * test of the function cannot see. It boots the real addon against the shared
 * fakes and asserts on the log line an operator will grep for.
 */
import { describe, expect, it, afterEach } from 'vitest'
import {
  createEvent,
  EventCategory,
  type FrameResult,
  type IEventBus,
  type ObjectDetection,
  type PipelineInferenceResultPayload,
} from '@camstack/types'
import { bootAnalytics, type Booted, type LogLine } from './boot-analytics.js'

const DEVICE_ID = 102

function detection(): ObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x: 220, y: 160, width: 200, height: 160 },
  }
}

function buildFrame(timestamp: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: [detection()],
  }
}

function emitInference(bus: IEventBus, emittedAt: number | undefined, capturedAt?: number): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame: buildFrame(Date.now()),
    nodeId: 'hub',
    ...(emittedAt !== undefined ? { emittedAt } : {}),
    ...(capturedAt !== undefined ? { capturedAt } : {}),
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 1))
    await new Promise<void>((r) => setImmediate(r))
  }
}

interface LagMeta {
  readonly busLagMaxMs: number | null
  readonly busLagMinMs: number | null
  readonly busLagUnknownFrames: number
  readonly captureLagMaxMs: number | null
  readonly frames: number
  readonly verdict: string
}

function lagLines(logs: readonly LogLine[]): readonly LogLine[] {
  return logs.filter((l) => l.message === 'pipeline-analytics frame lag')
}

function metaOf(line: LogLine): LagMeta {
  const extras = line.extras as { meta: LagMeta }
  return extras.meta
}

function tagsOf(line: LogLine): Record<string, unknown> {
  const extras = line.extras as { tags: Record<string, unknown> }
  return extras.tags
}

describe('pipeline-analytics frame lag line', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('reports a 13 s bus lag as STARVED, tagged with the numeric deviceId', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    emitInference(booted.bus.bus, Date.now() - 13_000, Date.now() - 13_200)
    await flush()

    const lines = lagLines(booted.logs)
    expect(lines).toHaveLength(1)
    const line = lines[0]!
    expect(tagsOf(line).deviceId).toBe(DEVICE_ID)
    const meta = metaOf(line)
    expect(meta.busLagMaxMs).toBeGreaterThanOrEqual(13_000)
    expect(meta.captureLagMaxMs).toBeGreaterThanOrEqual(13_200)
    expect(meta.frames).toBe(1)
    // The whole point: the line says which of the two mechanisms it saw, so
    // the next reader does not have to re-derive the rule from the ADR.
    expect(meta.verdict).toBe('starved')
    // A lag this size is not an `info` — an operator has to be able to grep it.
    expect(line.level).toBe('warn')
  })

  it('a payload with no emittedAt reads UNKNOWN, never a fabricated 0', async () => {
    // The normal case during a rolling deploy: the runner has not been
    // redeployed yet. A 0 here would read as "delivered instantly" and would
    // point the investigation straight at `processFrame` on no evidence.
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    emitInference(booted.bus.bus, undefined)
    await flush()

    const lines = lagLines(booted.logs)
    expect(lines).toHaveLength(1)
    const meta = metaOf(lines[0]!)
    expect(meta.busLagMaxMs).toBeNull()
    expect(meta.busLagUnknownFrames).toBe(1)
    expect(meta.verdict).toBe('unknown')
    expect(lines[0]!.level).toBe('info')
  })

  it('does not write a line per frame — the frame path is not a log source', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    for (let i = 0; i < 30; i += 1) {
      emitInference(booted.bus.bus, Date.now())
      await flush()
    }
    // One line for the device's first frame, and nothing else inside the window.
    expect(lagLines(booted.logs)).toHaveLength(1)
  })
})
