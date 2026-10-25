/**
 * Dreame without a live cloud connection (2026-10-21): the container must say
 * its child list is UNKNOWN (so the kernel deletes nothing — it deleted 97
 * accessories when the container answered only its core child), and neither the
 * container nor its children may claim to be online (D62).
 */
import type { Nodreame } from '@apocaliss92/nodedreame'
import {
  type AccessoryChildrenAnswer,
  type AccessoryChildrenRead,
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dreameFacades } from '../dreame-gateway.js'
import { DreameContainerDevice } from '../devices/dreame-container-device.js'
import { DreameSwitchDevice } from '../devices/dreame-switch-device.js'

const BROKER = 'int_0009'
const DID = 'did-1'
const MODEL = 'dreame.vacuum.r2538z'

function ctx(type: DeviceType, config: Record<string, unknown>): DeviceContext {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  let runtimeState: IDeviceRuntimeState | null = null
  const context = {
    id: type === DeviceType.Container ? 100 : 101,
    stableId: `dreame:${DID}:${type}`,
    parentDeviceId: null,
    deviceMeta: {
      type,
      name: 'Robot',
      location: null,
      disabled: false,
      addonId: 'provider-dreame',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeState = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState === undefined || runtimeState === null) return
      runtimeState.installCapSchema(
        cap.name,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- schema handed through by the test double
        cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
      )
    },
    api: {},
    logger,
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- DeviceContext test double
  return context as unknown as DeviceContext
}

const containerConfig = { dreameDeviceId: DID, brokerId: BROKER, model: MODEL, system: 'dreame' }
const childConfig = {
  ...containerConfig,
  siid: 4,
  piid: 1,
  label: 'Child lock',
}

function connect(): void {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- facade test double: only `devices` is read
  dreameFacades.set(BROKER, {
    devices: [{ deviceId: DID, getProperty: () => undefined }],
  } as unknown as Nodreame)
}

/** A plain list cannot say "unknown" or "complete": the container must answer a typed read. */
function typedRead(answer: AccessoryChildrenAnswer): AccessoryChildrenRead {
  if ('kind' in answer) return answer
  throw new Error('expected a typed accessory read, got a plain list')
}

afterEach(() => {
  dreameFacades.clear()
})

describe('dreame container without a cloud connection', () => {
  it('answers its child list as UNKNOWN, still naming the core child to spawn', () => {
    const container = new DreameContainerDevice(ctx(DeviceType.Container, containerConfig))
    const answer = typedRead(container.getAccessoryChildren())
    expect(answer.kind).toBe('unknown')
    if (answer.kind !== 'unknown') return
    expect(answer.known?.map((s) => s.stableIdSuffix)).toEqual(['vacuum'])
  })

  it('answers a COMPLETE list once the cloud device is reachable', () => {
    connect()
    const container = new DreameContainerDevice(ctx(DeviceType.Container, containerConfig))
    const answer = typedRead(container.getAccessoryChildren())
    expect(answer.kind).toBe('complete')
  })
})

describe('dreame online is the live cloud link', () => {
  it('a child built while disconnected is offline, and online when built connected', () => {
    const offline = new DreameSwitchDevice(ctx(DeviceType.Switch, childConfig))
    expect(offline.online).toBe(false)
    connect()
    const online = new DreameSwitchDevice(ctx(DeviceType.Switch, childConfig))
    expect(online.online).toBe(true)
  })

  it('the container is offline while disconnected', () => {
    const container = new DreameContainerDevice(ctx(DeviceType.Container, containerConfig))
    expect(container.online).toBe(false)
  })
})
