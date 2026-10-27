import {
  DeviceType,
  type DeviceContext,
  type IDeviceRuntimeState,
  type IScopedLogger,
} from '@camstack/types'

export interface LogLine {
  readonly level: string
  readonly message: string
  readonly extras: unknown
}

export function captureLogger(lines: LogLine[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string, extras?: unknown): void => {
      lines.push({ level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

export interface FakeCtx {
  readonly ctx: DeviceContext
  /** Providers the device registered, by capability name. */
  readonly providers: Map<string, unknown>
}

/**
 * A minimal device context. The cast is the one documented type boundary of the
 * test suite: the kernel's context is far wider than a device under test reads,
 * and the same boundary is drawn by the sibling provider addons' specs.
 */
export function makeCtx(
  persistedConfig: Record<string, unknown>,
  options: { readonly type?: DeviceType; readonly logs?: LogLine[] } = {},
): FakeCtx {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const providers = new Map<string, unknown>()
  const type = options.type ?? DeviceType.Container
  const ctx = {
    id: 7,
    stableId: 'esp:test:7',
    parentDeviceId: null,
    deviceMeta: {
      id: 7,
      stableId: 'esp:test:7',
      addonId: 'provider-esphome',
      type,
      name: 'Test',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig,
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
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
    logger: captureLogger(options.logs ?? []),
    api: {},
  } as unknown as DeviceContext
  return { ctx, providers }
}
