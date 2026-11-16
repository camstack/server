import { WorkloadStatusSchema, deriveWorkloadControls } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { UNIFI_HOST_WORKLOAD_OPTIONS, unifiHostWorkloadStatus } from '../unifi-host-workload.js'
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
