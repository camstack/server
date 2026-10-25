/**
 * `CameraStatus.cameraSensors` (D672): every status names every attached
 * sensor, from the camera-sensors controller's MEMORY.
 *
 * The service is built with `api: () => null as never`, exactly as the
 * switched-off spec does: any `ctx.api` read on the sensors path would throw
 * here, which is the no-I/O proof. The admin page polls every camera every few
 * seconds, so the status path must cost nothing for the sensors block.
 */
import type {
  AddonApi,
  CameraSensorsStatus,
  IScopedLogger,
  PipelineAssignment,
  RunnerCameraConfig,
} from '@camstack/types'
import { CAMERA_SENSORS_NOT_LOADED } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { CameraStatusService } from '../camera-status-service.js'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'
import type { AudioNodeAssignment } from '../orchestrator-types.js'
import { RepeatWarnSampler } from '../repeat-warn-sampler.js'
import { healthyAuthorities } from './camera-status-switch-authorities.js'

const CAMERA_ID = 103

const SILENT_LOGGER: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: (): IScopedLogger => SILENT_LOGGER,
  withTags: (): IScopedLogger => SILENT_LOGGER,
}

function makeService(
  cameraSensorsFor: (deviceId: number) => CameraSensorsStatus,
): CameraStatusService {
  return new CameraStatusService({
    api: (): AddonApi => null as never,
    logger: SILENT_LOGGER,
    warnSampler: new RepeatWarnSampler(),
    getAssignment: (): PipelineAssignment | null => null,
    getAudioAssignment: (): AudioNodeAssignment | null => null,
    getCameraConfig: (): RunnerCameraConfig | null => null,
    hasCameraConfig: (): boolean => true,
    getPendingReason: (): string | undefined => undefined,
    assignSource: (): string => 'hub',
    listAssignedDeviceIds: (): readonly number[] => [CAMERA_ID],
    isSessionCamera: (): boolean => false,
    switchAuthoritiesFor: async (deviceId) => healthyAuthorities(deviceId),
    cameraSensorsFor,
  })
}

const OFFLINE_PIR: CameraSensorsStatus = {
  state: 'configured',
  sensors: [
    {
      addonId: 'provider-homeassistant',
      stableId: 'ha:porch-pir',
      mode: 'in-addition',
      state: 'offline',
      deviceId: 3299,
      name: 'Motion',
      reason: 'offline',
    },
  ],
}

describe('CameraStatus.cameraSensors (D672)', () => {
  it('every status carries the controller snapshot, single and batched, with no device-manager read', async () => {
    const asked: number[] = []
    const svc = makeService((id) => {
      asked.push(id)
      return OFFLINE_PIR
    })
    expect((await svc.getCameraStatus(CAMERA_ID)).cameraSensors).toEqual(OFFLINE_PIR)
    expect((await svc.getCameraStatuses([CAMERA_ID]))[0]?.cameraSensors).toEqual(OFFLINE_PIR)
    expect(asked).toEqual([CAMERA_ID, CAMERA_ID])
  })

  it('the boot window travels as unreadable NOT LOADED, never as not-configured (D315)', async () => {
    const svc = makeService(() => CAMERA_SENSORS_NOT_LOADED)
    const status = await svc.getCameraStatus(CAMERA_ID)
    expect(status.cameraSensors).toEqual({
      state: 'unreadable',
      reason: 'camera sensor mappings not loaded',
    })
  })
})

describe('CameraStatus.cameraSensors — the whole addon (D672)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('getCameraStatus names the attached PIR the controller resolved', async () => {
    const infos: string[] = []
    const noop = (): void => {}
    const logger: IScopedLogger = {
      info: (message: string) => {
        infos.push(message)
      },
      debug: noop,
      warn: noop,
      error: noop,
      child: () => logger,
      withTags: () => logger,
    }
    const broker = makeFakeBroker('hub')
    wireRunnerToBroker(broker, 'hub', makeFakeRunner({ nodeId: 'hub' }))
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
      initialDeviceSettings: new Map([
        [
          809,
          {
            cameraSensors: {
              mode: 'in-addition',
              sensors: [{ addonId: 'provider-homeassistant', stableId: 'ha:porch-pir' }],
            },
          },
        ],
      ]),
      sensorDevices: [
        {
          id: 3299,
          addonId: 'provider-homeassistant',
          stableId: 'ha:porch-pir',
          capNames: ['motion'],
        },
      ],
      logger,
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    await waitUntil(() => infos.includes('camera-sensors: attachment ready'))

    const status = await addon.getCameraStatus({ deviceId: 809 })
    expect(status.cameraSensors).toMatchObject({
      state: 'configured',
      sensors: [
        {
          addonId: 'provider-homeassistant',
          stableId: 'ha:porch-pir',
          state: 'ready',
          deviceId: 3299,
        },
      ],
    })
  })
})
