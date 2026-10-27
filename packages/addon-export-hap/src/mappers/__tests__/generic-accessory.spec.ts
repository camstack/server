/**
 * The non-camera export path.
 *
 * Until now `pickMapperKind` returned `'camera'` for every device it was ever
 * asked about and the Export tab was hard-gated on `isCameraDevice`, so a
 * switch, a light, a lock or a contact sensor reached Home Assistant and Alexa
 * and was invisible to HomeKit. These tests pin the three things that fixes:
 *
 *  1. the capability→service TABLE (a cap is exported or it is not, and the
 *     answer is one row, not a `switch` statement buried in a builder),
 *  2. the accessory the table builds — one service per mapped capability, its
 *     characteristics hydrated and its writes routed back through the cap,
 *  3. the refusal: a device carrying nothing HomeKit understands must fail
 *     LOUDLY rather than pair as an empty tile.
 *
 * The fakes here carry only what a builder reads. `DeviceProxy` is codegen'd
 * from every capability in the workspace and a fake carrying all of it would
 * assert nothing these tests assert — that is the documented type boundary the
 * `as unknown as` below stands on, and the only one in this file.
 */

import type { AddonContext, DeviceProxy } from '@camstack/types'
import { applianceExport, DeviceType } from '@camstack/types'
import type { CharacteristicWarning } from '@homebridge/hap-nodejs'
import { Categories, Characteristic, Service } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import { buildGenericAccessory } from '../generic-accessory.js'
import { HAP_CAP_SERVICES, hapExportableCapNames } from '../builders/generic/cap-service-table.js'
import { HAP_EXPORTABLE_DEVICE_TYPES, pickMapperKind } from '../index.js'
import { createHapDecodeMemos } from '../builders/stream-hwaccel-memo.js'
import type { CameraMapperOptions } from '../types.js'

const DEVICE_ID = 904

const OPTIONS: CameraMapperOptions = {
  decodeMemos: createHapDecodeMemos(),
  resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
  hksvClipStore: null,
  hapDeviceSettings: { streamPreference: 'auto' },
}

function makeLogger(): AddonContext['logger'] {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger as unknown as AddonContext['logger']
}

interface FakeProxy {
  readonly [cap: string]: unknown
}

function makeCtx(proxy: FakeProxy): AddonContext {
  return {
    logger: makeLogger(),
    fetchDevice: async () => proxy as unknown as DeviceProxy,
  } as unknown as AddonContext
}

/** A proxy whose `binding.entries` advertise `caps`, plus `deviceManager` so
 *  the orchestrator can read the device's type. */
function makeProxy(
  caps: readonly string[],
  deviceType: DeviceType,
  caphandles: FakeProxy,
): FakeProxy {
  return {
    deviceId: DEVICE_ID,
    binding: { entries: caps.map((capName) => ({ capName })) },
    deviceManager: {
      getDevice: async () => ({ id: DEVICE_ID, name: 'Presa kitchen', type: deviceType }),
    },
    state: {},
    ...caphandles,
  }
}

async function build(proxy: FakeProxy, displayName = 'Presa kitchen') {
  return buildGenericAccessory({
    ctx: makeCtx(proxy),
    deviceId: String(DEVICE_ID),
    displayName,
    options: OPTIONS,
  })
}

function serviceOfType(accessory: { services: readonly Service[] }, type: { UUID: string }) {
  return accessory.services.find((s) => s.UUID === type.UUID)
}

