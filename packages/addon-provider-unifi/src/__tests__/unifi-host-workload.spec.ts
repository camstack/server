import { type IScopedLogger, WorkloadStatusSchema, deriveWorkloadControls } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsToConnection } from '../config.js'
import type { UnifiControllerClient } from '../unifi-client-contract.js'
import {
  UNIFI_HOST_WORKLOAD_OPTIONS,
  UNIFI_HOST_WORKLOAD_UNKNOWN,
  unifiHostWorkloadStatus,
} from '../unifi-host-workload.js'
import { UnifiIntegrationManager } from '../unifi-integration-manager.js'
import { UnifiControllerResolver } from '../unifi-node-resolver.js'
import { infraSnapshot } from './unifi-fixtures.js'

const NOW = 1_000_000

describe('unifiHostWorkloadStatus — a console, switch or AP as a workload host', () => {
  it('an online device is running since its uptime, with its CPU and temperature', () => {
    const status = unifiHostWorkloadStatus(
      infraSnapshot({ id: 'sw1', cpuPercent: 7, cpuTempC: 41, uptimeSec: 100 }),
      NOW,
    )
    expect(status.state).toBe('running')
    expect(status.since).toBe(NOW - 100_000)
    expect(status.resources.cpuPercent).toBe(7)
    expect(status.resources.temperature).toBe(41)
    expect(WorkloadStatusSchema.parse(status)).toEqual(status)
  })

  it('what the controller does not report is null, never 0 (D393)', () => {
    const status = unifiHostWorkloadStatus(infraSnapshot({ id: 'ap1' }), NOW)
    expect(status.since).toBeNull()
    expect(status.resources.cpuPercent).toBeNull()
    expect(status.resources.temperature).toBeNull()
    expect(status.resources.memoryUsedBytes).toBeNull()
    expect(status.hostDeviceId).toBeNull()
  })

  it('an offline device is stopped with no uptime; a device mid-adoption is unknown', () => {
    const offline = unifiHostWorkloadStatus(
      infraSnapshot({ id: 'sw1', online: false, state: 'offline', uptimeSec: 100 }),
      NOW,
    )
    expect(offline.state).toBe('stopped')
    expect(offline.since).toBeNull()
    expect(
      unifiHostWorkloadStatus(infraSnapshot({ id: 'sw1', state: 'adopting' }), NOW).state,
    ).toBeNull()
    expect(
      unifiHostWorkloadStatus(infraSnapshot({ id: 'sw1', state: 'upgrading' }), NOW).state,
    ).toBe('starting')
  })
})

describe('UNIFI_HOST_WORKLOAD_OPTIONS — no fake controls', () => {
  it('declares resources only, so the derived UI shows no start / stop / pause', () => {
    expect(UNIFI_HOST_WORKLOAD_OPTIONS.hasResources).toBe(true)
    const derived = deriveWorkloadControls(UNIFI_HOST_WORKLOAD_OPTIONS, 'running')
    expect(derived.controls).toEqual([])
    expect(derived.sections.resources).toBe(true)
  })
})

describe('a controller that stops answering (D315)', () => {
  const quiet: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => quiet,
    withTags: () => quiet,
  }

  it('a failed read leaves the host unknown, never the last "running"', async () => {
    let reachable = true
    const client: UnifiControllerClient = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      listInfraDevices: async () => {
        if (!reachable) throw new Error('connect ECONNREFUSED')
        return [infraSnapshot({ id: 'sw1', uptimeSec: 100 })]
      },
      listClients: async () => [],
      getInfraDevice: () => null,
      getClient: () => null,
      setPortPoe: async () => undefined,
      restartDevice: async () => undefined,
      powerCyclePort: async () => undefined,
      setLed: async () => undefined,
      degradedError: () => null,
      onLiveChange: () => () => undefined,
    }
    const manager = new UnifiIntegrationManager({
      id: 'u1',
      name: 'UniFi',
      connection: settingsToConnection({ host: 'console.example', apiKey: 'k' }),
      logger: quiet,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
      makeClient: () => client,
    })
    const resolver = new UnifiControllerResolver()
    resolver.set('u1', manager)
    await manager.start()
    const before = unifiHostWorkloadStatus(resolver.getLiveInfra('u1', 'sw1'), NOW)
    expect(before.state).toBe('running')

    reachable = false
    await manager.poll()
    const after = unifiHostWorkloadStatus(resolver.getLiveInfra('u1', 'sw1'), NOW + 5_000, before)
    expect(after.state).toBeNull()
    expect(after.since).toBeNull()
    await manager.stop()
  })

  it('no snapshot at all is unknown', () => {
    expect(unifiHostWorkloadStatus(null, NOW).state).toBeNull()
  })
})

describe('since does not drift between polls', () => {
  it('the same boot read a poll later keeps its since; a reset uptime moves it', () => {
    const first = unifiHostWorkloadStatus(infraSnapshot({ id: 'sw1', uptimeSec: 100 }), NOW)
    // 30 s later the controller reports 129 s (its uptime lags by a second): same boot.
    const second = unifiHostWorkloadStatus(
      infraSnapshot({ id: 'sw1', uptimeSec: 129 }),
      NOW + 30_000,
      first,
    )
    expect(second.since).toBe(first.since)
    // The device rebooted: uptime starts again.
    const rebooted = unifiHostWorkloadStatus(
      infraSnapshot({ id: 'sw1', uptimeSec: 5 }),
      NOW + 600_000,
      second,
    )
    expect(rebooted.since).toBe(NOW + 595_000)
  })

  it('the unknown seed is the starting point', () => {
    expect(UNIFI_HOST_WORKLOAD_UNKNOWN.state).toBeNull()
  })
})
