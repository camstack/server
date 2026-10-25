/**
 * The Apple Home direction switches ("Pan Left", "Tilt Up", ...) issue ONE
 * `ptz.move` per press and nothing else.
 *
 * `move` is the PTZ cap's self-terminating burst (`ptz.cap.ts`): the driver
 * runs it for the duration it calibrated and reports as
 * `getOptions().moveImpulseMs` (reolink 200, amcrest 350, hikvision 500, onvif
 * 1000). The exporter used to drive `continuousMove` + its own `ptzPulseMs`
 * timer + `stop` instead — a second authority over the same pulse, and on
 * ONVIF, whose `continuousMove` throws, a switch that never moved the head.
 *
 * The switch is momentary: it must read OFF again once the pulse is over —
 * after `move` resolves when the driver awaits its own pulse (hikvision), or
 * after `moveImpulseMs` when the driver returns at once (reolink, amcrest,
 * onvif).
 */

import type { AddonContext, DeviceProxy } from '@camstack/types'
import { Accessory, Characteristic, uuid } from '@homebridge/hap-nodejs'
import type { Service } from '@homebridge/hap-nodejs'
import { describe, expect, it, vi } from 'vitest'
import type { BuilderContext, BuilderHandle, CameraMapperOptions } from '../../types.js'
import { buildPtz } from '../ptz.js'
import { createHapDecodeMemos } from '../stream-hwaccel-memo.js'

const DEVICE_ID = 107

const OPTIONS: CameraMapperOptions = {
  decodeMemos: createHapDecodeMemos(),
  resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
  hksvClipStore: null,
  hapDeviceSettings: { streamPreference: 'auto' },
}

interface LoggerSpy {
  readonly logger: AddonContext['logger']
  readonly warn: ReturnType<typeof vi.fn>
}

