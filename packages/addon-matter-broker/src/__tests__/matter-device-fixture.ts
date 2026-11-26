/**
 * Test fixture: a MatterEndpointDevice over a recording DeviceContext. The
 * context is a structural fake at the kernel boundary (the same shape the
 * climate spec uses), so the casts live here and nowhere in the product code.
 */
import { DeviceType, type DeviceContext, type IDeviceRuntimeState } from '@camstack/types'
import { MatterEndpointDevice } from '../devices/matter-endpoint-device.js'

export const FIXTURE_DEVICE_ID = 42

/** What the fake bus keeps of an emitted event. */
export interface EmittedEvent {
  readonly category: string
  readonly data: unknown
}

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly tags: unknown
}

export interface DeviceFixture {
  readonly device: MatterEndpointDevice
  readonly emitted: EmittedEvent[]
  readonly logs: LogLine[]
  readonly caps: string[]
  /** The native provider registered per cap name. */
  readonly providers: Map<string, object>
}

export interface FixtureOptions {
  readonly type: DeviceType
  readonly capabilities: readonly string[]
  readonly deviceTypeIds?: readonly number[]
  readonly endpointId?: number
  /** Extra persisted endpoint config (lockUnbolting, powerSourceEndpointId …). */
  readonly extraConfig?: Record<string, unknown>
}

export async function activeEndpoint(options: FixtureOptions): Promise<DeviceFixture> {
  const emitted: EmittedEvent[] = []
  const logs: LogLine[] = []
  const caps: string[] = []
  const providers = new Map<string, object>()
  let runtime: IDeviceRuntimeState | null = null
  const line =
    (level: LogLine['level']) =>
    (message: string, ctx?: { tags?: unknown }): void => {
      logs.push({ level, message, tags: ctx?.tags })
    }
  const logger = {
    debug: line('debug'),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
    child() {
      return logger
    },
    withTags() {
      return logger
    },
  }
  const ctx = {
    id: FIXTURE_DEVICE_ID,
    stableId: 'matter:b1:1:1',
    parentDeviceId: null,
    deviceMeta: {
      id: FIXTURE_DEVICE_ID,
      stableId: 'matter:b1:1:1',
      addonId: 'matter-broker',
      type: options.type,
      name: 'fixture',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'b1',
      nodeId: '1',
      endpointId: options.endpointId ?? 1,
      deviceTypeIds: options.deviceTypeIds ?? [],
      capabilities: options.capabilities,
      ...options.extraConfig,
    },
    initialRuntimeState: {},
    eventBus: {
      emit: (event: EmittedEvent) => {
        emitted.push(event)
      },
      subscribe: () => () => {},
      getRecent: () => [],
    },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }, provider: object) => {
      caps.push(cap.name)
      providers.set(cap.name, provider)
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger,
    api: { deviceState: { getCapSlice: { query: async () => null } } },
  } as unknown as DeviceContext
  const device = new MatterEndpointDevice(ctx)
  await device.onActivate()
  return { device, emitted, logs, caps, providers }
}
