import { describe, it, expect, vi } from 'vitest'
import { BaseDeviceProvider } from '../base-device-provider.js'
import type { CreateDeviceSpec, SavedDevice } from '../device-management.js'
import type { PermanentRestoreFailure } from '../device-restore-retry.js'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import type { IDevice } from '../device.js'
import type { DeviceConstructor } from '../device-context.js'
import { DeviceType } from '../device-type.js'

/**
 * A failed device restore is retried, bounded, and — only after the
 * bound — reported as permanently failed where an operator can see it
 * (D347).
 *
 * Before this, `BaseDeviceProvider.onRestoreDevices` warned once and
 * moved on: the device's native caps never registered and every route
 * answered "binding not yet in LocalChildRegistry" for the life of the
 * process (27 cameras, 20 minutes, two manual restarts — 2026-09-04).
 */

class FakeDevice {
  constructor(readonly stableId: string) {}
}

interface FailurePlan {
  /** stableId → how many create() calls fail before succeeding
   *  ('always' = the device never answers). */
  readonly [stableId: string]: number | 'always'
}

interface Harness {
  provider: TestProvider
  createCalls: (stableId: string) => number
  created: () => string[]
  errorLog: ReturnType<typeof vi.fn>
}

class TestProvider extends BaseDeviceProvider {
  protected override readonly restoreRetryDelaysMs: readonly number[] = [1, 1, 1]
  protected override readonly restoreRetryConcurrency: number = 2
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
  shutdown(): Promise<void> {
    return this.onShutdown()
  }
}

class SlowRetryProvider extends TestProvider {
  protected override readonly restoreRetryDelaysMs: readonly number[] = [60, 60, 60]
}

function harness(
  plan: FailurePlan = {},
  ProviderClass: typeof TestProvider = TestProvider,
): Harness {
  const callCounts = new Map<string, number>()
  const created: string[] = []
  const remaining = new Map<string, number | 'always'>(Object.entries(plan))

  const devices = {
    create: async (stableId: string): Promise<IDevice> => {
      callCounts.set(stableId, (callCounts.get(stableId) ?? 0) + 1)
      const left = remaining.get(stableId)
      if (left === 'always') {
        throw new Error('UDS request timed out after 60000ms')
      }
      if (typeof left === 'number' && left > 0) {
        remaining.set(stableId, left - 1)
        throw new Error('UDS request timed out after 60000ms')
      }
      created.push(stableId)
      return new FakeDevice(stableId) as unknown as IDevice
    },
    getAll: async (): Promise<IDevice[]> =>
      created.map((stableId) => new FakeDevice(stableId) as unknown as IDevice),
    decommission: async (): Promise<void> => {},
  }

  const errorLog = vi.fn()
  const provider = new ProviderClass({})
  Reflect.set(provider, '_ctx', {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: errorLog,
    },
    kernel: { devices },
  })
  return {
    provider,
    createCalls: (stableId) => callCounts.get(stableId) ?? 0,
    created: () => [...created],
    errorLog,
  }
}

function row(id: number, parentDeviceId: number | null = null): SavedDevice {
  return {
    id,
    stableId: `cam-${id}`,
    type: DeviceType.Camera,
    name: `cam ${id}`,
    parentDeviceId,
    // A real restore row carries its persisted config — both entry points
    // (`runWorkerDeviceRestoreWithRetry`, `restoreAddonDevices`) read
    // `deviceManager.loadConfig` per row. An EMPTY blob is quarantined as a
    // leftover (D376), so a fixture that leaves it empty tests a device the
    // provider deliberately refuses.
    config: { host: '192.168.10.40' },
  } as unknown as SavedDevice
}

