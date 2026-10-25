/**
 * Regression test — S11 boot crash (`this.audio` null read during the
 * audio-analyzer readiness hydration replay).
 *
 * Root cause (confirmed from live `addon-runner` stderr): `orchestrator-
 * bootstrap.ts`'s `buildOrchestratorControllers` constructs every
 * controller and, near the end of its still-synchronous tail, calls
 * `subscribeToAudioAnalyzerReadiness(localNodeId)` — an addon-level
 * method (kept on `PipelineOrchestratorAddon`, `index.ts`) that reads
 * `this.audio!.handleAudioAnalyzerReadiness(...)` directly, synchronously,
 * inside the readiness callback. Before this fix `this.audio` wasn't
 * assigned until `onInitialize`'s post-`await` continuation ran — AFTER
 * `buildOrchestratorControllers` had already returned.
 *
 * `ReadinessRegistry.onReadyState` replays an already-`ready` snapshot to
 * a brand-new subscriber via `queueMicrotask` (see
 * `packages/types/src/readiness/readiness-registry.ts`). That replay
 * microtask is enqueued strictly BEFORE the outer `buildOrchestratorControllers`
 * promise settles (which is what schedules `onInitialize`'s `await`
 * continuation that assigns `this.audio`) — microtasks are FIFO, so the
 * replay always wins the race and fires first, reading `this.audio!`
 * while it was still `null`. The resulting `TypeError` is thrown inside a
 * bare `queueMicrotask` callback with no enclosing promise chain, so it
 * surfaces as a process-level `uncaughtException` — exactly the live
 * crash-loop symptom, not a normal rejected promise a caller could catch.
 *
 * This test reproduces the exact live trigger: a hub reboot where the
 * audio-analyzer producer's `ready` state is already sitting on the event
 * bus (mirrored here via `bus.getRecent(...)`, which `ReadinessRegistry`
 * consults at construction time) by the moment this addon boots.
 * `NodeLifecycleHandler`'s internal (test-harness-local, since the fake
 * `ctx.kernel` carries no shared registry) `ReadinessRegistry` hydrates
 * that snapshot synchronously in its own constructor, so the very next
 * `onReadyState` subscription — the audio-analyzer boot-time seed —
 * replays via `queueMicrotask` during boot, before `this.audio` used to
 * be assigned.
 */
import { emitReadiness, pipelineOrchestratorCapability } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioSubscriptionController } from '../audio-subscription-controller.js'
import PipelineOrchestratorAddon from '../index.js'
import { makeFakeContext } from './e2e-helpers.js'

describe('PipelineOrchestratorAddon — boot readiness race (S11 boot crash)', () => {
  let addon: PipelineOrchestratorAddon | undefined

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = undefined
  })

  it('does not crash on a null this.audio read when the audio-analyzer readiness hydration replay fires during boot', async () => {
    const { ctx, eventBus } = makeFakeContext()

    // Seed the bus with an already-`ready` audio-analyzer transition for
    // the local node ('hub' — the fake ctx's default `kernel.localNodeId`
    // when no fake broker is supplied) BEFORE the addon boots.
    emitReadiness(eventBus, {
      capName: 'audio-analyzer',
      scope: { type: 'node', nodeId: 'hub' },
      state: 'ready',
      generation: 'test-gen-1',
      sourceNodeId: 'hub',
    })

    const handleSpy = vi.spyOn(
      AudioSubscriptionController.prototype,
      'handleAudioAnalyzerReadiness',
    )

    // The crash (when present) throws inside a detached `queueMicrotask`
    // callback — NOT part of `addon.initialize(ctx)`'s own promise chain
    // — so it can only be observed as a process-level `uncaughtException`,
    // exactly as it manifested live. Capture it instead of letting it
    // terminate the test worker.
    const caught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      caught.push(err)
    }
    process.on('uncaughtException', onUncaught)

    try {
      addon = new PipelineOrchestratorAddon()
      const result = await addon.initialize(ctx)

      // Drain the microtask queue so the (detached) readiness replay has
      // definitely run before we assert nothing escaped.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(caught).toEqual([])

      // The provider must still register normally — the crash used to
      // take the whole addon-runner process down before this point was
      // ever reached live.
      expect(
        result?.providers?.some((p) => p.capability.name === pipelineOrchestratorCapability.name),
      ).toBe(true)

      // `handleAudioAnalyzerReadiness` is only ever reached through
      // `this.audio!.handleAudioAnalyzerReadiness(...)` — if `this.audio`
      // were still null when the replay fired, the property lookup would
      // throw before the method could ever be invoked, so this assertion
      // fails on the broken code path (RED) and passes once `this.audio`
      // is synced before the subscription can fire (GREEN).
      expect(handleSpy).toHaveBeenCalled()
    } finally {
      process.off('uncaughtException', onUncaught)
      handleSpy.mockRestore()
    }
  })
})
