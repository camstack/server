/**
 * An Unraid server is a Host, never a Gateway (D1064): discovery offers the server as the one
 * `workload` host carrying the WebGUI link, a LAN scan proposes it as a Host to set up, the
 * addon has no Gateway class, and a Gateway row persisted by an older version is retired on
 * restore through the normal removal (tombstone, D865).
 */
import {
  type AddonContext,
  deviceAdminLinkCapability,
  DeviceType,
  type IScopedLogger,
  type SavedDevice,
  workloadCapability,
} from '@camstack/types'
import { fakeAddonContext } from '@camstack/types/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnraidProviderAddon } from '../addon.js'
import { UNRAID_SYSTEM } from '../config.js'
import type { UnraidSnapshot } from '../unraid-client-contract.js'
import { buildUnraidCandidates, UNRAID_INSTANCE_ID } from '../unraid-discovery.js'
import { unraidServerCandidates } from '../unraid-lan-discovery.js'
import {
  isLegacyUnraidGatewayRow,
  retireLegacyUnraidGatewayRows,
} from '../unraid-legacy-gateway.js'
import { unraidHostWorkloadStatus } from '../unraid-workload-state.js'

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
class InspectableAddon extends UnraidProviderAddon {
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

describe('Unraid: the server is a Host, there is no Gateway', () => {
  it('discovery offers the server as the workload host with its WebGUI link, and no Gateway', () => {
    const candidates = buildUnraidCandidates({
      server: { name: 'Tower', online: true },
      dockers: [],
      vms: [],
      adopted: new Map(),
    })
    expect(candidates.map((c) => [c.childNativeId, c.type])).toEqual([
      [UNRAID_INSTANCE_ID, DeviceType.Workload],
    ])
    expect(candidates.some((c) => c.type === DeviceType.Gateway)).toBe(false)
    expect(candidates[0]?.capabilities).toEqual(
      expect.arrayContaining([workloadCapability.name, deviceAdminLinkCapability.name]),
    )
  })

  it('a LAN scan proposes the server as a Host to set up as an integration', () => {
    const { candidates } = unraidServerCandidates(
      [{ host: '192.0.2.10', port: 443, https: true }],
      [],
    )
    expect(candidates.map((c) => [c.type, c.setupIntegration])).toEqual([
      [DeviceType.Workload, true],
    ])
  })

  it('the addon has no Gateway device class', () => {
    expect(new InspectableAddon().classes()[DeviceType.Gateway]).toBeUndefined()
  })

  it('the host workload carries the array capacity as its disk', () => {
    const snapshot: UnraidSnapshot = {
      array: {
        state: 'STARTED',
        capacityKb: { total: 1000, used: 400, free: 600 },
        parityCheck: null,
        disks: [],
      },
      cpu: { percent: 12, tempC: 41, powerW: null },
      disks: [],
      dockers: [],
      vms: [],
      notifications: { activeCount: 0, latest: null },
    }
    const status = unraidHostWorkloadStatus({ kind: 'answering', snapshot }, 1_000)
    expect(status.state).toBe('running')
    expect(status.resources.diskUsedBytes).toBe(400 * 1024)
    expect(status.resources.diskTotalBytes).toBe(1000 * 1024)
    expect(status.resources.cpuPercent).toBe(12)
    expect(status.resources.temperature).toBe(41)
  })
})

function stoppedArraySnapshot(capacityKb: UnraidSnapshot['array']['capacityKb']): UnraidSnapshot {
  return {
    array: { state: 'STOPPED', capacityKb, parityCheck: null, disks: [] },
    cpu: { percent: 3, tempC: null, powerW: null },
    disks: [],
    dockers: [],
    vms: [],
    notifications: { activeCount: 0, latest: null },
  }
}

describe('Unraid: an array capacity the server did not report is unknown, never 0 B (D393)', () => {
  it('a missing capacity leaves the host disk unknown', () => {
    const status = unraidHostWorkloadStatus(
      {
        kind: 'answering',
        snapshot: stoppedArraySnapshot({ total: null, used: null, free: null }),
      },
      1_000,
    )
    expect(status.resources.diskUsedBytes).toBeNull()
    expect(status.resources.diskTotalBytes).toBeNull()
  })

  it('a zero total (a stopped array) leaves the host disk unknown', () => {
    const status = unraidHostWorkloadStatus(
      { kind: 'answering', snapshot: stoppedArraySnapshot({ total: 0, used: 0, free: 0 }) },
      1_000,
    )
    expect(status.resources.diskUsedBytes).toBeNull()
    expect(status.resources.diskTotalBytes).toBeNull()
  })
})

describe('Unraid: a Gateway row from an older version is retired on restore', () => {
  it('removes the legacy Gateway row through the removal path and restores the rest', async () => {
    const legacy = saved(1, `unraid:${INT}:gateway`, {
      nativeId: 'gateway',
      integrationId: INT,
      system: UNRAID_SYSTEM,
    })
    const host = saved(2, `unraid:${INT}:instance`, {
      nativeId: UNRAID_INSTANCE_ID,
      instanceId: INT,
      integrationId: INT,
      system: UNRAID_SYSTEM,
    })
    // A container that happens to be NAMED "gateway" is not the legacy row.
    const container = saved(3, `unraid:${INT}:docker:gateway`, {
      nativeId: 'docker:gateway',
      integrationId: INT,
      system: UNRAID_SYSTEM,
    })
    const remove = vi.fn(async (_id: number) => undefined)
    const rest = await retireLegacyUnraidGatewayRows({
      saved: [legacy, host, container],
      remove,
      logger: quiet,
    })
    expect(remove.mock.calls).toEqual([[1]])
    expect(rest.map((r) => r.id)).toEqual([2, 3])
  })

  it('matches an integration id that contains a colon, and never a container named gateway', () => {
    const legacy = saved(1, 'unraid:site:a:gateway', {
      nativeId: 'gateway',
      integrationId: 'site:a',
    })
    const container = saved(2, 'unraid:site:a:docker:gateway', {
      nativeId: 'docker:gateway',
      integrationId: 'site:a',
    })
    expect(isLegacyUnraidGatewayRow(legacy)).toBe(true)
    expect(isLegacyUnraidGatewayRow(container)).toBe(false)
  })

  it('a removal that fails keeps the row out of the restore and is retried next boot', async () => {
    const legacy = saved(1, `unraid:${INT}:gateway`, {
      nativeId: 'gateway',
      integrationId: INT,
    })
    const warn = vi.fn()
    const rest = await retireLegacyUnraidGatewayRows({
      saved: [legacy],
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
class RestorableAddon extends UnraidProviderAddon {
  constructor(private readonly stubCtx: AddonContext) {
    super()
  }
  override get ctx(): AddonContext {
    return this.stubCtx
  }
}

describe('Unraid: the addon retires a legacy Gateway row when it restores its devices', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes the legacy row through the kernel and never dials it; the Host row is restored', async () => {
    vi.useFakeTimers()
    const base = fakeAddonContext({ id: 'provider-unraid' })
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
      ...saved(1, `unraid:${INT}:gateway`, {
        nativeId: 'gateway',
        integrationId: INT,
        system: UNRAID_SYSTEM,
      }),
      type: DeviceType.Gateway,
    }
    const host = saved(2, `unraid:${INT}:instance`, {
      nativeId: UNRAID_INSTANCE_ID,
      integrationId: INT,
      system: UNRAID_SYSTEM,
    })
    await new RestorableAddon(ctx).restoreDevices([legacy, host])
    expect(remove.mock.calls).toEqual([[1]])
    expect(create.mock.calls.map((call) => call[0])).toEqual([host.stableId])
  })
})
