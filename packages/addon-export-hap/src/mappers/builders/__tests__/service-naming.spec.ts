/**
 * Every secondary service on the camera accessory must publish a
 * `ConfiguredName`, and the accessory must still build WITHOUT hap-nodejs
 * warning about a single characteristic.
 *
 * Those two requirements were once thought to be in conflict. The live hub
 * logged this on every accessory build, twice per camera:
 *
 * ```
 * [Camera front door@Siren@Configured Name] Characteristic not in required
 *   or optional characteristic section for service Switch. Adding anyway.
 * ```
 *
 * A round of this bug read that as a rejection and removed `ConfiguredName`.
 * It is a WARNING — `Service.getCharacteristic` calls `addCharacteristic`
 * unconditionally and only then emits it — and `Service.addOptionalCharacteristic`
 * takes the branch above it, so both requirements hold at once. The full
 * mechanism, including why `Name` alone cannot rename a service on a paired
 * controller, is in `service-label.ts`.
 *
 * These tests do not assert on strings in the source. They attach a listener
 * to the SAME `characteristic-warning` event hap-nodejs emits into the log and
 * require the count to be zero, and separately require the characteristic to
 * be present with the right value — so dropping either half turns one red.
 */

import type { AddonContext, DeviceProxy } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import type { CharacteristicWarning } from '@homebridge/hap-nodejs'
import { Accessory, Characteristic, Perms, Service, uuid } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'
import type { BuilderContext, CameraMapperOptions } from '../../types.js'
import { buildBattery } from '../battery.js'
import { buildChildSwitch } from '../child-switch.js'
import { createHapDecodeMemos } from '../stream-hwaccel-memo.js'
import { buildMotionSensor } from '../motion-sensor.js'
import { buildPrivacySwitch } from '../privacy-switch.js'
import { buildPtz } from '../ptz.js'

const DEVICE_ID = 112
const CAMERA_NAME = 'Camera kitchen'

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
  // Documented type boundary: the builders only ever call the five methods
  // above on the injected logger.
  return logger as unknown as AddonContext['logger']
}

interface WarningSink {
  readonly accessory: Accessory
  readonly warnings: CharacteristicWarning[]
}

function makeAccessory(): WarningSink {
  const accessory = new Accessory(CAMERA_NAME, uuid.generate(`camstack:camera:${DEVICE_ID}`))
  const warnings: CharacteristicWarning[] = []
  accessory.on('characteristic-warning', (warning) => warnings.push(warning))
  return { accessory, warnings }
}

function makeCtx(): AddonContext {
  // Documented type boundary: `AddonContext` is the kernel's full injected
  // surface; the builders under test reach for `logger` and — the motion
  // sensor only — `eventBus.subscribe`.
  return {
    logger: makeLogger(),
    eventBus: { subscribe: () => () => undefined },
  } as unknown as AddonContext
}

function makeBctx(accessory: Accessory, proxy: object, displayName: string): BuilderContext {
  return {
    ctx: makeCtx(),
    accessory,
    // Documented type boundary: `DeviceProxy` is codegen'd from every
    // capability in the workspace; a fake carrying all of it would assert
    // nothing that these tests assert.
    proxy: proxy as unknown as DeviceProxy,
    numericDeviceId: DEVICE_ID,
    displayName,
    options: OPTIONS,
  }
}

const PRIVACY_PROXY = {
  privacyMask: {
    getStatus: async () => ({ enabled: false }),
    setMask: async () => undefined,
  },
  state: {},
}

const SIREN_PROXY = {
  switch: {
    getStatus: async () => ({ on: false }),
    setState: async () => undefined,
  },
  state: {},
}

const SENSOR_PROXY = {
  motion: { isDetected: async () => false },
  battery: {
    getStatus: async () => ({ percentage: 74, charging: 'none', lastUpdated: 1 }),
  },
  state: {},
}

const PTZ_PROXY = {
  ptz: {
    getPresets: async () => [{ id: '1', name: 'front door' }],
    goToPreset: async () => undefined,
    move: async () => undefined,
    getOptions: async () => ({ moveImpulseMs: 200 }),
  },
  state: {},
}

/** The Name a service ended up publishing, or `null` when it has none. */
function serviceName(accessory: Accessory, subtype: string): string | null {
  const service = accessory.services.find((s) => s.subtype === subtype)
  if (service === undefined) return null
  const value = service.getCharacteristic(Characteristic.Name).value
  return typeof value === 'string' ? value : null
}

