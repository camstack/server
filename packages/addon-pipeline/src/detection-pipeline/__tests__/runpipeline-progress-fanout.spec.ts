/**
 * R1 — `pipeline.progress` is not produced on the live camera path.
 *
 * `runPipeline` builds a local `emit()` that fires `EventCategory.PipelineProgress`.
 * Four of its call sites run BEFORE the executor branch whose own comment says
 * the runtime path "skip[s] the benchmark-only per-step progress spam", so on
 * the live hub those four fired on every camera frame on every node: measured
 * 107.7–112.3 events/s, offered to 38 runners, delivered to none (the busiest
 * runner in the whole registry receives 89.9/s across ALL categories, so no
 * runner can be receiving this one). That is 43 % of every event delivery
 * decision hub-main takes.
 *
 * The gate is `progressToBus`, and these tests pin BOTH of its edges:
 *   - a runtime dispatch that asked for nothing produces nothing, and
 *   - every caller that DID ask — a benchmark image, and the capacity ramp /
 *     `runPipelineBatch` shape which sends a raw frame AND its own `sessionId`
 *     — still gets every line.
 *
 * Each case only needs the FIRST emit of its branch, which fires before any
 * model, engine or decode work, so the run is allowed to reject afterwards.
 *
 * See `docs/design/2026-08-29-event-bus-fanout-load.md` §3 (R1) and D290.
 */
import type {
  FrameRef,
  IEventBus,
  IScopedLogger,
  PipelineStepInput,
  SystemEvent,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DetectionPipelineProvider } from '../provider.js'

function stubLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface RecordingBus {
  readonly bus: IEventBus
  readonly events: SystemEvent[]
}

function recordingBus(): RecordingBus {
  const events: SystemEvent[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      events.push(event)
    },
    subscribe: () => () => undefined,
    getRecent: () => [],
  }
  return { bus, events }
}

const STEPS: readonly PipelineStepInput[] = [
  { addonId: 'object-detection', modelId: 'yolo', enabled: true },
]

/** A process-local frame identity — the live camera dispatch shape. */
function makeFrameRef(): FrameRef {
  return {
    registryId: 'reg-test',
    id: 'frame-1',
    width: 3840,
    height: 2160,
    format: 'rgb',
    timestamp: 1,
  }
}

function makeProvider(bus: IEventBus): DetectionPipelineProvider {
  return new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models',
    stubLogger(),
    bus,
  )
}

function progressEvents(events: readonly SystemEvent[]): readonly SystemEvent[] {
  return events.filter((e) => e.category === EventCategory.PipelineProgress)
}

/** Every emitted progress `message`, in order. */
function progressMessages(events: readonly SystemEvent[]): readonly string[] {
  return progressEvents(events).map((e) => {
    const data: Record<string, unknown> = e.data ?? {}
    return typeof data['message'] === 'string' ? data['message'] : ''
  })
}

describe('runPipeline — pipeline.progress fan-out gate (R1)', () => {
  it('emits NOTHING on the bus for a live camera dispatch (frameRef, no sessionId)', async () => {
    const { bus, events } = recordingBus()
    const provider = makeProvider(bus)

    // `frameRef` + no `sessionId` is exactly the payload measured on the hub:
    // every observed event carried a minted `run-<ms>-<rand>` id, i.e. nobody
    // asked for the stream.
    await provider
      .runPipeline({ steps: STEPS, frameRef: makeFrameRef(), deviceId: 102 })
      .catch(() => undefined)

    expect(progressMessages(events)).toEqual([])
  })

  it('still calls the in-process onProgress callback on that same dispatch', async () => {
    const { bus, events } = recordingBus()
    const provider = makeProvider(bus)
    const seen: string[] = []

    // Only the BUS half is gated. A caller holding the closure is in-process
    // and costs no delivery decision, so it keeps every line — this is what
    // separates "not fanned out" from "not produced".
    await provider
      .runPipeline({ steps: STEPS, frameRef: makeFrameRef(), deviceId: 102 }, (m) => {
        seen.push(m)
      })
      .catch(() => undefined)

    expect(seen.some((m) => m.startsWith('FrameRef: 3840×2160'))).toBe(true)
    expect(progressMessages(events)).toEqual([])
  })

  it('emits for a raw-frame run that carries its own sessionId (capacity ramp / runPipelineBatch)', async () => {
    const { bus, events } = recordingBus()
    const provider = makeProvider(bus)

    // pipeline-runner/index.ts:1937 and provider.ts:3593 both send a raw
    // frame AND a sessionId. Gating on the frame alone would silently blank
    // an operator's benchmark, which is worse than the load it saves.
    await provider
      .runPipeline({ steps: STEPS, frameRef: makeFrameRef(), sessionId: 'ramp-42' })
      .catch(() => undefined)

    const emitted = progressEvents(events)
    expect(emitted.length).toBeGreaterThan(0)
    expect(progressMessages(events)[0]).toMatch(/^FrameRef: 3840×2160/)
    for (const e of emitted) {
      const data: Record<string, unknown> = e.data ?? {}
      expect(data['sessionId']).toBe('ramp-42')
    }
  })

  it('emits for a benchmark image run (no frame at all)', async () => {
    const { bus, events } = recordingBus()
    const provider = makeProvider(bus)

    // The UI-initiated one-shot ImageTab drives. Not a runtime dispatch, so
    // the gate must not touch it even without a sessionId.
    await provider
      .runPipeline({ steps: STEPS, image: new Uint8Array([1, 2, 3]) })
      .catch(() => undefined)

    expect(progressMessages(events)).toContain('Decoding image...')
  })
})