const tick = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('BaseDeviceProvider — a failed restore is retried, bounded, and reported', () => {
  it('a device that lost the boot race comes back on retry — no manual restart needed', async () => {
    const h = harness({ 'cam-1': 1 })
    await h.provider.restoreDevices([row(1), row(2)])
    await h.provider.awaitRetrySettled()

    expect(h.created().toSorted()).toEqual(['cam-1', 'cam-2'])
    expect(h.createCalls('cam-1')).toBe(2)
    expect(h.provider.failures()).toEqual([])
    const status = await h.provider.getStatus()
    expect(status.error).toBeUndefined()
  })

  it('a device that never answers stops being retried after the bound and is VISIBLE: ERROR log with deviceId tag + getStatus().error', async () => {
    const h = harness({ 'cam-1': 'always' })
    await h.provider.restoreDevices([row(1), row(2)])
    await h.provider.awaitRetrySettled()

    // 1 initial + 3 bounded retries — never an infinite loop.
    expect(h.createCalls('cam-1')).toBe(4)
    expect(h.provider.failures()).toHaveLength(1)
    expect(h.provider.failures()[0]).toMatchObject({
      deviceId: 1,
      stableId: 'cam-1',
      attempts: 4,
      lastError: 'UDS request timed out after 60000ms',
    })

    // Per-camera findable in logs (repo rule: tags.deviceId, numeric).
    expect(h.errorLog).toHaveBeenCalledTimes(1)
    const [, extras] = h.errorLog.mock.calls[0] as [string, { tags?: { deviceId?: number } }]
    expect(extras.tags?.deviceId).toBe(1)

    // And visible without reading logs at all.
    const status = await h.provider.getStatus()
    expect(status.error).toContain('1 device(s) permanently failed restore')
    expect(status.error).toContain('deviceIds: 1')
  })

  it("a hub-adopted child deferred by its parent's failure restores once the parent's retry lands", async () => {
    const h = harness({ 'cam-1': 1 })
    await h.provider.restoreDevices([row(1), row(2), row(9, 1)])
    await h.provider.awaitRetrySettled()

    expect(h.created().toSorted()).toEqual(['cam-1', 'cam-2', 'cam-9'])
    expect(h.provider.failures()).toEqual([])
  })

  it('a child whose parent exhausts the bound terminally fails WITH the parent — both reported', async () => {
    const h = harness({ 'cam-1': 'always' })
    await h.provider.restoreDevices([row(1), row(9, 1)])
    await h.provider.awaitRetrySettled()

    const failedIds = h.provider
      .failures()
      .map((f) => f.deviceId)
      .toSorted()
    expect(failedIds).toEqual([1, 9])
    // The child was never blindly created against a missing parent.
    expect(h.created()).toEqual([])
  })

  it('shutdown cancels pending retries and marks nothing failed — the next boot restores from disk', async () => {
    const h = harness({ 'cam-1': 'always' }, SlowRetryProvider)
    await h.provider.restoreDevices([row(1)])
    expect(h.createCalls('cam-1')).toBe(1)

    await h.provider.shutdown()
    // Longer than the first retry delay — a live scheduler would have
    // re-dialled by now.
    await tick(120)

    expect(h.createCalls('cam-1')).toBe(1)
    expect(h.provider.failures()).toEqual([])
  })
})

/**
 * A provider's OWN restore loop (HA / Homematic standalone entities, ONVIF)
 * gets the same bound (D347, D677): a build refused on a runtime-state load
 * that did not answer is retried — never lost until the next runner restart.
 */
class OwnLoopProvider extends TestProvider {
  protected override async onRestoreDevices(saved: readonly SavedDevice[]): Promise<void> {
    await this.restoreWithBoundedRetry(saved, async (row) => {
      await this.ctx.kernel.devices!.create(
        row.stableId,
        FakeDevice as unknown as DeviceConstructor<IDevice>,
        {},
      )
    })
  }
}

class OwnLoopSlowProvider extends OwnLoopProvider {
  protected override readonly restoreRetryDelaysMs: readonly number[] = [60, 60, 60]
}

describe('restoreWithBoundedRetry — a provider-owned restore loop is bounded too (D347, D677)', () => {
  it('a row whose first build is refused comes back on retry', async () => {
    const h = harness({ 'cam-1': 1 }, OwnLoopProvider)
    await h.provider.restoreDevices([row(1), row(2)])
    await h.provider.awaitRetrySettled()

    expect(h.created().toSorted()).toEqual(['cam-1', 'cam-2'])
    expect(h.createCalls('cam-1')).toBe(2)
    expect(h.provider.failures()).toEqual([])
  })

  it('a row that never builds is reported after the bound, tagged with its deviceId', async () => {
    const h = harness({ 'cam-1': 'always' }, OwnLoopProvider)
    await h.provider.restoreDevices([row(1)])
    await h.provider.awaitRetrySettled()

    expect(h.createCalls('cam-1')).toBe(4)
    expect(h.provider.failures().map((f) => f.deviceId)).toEqual([1])
  })

  it('shutdown cancels its retries as well', async () => {
    const h = harness({ 'cam-1': 'always' }, OwnLoopSlowProvider)
    await h.provider.restoreDevices([row(1)])
    await h.provider.shutdown()
    await tick(120)
    expect(h.createCalls('cam-1')).toBe(1)
  })
})

describe('restoreWithBoundedRetry — the D376 quarantine and a shutdown mid-pass (D677 re-review)', () => {
  it('a config-less top-level row is quarantined once — never dialled, never retried (N2)', async () => {
    const h = harness({}, OwnLoopProvider)
    const shell = { ...row(3), config: {} } as SavedDevice
    await h.provider.restoreDevices([shell, row(2)])
    await h.provider.awaitRetrySettled()

    expect(h.createCalls('cam-3')).toBe(0)
    expect(h.created()).toEqual(['cam-2'])
    expect(h.provider.failures()).toMatchObject([
      { deviceId: 3, attempts: 0, lastError: 'persisted row has no configuration' },
    ])
  })

  it('a shutdown during the first pass starts no scheduler afterwards (N5)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    class GatedProvider extends TestProvider {
      protected override async onRestoreDevices(saved: readonly SavedDevice[]): Promise<void> {
        await this.restoreWithBoundedRetry(saved, async (r) => {
          await gate
          await this.ctx.kernel.devices!.create(
            r.stableId,
            FakeDevice as unknown as DeviceConstructor<IDevice>,
            {},
          )
        })
      }
    }
    const h = harness({ 'cam-1': 'always' }, GatedProvider)
    const pass = h.provider.restoreDevices([row(1)])
    await h.provider.shutdown()
    release()
    await pass
    await tick(50) // longer than the whole [1,1,1] retry schedule

    expect(h.createCalls('cam-1')).toBe(1)
    expect(h.provider.failures()).toEqual([])
  })
})