describe('camera accessory services — hap-nodejs must reject nothing', () => {
  it('the privacy switch adds no characteristic the Switch service does not list', async () => {
    const { accessory, warnings } = makeAccessory()
    const handle = await buildPrivacySwitch(makeBctx(accessory, PRIVACY_PROXY, CAMERA_NAME))

    expect(warnings.map((w) => w.originatorChain.join('@'))).toEqual([])
    await handle.dispose()
  })

  it('the child switch adds no characteristic the Switch service does not list', async () => {
    const { accessory, warnings } = makeAccessory()
    const handle = await buildChildSwitch(
      makeBctx(accessory, SIREN_PROXY, 'Sirena'),
      'child-588',
      DeviceType.Siren,
    )

    expect(warnings.map((w) => w.originatorChain.join('@'))).toEqual([])
    await handle.dispose()
  })

  it('the PTZ switches add no characteristic the Switch service does not list', async () => {
    // Same defect, four more services, never reported — a PTZ camera emitted
    // six of these lines per build.
    const { accessory, warnings } = makeAccessory()
    const handle = await buildPtz(makeBctx(accessory, PTZ_PROXY, CAMERA_NAME))

    expect(warnings.map((w) => w.originatorChain.join('@'))).toEqual([])
    await handle.dispose()
  })

  it('every switch-shaped service publishes ConfiguredName, equal to its Name', async () => {
    // `Name` is `pr` only and does not participate in the config-number hash,
    // so it cannot rename anything a controller already cached. Silently
    // dropping `ConfiguredName` again would leave the three warning-count
    // assertions above green.
    const { accessory, warnings } = makeAccessory()
    const handles = [
      await buildPrivacySwitch(makeBctx(accessory, PRIVACY_PROXY, CAMERA_NAME)),
      await buildChildSwitch(
        makeBctx(accessory, SIREN_PROXY, 'Sirena'),
        'child-588',
        DeviceType.Siren,
      ),
      await buildPtz(makeBctx(accessory, PTZ_PROXY, CAMERA_NAME)),
    ]

    const switchLike = accessory.services.filter(
      (s) => s.UUID === Service.Switch.UUID || s.UUID === Service.Lightbulb.UUID,
    )
    expect(switchLike.length).toBeGreaterThan(0)

    for (const service of switchLike) {
      const configured = service.characteristics.find(
        (c) => c.UUID === Characteristic.ConfiguredName.UUID,
      )
      expect(configured, `${service.displayName} carries no ConfiguredName`).toBeDefined()
      expect(configured?.value).toBe(service.getCharacteristic(Characteristic.Name).value)
    }

    // …and it is registered as optional, so none of the above warned.
    expect(warnings.map((w) => w.originatorChain.join('@'))).toEqual([])
    for (const h of handles) await h.dispose()
  })

  it('publishes ConfiguredName on the SENSOR services too', async () => {
    // `MotionSensor` and `Battery` were deliberately excluded, on the theory
    // that iOS Home does not render them as separately named tiles. The theory
    // was never measured and it made the whole `ConfiguredName` hypothesis
    // untestable — a partial application proves nothing about the mechanism.
    const { accessory, warnings } = makeAccessory()
    const handles = [
      await buildMotionSensor(makeBctx(accessory, SENSOR_PROXY, CAMERA_NAME)),
      await buildBattery(makeBctx(accessory, SENSOR_PROXY, CAMERA_NAME)),
    ]

    const sensorLike = accessory.services.filter(
      (s) => s.UUID === Service.MotionSensor.UUID || s.UUID === Service.Battery.UUID,
    )
    expect(sensorLike).toHaveLength(2)
    for (const service of sensorLike) {
      const configured = service.characteristics.find(
        (c) => c.UUID === Characteristic.ConfiguredName.UUID,
      )
      expect(configured, `${service.displayName} carries no ConfiguredName`).toBeDefined()
      expect(configured?.value).toBe(service.getCharacteristic(Characteristic.Name).value)
    }
    expect(warnings.map((w) => w.originatorChain.join('@'))).toEqual([])
    for (const h of handles) await h.dispose()
  })

  it("labels the controller's OWN motion service, the one HKSV records from", async () => {
    // Under HKSV the builder adopts the service `CameraController` created. It
    // is still a service the operator sees and can rename, and skipping it left
    // exactly one unlabelled service on every recording camera.
    const { accessory } = makeAccessory()
    const adopted = accessory.addService(Service.MotionSensor, 'Controller motion')
    const handle = await buildMotionSensor(makeBctx(accessory, SENSOR_PROXY, CAMERA_NAME), adopted)

    const configured = adopted.characteristics.find(
      (c) => c.UUID === Characteristic.ConfiguredName.UUID,
    )
    expect(configured?.value).toBe(CAMERA_NAME)
    await handle.dispose()
  })

  it('gives ConfiguredName the writable, notifying perms a rename needs', async () => {
    // The whole point of the characteristic: `Name` is `pr` only.
    const { accessory } = makeAccessory()
    const handle = await buildPrivacySwitch(makeBctx(accessory, PRIVACY_PROXY, CAMERA_NAME))

    const service = accessory.services.find((s) => s.subtype === 'privacy-mask')
    const perms = service?.getCharacteristic(Characteristic.ConfiguredName).props.perms ?? []
    expect(perms).toContain(Perms.PAIRED_WRITE)
    expect(perms).toContain(Perms.NOTIFY)
    await handle.dispose()
  })
})

