/**
 * The vendor flag is put back AT ATTACH, not only at save time.
 *
 * Saving the pick already writes the flag (`applyDeviceSettingsPatch` →
 * `nativeObjectDetection.setEnabled`), and that was never the hole. The hole is
 * that the flag is DEVICE state: the Reolink provider re-seeds its
 * `native-object-detection` slice with `enabled: false` whenever its persisted
 * slice does not reach the device's `runtimeState` before the cap registers.
 * Measured on the live hub (2026-09-15): the provider process started at
 * 23:19:36 the previous evening and all seven Reolink cameras carried a
 * `lastFetchedAt` from 23:19:38–23:20:03 — a field only the cold-start seed
 * writes. Device 106's pick said `['onboard']`, its flag said `false`, and the
 * provider logged the dropped detections once a minute.
 *
 * So `startDetection` — the one call every camera goes through whenever it is
 * wired, at boot and after every settings change — reconciles the mechanism
 * with the authority, in both directions.
 *
 * `detectionMode: 'disabled'` throughout: the reconcile must not depend on the
 * camera holding a standing attach, and it keeps the rest of `startDetection`
 * inert so the assertion is about the flag and nothing else.
 */
import type { CameraDetectionConfig } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const NODE = 'hub'
/** Key shape `getBindings` synthesises a `kind:'native'` entry from. */
const NATIVE_CAP_KEY = (deviceId: number): string => `native-object-detection:${deviceId}`

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
    detectionMode: 'disabled',
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

interface Harness {
  readonly addon: PipelineOrchestratorAddon
  readonly flags: Map<number, boolean>
}

async function bootWith(input: {
  deviceId: number
  flag: boolean
  readFails?: boolean
}): Promise<Harness> {
  const broker = makeFakeBroker(NODE)
  const runner = makeFakeRunner({ nodeId: NODE })
  wireRunnerToBroker(broker, NODE, runner)

  const flags = new Map<number, boolean>([[input.deviceId, input.flag]])
  const { ctx } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialGlobalSettings: { enabledNodes: [NODE], enabledDecoderNodes: [NODE] },
    nativeProviders: new Map([[NATIVE_CAP_KEY(input.deviceId), {}]]),
    onboardForwarding: flags,
    ...(input.readFails === true ? { onboardForwardingReadFails: new Set([input.deviceId]) } : {}),
  })
  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(ctx)
  return { addon, flags }
}

describe('startDetection reconciles the onboard forwarding flag with the pick', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('re-arms a camera whose pick is onboard but whose flag was lost to a provider restart', async () => {
    const h = await bootWith({ deviceId: 106, flag: false })
    addon = h.addon

    await addon.startDetection(106, makeConfig({ detectionSources: ['onboard'] }))

    expect(h.flags.get(106)).toBe(true)
  })

  it('turns forwarding OFF for a camera whose pick does not include onboard', async () => {
    const h = await bootWith({ deviceId: 108, flag: true })
    addon = h.addon

    await addon.startDetection(108, makeConfig({ detectionSources: ['pipeline'] }))

    expect(h.flags.get(108)).toBe(false)
  })

  it('leaves an agreeing flag alone', async () => {
    const h = await bootWith({ deviceId: 107, flag: true })
    addon = h.addon

    await addon.startDetection(107, makeConfig({ detectionSources: ['onboard'] }))

    expect(h.flags.get(107)).toBe(true)
  })

  it('does not fail the attach when the vendor flag cannot be read', async () => {
    const h = await bootWith({ deviceId: 3825, flag: true, readFails: true })
    addon = h.addon

    await expect(
      addon.startDetection(3825, makeConfig({ detectionSources: ['pipeline'] })),
    ).resolves.toBeUndefined()

    // Unknown is not "off": nothing was written.
    expect(h.flags.get(3825)).toBe(true)
  })
})
