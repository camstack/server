/**
 * Discovery proposes each UniFi device with the type the one mapping gives it, and a switch
 * with its PoE ports as port devices under it (#583), named after the client on the port when
 * one is known, else by number (planning#587).
 */
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { UnifiInfraSnapshot } from '../unifi-client-contract.js'
import { buildDiscoveryCandidates } from '../unifi-discovery.js'
import { infraSnapshot, port } from './unifi-fixtures.js'

function infra(over: Partial<UnifiInfraSnapshot> & Pick<UnifiInfraSnapshot, 'id' | 'model'>) {
  return infraSnapshot(over)
}

const CONSOLE = infra({ id: 'udm', model: 'UDM-Pro', kind: 'console' })
const SWITCH = infra({
  id: 'sw1',
  model: 'USW-Lite-8-PoE',
  kind: 'switch',
  ports: [
    port({ idx: 1 }),
    port({ idx: 2, poeOn: false, poeCapable: false }),
    port({ idx: 3, poeOn: false, clientName: 'snapshot-client' }),
  ],
})
const AP = infra({ id: 'ap1', model: 'U6-Pro', kind: 'access-point' })

const BASE = {
  controllerName: 'Home',
  controllerOnline: true,
  infra: [CONSOLE, SWITCH, AP],
  clients: [],
  adopted: new Map<string, number>(),
}

describe('buildDiscoveryCandidates', () => {
  it('proposes each kind with the type the mapping gives it', () => {
    const out = buildDiscoveryCandidates(BASE)
    expect(out.map((c) => [c.childNativeId, c.type])).toEqual([
      ['gateway', DeviceType.Gateway],
      ['infra:udm', DeviceType.Workload],
      ['infra:sw1', DeviceType.Workload],
      ['infra:ap1', DeviceType.Workload],
    ])
    expect(out[0]?.metadata.model).toBe('UDM-Pro')
  })

  it('proposes every PoE port as a device under its switch, named after its client', () => {
    const sw = buildDiscoveryCandidates(BASE).find((c) => c.childNativeId === 'infra:sw1')
    expect(sw?.children?.map((c) => [c.childNativeId, c.type, c.name])).toEqual([
      ['infra:sw1:port-1', DeviceType.Switch, 'Port 1'],
      ['infra:sw1:port-3', DeviceType.Switch, 'snapshot-client (port 3)'],
    ])
    expect(sw?.children?.[0]?.capabilities).toEqual(['power-meter', 'network-link'])
  })

  it('a device without PoE ports proposes no children', () => {
    const ap = buildDiscoveryCandidates(BASE).find((c) => c.childNativeId === 'infra:ap1')
    expect(ap?.children).toBeUndefined()
  })

  it('names a port after its client when the namer hook knows it', () => {
    const sw = buildDiscoveryCandidates({
      ...BASE,
      portClientName: ({ infraId, portIdx }) =>
        infraId === 'sw1' && portIdx === 3 ? 'marker-camera' : null,
    }).find((c) => c.childNativeId === 'infra:sw1')
    expect(sw?.children?.map((c) => c.name)).toEqual(['Port 1', 'marker-camera (port 3)'])
  })
})
