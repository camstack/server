/**
 * The watchdog's audio stage needs EVIDENCE, and the evidence is read at
 * dispatch time.
 *
 * `audioMode` defaults to `always-on`, so every hub-local camera used to arm an
 * audio stage — including cameras whose source carries no audio track at all.
 * That stage could never receive a signal, so it stalled, burned its recovery
 * budget, and then re-requested recovery on the slow cadence for as long as the
 * process lived.
 *
 * The decision itself is pure (`watchdog-camera.spec.ts`). What is asserted
 * here is the WIRING: the dispatch path resolves the evidence, from the broker,
 * for the audio stage's own stream — once per dispatch, and never for a camera
 * whose audio mode could not arm the stage anyway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import type { StreamSourceEntry } from '@camstack/types'
import {
  enabledNodesFromBroker,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeFakeStreamBrokerCap,
  makeRunnerCameraConfig,
  wireRunnerToBroker,
} from './e2e-helpers.js'

/**
 * The camera's published rungs. Registered because the audio stage no longer
 * rides `motionStreamId`: it rides the lowest NATIVE rung, resolved from the
 * profile-slot table (`selectAudioCamStream`), so a camera with no slots has no
 * audio stream to probe at all.
 */
function makeCameraStreams(): readonly StreamSourceEntry[] {
  return [
    { id: 'sub', label: 'sub', protocol: 'rtsp', url: 'rtsp://cam/sub', profileHint: 'low' },
    { id: 'main', label: 'main', protocol: 'rtsp', url: 'rtsp://cam/main', profileHint: 'high' },
  ]
}

describe('PipelineOrchestratorAddon — watchdog audio-source probe', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('probes the broker for an audio track on the audio stage stream when dispatching an always-on-audio camera', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', makeCameraStreams())

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const api = ctx.api
    expect(api).toBeDefined()
    const probe = vi.spyOn(api!.streamBroker.getBrokerStats, 'query')

    // `sub` is the camera's lowest NATIVE rung — the stream audio rides.
    const result = await addon.dispatchCamera(makeRunnerCameraConfig(1))
    expect(result.kind).toBe('assigned')

    expect(probe).toHaveBeenCalled()
    const probedBrokerIds = probe.mock.calls.map((c) => c[0].brokerId)
    expect(probedBrokerIds).toContain('1/sub')
  })

  it('never probes for a camera whose audio mode could not arm the stage anyway', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const api = ctx.api
    expect(api).toBeDefined()
    const probe = vi.spyOn(api!.streamBroker.getBrokerStats, 'query')

    const result = await addon.dispatchCamera(makeRunnerCameraConfig(2, { audioMode: 'on-motion' }))
    expect(result.kind).toBe('assigned')

    const probedBrokerIds = probe.mock.calls.map((c) => c[0].brokerId)
    expect(probedBrokerIds).not.toContain('2/sub')
  })
})
