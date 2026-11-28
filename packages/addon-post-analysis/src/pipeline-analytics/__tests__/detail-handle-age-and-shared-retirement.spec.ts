/**
 * #628 — a handle the runner refused as expired is retired for the whole
 * device, not only for the track whose dispatch was refused. Live: three
 * refusals of one handle within 250 ms, from different tracks and the
 * scheduler's retry. The runner's refusal stays the only authority on age.
 */
import type {
  DetailStepAnnounce,
  FrameHandle,
  IScopedLogger,
  LogExtras,
  LogTags,
} from '@dominevo/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackDetailDispatcher, type TrackDetailFrame } from '../detail-dispatcher.js'
import { DetailScheduler } from '../detail-scheduler.js'

const DEVICE_ID = 592
const NODE_ID = 'agent-1'

interface Line {
  readonly message: string
  readonly extras: LogExtras | undefined
}

class RecordingLogger implements IScopedLogger {
  constructor(readonly lines: Line[] = []) {}
  debug(message: string, extras?: LogExtras): void {
    this.lines.push({ message, extras })
  }
  info(message: string, extras?: LogExtras): void {
    this.lines.push({ message, extras })
  }
  warn(message: string, extras?: LogExtras): void {
    this.lines.push({ message, extras })
  }
  error(message: string, extras?: LogExtras): void {
    this.lines.push({ message, extras })
  }
  child(_childScope: string): IScopedLogger {
    return this
  }
  withTags(_tags: LogTags): IScopedLogger {
    return this
  }
}

function handle(seq: number): FrameHandle {
  return {
    shmId: `ram:${NODE_ID}:${DEVICE_ID}`,
    nodeId: NODE_ID,
    slot: 792,
    seq,
    width: 640,
    height: 480,
    format: 'jpeg',
    pts: 0,
    byteLength: 0,
    slotCount: 1,
  }
}

function frame(seq: number): TrackDetailFrame {
  return {
    frameHandle: handle(seq),
    nodeId: NODE_ID,
    bbox: { x: 10, y: 10, w: 40, h: 80 },
    frameWidth: 640,
    frameHeight: 480,
    className: 'person',
    confidence: 0.9,
    timestamp: 0,
    matchedThisFrame: true,
  }
}

const ONCE: readonly DetailStepAnnounce[] = [
  { stepId: 'face-detection', inputClasses: ['person'], cadence: { trigger: 'once' } },
]
const PERIODIC: readonly DetailStepAnnounce[] = [
  {
    stepId: 'face-detection',
    inputClasses: ['person'],
    cadence: { trigger: 'periodic', minIntervalMs: 0 },
  },
]

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

function refuseHandles(): (input: { frameHandle?: FrameHandle }) => Promise<null> {
  return async (input) => {
    if (input.frameHandle !== undefined) {
      throw new Error('runDetailSubtree-refused:handle-expired — age 30934 ms')
    }
    return null
  }
}

function handleCalls(fn: ReturnType<typeof vi.fn>): number {
  return fn.mock.calls.filter((c) => {
    const input: unknown = c[0]
    return typeof input === 'object' && input !== null && Reflect.has(input, 'frameHandle')
  }).length
}

describe('TrackDetailDispatcher — one refused handle is retired for the device (#628)', () => {
  let dispatcher: TrackDetailDispatcher | null = null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(0)
  })

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('a handle refused for track A is not sent for track B', async () => {
    const runDetailSubtree = vi.fn(refuseHandles())
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      logger: new RecordingLogger(),
      maxInFlightPerDevice: 1,
    })
    const shared = frame(83736)
    dispatcher.onTrackStarted(DEVICE_ID, 'a', 'person', ONCE, shared, 0)
    await flush()
    dispatcher.onTrackStarted(DEVICE_ID, 'b', 'person', ONCE, shared, 0)
    await flush()

    expect(handleCalls(runDetailSubtree)).toBe(1)
  })

  it('drops a retry whose only frame source is a retired handle: logged, and the scheduler is told', async () => {
    const onFrameMiss = vi.spyOn(DetailScheduler.prototype, 'onFrameMiss')
    const runDetailSubtree = vi.fn(refuseHandles())
    const logger = new RecordingLogger()
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      logger,
      tickIntervalMs: 1000,
    })
    const shared = frame(83736)
    // Track A is refused; the handle is retired for the device.
    dispatcher.onTrackStarted(DEVICE_ID, 'a', 'person', ONCE, shared, 0)
    await flush()
    // Track B still holds that handle: its first dispatch skips the RPC and
    // misses, arming a retry whose only frame source is the retired handle.
    dispatcher.onTrackStarted(DEVICE_ID, 'b', 'person', PERIODIC, shared, 0)
    await flush()
    const missesOfB = (): number => onFrameMiss.mock.calls.filter((c) => c[0] === 'b').length
    expect(missesOfB()).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    await flush()

    const dropped = logger.lines.filter((l) => l.message.includes('retry dropped'))
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.extras?.tags).toEqual({ deviceId: DEVICE_ID })
    // The dropped retry reports a second miss for B.
    expect(missesOfB()).toBe(2)
    expect(handleCalls(runDetailSubtree)).toBe(1)
  })
})
