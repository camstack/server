/**
 * `pipelineOrchestrator.setCameraSensors` (G5, D676): the one typed write path
 * of a camera's attached sensors (D672). Validated, refused BY NAME before
 * anything is written (D49, D391), handed under the CS-1 key to the ONE store
 * effect (the addon binds it to `applyDeviceSettingsPatch`, whose event the
 * delegate spec in device-contribution.spec.ts proves) — and `null` clears.
 */
import { CAMERA_SENSORS_SETTINGS_KEY, type IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { type CameraSensorsWriteDevice, writeCameraSensors } from '../camera-sensors/write.js'

const CAMERA: CameraSensorsWriteDevice = {
  type: 'camera',
  addonId: 'provider-hikvision',
  stableId: 'mac-103',
}
const PIR = { addonId: 'provider-homeassistant', stableId: 'binary_sensor.porch_pir' }

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function deps(device: CameraSensorsWriteDevice | null | Error = CAMERA) {
  return {
    readDevice: vi.fn(async (_deviceId: number) => {
      if (device instanceof Error) throw device
      return device
    }),
    writeDeviceStore: vi.fn(
      async (_deviceId: number, _patch: Record<string, unknown>) => undefined,
    ),
    logger: makeLogger(),
  }
}

describe('writeCameraSensors (G5)', () => {
  it('writes the validated config under the CS-1 key, as its only effect', async () => {
    const d = deps()
    await expect(
      writeCameraSensors(d, {
        deviceId: 103,
        config: { sensors: [{ ...PIR, mode: 'in-addition' }] },
      }),
    ).resolves.toEqual({ success: true })
    expect(d.writeDeviceStore).toHaveBeenCalledWith(103, {
      [CAMERA_SENSORS_SETTINGS_KEY]: { sensors: [{ ...PIR, mode: 'in-addition' }] },
    })
    expect(d.writeDeviceStore).toHaveBeenCalledTimes(1)
    expect(d.logger.info).toHaveBeenCalledWith(
      'camera sensors saved',
      expect.objectContaining({ tags: { deviceId: 103 } }),
    )
  })

  it('null clears the attachment', async () => {
    const d = deps()
    await writeCameraSensors(d, { deviceId: 103, config: null })
    expect(d.writeDeviceStore).toHaveBeenCalledWith(103, { [CAMERA_SENSORS_SETTINGS_KEY]: null })
  })

  it.each([
    ['a non-camera', { ...CAMERA, type: 'sensor' }, 'device 103 is not a camera'],
    ['an unknown device', null, 'no device 103'],
    ['an unreadable device', new Error('bus down'), 'could not read device 103: bus down'],
  ])('refuses %s by name, logs it and writes nothing', async (_label, device, message) => {
    const d = deps(device)
    await expect(
      writeCameraSensors(d, {
        deviceId: 103,
        config: { sensors: [{ ...PIR, mode: 'in-addition' }] },
      }),
    ).rejects.toThrow(message)
    expect(d.writeDeviceStore).not.toHaveBeenCalled()
    expect(d.logger.warn).toHaveBeenCalledWith(
      'camera sensors write refused',
      expect.objectContaining({ tags: { deviceId: 103 } }),
    )
  })

  it('refuses the camera as its own sensor', async () => {
    const d = deps()
    await expect(
      writeCameraSensors(d, {
        deviceId: 103,
        config: {
          sensors: [{ addonId: CAMERA.addonId, stableId: CAMERA.stableId, mode: 'in-addition' }],
        },
      }),
    ).rejects.toThrow('a camera cannot be its own sensor')
    expect(d.writeDeviceStore).not.toHaveBeenCalled()
  })

  it('a camera can still be cleared when it is the only thing it could read (null skips the self check)', async () => {
    const d = deps()
    await writeCameraSensors(d, { deviceId: 103, config: null })
    expect(d.writeDeviceStore).toHaveBeenCalledTimes(1)
  })
})