describe('the capability→service table', () => {
  it('claims every capability exactly once', () => {
    // Two rows claiming one cap would publish two services for it, and which
    // one iOS renders would depend on array order.
    const claimed = HAP_CAP_SERVICES.flatMap((row) => [...row.caps])
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('covers the Tier A device functions the operator actually owns', () => {
    const caps = hapExportableCapNames()
    for (const cap of [
      'switch',
      'brightness',
      'lock-control',
      'contact',
      'motion',
      'presence',
      'smoke',
      'carbon-monoxide',
      'flood',
      'temperature-sensor',
      'humidity-sensor',
      'ambient-light-sensor',
      'battery',
    ]) {
      expect(caps.has(cap), `${cap} is not exported to HomeKit`).toBe(true)
    }
  })
})

describe('pickMapperKind', () => {
  it('still routes a camera to the camera orchestrator', () => {
    expect(pickMapperKind(DeviceType.Camera)).toBe('camera')
  })

  it('routes a switch, a light, a lock and a sensor to the generic path', () => {
    for (const type of [DeviceType.Switch, DeviceType.Light, DeviceType.Lock, DeviceType.Sensor]) {
      expect(pickMapperKind(type)).toBe('generic')
    }
  })

  it('refuses a device type no HomeKit service exists for', () => {
    // A media player is Tier B at best; returning `generic` would build an
    // accessory with no services on it.
    expect(pickMapperKind(DeviceType.MediaPlayer)).toBeNull()
    expect(HAP_EXPORTABLE_DEVICE_TYPES).not.toContain(DeviceType.MediaPlayer)
  })

  it('refuses a washer, a dryer and a dishwasher', () => {
    for (const type of [DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher]) {
      expect(pickMapperKind(type)).toBeNull()
      expect(HAP_EXPORTABLE_DEVICE_TYPES).not.toContain(type)
      expect(applianceExport('homekit', type)?.exported).toBe(false)
    }
  })

  it('falls back to the camera path when the device type is unknown', () => {
    // `getDevice` failing must not change what an already-exposed camera does.
    expect(pickMapperKind(null)).toBe('camera')
  })
})

describe('the generic accessory', () => {
  it('publishes a Switch for a switch device, hydrated from the cap', async () => {
    const proxy = makeProxy(['switch'], DeviceType.Switch, {
      switch: { getStatus: async () => ({ on: true }), setState: async () => undefined },
    })
    const mapper = await build(proxy)

    const service = serviceOfType(mapper.accessory, Service.Switch)
    expect(service).toBeDefined()
    expect(service?.getCharacteristic(Characteristic.On).value).toBe(true)
    expect(mapper.accessory.category).toBe(Categories.SWITCH)
    await mapper.dispose()
  })

  it('routes an On write back through the switch cap', async () => {
    const written: boolean[] = []
    const proxy = makeProxy(['switch'], DeviceType.Switch, {
      switch: {
        getStatus: async () => ({ on: false }),
        setState: async (input: { on: boolean }) => {
          written.push(input.on)
        },
      },
    })
    const mapper = await build(proxy)

    const service = serviceOfType(mapper.accessory, Service.Switch)
    await service?.getCharacteristic(Characteristic.On).handleSetRequest(true)
    expect(written).toEqual([true])
    await mapper.dispose()
  })

  it('publishes a Lightbulb with Brightness for a dimmable light', async () => {
    const proxy = makeProxy(['switch', 'brightness'], DeviceType.Light, {
      switch: { getStatus: async () => ({ on: true }), setState: async () => undefined },
      brightness: {
        getStatus: async () => ({ level: 42 }),
        setBrightness: async () => undefined,
      },
    })
    const mapper = await build(proxy)

    const service = serviceOfType(mapper.accessory, Service.Lightbulb)
    expect(service).toBeDefined()
    expect(service?.getCharacteristic(Characteristic.Brightness).value).toBe(42)
    expect(serviceOfType(mapper.accessory, Service.Switch)).toBeUndefined()
    expect(mapper.accessory.category).toBe(Categories.LIGHTBULB)
    await mapper.dispose()
  })

  it('publishes a ContactSensor and follows the slice', async () => {
    const listeners: Array<(value: unknown) => void> = []
    const proxy = {
      ...makeProxy(['contact'], DeviceType.Sensor, {
        contact: { getStatus: async () => ({ entryOpen: false, lastChangedAt: 1 }) },
      }),
      state: {
        contact: {
          subscribe: (cb: (value: unknown) => void) => {
            listeners.push(cb)
            return () => undefined
          },
        },
      },
    }
    const mapper = await build(proxy)

    const service = serviceOfType(mapper.accessory, Service.ContactSensor)
    expect(service?.getCharacteristic(Characteristic.ContactSensorState).value).toBe(
      Characteristic.ContactSensorState.CONTACT_DETECTED,
    )

    expect(listeners).toHaveLength(1)
    listeners[0]?.({ entryOpen: true, lastChangedAt: 2 })
    expect(service?.getCharacteristic(Characteristic.ContactSensorState).value).toBe(
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    )
    await mapper.dispose()
  })

  it('publishes a LockMechanism and routes a lock write through the cap', async () => {
    const calls: string[] = []
    const proxy = makeProxy(['lock-control'], DeviceType.Lock, {
      lockControl: {
        getStatus: async () => ({ state: 'unlocked', lastChangedAt: 1 }),
        lock: async () => {
          calls.push('lock')
        },
        unlock: async () => {
          calls.push('unlock')
        },
      },
    })
    const mapper = await build(proxy)

    const service = serviceOfType(mapper.accessory, Service.LockMechanism)
    expect(service?.getCharacteristic(Characteristic.LockCurrentState).value).toBe(
      Characteristic.LockCurrentState.UNSECURED,
    )
    expect(mapper.accessory.category).toBe(Categories.DOOR_LOCK)

    await service
      ?.getCharacteristic(Characteristic.LockTargetState)
      .handleSetRequest(Characteristic.LockTargetState.SECURED)
    expect(calls).toEqual(['lock'])
    await mapper.dispose()
  })

  it('publishes one service per sensor capability, each separately labelled', async () => {
    const proxy = makeProxy(['temperature-sensor', 'humidity-sensor'], DeviceType.Sensor, {
      temperatureSensor: { getStatus: async () => ({ temperature: 21.5, lastFetchedAt: 1 }) },
      humiditySensor: { getStatus: async () => ({ humidity: 55, lastFetchedAt: 1 }) },
    })
    const mapper = await build(proxy, 'Sensore salotto')

    const temperature = serviceOfType(mapper.accessory, Service.TemperatureSensor)
    const humidity = serviceOfType(mapper.accessory, Service.HumiditySensor)
    expect(temperature?.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(21.5)
    expect(humidity?.getCharacteristic(Characteristic.CurrentRelativeHumidity).value).toBe(55)

    // Two services on one tile — indistinguishable labels are the whole
    // "Interruttore N" defect, one accessory shape further out.
    const names = [temperature, humidity].map(
      (s) => s?.getCharacteristic(Characteristic.Name).value,
    )
    expect(new Set(names).size).toBe(2)
    await mapper.dispose()
  })

  it('names a single-service accessory after the device itself', async () => {
    const proxy = makeProxy(['motion'], DeviceType.Sensor, {
      motion: { getStatus: async () => ({ detected: true, lastDetectedAt: 1 }) },
    })
    const mapper = await build(proxy, 'Sensore hallway')

    const service = serviceOfType(mapper.accessory, Service.MotionSensor)
    expect(service?.getCharacteristic(Characteristic.Name).value).toBe('Sensore hallway')
    expect(service?.getCharacteristic(Characteristic.MotionDetected).value).toBe(true)
    await mapper.dispose()
  })

  it('gives every published service a ConfiguredName, and warns about none', async () => {
    // Same reasoning as `service-naming.spec.ts`: `Name` is `pr` only and does
    // not participate in the config-number hash, so it cannot rename anything a
    // controller already cached.
    const proxy = makeProxy(['switch', 'battery'], DeviceType.Switch, {
      switch: { getStatus: async () => ({ on: false }), setState: async () => undefined },
      battery: {
        getStatus: async () => ({ level: 88, charging: 'none', lastUpdated: 1 }),
      },
    })
    const mapper = await build(proxy)
    const warnings: CharacteristicWarning[] = []
    mapper.accessory.on('characteristic-warning', (warning) => warnings.push(warning))

    for (const service of mapper.accessory.services) {
      if (service.UUID === Service.AccessoryInformation.UUID) continue
      const configured = service.characteristics.find(
        (c) => c.UUID === Characteristic.ConfiguredName.UUID,
      )
      expect(configured, `${service.displayName} carries no ConfiguredName`).toBeDefined()
      expect(configured?.value).toBe(service.getCharacteristic(Characteristic.Name).value)
    }
    expect(warnings).toEqual([])
    await mapper.dispose()
  })

  it('REFUSES a device carrying no capability HomeKit understands', async () => {
    // The alternative is an accessory with an AccessoryInformation service and
    // nothing else: it pairs, it appears, it does nothing, and the operator has
    // no way to tell that from a broken integration.
    const proxy = makeProxy(['numeric-sensor'], DeviceType.Sensor, {})
    await expect(build(proxy)).rejects.toThrow(/no capability/i)
  })

  it('gives the generic accessory its OWN uuid namespace', async () => {
    // Sharing `camstack:camera:<id>` would make a switch and a camera with the
    // same device id the same HomeKit accessory.
    const proxy = makeProxy(['switch'], DeviceType.Switch, {
      switch: { getStatus: async () => ({ on: false }), setState: async () => undefined },
    })
    const mapper = await build(proxy)
    const { accessoryUuidFor } = await import('../index.js')

    expect(mapper.accessory.UUID).toBe(accessoryUuidFor('generic', DEVICE_ID))
    expect(mapper.accessory.UUID).not.toBe(accessoryUuidFor('camera', DEVICE_ID))
    await mapper.dispose()
  })
})
