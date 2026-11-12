/**
 * The CHILD path: a switch child of a parent device becomes one service on the
 * parent accessory, chosen by the child's type and role (operator decision
 * 2026-11-12: every switch sub-role is exported as its own service).
 *
 * The fakes carry only what the builder reads. `DeviceProxy` and
 * `AddonContext` are codegen'd from every capability in the workspace; a fake
 * carrying all of it would assert nothing these tests assert — that is the
 * documented type boundary the `as unknown as` below stands on.
 */

import type { AddonContext, DeviceProxy } from '@camstack/types'
import { DeviceRole, DeviceType } from '@camstack/types'
import { Accessory, Characteristic, Service, uuid } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import { buildChildServicesFor } from '../child-accessory.js'
import { createHapDecodeMemos } from '../builders/stream-hwaccel-memo.js'
import type { CameraMapperOptions } from '../types.js'

const PARENT_ID = 610
const CHILD_ID = 611

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

interface ChildRow {
  readonly type: string
  readonly role: string | null
}

async function buildWithChild(child: ChildRow, written: boolean[]) {
  const childProxy = {
    deviceId: CHILD_ID,
    switch: {
      getStatus: async () => ({ on: true }),
      setState: async (input: { on: boolean }) => {
        written.push(input.on)
      },
    },
    state: {},
  }
  const ctx = {
    logger: makeLogger(),
    api: {
      deviceManager: {
        getChildren: {
          query: async () => [
            { id: CHILD_ID, name: 'Garage relay', type: child.type, role: child.role },
          ],
        },
      },
    },
    fetchDevice: async () => childProxy as unknown as DeviceProxy,
  } as unknown as AddonContext
  const accessory = new Accessory('Garage', uuid.generate(`camstack:test:${PARENT_ID}`))
  const handle = await buildChildServicesFor({
    parentCtx: {
      ctx,
      accessory,
      proxy: {} as unknown as DeviceProxy,
      numericDeviceId: PARENT_ID,
      displayName: 'Garage',
      options: OPTIONS,
    },
  })
  return { accessory, handle }
}

const ON_OFF_SERVICES = [Service.Switch, Service.Outlet, Service.Fan, Service.Lightbulb]

describe('a switch child on the parent accessory', () => {
  it.each([
    [DeviceRole.Outlet, Service.Outlet],
    [DeviceRole.SwitchLight, Service.Lightbulb],
    [DeviceRole.SwitchFan, Service.Fan],
    // No HomeKit service is a heater with power only: a Switch, no thermostat.
    [DeviceRole.SwitchHeater, Service.Switch],
    [DeviceRole.BinaryHelper, Service.Switch],
    [null, Service.Switch],
  ] as const)('with role %s is its own service, on/off only', async (role, service) => {
    const written: boolean[] = []
    const { accessory, handle } = await buildWithChild({ type: DeviceType.Switch, role }, written)
    const published = accessory.services.find(
      (s) => s.UUID === service.UUID && s.subtype === `child-${CHILD_ID}`,
    )
    expect(published).toBeDefined()
    for (const other of ON_OFF_SERVICES.filter((s) => s.UUID !== service.UUID)) {
      expect(accessory.services.find((s) => s.UUID === other.UUID)).toBeUndefined()
    }
    expect(published?.getCharacteristic(Characteristic.On).value).toBe(true)
    expect(published?.testCharacteristic(Characteristic.Brightness)).toBe(false)
    expect(published?.testCharacteristic(Characteristic.RotationSpeed)).toBe(false)
    await published?.getCharacteristic(Characteristic.On).handleSetRequest(false)
    expect(written).toEqual([false])
    await handle.dispose()
  })

  it('a siren child stays a Switch', async () => {
    const { accessory, handle } = await buildWithChild({ type: DeviceType.Siren, role: null }, [])
    expect(accessory.services.find((s) => s.UUID === Service.Switch.UUID)).toBeDefined()
    await handle.dispose()
  })
})
