/**
 * planning#580: a Camera grid / Terminal camera block is DECLARED by the
 * composer (`composed-<blockId>`) and SERVED by an engine. The composer's
 * device on that row registers nothing and never writes `device-status`:
 * the engine is that slice's only writer.
 */
import {
  type CapabilityDefinition,
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { isComposedDevice } from '../composed-device.js'
import { declarationFor, shapeOf } from '../composition-declarations.js'

const HOSTED = {
  blockId: 'g1',
  name: 'Driveway grid',
  target: { kind: 'new', type: DeviceType.Camera },
  caps: [],
  hosted: true,
} as const

interface FakeContext {
  readonly ctx: DeviceContext
  readonly registered: string[]
  readonly writes: string[]
}

/** The members `BaseDevice` reaches at construction; a structural double narrowed at this one boundary. */
function fakeContext(id: number, stableId: string): FakeContext {
  const registered: string[] = []
  const writes: string[] = []
  let state: IDeviceRuntimeState | null = null
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  const surface = {
    id,
    stableId,
    parentDeviceId: null,
    persistedConfig: {},
    persistConfig: vi.fn().mockResolvedValue(undefined),
    logger,
    eventBus: { emit: vi.fn(), subscribe: vi.fn() },
    deviceMeta: {
      id,
      stableId,
      addonId: 'composer',
      type: DeviceType.Camera,
      name: 'Driveway grid',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    fetchDevice: vi.fn().mockResolvedValue({
      deviceState: {
        setCapSlice: vi.fn(async (input: { capName: string }) => {
          writes.push(input.capName)
        }),
      },
    }),
    bindRuntimeState: (s: IDeviceRuntimeState) => {
      state = s
    },
    registerNativeCap: (cap: CapabilityDefinition) => {
      registered.push(cap.name)
      if (cap.runtimeState && state) state.installCapSchema(cap.name, cap.runtimeState)
    },
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: a documented type boundary
  return { ctx: surface as unknown as DeviceContext, registered, writes }
}

describe('an engine-hosted block (grid, terminal)', () => {
  it('declares composed-<blockId> as a Camera', () => {
    expect(declarationFor(HOSTED)).toMatchObject({
      stableId: 'composed-g1',
      name: 'Driveway grid',
      type: DeviceType.Camera,
    })
  })

  it('its device registers no device-status and never writes it, not even on setAvailable', async () => {
    const f = fakeContext(4581, 'composed-g1')
    const device = new (declarationFor(HOSTED).DeviceClass)(f.ctx)
    expect(isComposedDevice(device)).toBe(true)
    if (!isComposedDevice(device)) return
    device.setAvailable(false)
    device.setAvailable(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.registered).not.toContain('device-status')
    expect(f.writes).not.toContain('device-status')
  })

  it('a non-hosted block still writes its own device-status (the double above is live)', async () => {
    const f = fakeContext(901, 'composed-b1')
    const device = new (declarationFor({ ...HOSTED, hosted: false }).DeviceClass)(f.ctx)
    if (isComposedDevice(device)) device.setAvailable(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.registered).toContain('device-status')
    expect(f.writes).toContain('device-status')
  })

  it('hosted is part of the shape: flipping it rebuilds the device', () => {
    expect(shapeOf(HOSTED)).not.toBe(shapeOf({ ...HOSTED, hosted: false }))
  })
})
