import { describe, expect, it } from 'vitest'
import type { DeviceHistorySeriesInfo } from '@camstack/types'
import {
  buildCatalog,
  builtInSelection,
  candidateSearchText,
  readItemOf,
  splitOverlay,
} from '../history-page-model'

const info = (
  key: string,
  over: Partial<DeviceHistorySeriesInfo> = {},
): DeviceHistorySeriesInfo => ({
  key,
  scope: '',
  kind: 'gauge',
  unit: null,
  displayName: key,
  source: 'cap',
  values: null,
  firstTs: 0,
  lastTs: 0,
  ...over,
})

const catalog = buildCatalog(
  [
    {
      device: { id: 1, name: 'Thermostat', location: 'Living room' },
      series: [
        info('cap:climate-control.currentTemp', { unit: '°C' }),
        info('cap:device-status.online', { kind: 'boolean' }),
      ],
    },
    {
      device: { id: 2, name: 'Sensor', location: 'Attic' },
      series: [info('cap:temperature-sensor.temperature', { unit: '°C' })],
    },
    {
      device: { id: 3, name: 'Dishwasher', location: 'Kitchen' },
      series: [info('derived:energy.kwh', { unit: 'kWh', kind: 'counter', source: 'derived' })],
    },
  ],
  [
    {
      node: { id: 'hub', name: 'Hub' },
      series: [
        info('addon:metrics-native/node-memory-percent', { unit: '%', source: 'addon' }),
        info('addon:metrics-native/node-cpu-percent', { unit: '%', source: 'addon' }),
        info('addon:metrics-native/runner-cpu-main-percent', { unit: '%', scope: 'recorder' }),
        info('addon:storage-orchestrator/location-used-percent', { unit: '%', scope: 'rec:ssd' }),
      ],
    },
  ],
  (i) => (i.scope === 'rec:ssd' ? 'Fast SSD' : i.scope),
)

describe('history page catalogue', () => {
  it('searches by device, room, metric and node', () => {
    const thermo = catalog.find((c) => c.info.key === 'cap:climate-control.currentTemp')
    expect(thermo && candidateSearchText(thermo)).toMatch(/Thermostat.*Living room/)
    const ssd = catalog.find((c) => c.info.scope === 'rec:ssd')
    expect(ssd?.metric).toContain('Fast SSD')
  })
})

describe('built-in panels', () => {
  it('Temperatures by room: every room temperature, sorted by room', () => {
    expect(builtInSelection('temperatures', catalog).map((r) => r.subject)).toEqual([
      { kind: 'device', deviceId: 2 },
      { kind: 'device', deviceId: 1 },
    ])
  })

  it('Cluster nodes: CPU then memory per node, never a runner', () => {
    expect(builtInSelection('nodes', catalog).map((r) => r.key)).toEqual([
      'addon:metrics-native/node-cpu-percent',
      'addon:metrics-native/node-memory-percent',
    ])
  })

  it('Total energy and Storage locations pick their one key', () => {
    expect(builtInSelection('energy', catalog).map((r) => r.subject)).toEqual([
      { kind: 'device', deviceId: 3 },
    ])
    expect(builtInSelection('storage', catalog).map((r) => r.scope)).toEqual(['rec:ssd'])
  })
})

describe('splitOverlay', () => {
  it('lines, states and energy each go to their own chart; a vanished series is reported', () => {
    const part = splitOverlay(
      [
        catalog[0]!.ref,
        catalog[1]!.ref,
        catalog[3]!.ref,
        { subject: { kind: 'device', deviceId: 99 }, key: 'cap:x.y', scope: '' },
      ],
      catalog,
    )
    expect(part.lines.map((c) => c.info.key)).toEqual(['cap:climate-control.currentTemp'])
    expect(part.states.map((c) => c.info.key)).toEqual(['cap:device-status.online'])
    expect(part.energy.map((c) => c.info.key)).toEqual(['derived:energy.kwh'])
    expect(part.missing).toHaveLength(1)
  })

  it('reads a node series by forNodeId, never a top-level nodeId (D896)', () => {
    const node = catalog.find((c) => c.ref.subject.kind === 'node')
    expect(node && readItemOf(node.ref)).toEqual({
      forNodeId: 'hub',
      key: node?.info.key,
      scope: node?.info.scope,
    })
  })
})
