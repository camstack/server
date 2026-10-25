/**
 * The runner half of the age bound (ADR-0419): what `getNativeCrop` does with a
 * handle older than {@link NATIVE_CROP_LEASE_MAX_AGE_MS}, and what it LOGS.
 *
 * The defect: on the Mac agent node, 332 `native crop miss` lines in 54
 * minutes, every one of them `worker-lease-gone`, at a median `handleAgeMs` of
 * 30 099 ms. Each paid a cross-process round trip to the decode worker for a
 * frame whose tiles had expired 20 s earlier. The registry was pinned at
 * `4096/4096` the whole window — which is what makes "raise the cap" look like
 * the fix and is why it is not one: a bigger cap keeps MORE full-resolution
 * surfaces alive and moves the same pinning to a later threshold.
 *
 * Two things must be true for the next person not to re-measure the same 332:
 *  1. the doomed round trip does not happen at all, and
 *  2. a refusal-by-age is DISTINGUISHABLE in the log from a real miss.
 */
import type { FrameHandle } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PipelineRunnerAddon from '../index.js'
import { NATIVE_CROP_LEASE_MAX_AGE_MS } from '../../session-decode/native-crop-lease-age.js'

const DEVICE_ID = 111
const MEASURED_MEDIAN_AGE_MS = 30_099

/** A subject ROI — never a full frame, so the served tier is `miss` (no
 *  ≤640 masquerade) and the line is a warn on both paths. */
const SUBJECT_ROI = { x: 0.4, y: 0.35, w: 0.12, h: 0.2 }

function makeFrameHandle(): FrameHandle {
  return {
    shmId: 'csr.dev1443',
    slot: 0,
    seq: 7,
    width: 3840,
    height: 2160,
    format: 'rgb',
    pts: 0,
    byteLength: 3840 * 2160 * 3,
    nodeId: 'MacMiniAgent.localdomain',
    slotCount: 4,
  }
}

interface FakeRequester {
  (
    bbox: unknown,
    maxWidth?: number,
  ): Promise<{
    kind: 'crop'
    crop: { bytes: Uint8Array; width: number; height: number; source: string }
  }>
  release(): void
  markInferred(): void
  cutTiles(bboxes: readonly unknown[]): void
}

/** A worker that WOULD answer with a tile — so "it was never asked" is provable. */
function makeRequester(): FakeRequester {
  return Object.assign(
    vi.fn(async () => ({
      kind: 'crop' as const,
      crop: { bytes: Buffer.alloc(64 * 64 * 3, 128), width: 64, height: 64, source: 'tile' },
    })),
    { release: vi.fn(), markInferred: vi.fn(), cutTiles: vi.fn() },
  )
}

interface AddonInternals {
  onInitialize(): Promise<unknown>
  nativeCropRegistry: {
    register(handle: FrameHandle, request: FakeRequester, deviceId: number): void
  }
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  // Single documented type boundary — white-box access to the node-wide
  // registry, the same convention as `detail-park-soft-detach.spec.ts`.
  return addon as unknown as AddonInternals
}

/** The four spies the runner's `IScopedLogger` calls are recorded on. */
function makeFakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

type FakeLogger = ReturnType<typeof makeFakeLogger>

function makeFakeCtx(logger: FakeLogger) {
  return {
    id: 'pipeline-runner',
    logger: {
      ...logger,
      child: vi.fn(function (this: unknown) {
        return this
      }),
      withTags: vi.fn(function (this: unknown) {
        return this
      }),
    },
    kernel: { localNodeId: 'MacMiniAgent.localdomain' },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: () => [] },
    api: { pipelineExecutor: { runPipeline: { mutate: vi.fn() } }, streamBroker: {} },
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    fetchDevice: vi.fn(),
  }
}

/** Every `warn` line the runner emitted, as `[message, fields]` pairs. */
function warnLines(logger: FakeLogger): ReadonlyArray<readonly [string, unknown]> {
  return logger.warn.mock.calls.map((call) => [String(call[0]), call[1]] as const)
}

describe('getNativeCrop refuses a handle older than the lease age bound', () => {
  let addon: PipelineRunnerAddon
  let logger: FakeLogger

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T10:00:00Z'))
    logger = makeFakeLogger()
    addon = new PipelineRunnerAddon()
    const ctx = makeFakeCtx(logger)
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    Object.defineProperty(addon, 'ctxIfReady', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await addon.shutdown().catch(() => {
      /* swallow */
    })
  })

  it('the 30 099 ms ask is refused WITHOUT the cross-process round trip', async () => {
    const handle = makeFrameHandle()
    const requester = makeRequester()
    asInternals(addon).nativeCropRegistry.register(handle, requester, DEVICE_ID)

    vi.setSystemTime(Date.now() + MEASURED_MEDIAN_AGE_MS)
    const result = await addon.getNativeCrop({ handle, bbox: SUBJECT_ROI })

    // The caller takes the detection-frame fallback the ring's header calls
    // free and expected.
    expect(result).toBeNull()
    // And the work that produced 332 useless round trips never starts.
    expect(requester).not.toHaveBeenCalled()
  })

  it('the 2 000 ms ask still reaches the worker and is served', async () => {
    const handle = makeFrameHandle()
    const requester = makeRequester()
    asInternals(addon).nativeCropRegistry.register(handle, requester, DEVICE_ID)

    vi.setSystemTime(Date.now() + 2_000)
    const result = await addon.getNativeCrop({ handle, bbox: SUBJECT_ROI })

    expect(requester).toHaveBeenCalledTimes(1)
    expect(result?.width).toBe(64)
  })

  it('a refusal-by-age is a DIFFERENT log line from a miss, and carries the numeric deviceId', async () => {
    const handle = makeFrameHandle()
    asInternals(addon).nativeCropRegistry.register(handle, makeRequester(), DEVICE_ID)

    vi.setSystemTime(Date.now() + MEASURED_MEDIAN_AGE_MS)
    await addon.getNativeCrop({ handle, bbox: SUBJECT_ROI })

    const refusals = warnLines(logger).filter(([message]) => /refused/.test(message))
    expect(refusals).toHaveLength(1)
    // Never the miss wording — the two must be separable by a log query, or
    // the next person measures the same 332 and learns nothing new.
    expect(warnLines(logger).filter(([m]) => m === 'native crop miss')).toHaveLength(0)

    const [, fields] = refusals[0] ?? []
    expect(fields).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: {
        reason: 'handle-expired',
        handleAgeMs: MEASURED_MEDIAN_AGE_MS,
        leaseMaxAgeMs: NATIVE_CROP_LEASE_MAX_AGE_MS,
      },
    })
  })

  it('a handle the registry never held is still `no-registry-entry`, not a refusal', async () => {
    const handle = makeFrameHandle()
    await addon.getNativeCrop({ handle, bbox: SUBJECT_ROI })

    const lines = warnLines(logger)
    expect(lines.filter(([m]) => /refused/.test(m))).toHaveLength(0)
    const misses = lines.filter(([m]) => m === 'native crop miss')
    expect(misses).toHaveLength(1)
    expect(misses[0]?.[1]).toMatchObject({ meta: { reason: 'no-registry-entry' } })
  })
})
