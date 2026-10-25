import type { StreamSourceEntry } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AudioSubscriptionController,
  type AudioSubscriptionControllerDeps,
} from '../audio-subscription-controller.js'
import PipelineOrchestratorAddon from '../index'
import {
  makeFakeAudioAnalyzer,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeFakeStreamBroker,
  makeFakeStreamBrokerCap,
  makeLocalEventBus,
  makeSilentLogger,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

/**
 * Regression coverage for the audio-subscription concurrency race.
 *
 * The per-device async mutex (`withAudioSubLock`) must run the whole
 * get -> teardown -> subscribe -> set sequence atomically per deviceId, so a
 * prior unsubscribe handle is ALWAYS invoked before it is replaced (no
 * orphaned broker subscription). Different deviceIds must NOT serialize
 * against each other, and a throwing section must not wedge the lock.
 *
 * S7 retarget (seam-retarget, not a weakening): this block used to subclass
 * `PipelineOrchestratorAddon` to reach its `protected audioSubscriptions` /
 * `audioSubLocks` / `storeAudioSub` / `withAudioSubLock` fields — those now
 * live on `AudioSubscriptionController` (see `audio-subscription-controller.ts`).
 * The generic lock-concurrency semantics (FIFO, independent keys, throwing
 * section, shutdown no-op) are ALSO covered in isolation by
 * `keyed-async-lock.spec.ts` — this file additionally proves the audio
 * controller's OWN `audioSubscriptions`/`storeAudioSub`/`audioShuttingDown`
 * wiring onto that lock, which `keyed-async-lock.spec.ts` cannot see. The
 * controller is constructed directly with fake deps (no `ctx` needed —
 * these tests never call `resubscribe`/`subscribeAudioStream`, only the
 * lock + map primitives), via a thin test subclass exposing the same
 * `protected` seam the addon class used to.
 */

type Unsub = () => void

/** Resolver-bearing deferred so the test can control interleaving. */
interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Deps the lock/map tests never actually exercise — minimal no-op fakes. */
function makeFakeAudioControllerDeps(): AudioSubscriptionControllerDeps {
  const { bus } = makeLocalEventBus()
  return {
    api: () => null,
    eventBus: bus,
    logger: makeSilentLogger(),
    readDeviceStore: async () => ({}),
    assignedProfiles: async () => null,
    // Never reached: these tests drive the lock/map primitives only.
    probeAudioTrack: async () => ({ kind: 'unknown', reason: 'test' }),
    ingestNode: () => 'hub',
    localNodeId: () => 'hub',
    enabledAudioNodes: () => [],
    audioNodeRole: () => 'hub',
    isAudioAnalysisActive: async () => true,
    isDetectionActive: () => false,
    getActiveDetectionConfig: () => undefined,
    getLedgerConfig: () => null,
    scheduleReconcile: () => undefined,
  }
}

/**
 * Test seam: drives one realistic "subscribe" critical section through the
 * production lock. Mirrors the four call sites (capture prior handle, tear it
 * down, await the new subscription, store the new handle) so the assertions
 * cover the exact shape the fix protects.
 */
class TestAudioController extends AudioSubscriptionController {
  constructor() {
    super(makeFakeAudioControllerDeps())
  }

  runLockedSubscribe(deviceId: number, subscribe: () => Promise<Unsub>): Promise<void> {
    return this.withAudioSubLock(deviceId, async () => {
      const prior = this.audioSubscriptions.get(deviceId)
      if (prior) {
        prior()
        this.audioSubscriptions.delete(deviceId)
      }
      const unsub = await subscribe()
      this.audioSubscriptions.set(deviceId, unsub)
    })
  }

  liveHandles(deviceId: number): Unsub | undefined {
    return this.audioSubscriptions.get(deviceId)
  }

  lockCount(): number {
    return this.audioSubLocks.size
  }

  acquire(deviceId: number, fn: () => Promise<void>): Promise<void> {
    return this.withAudioSubLock(deviceId, fn)
  }

  /** Flip the audio-shutdown guard the way `onShutdown` does. */
  beginAudioShutdown(): void {
    this.audioShuttingDown = true
  }

  /** Drive a locked subscribe whose store goes through `storeAudioSub`. */
  runLockedSubscribeViaStore(deviceId: number, subscribe: () => Promise<Unsub>): Promise<void> {
    return this.withAudioSubLock(deviceId, async () => {
      const unsub = await subscribe()
      this.storeAudioSub(deviceId, unsub)
    })
  }
}

describe('audio-subscription per-device lock', () => {
  it('serializes two concurrent subscribes for the SAME device — first handle is torn down, not orphaned', async () => {
    const orch = new TestAudioController()
    const deviceId = 42

    const unsubA = vi.fn()
    const unsubB = vi.fn()

    const gateA = deferred()
    const gateB = deferred()

    // First subscribe resolves only when we release gateA.
    const callA = orch.runLockedSubscribe(deviceId, async () => {
      await gateA.promise
      return unsubA
    })
    // Second subscribe (queued concurrently for the SAME device) resolves on gateB.
    const callB = orch.runLockedSubscribe(deviceId, async () => {
      await gateB.promise
      return unsubB
    })

    // Neither subscribe has completed; nothing torn down yet.
    expect(unsubA).not.toHaveBeenCalled()
    expect(unsubB).not.toHaveBeenCalled()

    // Let the first finish: it stores unsubA.
    gateA.resolve()
    await callA
    expect(orch.liveHandles(deviceId)).toBe(unsubA)
    expect(unsubA).not.toHaveBeenCalled()

    // Now let the second run. Because the lock serialized it, B's critical
    // section sees A's stored handle, tears it down, then stores its own.
    gateB.resolve()
    await callB

    // (a) the FIRST subscription was unsubscribed (not orphaned).
    expect(unsubA).toHaveBeenCalledTimes(1)
    expect(unsubB).not.toHaveBeenCalled()
    // (b) exactly ONE handle remains for the device — the latest.
    expect(orch.liveHandles(deviceId)).toBe(unsubB)
    // lock map drains to empty once the chain settles. Flush the full
    // microtask/event-loop queue (not a single microtask) so this stays
    // correct if the lock's internal promise-chain depth changes.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(orch.lockCount()).toBe(0)
  })

  it('does NOT serialize two DIFFERENT devices — they run concurrently', async () => {
    const orch = new TestAudioController()

    const startedB = vi.fn()
    const gateA = deferred()

    // Device 1 blocks on gateA (never released until B has already started).
    const callA = orch.acquire(1, async () => {
      await gateA.promise
    })
    // Device 2 must be able to start and finish WITHOUT waiting on device 1.
    const callB = orch.acquire(2, async () => {
      startedB()
    })

    await callB
    expect(startedB).toHaveBeenCalledTimes(1)

    // Device 1 is still blocked; releasing it now lets it finish.
    gateA.resolve()
    await callA
  })

  it('a throwing section does not wedge the lock for the next call on the same device', async () => {
    const orch = new TestAudioController()
    const deviceId = 7

    const boom = orch.acquire(deviceId, async () => {
      throw new Error('subscribe failed')
    })
    await expect(boom).rejects.toThrow('subscribe failed')

    // The chain must keep serializing: the next section still runs.
    const ran = vi.fn()
    await orch.acquire(deviceId, async () => {
      ran()
    })
    expect(ran).toHaveBeenCalledTimes(1)
  })

  it('a section completing AFTER shutdown began does NOT resurrect a handle', async () => {
    const orch = new TestAudioController()
    const deviceId = 13

    const unsub = vi.fn()
    const gate = deferred()
    const started = deferred()

    // Start a locked subscribe that is mid-`await subscribe()` when shutdown
    // begins. Its store must route through `storeAudioSub` and be refused.
    const call = orch.runLockedSubscribeViaStore(deviceId, async () => {
      // Signal that the critical section has actually entered `subscribe`
      // (past the lock's shutdown gate) before we flip the flag.
      started.resolve()
      await gate.promise
      return unsub
    })

    // Wait until the section is genuinely in flight (awaiting `gate`), so the
    // store happens on the POST-await path with the flag already set.
    await started.promise
    // Shutdown begins while the subscribe is still in flight.
    orch.beginAudioShutdown()

    // Now let the in-flight subscribe resolve.
    gate.resolve()
    await call

    // No zombie entry: the handle was unsubscribed, not stored.
    expect(unsub).toHaveBeenCalledTimes(1)
    expect(orch.liveHandles(deviceId)).toBeUndefined()
  })

  it('a queued section becomes a no-op once shutdown began', async () => {
    const orch = new TestAudioController()
    const deviceId = 21

    orch.beginAudioShutdown()

    // Queued AFTER the flag is set — its `fn` must not run.
    const ran = vi.fn()
    await orch.acquire(deviceId, async () => {
      ran()
    })
    expect(ran).not.toHaveBeenCalled()
  })

  it('runs queued sections for the same device in FIFO order', async () => {
    const orch = new TestAudioController()
    const deviceId = 9
    const order: number[] = []

    const gate1 = deferred()
    const c1 = orch.acquire(deviceId, async () => {
      await gate1.promise
      order.push(1)
    })
    const c2 = orch.acquire(deviceId, async () => {
      order.push(2)
    })
    const c3 = orch.acquire(deviceId, async () => {
      order.push(3)
    })

    // Even though 1 is gated, 2 and 3 must not jump ahead.
    expect(order).toEqual([])
    gate1.resolve()
    await Promise.all([c1, c2, c3])
    expect(order).toEqual([1, 2, 3])
  })
})

/**
 * T4 — `assignAudio`/`unassignAudio` apply the pin IMMEDIATELY.
 *
 * Previously they only cleared the assignment cache ("next dispatch
 * re-balances"), so a pin did nothing until an unrelated re-subscription. The
 * fix appends `reattachAudioForDevice`, which — under `withAudioSubLock` — tears
 * down the prior audio subscription and re-subscribes under the fresh pin. These
 * tests drive the real audio path end-to-end through the fake harness.
 */

/** Standard orchestrator schema defaults (mirrors detection-wiring-e2e). */
const DEFAULT_DEVICE_SETTINGS = {
  detectionMode: 'on-motion' as const,
  motionSources: ['analyzer'] as const,
  motionStreamProfile: 'low' as const,
  detectionStreamProfile: 'high' as const,
  motionFps: 4,
  detectionFps: 10,
  motionCooldownMs: 10_000,
  gpuAffinityFpsThreshold: 15,
  capacityTieEpsilon: 1.5,
  onDisconnect: 'migrate' as const,
  pinnedOnDisconnect: 'leave-pinned' as const,
  onReconnect: 'restore' as const,
}

function makeCameraStreams(): readonly StreamSourceEntry[] {
  return [
    { id: 'sub', label: 'sub', protocol: 'rtsp', url: 'rtsp://cam/sub', profileHint: 'low' },
    { id: 'main', label: 'main', protocol: 'rtsp', url: 'rtsp://cam/main', profileHint: 'high' },
  ]
}

const AUDIO_NODE = 'agent-a'

/**
 * Build an orchestrator with an ACTIVE audio subscription for device 1 on the
 * single node `agent-a`. Returns the addon plus the fake analyzer so the
 * caller can observe the attach/detach cycle.
 *
 * D461 retarget (seam-retarget, not a weakening): the orchestrator no longer
 * holds a broker audio subscription of its own — it calls
 * `audioAnalyzer.attachDevice` / `detachDevice` and the ANALYZER holds the
 * subscription. So the cycle these tests watch moved from the fake broker's
 * `audioSubscribers` to the fake analyzer's `attaches`/`detaches`. The property
 * is unchanged and is if anything sharper: a re-pin must produce a detach of
 * the prior attachment AND a fresh attach, never one without the other.
 */
async function makeActiveAudioOrchestrator(): Promise<{
  addon: PipelineOrchestratorAddon
  audioAnalyzer: ReturnType<typeof makeFakeAudioAnalyzer>
  logger: { warn: ReturnType<typeof vi.fn> }
}> {
  const broker = makeFakeBroker(AUDIO_NODE)
  const runner = makeFakeRunner({ nodeId: AUDIO_NODE })
  wireRunnerToBroker(broker, AUDIO_NODE, runner)

  const streams = makeCameraStreams()
  const streamBrokerCap = makeFakeStreamBrokerCap()
  streamBrokerCap.register(1, 'provider-rtsp', streams)
  const audioBroker = makeFakeStreamBroker('1')
  streamBrokerCap.attachBroker('1/sub', audioBroker)

  const audioAnalyzer = makeFakeAudioAnalyzer({
    resolver: async () => ({ minConfidence: 0.3, allowedClasses: ['speech'] }),
    classifications: [{ className: 'speech', score: 0.91 }],
  })

  const { ctx, eventBus } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialDeviceSettings: new Map([[1, { ...DEFAULT_DEVICE_SETTINGS }]]),
    initialGlobalSettings: { enabledNodes: [AUDIO_NODE], enabledAudioNodes: [AUDIO_NODE] },
    providers: { 'stream-broker': streamBrokerCap, 'audio-analyzer': audioAnalyzer },
  })
  // Capture warns for the R6 eligibility assertion.
  const warn = vi.fn()
  const realWarn = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = (...args: Parameters<typeof ctx.logger.warn>) => {
    warn(...args)
    return realWarn(...args)
  }

  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(ctx)

  eventBus.emit({
    id: 'evt-1',
    timestamp: new Date(),
    source: { type: 'device', id: 1 },
    category: EventCategory.CameraStreamsProfileSlotsChanged,
    data: { deviceId: 1, providerId: 'provider-rtsp' },
  })
  await waitUntil(() => audioAnalyzer.attaches.length === 1, 2000)

  return { addon, audioAnalyzer, logger: { warn } }
}

