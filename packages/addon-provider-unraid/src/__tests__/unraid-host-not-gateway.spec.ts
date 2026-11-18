/**
 * An Unraid server is a Host, never a Gateway (D1064): discovery offers the server as the one
 * `workload` host carrying the WebGUI link, a LAN scan proposes it as a Host to set up, the
 * addon has no Gateway class, and a Gateway row persisted by an older version is retired on
 * restore through the normal removal (tombstone, D865).
 */
import {
  deviceAdminLinkCapability,
  DeviceType,
  type IScopedLogger,
  type SavedDevice,
  workloadCapability,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { UnraidProviderAddon } from '../addon.js'
import { UNRAID_SYSTEM } from '../config.js'
import type { UnraidSnapshot } from '../unraid-client-contract.js'
import { buildUnraidCandidates, UNRAID_INSTANCE_ID } from '../unraid-discovery.js'
import { unraidServerCandidates } from '../unraid-lan-discovery.js'
import { retireLegacyUnraidGatewayRows } from '../unraid-legacy-gateway.js'
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
