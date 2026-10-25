/**
 * A fake `DeviceContext` for the camstack alarm panel — shared by the specs
 * that drive the REAL `NcAlarmPanelDevice`.
 *
 * The casts live here — three of them, all at the documented test boundary
 * every device spec in this repo uses: the fake `DeviceContext` and the fake
 * `IDeviceRuntimeState` it binds (`as unknown as`: a real one is the kernel's,
 * and building one would test the kernel rather than the panel), and the
 * provider `registerNativeCap` receives, narrowed to the three methods the
 * specs call.
 */

import {
  type AlarmArmMode,
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { vi } from 'vitest'

export const TEST_PANEL_ID = 1023

/** The `alarm-panel` provider the device registers — what a cap call reaches. */
export interface NcTestPanelCap {
  arm(input: { deviceId: number; mode: AlarmArmMode }): Promise<void>
  disarm(input: { deviceId: number }): Promise<void>
  trigger(input: { deviceId: number }): Promise<void>
}

export interface NcTestLogLine {
  readonly level: string
  readonly message: string
  readonly deviceId: number | undefined
  readonly meta: Record<string, unknown> | undefined
}

export interface NcTestPanelContext {
  readonly ctx: DeviceContext
  /** The provider, once the device has registered it. */
  cap(): NcTestPanelCap
}

/**
 * A context whose persisted config is `config` (mutated in place by the
 * device's own writes, so a restart can rebuild from it) and whose logger
 * appends to `logs`.
 */
export function makePanelContext(
  config: Record<string, unknown>,
  logs: NcTestLogLine[],
): NcTestPanelContext {
  let provider: NcTestPanelCap | null = null

  const record =
    (level: string) =>
    (
      message: string,
      ctx?: { tags?: { deviceId?: number }; meta?: Record<string, unknown> },
    ): void => {
      logs.push({ level, message, deviceId: ctx?.tags?.deviceId, meta: ctx?.meta })
    }

  const runtimeState = {
    installCapSchema: vi.fn(),
    setCapState: vi.fn(),
    getCapState: vi.fn(),
    getCapField: vi.fn(),
    patchCapState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeCap: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({})),
    flush: vi.fn(async () => {}),
  } as unknown as IDeviceRuntimeState

  const ctx = {
    id: TEST_PANEL_ID,
    stableId: 'nc:alarm-panel',
    parentDeviceId: null,
    deviceMeta: {
      id: TEST_PANEL_ID,
      stableId: 'nc:alarm-panel',
      type: DeviceType.AlarmPanel,
      name: 'Allarme',
      location: null,
      disabled: false,
      addonId: 'pipeline-analytics',
      metadata: null,
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async (data: unknown) => {
      if (data !== null && typeof data === 'object') Object.assign(config, data)
    }),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: { create: vi.fn(async () => null) },
    bindRuntimeState: vi.fn((rs: IDeviceRuntimeState) => {
      Object.assign(rs, runtimeState)
    }),
    registerNativeCap: vi.fn((_cap: unknown, p: unknown) => {
      provider = p as NcTestPanelCap
    }),
    api: {},
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      child: vi.fn(),
      withTags: vi.fn(() => null),
      addContext: vi.fn(),
      with: vi.fn(),
    },
  } as unknown as DeviceContext

  return {
    ctx,
    cap: () => {
      if (provider === null) throw new Error('the panel registered no alarm-panel provider')
      return provider
    },
  }
}
