import type { CameraDetectionConfig, Unsubscribe } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AudioSubscriptionController,
  type AudioSubscriptionControllerDeps,
} from '../audio-subscription-controller.js'
import { makeFakeContext, makeLocalEventBus, makeSilentLogger } from './e2e-helpers.js'

/**
 * `audioMode: 'on-motion'` on an ONBOARD-ONLY camera — the battery case.
 *
 * A battery Reolink cam is reachable only while awake. Its motion arrives
 * either as a Baichuan push or (while asleep) as an email-push SMTP
 * delivery, and BOTH land on the bus as
 * `MotionOnMotionChanged { detected: true, source: 'onboard' }`.
 *
 * The load-bearing asymmetry this file guards: the Reolink provider emits
 * ONLY the rising edge — `reolink-camera.ts` emits `detected: true` at both
 * of its emit sites and has no falling-edge counterpart. Only the frame-diff
 * ANALYZER emits falls, and an onboard-only camera has no standing analyzer.
 * So a teardown reachable ONLY from a `detected:false` edge is a teardown
 * that never runs: the audio subscription stays open forever and the
 * operator's `on-motion` pick silently degrades into `always-on`. On a camera
 * running off a battery that is not a performance regression, it is a flat
 * battery — which is the whole reason `on-motion` exists.
 *
 * The window must therefore close on a QUIET TIMER measured from the LAST
 * motion, independent of any falling edge.
 */

interface Harness {
  readonly controller: AudioSubscriptionController
  /** How many times an audio subscription was opened. */
  readonly openCount: () => number
  /** How many times an opened subscription was torn down. */
  readonly closeCount: () => number
}

/**
 * Controller with the broker-facing `subscribeAudioStream` replaced by a
 * counting fake. This file tests the WINDOW bookkeeping (open / rearm /
 * close), not the broker plumbing — `audio-subscription-refusal.spec.ts`
 * already covers the latter. The fake also lets us assert the property that
 * matters most for churn: a re-fire must NOT reopen the stream.
 */
function makeHarness(): Harness {
  let opens = 0
  let closes = 0
  const { bus } = makeLocalEventBus()

  // Only the members `handleLazyAudioMotion` actually reaches are real; the
  // rest are never invoked on this path (the subscribe call itself is
  // overridden below).
  const deps = {
    api: () => null,
    eventBus: bus,
    logger: makeSilentLogger(),
    readDeviceStore: async () => ({}),
    probeAudioTrack: async () => ({ kind: 'unknown', reason: 'test harness' }) as const,
    // Slot table unreadable in this harness. The motion stream is NATIVE, so
    // the selection keeps it (`motion-stream-fallback`) — a transient read
    // failure must never mute a camera that costs no transcode.
    assignedProfiles: async () => null,
    ingestNode: () => 'hub',
    localNodeId: () => 'hub',
    enabledAudioNodes: () => ['hub'],
    audioNodeRole: () => 'hub',
    isAudioAnalysisActive: async () => true,
    isDetectionActive: () => true,
    getActiveDetectionConfig: () => undefined,
    getLedgerConfig: () => null,
    scheduleReconcile: () => undefined,
  } satisfies AudioSubscriptionControllerDeps

  class TestController extends AudioSubscriptionController {
    protected override async subscribeAudioStream(): Promise<Unsubscribe | null> {
      opens += 1
      return () => {
        closes += 1
      }
    }
  }

  return {
    controller: new TestController(deps),
    openCount: () => opens,
    closeCount: () => closes,
  }
}

function onMotionConfig(overrides: Partial<CameraDetectionConfig> = {}): CameraDetectionConfig {
  const base = {
    deviceId: 106,
    enabled: true,
    audioMode: 'on-motion',
    detectionMode: 'on-motion',
    motionCooldownMs: 30_000,
    motionSources: ['onboard'],
    pipelineEnabled: true,
  }
  return { ...base, ...overrides } as CameraDetectionConfig
}