describe('camera accessory services — the operator can tell them apart', () => {
  it('names the privacy switch by its FUNCTION, not by the camera around it', async () => {
    const { accessory } = makeAccessory()
    const handle = await buildPrivacySwitch(makeBctx(accessory, PRIVACY_PROXY, CAMERA_NAME))

    expect(serviceName(accessory, 'privacy-mask')).toBe('Privacy')
    await handle.dispose()
  })

  it("names the child switch after the child's own device name", async () => {
    const { accessory } = makeAccessory()
    // `child-accessory.ts` resolves this through `childServiceName`, which has
    // already stripped the camera prefix by the time the builder sees it.
    const handle = await buildChildSwitch(
      makeBctx(accessory, SIREN_PROXY, 'Sirena'),
      'child-588',
      DeviceType.Siren,
    )

    expect(serviceName(accessory, 'child-588')).toBe('Sirena')
    await handle.dispose()
  })

  it('repeats the camera name in NO secondary service label', async () => {
    // The operator's second report: every switch read "<camera> <function>"
    // inside a tile already titled "<camera>".
    const { accessory } = makeAccessory()
    const handles = [
      await buildPrivacySwitch(makeBctx(accessory, PRIVACY_PROXY, CAMERA_NAME)),
      await buildPtz(makeBctx(accessory, PTZ_PROXY, CAMERA_NAME)),
    ]

    for (const service of accessory.services) {
      if (service.UUID === Service.AccessoryInformation.UUID) continue
      const name = serviceName(accessory, service.subtype ?? '')
      expect(name, `${service.displayName} still carries the camera name`).not.toContain(
        CAMERA_NAME,
      )
    }
    for (const h of handles) await h.dispose()
  })

  it('keeps every label on one accessory unique after the trim', async () => {
    // The camera prefix was IDENTICAL on every service of an accessory, so it
    // never disambiguated anything within one — removing it cannot introduce a
    // collision that did not already exist. This pins that argument.
    const { accessory } = makeAccessory()
    const handles = [
      await buildPrivacySwitch(makeBctx(accessory, PRIVACY_PROXY, CAMERA_NAME)),
      await buildChildSwitch(
        makeBctx(accessory, SIREN_PROXY, 'Sirena'),
        'child-588',
        DeviceType.Siren,
      ),
      await buildPtz(makeBctx(accessory, PTZ_PROXY, CAMERA_NAME)),
    ]

    const names = accessory.services
      .filter((s) => s.UUID === Service.Switch.UUID || s.UUID === Service.Lightbulb.UUID)
      .map((s) => serviceName(accessory, s.subtype ?? ''))
    expect(names.length).toBeGreaterThan(4)
    expect(new Set(names).size).toBe(names.length)
    for (const h of handles) await h.dispose()
  })

  it('leaves the ACCESSORY name — the camera itself — untouched', async () => {
    // Trimming the service labels must not reach the tile's own title.
    const { accessory } = makeAccessory()
    const handles = [
      await buildPrivacySwitch(makeBctx(accessory, PRIVACY_PROXY, CAMERA_NAME)),
      await buildPtz(makeBctx(accessory, PTZ_PROXY, CAMERA_NAME)),
    ]

    expect(accessory.displayName).toBe(CAMERA_NAME)
    for (const h of handles) await h.dispose()
  })

  it('gives two switches on one accessory DIFFERENT names', async () => {
    // The operator's actual report: two switches, indistinguishable.
    const { accessory } = makeAccessory()
    const handles = [
      await buildPrivacySwitch(makeBctx(accessory, PRIVACY_PROXY, CAMERA_NAME)),
      await buildChildSwitch(
        makeBctx(accessory, SIREN_PROXY, 'Sirena'),
        'child-588',
        DeviceType.Siren,
      ),
    ]

    const names = accessory.services
      .filter((s) => s.UUID === Service.Switch.UUID)
      .map((s) => serviceName(accessory, s.subtype ?? ''))
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(name).not.toBeNull()
    for (const h of handles) await h.dispose()
  })
})
