/**
 * Probe-readiness gate on the HAP exporter's per-device fingerprint
 * (`computeExportFingerprint`) + the DeviceReady reconcile trigger.
 *
 * Regression guard for the "re-pairing / re-discovery on every restart" bug:
 * on restart a Reolink camera re-registers with PARTIAL features, then its
 * probe-gated caps (PTZ / intercom) land ~5s later → fingerprint flips
 * partial→full → `reconcileDevice` detaches + re-attaches the accessory (Apple
 * emits a "discovered" notification), then rebuilds AGAIN once the probe lands.
 *
 * The fix: while a device's initial feature-probe has not completed
 * (`device.probed === false`), `computeExportFingerprint` carries the persisted
 * (last-advertised) fingerprint forward so the reconcile sees NO change. These
 * tests drive the real `computeExportFingerprint` through a thin subclass that
 * supplies a fake `ctx.api.deviceManager.getDevice` + `config`, plus the
 * DeviceReady subscription gating.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventCategory } from '@camstack/types'
import type { SystemEvent } from '@camstack/types'
import { canonicalDeviceFingerprint } from '@camstack/types/node'
import { ExportHapAddon } from '../hap-export.addon.js'

type LifecycleHandler = (event: SystemEvent) => void

interface FakeDevice {
  type: string
  features: readonly string[]
  probed: boolean
}

interface FakeConfig {
  exposed: ReadonlyArray<{ deviceId: string; displayName: string; mapperKind: string }>
  exportSyncState: Record<string, { fingerprint: string; externalIds: readonly string[] }>
}

class TestAddon extends ExportHapAddon {
  devices = new Map<number, FakeDevice>()
  fakeConfig: FakeConfig = { exposed: [], exportSyncState: {} }
  reconciled: string[] = []
  private handlers = new Map<EventCategory, LifecycleHandler>()
  private disposers: Array<() => void | Promise<void>> = []

  override get ctx() {
    const logger = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
      withTags: () => logger,
    }
    return {
      api: {
        deviceManager: {
          getDevice: {
            query: async ({ deviceId }: { deviceId: number }) => this.devices.get(deviceId) ?? null,
          },
        },
      },
      logger,
      eventBus: {
        subscribe: (filter: { category: EventCategory }, handler: LifecycleHandler) => {
          this.handlers.set(filter.category, handler)
          return () => this.handlers.delete(filter.category)
        },
      },
      addDisposer: (fn: () => void | Promise<void>) => {
        this.disposers.push(fn)
        return () => {}
      },
    } as unknown as ExportHapAddon['ctx']
  }

  override get config() {
    return this.fakeConfig as unknown as ExportHapAddon['config']
  }

  protected override async reconcileDevice(deviceId: string): Promise<void> {
    this.reconciled.push(deviceId)
  }

  callComputeExportFingerprint(deviceId: number): Promise<string | null> {
    return this.computeExportFingerprint(deviceId)
  }

  armReadySubscription(): void {
    this.subscribeDeviceReadyForReconcile()
  }

  emit(category: EventCategory, deviceId: number): void {
    this.handlers.get(category)?.({ category, data: { deviceId } } as unknown as SystemEvent)
  }

  async runDisposers(): Promise<void> {
    for (const fn of this.disposers) await fn()
  }
}

function exposed(deviceId: number): FakeConfig['exposed'][number] {
  return { deviceId: String(deviceId), displayName: `cam-${deviceId}`, mapperKind: 'camera' }
}

const fp = (type: string, features: readonly string[]): string =>
  canonicalDeviceFingerprint({ deviceId: 0, deviceType: type, features })

/**
 * A camera's fingerprint carries what it CAN record beside its shape — the
 * slot, and whether serving it needs an encoder (D587, D588).
 *
 * These fixtures cannot read profiles at all (the fake device has no
 * `cameraStreams`), and an unreadable profile list is deliberately NOT an
 * answer: it carries the persisted token forward rather than moving the
 * fingerprint, so here the token is absent entirely. Whether HomeKit is
 * RECORDING is not in it — that is HomeKit's own characteristic and it does
 * not change the accessory's shape (D589).
 */
const camFp = (features: readonly string[]): string => fp('camera', features)

let addon: TestAddon

beforeEach(() => {
  addon = new TestAddon()
})

