/**
 * A UniFi console is a Host, never a Gateway (D1064): discovery offers no Gateway, the console
 * is proposed as a workload Host (its restart is the workload's), a LAN scan proposes the console as a Host to
 * set up, the addon has no Gateway class, and a Gateway row persisted by an older version is
 * retired on restore through the normal removal (tombstone, D865).
 */
import {
  type AddonContext,
  deviceAdminLinkCapability,
  DeviceType,
  type IScopedLogger,
  rebootCapability,
  type SavedDevice,
  workloadCapability,
} from '@dominevo/types'
import { fakeAddonContext } from '@dominevo/types/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnifiProviderAddon } from '../addon.js'
import { UNIFI_SYSTEM } from '../config.js'
import { buildDiscoveryCandidates } from '../unifi-discovery.js'
import { unifiConsoleCandidates } from '../unifi-lan-discovery.js'
import { isLegacyUnifiGatewayRow, retireLegacyUnifiGatewayRows } from '../unifi-legacy-gateway.js'
import { infraSnapshot } from './unifi-fixtures.js'

const INT = 'int-1'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

/** Exposes the protected class table; adds nothing. */
class InspectableAddon extends UnifiProviderAddon {
  classes() {
    return this.deviceClasses
  }
}

function saved(id: number, stableId: string, config: Record<string, unknown>): SavedDevice {
  return {
    id,
    stableId,
    type: DeviceType.Workload,
    name: `row-${id}`,
    location: null,
    disabled: false,
    parentDeviceId: null,
    config,
  }
}

describe('UniFi: the console is a Host, there is no Gateway', () => {
  it('discovery offers no Gateway; the console is a workload Host with its admin link', () => {
    const out = buildDiscoveryCandidates({
      controllerName: 'Home',
      controllerOnline: true,
      infra: [
        infraSnapshot({ id: 'udm', model: 'UDM-Pro', kind: 'console' }),
        infraSnapshot({ id: 'sw1', model: 'USW-Lite-8-PoE', kind: 'switch' }),
      ],
      clients: [],
      adopted: new Map(),
    })
    expect(out.map((c) => [c.childNativeId, c.type])).toEqual([
      ['infra:udm', DeviceType.Workload],
      ['infra:sw1', DeviceType.Workload],
    ])
    expect(out.some((c) => c.type === DeviceType.Gateway)).toBe(false)
    expect(out[0]?.capabilities).toEqual(
      expect.arrayContaining([workloadCapability.name, deviceAdminLinkCapability.name]),
    )
    // The console restarts through its workload: no separate reboot capability.
    expect(out[0]?.capabilities ?? []).not.toContain(rebootCapability.name)
    // A switch is not the Host: no console hints (it restarts through its own workload).
    expect(out[1]?.capabilities).toBeUndefined()
  })

  it('a LAN scan proposes the console as a Host to set up as an integration', () => {
    const { candidates } = unifiConsoleCandidates([{ host: '192.0.2.1', name: 'UDM' }], [])
    expect(candidates.map((c) => [c.type, c.setupIntegration])).toEqual([
      [DeviceType.Workload, true],
    ])
  })

  it('the addon has no Gateway device class', () => {
    expect(new InspectableAddon().classes()[DeviceType.Gateway]).toBeUndefined()
  })
})

describe('UniFi: a Gateway row from an older version is retired on restore', () => {
  it('removes the legacy Gateway row through the removal path and restores the rest', async () => {
    const legacy = saved(1, `unifi:${INT}:gateway`, {
      nativeId: 'gateway',
      integrationId: INT,
      system: UNIFI_SYSTEM,
    })
    const host = saved(2, `unifi:${INT}:infra:udm`, {
      integrationId: INT,
      infraNativeId: 'udm',
      system: UNIFI_SYSTEM,
    })
    const remove = vi.fn(async (_id: number) => undefined)
    const rest = await retireLegacyUnifiGatewayRows({
      saved: [legacy, host],
      remove,
      logger: quiet,
    })
    expect(remove.mock.calls).toEqual([[1]])
    expect(rest.map((r) => r.id)).toEqual([2])
  })

  it('matches an integration id that contains a colon, and never an infra device', () => {
    expect(
      isLegacyUnifiGatewayRow(
        saved(1, 'unifi:site:a:gateway', { nativeId: 'gateway', integrationId: 'site:a' }),
      ),
    ).toBe(true)
    expect(
      isLegacyUnifiGatewayRow(
        saved(2, 'unifi:site:a:infra:gateway', {
          infraNativeId: 'gateway',
          integrationId: 'site:a',
        }),
      ),
    ).toBe(false)
  })

  it('a removal that fails keeps the row out of the restore and says so per device', async () => {
    const warn = vi.fn()
    const rest = await retireLegacyUnifiGatewayRows({
      saved: [
        saved(1, `unifi:${INT}:gateway`, {
          nativeId: 'gateway',
          integrationId: INT,
        }),
      ],
      remove: async () => {
        throw new Error('registry down')
      },
      logger: { ...quiet, warn },
    })
    expect(rest).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: 1 } }),
    )
  })
})

/** The addon with a stub context in place of `initialize()`; adds nothing else. */
class RestorableAddon extends UnifiProviderAddon {
  constructor(private readonly stubCtx: AddonContext) {
    super()
  }
  override get ctx(): AddonContext {
    return this.stubCtx
  }
}

describe('UniFi: the addon retires a legacy Gateway row when it restores its devices', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes the legacy row through the kernel and never dials it; the Host row is restored', async () => {
    vi.useFakeTimers()
    const base = fakeAddonContext({ id: 'provider-unifi' })
    const kernelDevices = base.kernel.devices
    if (kernelDevices === undefined) throw new Error('fake context has kernel devices')
    const remove = vi.fn(async (_id: number) => undefined)
    const create = vi.fn(async (stableId: string): Promise<never> => {
      throw new Error(`stub create ${stableId}`)
    })
    const ctx: AddonContext = {
      ...base,
      kernel: {
        ...base.kernel,
        devices: { ...kernelDevices, remove, create, getAll: async () => [] },
      },
    }
    const legacy = {
      ...saved(1, `unifi:${INT}:gateway`, {
        nativeId: 'gateway',
        integrationId: INT,
        system: UNIFI_SYSTEM,
      }),
      type: DeviceType.Gateway,
    }
    const host = saved(2, `unifi:${INT}:infra:udm`, {
      integrationId: INT,
      infraNativeId: 'udm',
      model: 'UDM-Pro',
      system: UNIFI_SYSTEM,
    })
    await new RestorableAddon(ctx).restoreDevices([legacy, host])
    expect(remove.mock.calls).toEqual([[1]])
    expect(create.mock.calls.map((call) => call[0])).toEqual([host.stableId])
  })
})
