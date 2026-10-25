/**
 * A persisted row with no configuration is quarantined, not dialled (D376).
 *
 * Device 105 was a shell left behind by a removal: row present, `config: {}`.
 * Its provider dialled it at every boot and failed the same Zod refusal on
 * `host`/`password` — eight times in one day. The retry bound is per PROCESS,
 * and the runner restarts, so "bounded" never bounded anything over time.
 */
import { describe, expect, it, vi } from 'vitest'
import { BaseDeviceProvider } from '../base-device-provider.js'
import type { CreateDeviceSpec, SavedDevice } from '../device-management.js'
import type { PermanentRestoreFailure } from '../device-restore-retry.js'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import type { IDevice } from '../device.js'
import type { DeviceConstructor } from '../device-context.js'
import { DeviceType } from '../device-type.js'

class FakeDevice {
  constructor(readonly stableId: string) {}
}

class TestProvider extends BaseDeviceProvider {
  protected override readonly restoreRetryDelaysMs: readonly number[] = [1, 1, 1]
  protected readonly addonId = 'provider-test'
  protected readonly providerName = 'test'
  protected readonly deviceClasses = {
    [DeviceType.Camera]: FakeDevice as unknown as DeviceConstructor<IDevice>,
  }
  protected async onGetCreationSchema(): Promise<ConfigUISchema | null> {
    return null
  }
  protected async onCreateDevice(): Promise<CreateDeviceSpec> {
    throw new Error('not used')
  }
  awaitRetrySettled(): Promise<void> {
    return this.restoreRetryCompletion ?? Promise.resolve()
  }
  failures(): readonly PermanentRestoreFailure[] {
    return this.permanentRestoreFailures
  }
}

class OptedOutProvider extends TestProvider {
  protected override readonly quarantineConfiglessTopLevelRestores = false
}

interface Harness {
  readonly provider: TestProvider
  readonly created: string[]
  readonly errorLog: ReturnType<typeof vi.fn>
  readonly warnLog: ReturnType<typeof vi.fn>
}

function harness(ProviderClass: typeof TestProvider = TestProvider): Harness {
  const created: string[] = []
  const devices = {
    create: async (stableId: string): Promise<IDevice> => {
      created.push(stableId)
      return new FakeDevice(stableId) as unknown as IDevice
    },
    getAll: async (): Promise<IDevice[]> =>
      created.map((stableId) => new FakeDevice(stableId) as unknown as IDevice),
    decommission: async (): Promise<void> => {},
  }
  const errorLog = vi.fn()
  const warnLog = vi.fn()
  const provider = new ProviderClass({})
  Reflect.set(provider, '_ctx', {
    logger: { debug: () => {}, info: () => {}, warn: warnLog, error: errorLog },
    kernel: { devices },
  })
  return { provider, created, errorLog, warnLog }
}

function row(
  id: number,
  config: Record<string, unknown> | undefined,
  parentDeviceId: number | null = null,
): SavedDevice {
  return {
    id,
    stableId: `cam-${id}`,
    type: DeviceType.Camera,
    name: `cam ${id}`,
    location: null,
    disabled: false,
    parentDeviceId,
    config: config as Record<string, unknown>,
  }
}

describe('a config-less top-level row is quarantined', () => {
  it('is never dialled, is reported once with its deviceId, and is not retried', async () => {
    const h = harness()

    await h.provider.restoreDevices([row(105, {}), row(101, { host: '192.168.10.41' })])
    await h.provider.awaitRetrySettled()

    expect(h.created).toEqual(['cam-101'])
    expect(h.provider.failures().map((f) => f.deviceId)).toEqual([105])
    const quarantineLines = h.errorLog.mock.calls.filter((call) =>
      String(call[0]).includes('NO configuration'),
    )
    expect(quarantineLines).toHaveLength(1)
    expect(quarantineLines[0]?.[1]?.tags?.deviceId).toBe(105)
    // Never handed to the bounded retry — that is what made it perpetual.
    expect(
      h.warnLog.mock.calls.some((call) => String(call[0]).includes('bounded retry scheduled')),
    ).toBe(false)
  })

  it('leaves children alone — an accessory legitimately carries no config', async () => {
    const h = harness()

    await h.provider.restoreDevices([row(101, { host: '192.168.10.41' }), row(616, {}, 101)])
    await h.provider.awaitRetrySettled()

    expect(h.created).toContain('cam-616')
    expect(h.provider.failures()).toEqual([])
  })

  it('never quarantines on an UNFETCHED config — unknown is not empty', async () => {
    const h = harness()

    await h.provider.restoreDevices([row(105, undefined)])
    await h.provider.awaitRetrySettled()

    expect(h.created).toEqual(['cam-105'])
    expect(h.provider.failures()).toEqual([])
  })

  it('can be turned off by a provider whose devices need no configuration', async () => {
    const h = harness(OptedOutProvider)

    await h.provider.restoreDevices([row(105, {})])
    await h.provider.awaitRetrySettled()

    expect(h.created).toEqual(['cam-105'])
  })
})
