/**
 * D109's gate, asserted against the AUTHORITY rather than the switch group.
 *
 * ## Why this file exists
 *
 * D109 ("off means free") is enforced by three specs, and one of them was
 * `camera-switches-e2e.spec.ts` — which drives
 * `pipelineOrchestrator.setCameraSwitch`. That cap is a DEPRECATED
 * compatibility surface with a deletion date (D113): when it goes, the spec
 * enforcing D109 goes with it, and the gate that stops a switched-off camera
 * from dialling its RTSP would lose its guard on the same commit that removes
 * an unrelated UI.
 *
 * So the load-bearing assertion moves HERE, expressed the way it will still be
 * expressible afterwards: `deviceManager.setWrapperActive` on
 * `detection-pipeline` — the authority that has owned this function all along
 * and that the switch merely wrote through.
 *
 * ## What is asserted, and what deliberately is not
 *
 * `attachedCameras`, never `pipelineEnabled`. Asserting the flag is precisely
 * what a DEAD flag passes: `pipelineEnabled` reached the runner for months and
 * nothing in `packages/addon-pipeline` ever read it, while the camera kept
 * dialling RTSP, spawning ffmpeg and holding a decode session. Stopping
 * INFERENCE is not stopping WORK. Measured on camera 3218 with the function
 * off: `ffmpeg source: streaming`, `RTSP client connected`,
 * `session-decode-coordinator … waitedMs=40001`.
 *
 * The COLD-START leg is the one this file adds over
 * `detection-wiring-e2e.spec.ts`'s existing "attaches, then detaches" case: a
 * camera whose binding is already inactive when its streams first register
 * must never be handed to the runner at all — not attached-then-detached, and
 * not re-attached by the next dispatch trigger. That is where the decoder came
 * back the first time.
 */

import type { StreamSourceEntry } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  enabledNodesFromBroker,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeFakeStreamBrokerCap,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const DEFAULT_DEVICE_SETTINGS = {
  detectionMode: 'always-on' as const,
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

interface BootResult {
  readonly addon: PipelineOrchestratorAddon
  readonly ctx: ReturnType<typeof makeFakeContext>['ctx']
  readonly eventBus: ReturnType<typeof makeFakeContext>['eventBus']
  readonly runner: ReturnType<typeof makeFakeRunner>
}

async function boot(): Promise<BootResult> {
  const broker = makeFakeBroker('hub')
  const runner = makeFakeRunner({ nodeId: 'hub' })
  wireRunnerToBroker(broker, 'hub', runner)

  const streamBrokerCap = makeFakeStreamBrokerCap()
  streamBrokerCap.register(1, 'provider-rtsp', makeCameraStreams())

  const { ctx, eventBus } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialDeviceSettings: new Map<number, Record<string, unknown>>([
      [1, { ...DEFAULT_DEVICE_SETTINGS }],
    ]),
    initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    providers: { 'stream-broker': streamBrokerCap },
  })

  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(ctx)
  return { addon, ctx, eventBus, runner }
}

function fireStreamsRegistered(eventBus: BootResult['eventBus'], deviceId = 1): void {
  eventBus.emit({
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.CameraStreamsProfileSlotsChanged,
    data: { deviceId, providerId: 'provider-rtsp' },
  })
}

async function setDetectionActive(b: BootResult, active: boolean): Promise<void> {
  await b.ctx.api.deviceManager.setWrapperActive.mutate({
    deviceId: 1,
    capName: 'detection-pipeline',
    wrapperAddonId: 'pipeline-executor',
    active,
  })
}

describe('object detection OFF at the AUTHORITY — the producer never runs (D109)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('the RUNNER is never handed a camera whose detection binding is inactive', async () => {
    const b = await boot()
    addon = b.addon

    await setDetectionActive(b, false)
    fireStreamsRegistered(b.eventBus)
    await new Promise((r) => setTimeout(r, 150))

    // Never attached AT ALL — not attached-with-empty-steps. An attached
    // camera dials its RTSP and opens a decode session no matter how empty its
    // pipeline is, so "off" has to mean the producer never starts.
    expect(b.runner.attachedCameras.has(1)).toBe(false)
  })

  it('a second dispatch trigger does not resurrect it', async () => {
    const b = await boot()
    addon = b.addon

    await setDetectionActive(b, false)
    fireStreamsRegistered(b.eventBus)
    await new Promise((r) => setTimeout(r, 120))
    fireStreamsRegistered(b.eventBus)
    await new Promise((r) => setTimeout(r, 120))

    expect(b.runner.attachedCameras.has(1)).toBe(false)
  })

  it('the resolved pipeline is empty, so nothing downstream has work either', async () => {
    const b = await boot()
    addon = b.addon

    await setDetectionActive(b, false)

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps).toEqual([])
    expect(resolved.audio).toBeNull()
  })

  it('is REPORTED as switched off — disabled must never look like broken', async () => {
    // The badge is composed from this same binding (D113), with no switch group
    // in between. A camera producing zero detections and reporting nothing
    // switched off is a camera an operator will debug for an hour.
    const b = await boot()
    addon = b.addon

    await setDetectionActive(b, false)

    const status = await addon.getCameraStatus({ deviceId: 1 })
    expect(status.switchedOff).toContain('object-detection')
  })

  it('turning it back ON restores exactly what was resolving before — not a one-way door', async () => {
    const b = await boot()
    addon = b.addon

    fireStreamsRegistered(b.eventBus)
    await waitUntil(() => b.runner.attachedCameras.has(1))

    await setDetectionActive(b, false)
    await waitUntil(() => !b.runner.attachedCameras.has(1), 2000)

    await setDetectionActive(b, true)
    fireStreamsRegistered(b.eventBus)
    await waitUntil(() => b.runner.attachedCameras.has(1), 2000)
    expect(b.runner.attachedCameras.has(1)).toBe(true)
  })
})
