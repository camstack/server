/**
 * The ONE typed write path of a camera's attached sensors (D672 config,
 * G5/D676) — `pipelineOrchestrator.setCameraSensors`.
 *
 * The input is already validated by the cap schema at the router. Here it is
 * refused BY NAME, and logged with the device tag, before anything is written
 * (D391): a device that could not be read (a failed read changes nothing,
 * D49), an unknown device, a non-camera, a camera named as its own sensor.
 * The value is then handed to `writeDeviceStore` under the CS-1 key, which the
 * addon binds to `applyDeviceSettingsPatch` — so the D672 patch gate, the
 * PARSED value, the store and the settings-updated event that refreshes the
 * bridge's resolver are ONE path, never a copy of it. `null` clears: the
 * device store keeps a null key, and `parseCameraSensorsSetting` reads it as
 * not-configured.
 */
import {
  CAMERA_SENSORS_SETTINGS_KEY,
  DeviceType,
  errMsg,
  type IScopedLogger,
  type SetCameraSensorsInput,
} from '@camstack/types'

/** The fields of a device row this write needs — nothing else. */
export interface CameraSensorsWriteDevice {
  readonly type: string
  readonly addonId: string
  readonly stableId: string
}

export interface CameraSensorsWriteDeps {
  /** `null` = the registry answered that no such device exists. A throw = it did not answer. */
  readonly readDevice: (deviceId: number) => Promise<CameraSensorsWriteDevice | null>
  /** The ONLY effect of an accepted write — bound to `applyDeviceSettingsPatch` in the addon. */
  readonly writeDeviceStore: (deviceId: number, patch: Record<string, unknown>) => Promise<void>
  readonly logger: IScopedLogger
}

export interface CameraSensorsWriteResult {
  readonly success: true
}

function refuse(deps: CameraSensorsWriteDeps, deviceId: number, reason: string): never {
  deps.logger.warn('camera sensors write refused', { tags: { deviceId }, meta: { reason } })
  throw new Error(`pipeline-orchestrator: camera sensors of ${deviceId} not saved — ${reason}`)
}

async function readOrRefuse(
  deps: CameraSensorsWriteDeps,
  deviceId: number,
): Promise<CameraSensorsWriteDevice> {
  let device: CameraSensorsWriteDevice | null
  try {
    device = await deps.readDevice(deviceId)
  } catch (err: unknown) {
    return refuse(deps, deviceId, `could not read device ${deviceId}: ${errMsg(err)}`)
  }
  if (device === null) return refuse(deps, deviceId, `no device ${deviceId}`)
  return device
}

export async function writeCameraSensors(
  deps: CameraSensorsWriteDeps,
  input: SetCameraSensorsInput,
): Promise<CameraSensorsWriteResult> {
  const { deviceId, config } = input
  const device = await readOrRefuse(deps, deviceId)
  if (device.type !== DeviceType.Camera) {
    return refuse(deps, deviceId, `device ${deviceId} is not a camera`)
  }
  const selfAttached =
    config !== null &&
    config.sensors.some((s) => s.addonId === device.addonId && s.stableId === device.stableId)
  if (selfAttached) return refuse(deps, deviceId, 'a camera cannot be its own sensor')
  await deps.writeDeviceStore(deviceId, { [CAMERA_SENSORS_SETTINGS_KEY]: config })
  deps.logger.info('camera sensors saved', {
    tags: { deviceId },
    meta: { sensors: config === null ? 0 : config.sensors.length },
  })
  return { success: true }
}
