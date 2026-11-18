import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device-type.js'
import { build } from './hero-test-kit.js'

const caps = ['workload', 'power-meter']
const RESOURCES = {
  cpuPercent: null,
  memoryUsedBytes: null,
  memoryLimitBytes: null,
  vcpus: null,
  diskUsedBytes: null,
  diskTotalBytes: null,
  netRxKbps: null,
  netTxKbps: null,
  load1: null,
  temperature: null,
}
const status = (state: string | null) => ({
  state,
  since: null,
  hostDeviceId: null,
  image: null,
  os: null,
  version: null,
  autostart: null,
  resources: RESOURCES,
  ports: [],
  addresses: [],
  updateAvailable: null,
  lastFetchedAt: 0,
})
const slices = (state: string | null) => ({
  workload: status(state),
  'power-meter': { deliveredPower: 29.43, lastFetchedAt: 0 },
})

describe('workload hero', () => {
  it('a running host reads on, titled Running, and keeps its delivered-power fact', () => {
    const m = build(DeviceType.Workload, caps, slices('running'))
    expect(m.state).toBe('on')
    expect(m.title.en).toBe('Running')
    expect(m.title.it).toBe('In esecuzione')
    expect(JSON.stringify(m.facts)).toContain('Erogata 29 W')
  })
  it('stopped is off, crashed an alert, a transition running', () => {
    expect(build(DeviceType.Workload, caps, slices('stopped')).state).toBe('off')
    expect(build(DeviceType.Workload, caps, slices('crashed')).state).toBe('alert')
    expect(build(DeviceType.Workload, caps, slices('starting')).title.en).toBe('Starting')
  })
  it('an unknown state stays unknown, never off', () => {
    expect(build(DeviceType.Workload, caps, slices(null)).state).toBe('unknown')
  })
})