/**
 * How many attachments are LIVE for a device: every attach that has not been
 * matched by a later detach. This is the "no orphan" invariant expressed as a
 * number — it must be exactly 1 for a camera whose audio is running, both
 * before and after a re-pin, and it can only stay 1 if the controller tears
 * the prior attachment down before installing the next.
 */
function liveAttachments(
  analyzer: ReturnType<typeof makeFakeAudioAnalyzer>,
  deviceId: number,
): number {
  const attached = analyzer.attaches.filter((a) => a.deviceId === deviceId).length
  const detached = analyzer.detaches.filter((id) => id === deviceId).length
  return attached - detached
}

describe('assignAudio / unassignAudio apply the pin immediately (T4)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('assignAudio re-attaches the device under the fresh pin (prior attachment detached, no orphan)', async () => {
    const harness = await makeActiveAudioOrchestrator()
    addon = harness.addon
    const { audioAnalyzer } = harness

    // Baseline: auto-balanced (not pinned) to the only node.
    const before = await addon.getAudioAssignment({ deviceId: 1 })
    expect(before?.nodeId).toBe(AUDIO_NODE)
    expect(before?.pinned).toBe(false)
    expect(audioAnalyzer.attaches).toHaveLength(1)
    expect(liveAttachments(audioAnalyzer, 1)).toBe(1)

    // Pin audio to the (eligible) node.
    await addon.assignAudio({ deviceId: 1, nodeId: AUDIO_NODE })

    // (a) a NEW attach landed…
    await waitUntil(() => audioAnalyzer.attaches.length === 2, 2000)
    // (b) …and the prior one was detached first, so exactly one is live. An
    // orphan would show here as 2, and on the real broker it would be a FIFO
    // nobody drains holding the source dial open.
    expect(audioAnalyzer.detaches).toContain(1)
    expect(liveAttachments(audioAnalyzer, 1)).toBe(1)

    // (c): the pin took effect immediately — assignment is now the pinned node.
    const after = await addon.getAudioAssignment({ deviceId: 1 })
    expect(after?.nodeId).toBe(AUDIO_NODE)
    expect(after?.pinned).toBe(true)
  })

  it('unassignAudio re-attaches the device back to auto-balance immediately', async () => {
    const harness = await makeActiveAudioOrchestrator()
    addon = harness.addon
    const { audioAnalyzer } = harness

    // Pin first so we have something to unpin.
    await addon.assignAudio({ deviceId: 1, nodeId: AUDIO_NODE })
    await waitUntil(() => audioAnalyzer.attaches.length === 2, 2000)
    expect((await addon.getAudioAssignment({ deviceId: 1 }))?.pinned).toBe(true)

    // Unpin — re-attaches and re-balances back to auto.
    await addon.unassignAudio({ deviceId: 1 })

    await waitUntil(() => audioAnalyzer.attaches.length === 3, 2000)
    expect(liveAttachments(audioAnalyzer, 1)).toBe(1)

    const after = await addon.getAudioAssignment({ deviceId: 1 })
    expect(after?.nodeId).toBe(AUDIO_NODE)
    expect(after?.pinned).toBe(false)
  })

  it('warns when pinning audio to a node not in enabledAudioNodes (R6)', async () => {
    const harness = await makeActiveAudioOrchestrator()
    addon = harness.addon

    await addon.assignAudio({ deviceId: 1, nodeId: 'ghost-node' })

    const warned = harness.logger.warn.mock.calls.some((call) =>
      String(call[0]).includes('enabledAudioNodes'),
    )
    expect(warned).toBe(true)
  })
})