function makeLogger(): LoggerSpy {
  const warn = vi.fn()
  const logger = {
    debug: () => {},
    info: () => {},
    warn,
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  // Documented type boundary: the builder only calls these methods.
  return { logger: logger as unknown as AddonContext['logger'], warn }
}

interface PtzFake {
  readonly move: ReturnType<typeof vi.fn>
  readonly continuousMove: ReturnType<typeof vi.fn>
  readonly stop: ReturnType<typeof vi.fn>
  readonly getOptions: ReturnType<typeof vi.fn>
  readonly getPresets: ReturnType<typeof vi.fn>
  readonly goToPreset: ReturnType<typeof vi.fn>
}

function makePtz(overrides: Partial<PtzFake> = {}): PtzFake {
  return {
    move: vi.fn(async () => undefined),
    continuousMove: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getOptions: vi.fn(async () => ({ moveImpulseMs: 40 })),
    getPresets: vi.fn(async () => []),
    goToPreset: vi.fn(async () => undefined),
    ...overrides,
  }
}

interface Built {
  readonly accessory: Accessory
  readonly handle: BuilderHandle
  readonly warn: ReturnType<typeof vi.fn>
}

async function build(ptz: PtzFake): Promise<Built> {
  const accessory = new Accessory('Camera camera', uuid.generate(`camstack:camera:${DEVICE_ID}`))
  const { logger, warn } = makeLogger()
  const bctx: BuilderContext = {
    // Documented type boundary: the PTZ builder reaches for `logger` only.
    ctx: { logger } as unknown as AddonContext,
    accessory,
    // Documented type boundary: `DeviceProxy` is codegen'd from every
    // capability; the PTZ builder touches `ptz` (and `ptzAutotrack`, absent).
    proxy: { ptz, state: {} } as unknown as DeviceProxy,
    numericDeviceId: DEVICE_ID,
    displayName: 'Camera camera',
    options: OPTIONS,
  }
  return { accessory, handle: await buildPtz(bctx), warn }
}

function serviceBySubtype(accessory: Accessory, subtype: string): Service {
  const service = accessory.services.find((s) => s.subtype === subtype)
  if (service === undefined) throw new Error(`no service ${subtype}`)
  return service
}

function isOn(service: Service): boolean {
  return service.getCharacteristic(Characteristic.On).value === true
}

/** Press the switch the way a controller write does — through the set handler. */
async function press(service: Service): Promise<void> {
  await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
}

describe('HomeKit PTZ direction switches', () => {
  it('a press issues ONE ptz.move with the direction, never continuousMove or stop', async () => {
    const ptz = makePtz()
    const { accessory, handle } = await build(ptz)

    await press(serviceBySubtype(accessory, 'ptz-pan-left'))

    expect(ptz.move).toHaveBeenCalledTimes(1)
    expect(ptz.move).toHaveBeenCalledWith({ pan: -1 })
    expect(ptz.continuousMove).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 80))
    expect(ptz.stop).not.toHaveBeenCalled()
    await handle.dispose()
  })

  it('every direction maps to its own pan/tilt sign', async () => {
    const ptz = makePtz()
    const { accessory, handle } = await build(ptz)

    await press(serviceBySubtype(accessory, 'ptz-pan-right'))
    await press(serviceBySubtype(accessory, 'ptz-tilt-up'))
    await press(serviceBySubtype(accessory, 'ptz-tilt-down'))

    expect(ptz.move.mock.calls.map((c) => c[0])).toEqual([{ pan: 1 }, { tilt: 1 }, { tilt: -1 }])
    await handle.dispose()
  })

  it('resets to OFF once the driver-reported impulse has elapsed when move returns at once', async () => {
    const ptz = makePtz({ getOptions: vi.fn(async () => ({ moveImpulseMs: 60 })) })
    const { accessory, handle } = await build(ptz)
    const service = serviceBySubtype(accessory, 'ptz-tilt-up')

    await press(service)
    // Still ON while the head is (per the driver) still moving.
    expect(isOn(service)).toBe(true)
    await vi.waitFor(() => expect(isOn(service)).toBe(false), { timeout: 500, interval: 5 })
    await handle.dispose()
  })

  it('resets to OFF right after move resolves when the driver awaited its own pulse', async () => {
    // hikvision: `move` sleeps PTZ_MOVE_IMPULSE_MS before resolving, so no
    // further wait is owed once it returns.
    const ptz = makePtz({
      move: vi.fn(() => new Promise<void>((r) => setTimeout(r, 60))),
      getOptions: vi.fn(async () => ({ moveImpulseMs: 60 })),
    })
    const { accessory, handle } = await build(ptz)
    const service = serviceBySubtype(accessory, 'ptz-pan-right')

    await press(service)
    await vi.waitFor(() => expect(isOn(service)).toBe(false), { timeout: 30, interval: 2 })
    await handle.dispose()
  })

  it('still resets when the driver cannot report moveImpulseMs', async () => {
    const ptz = makePtz({ getOptions: vi.fn(async () => ({ moveImpulseMs: null })) })
    const { accessory, handle } = await build(ptz)
    const service = serviceBySubtype(accessory, 'ptz-pan-left')

    await press(service)
    await vi.waitFor(() => expect(isOn(service)).toBe(false), { timeout: 500, interval: 5 })
    await handle.dispose()
  })

  it('a failed move resets the switch and logs a warning', async () => {
    const ptz = makePtz({
      move: vi.fn(async () => {
        throw new Error('camera offline')
      }),
    })
    const { accessory, handle, warn } = await build(ptz)
    const service = serviceBySubtype(accessory, 'ptz-tilt-down')

    await press(service)

    await vi.waitFor(() => expect(isOn(service)).toBe(false), { timeout: 500, interval: 5 })
    expect(warn).toHaveBeenCalledWith(
      'export-hap: ptz.move failed',
      expect.objectContaining({ meta: expect.objectContaining({ dir: 'Tilt Down' }) }),
    )
    await handle.dispose()
  })
})
