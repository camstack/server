import { type DeviceContext, type DeviceType, type IDeviceRuntimeState } from '@camstack/types'

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: unknown
}

export interface TestDeviceCtx {
  readonly ctx: DeviceContext
  /** Providers registered through `registerNativeCap`, by cap name. */
  readonly providers: Map<string, unknown>
  readonly logs: LogLine[]
  readonly emitted: unknown[]
  readonly metadataPatches: Record<string, unknown>[]
  runtimeState(): IDeviceRuntimeState
}

export interface TestDeviceCtxInput {
  readonly id: number
  readonly stableId: string
  readonly type: DeviceType
  readonly name?: string
  readonly parentDeviceId?: number | null
  readonly config: Record<string, unknown>
}

/** A just-enough {@link DeviceContext}: runtime state, native-cap registry, a recording logger. */
export function makeDeviceCtx(input: TestDeviceCtxInput): TestDeviceCtx {
  const providers = new Map<string, unknown>()
  const logs: LogLine[] = []
  const emitted: unknown[] = []
  const metadataPatches: Record<string, unknown>[] = []
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const record =
    (level: LogLine['level']) =>
    (message: string, extras?: unknown): void => {
      logs.push({ level, message, extras })
    }
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  const parentDeviceId = input.parentDeviceId ?? null
  const ctx = {
    id: input.id,
    stableId: input.stableId,
    parentDeviceId,
    deviceMeta: {
      id: input.id,
      stableId: input.stableId,
      addonId: 'bosch-home-connect',
      type: input.type,
      name: input.name ?? 'Test device',
      location: null,
      disabled: false,
      parentDeviceId,
      metadata: null,
    },
    persistedConfig: input.config,
    initialRuntimeState: {},
    eventBus: {
      emit: (event: unknown) => {
        emitted.push(event)
      },
      subscribe: () => () => {},
      getRecent: () => [],
    },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }, provider: unknown) => {
      providers.set(cap.name, provider)
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger,
    api: {
      deviceManager: {
        setMetadata: {
          mutate: async (call: { patch: Record<string, unknown> }) => {
            metadataPatches.push(call.patch)
          },
        },
      },
    },
    fetchDevice: async () => ({ deviceState: { setCapSlice: async () => {} } }),
  } as unknown as DeviceContext
  return {
    ctx,
    providers,
    logs,
    emitted,
    metadataPatches,
    runtimeState: () => {
      if (runtimeStateRef === null) throw new Error('runtime state not bound')
      return runtimeStateRef
    },
  }
}