describe('computeExportFingerprint — probe-readiness gate', () => {
  it('un-probed device WITH a persisted entry → carries the persisted fingerprint forward', async () => {
    addon.devices.set(1, { type: 'camera', features: ['motion-trigger'], probed: false })
    const persisted = fp('camera', ['motion-trigger', 'pan-tilt-zoom', 'two-way-audio'])
    addon.fakeConfig = {
      exposed: [exposed(1)],
      exportSyncState: { '1': { fingerprint: persisted, externalIds: ['uuid-1'] } },
    }

    expect(await addon.callComputeExportFingerprint(1)).toBe(persisted)
  })

  it('probed device → returns the FRESH fingerprint (full shape)', async () => {
    const features = ['motion-trigger', 'pan-tilt-zoom']
    addon.devices.set(1, { type: 'camera', features, probed: true })
    const stale = fp('camera', ['motion-trigger'])
    addon.fakeConfig = {
      exposed: [exposed(1)],
      exportSyncState: { '1': { fingerprint: stale, externalIds: ['uuid-1'] } },
    }

    const result = await addon.callComputeExportFingerprint(1)
    expect(result).toBe(camFp(features))
    // Fresh shape differs from the persisted (stale) fingerprint — a genuine
    // change. This assertion only covers the fingerprint itself; the companion
    // "drives reconcileDevice once on a genuine change" test below proves the
    // reconcile path actually rebuilds.
    expect(result).not.toBe(stale)
  })

  it('un-probed device with NO persisted entry → falls back to fresh (publishes once)', async () => {
    addon.devices.set(1, { type: 'camera', features: ['motion-trigger'], probed: false })
    addon.fakeConfig = { exposed: [exposed(1)], exportSyncState: {} }

    expect(await addon.callComputeExportFingerprint(1)).toBe(camFp(['motion-trigger']))
  })

  it('restart of an unchanged-but-un-probed device → fingerprint equals persisted (no rebuild)', async () => {
    // The reconcile compares this against `last.fingerprint` and no-ops when equal.
    addon.devices.set(1, { type: 'camera', features: ['motion-trigger'], probed: false })
    const persisted = fp('camera', ['motion-trigger', 'pan-tilt-zoom'])
    addon.fakeConfig = {
      exposed: [exposed(1)],
      exportSyncState: { '1': { fingerprint: persisted, externalIds: ['uuid-1'] } },
    }

    const current = await addon.callComputeExportFingerprint(1)
    expect(current).toBe(persisted) // last?.fingerprint === current → reconcile no-op
  })
})

describe('DeviceReady subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('triggers the per-device reconcile for an EXPOSED device', () => {
    addon.fakeConfig = { exposed: [exposed(1)], exportSyncState: {} }
    addon.armReadySubscription()

    addon.emit(EventCategory.DeviceReady, 1)
    vi.advanceTimersByTime(499)
    expect(addon.reconciled).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(addon.reconciled).toEqual(['1'])
  })

  it('on a genuine change → drives reconcileDevice exactly once', async () => {
    // Probed device whose FRESH shape (full) differs from its persisted
    // (partial) fingerprint — the genuine-change case. Proves the DeviceReady
    // trigger actually fans into reconcileDevice (the comment on the
    // computeExportFingerprint test only claims the fingerprint differs).
    const features = ['motion-trigger', 'pan-tilt-zoom']
    addon.devices.set(1, { type: 'camera', features, probed: true })
    const stale = fp('camera', ['motion-trigger'])
    addon.fakeConfig = {
      exposed: [exposed(1)],
      exportSyncState: { '1': { fingerprint: stale, externalIds: ['uuid-1'] } },
    }
    addon.armReadySubscription()

    // Sanity: the fresh fingerprint really is a change vs the persisted one.
    expect(await addon.callComputeExportFingerprint(1)).not.toBe(stale)

    addon.emit(EventCategory.DeviceReady, 1)
    vi.advanceTimersByTime(500)
    expect(addon.reconciled).toEqual(['1'])
  })

  it('is IGNORED for a non-exposed device', () => {
    addon.fakeConfig = { exposed: [exposed(1)], exportSyncState: {} }
    addon.armReadySubscription()

    addon.emit(EventCategory.DeviceReady, 999) // not exposed
    vi.advanceTimersByTime(1000)
    expect(addon.reconciled).toHaveLength(0)
  })

  it('disposer unsubscribes — a later DeviceReady does not trigger', async () => {
    addon.fakeConfig = { exposed: [exposed(1)], exportSyncState: {} }
    addon.armReadySubscription()
    await addon.runDisposers()

    addon.emit(EventCategory.DeviceReady, 1)
    vi.advanceTimersByTime(1000)
    expect(addon.reconciled).toHaveLength(0)
  })
})
