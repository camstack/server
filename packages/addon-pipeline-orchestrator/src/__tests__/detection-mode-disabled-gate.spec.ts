/**
 * D109, second doorway: `detectionMode: 'disabled'` must cost NOTHING.
 *
 * `startDetection`'s branching was:
 *
 *   if (!config.pipelineEnabled)          → produce nothing        (D109 gate)
 *   else if (detectionMode==='on-motion') → motion watch only
 *   else                                  → STANDING attach + decoder
 *
 * `'disabled'` is a legal `PipelinePhaseMode` the operator can pick from the
 * detection-mode selector, and it fell into that trailing `else` — so a camera
 * the operator explicitly set to "no detection" still got a standing attach,
 * still dialled its source and still paid for a decode session whose frames
 * nobody read. Exactly the D109 bug, reached through a different door: the
 * `object-detection` switch (`pipelineEnabled`) was gated, the MODE was not.
 *
 * Asserted on `runner.attachedCameras` — never on a flag in the attach
 * payload. A payload assertion is precisely what the original dead
 * `pipelineEnabled` flag passed for months while the decoder ran anyway; the
 * only honest question is whether the runner was handed a camera at all.
 *
 * The audio scenario is the load-bearing half of this change: audio
 * classification is a SEPARATE pipeline branch behind its own `audioMode` +
 * `audio-analysis` binding, and `AudioSubscriptionController.resubscribe`
 * runs OUTSIDE the detectionMode branch. A camera with detection off and
 * audio on must keep its audio subscription.
 */

import type { CameraDetectionConfig, StreamSourceEntry } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeAudioAnalyzer,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeFakeStreamBroker,
  makeFakeStreamBrokerCap,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const NODE = 'hub'

function makeConfig(overrides: Partial<CameraDetectionConfig> = {}): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['analyzer'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 10_000,
    detectionMode: 'always-on',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
    ...overrides,
  }
}

function makeCameraStreams(): readonly StreamSourceEntry[] {
  return [
    { id: 'sub', label: 'sub', protocol: 'rtsp', url: 'rtsp://cam/sub', profileHint: 'low' },
    { id: 'main', label: 'main', protocol: 'rtsp', url: 'rtsp://cam/main', profileHint: 'high' },
  ]
}

describe("startDetection — detectionMode:'disabled' joins the D109 no-produce gate", () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it("never attaches a camera whose detectionMode is 'disabled' (no standing attach, no decode session)", async () => {
    const broker = makeFakeBroker(NODE)
    const runner = makeFakeRunner({ nodeId: NODE })
    wireRunnerToBroker(broker, NODE, runner)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: [NODE], enabledDecoderNodes: [NODE] },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(2001, makeConfig({ detectionMode: 'disabled' }))

    // No attach, and no placement claimed — the camera costs nothing.
    expect(runner.attachedCameras.has(2001)).toBe(false)
    expect(addon.getPipelineAssignment({ deviceId: 2001 })).toBeNull()
  })

  it("still attaches an 'always-on' camera through the same call (the gate is mode-scoped, not a blanket off)", async () => {
    const broker = makeFakeBroker(NODE)
    const runner = makeFakeRunner({ nodeId: NODE })
    wireRunnerToBroker(broker, NODE, runner)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: [NODE], enabledDecoderNodes: [NODE] },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(2002, makeConfig({ detectionMode: 'always-on' }))

    expect(runner.attachedCameras.has(2002)).toBe(true)
  })

  it("keeps the audio subscription for a detectionMode:'disabled' camera whose audioMode is on", async () => {
    const broker = makeFakeBroker(NODE)
    const runner = makeFakeRunner({ nodeId: NODE })
    wireRunnerToBroker(broker, NODE, runner)

    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(3, 'provider-rtsp', makeCameraStreams())
    const audioBroker = makeFakeStreamBroker('3')
    streamBrokerCap.attachBroker('3/sub', audioBroker)

    const audioAnalyzer = makeFakeAudioAnalyzer({
      resolver: async () => ({ minConfidence: 0.3, allowedClasses: ['speech'] }),
      classifications: [{ className: 'speech', score: 0.91 }],
    })

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: [NODE],
        enabledDecoderNodes: [NODE],
        enabledAudioNodes: [NODE],
      },
      providers: { 'stream-broker': streamBrokerCap, 'audio-analyzer': audioAnalyzer },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(3, makeConfig({ detectionMode: 'disabled', audioMode: 'always-on' }))

    // Audio is an independent branch: it must run even though detection
    // produced nothing. If this ever regresses, the "cost nothing" gate has
    // swallowed a feature it does not own.
    //
    // D461 retarget: the orchestrator asks the ANALYZER to pull this camera's
    // audio rather than subscribing to the broker itself, so the observable is
    // the attach, not a broker subscriber. Same property, one hop further on —
    // and it is still the honest question, because an attach is what actually
    // opens the broker subscription.
    await waitUntil(() => audioAnalyzer.attaches.length === 1, 2_000)
    expect(audioAnalyzer.attaches[0]!.deviceId).toBe(3)
    expect(audioAnalyzer.attaches[0]!.brokerId).toBe('3/sub')
    // …and detection still produced nothing.
    expect(runner.attachedCameras.has(3)).toBe(false)
  })
})