describe('lazy audio motion window (onboard-only / battery)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the audio window on a rising motion edge', async () => {
    const h = makeHarness()
    await h.controller.handleLazyAudioMotion(106, true, onMotionConfig())
    expect(h.openCount()).toBe(1)
    expect(h.closeCount()).toBe(0)
  })

  it('closes the window after the quiet period even though NO detected:false ever arrives', async () => {
    const h = makeHarness()
    await h.controller.handleLazyAudioMotion(106, true, onMotionConfig())
    expect(h.openCount()).toBe(1)

    // The onboard path never sends a falling edge. Advance past the quiet
    // window; the subscription must be gone anyway.
    await vi.advanceTimersByTimeAsync(200_000)
    expect(h.closeCount()).toBe(1)
  })

  it('rearms the quiet window on each re-fire instead of restarting the stream', async () => {
    const h = makeHarness()
    await h.controller.handleLazyAudioMotion(106, true, onMotionConfig())

    // Re-fires keep the window alive without churning the subscription — a
    // teardown-first rearm would restart the broker stream on every event.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000)
      await h.controller.handleLazyAudioMotion(106, true, onMotionConfig())
    }
    expect(h.openCount()).toBe(1)
    expect(h.closeCount()).toBe(0)

    // Once the re-fires stop, the window closes on its own.
    await vi.advanceTimersByTimeAsync(200_000)
    expect(h.closeCount()).toBe(1)
  })

  it('honours a per-camera quiet period', async () => {
    const h = makeHarness()
    await h.controller.handleLazyAudioMotion(
      106,
      true,
      onMotionConfig({ audioMotionWindowMs: 10_000 }),
    )
    await vi.advanceTimersByTimeAsync(9_000)
    expect(h.closeCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.closeCount()).toBe(1)
  })

  /**
   * The block above stubs the broker call, so it proves the bookkeeping but
   * NOT that the real subscribe path honours the window. This one drives the
   * REAL `subscribeAudioStream`, using the same observable
   * `audio-subscription-refusal.spec.ts` uses: `resolveDeviceSettings` is
   * only reached once a call gets PAST the mode gate.
   *
   * Without this, `on-motion` could pass every test above and still be mute
   * in production — the gate would refuse the very subscription the window
   * just authorised.
   */
  it('the real subscribe path refuses outside a window and proceeds inside one', async () => {
    const { ctx } = makeFakeContext()
    const api = ctx.api
    if (!api) throw new Error('fake context has no api')
    const settingsRead = vi.spyOn(api.audioAnalysis.resolveDeviceSettings, 'query')
    const { bus } = makeLocalEventBus()
    const deps = {
      api: () => api,
      eventBus: bus,
      logger: makeSilentLogger(),
      readDeviceStore: async () => ({}),
      probeAudioTrack: async () => ({ kind: 'present', codec: 'AAC' }),
      assignedProfiles: async () => null,
      ingestNode: () => 'hub',
      localNodeId: () => 'hub',
      enabledAudioNodes: () => ['hub'],
      audioNodeRole: () => 'hub',
      isAudioAnalysisActive: async () => true,
      isDetectionActive: () => true,
      getActiveDetectionConfig: () => undefined,
      getLedgerConfig: () => null,
      scheduleReconcile: () => undefined,
    } satisfies AudioSubscriptionControllerDeps
    const controller = new AudioSubscriptionController(deps)
    const config = onMotionConfig({
      motionStreamId: 'low',
      detectionStreamId: 'high',
    })

    // No window open — an on-motion camera must not subscribe.
    await controller.resubscribe(106, config)
    expect(settingsRead).not.toHaveBeenCalled()

    // Motion opens the window; the same config now gets through.
    await controller.handleLazyAudioMotion(106, true, config)
    expect(settingsRead).toHaveBeenCalled()
  })

  it('reopens on a later motion after the window closed', async () => {
    const h = makeHarness()
    await h.controller.handleLazyAudioMotion(106, true, onMotionConfig())
    await vi.advanceTimersByTimeAsync(200_000)
    expect(h.closeCount()).toBe(1)

    await h.controller.handleLazyAudioMotion(106, true, onMotionConfig())
    expect(h.openCount()).toBe(2)
  })

  it('does not leave a window open once the device is stopped', async () => {
    const h = makeHarness()
    await h.controller.handleLazyAudioMotion(106, true, onMotionConfig())
    await h.controller.stopForDevice(106)
    expect(h.closeCount()).toBe(1)

    // A stopped device must not still be holding a quiet timer that would
    // fire against a device nothing is sustaining any more.
    await vi.advanceTimersByTimeAsync(200_000)
    expect(h.closeCount()).toBe(1)
  })

  it('still closes on an explicit falling edge, after the motion cooldown', async () => {
    const h = makeHarness()
    await h.controller.handleLazyAudioMotion(106, true, onMotionConfig())
    // An analyzer-backed camera DOES send falls — that path must keep
    // closing on the (shorter) motion cooldown rather than waiting out the
    // quiet window.
    await h.controller.handleLazyAudioMotion(106, false, onMotionConfig())
    await vi.advanceTimersByTimeAsync(31_000)
    expect(h.closeCount()).toBe(1)
  })
})
