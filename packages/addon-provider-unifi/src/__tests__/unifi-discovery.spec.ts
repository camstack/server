/**
 * Discovery proposes each UniFi device with the type the one mapping gives it, and a switch
 * with its PoE ports as switches under it, named by port number unless a client namer (#583)
 * knows what is plugged in (planning#587).
 */
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { UnifiInfraSnapshot } from '../unifi-client-contract.js'
import { buildDiscoveryCandidates } from '../unifi-discovery.js'

function infra(over: Partial<UnifiInfraSnapshot> & Pick<UnifiInfraSnapshot, 'id' | 'model'>) {
  const base: UnifiInfraSnapshot = {
    id: over.id,
    name: over.id,
    model: over.model,
    kind: 'other',
    cpuPercent: null,
    cpuTempC: null,
    clients: 0,
    state: 'online',
    uptimeSec: null,
    ports: [],
    ledOn: false,
    online: true,
  }
  return { ...base, ...over }
}

const CONSOLE = infra({ id: 'udm', model: 'UDM-Pro', kind: 'console' })
const SWITCH = infra({
  id: 'sw1',
  model: 'USW-Lite-8-PoE',
  kind: 'switch',
  ports: [
    { idx: 1, poeOn: true, poeCapable: true },
    { idx: 2, poeOn: false, poeCapable: false },
    { idx: 3, poeOn: false, poeCapable: true },
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
      ['infra:udm', DeviceType.Container],
      ['infra:sw1', DeviceType.Container],
      ['infra:ap1', DeviceType.Container],
    ])
    expect(out[0]?.metadata.model).toBe('UDM-Pro')
  })

  it('proposes every PoE port as a switch under its switch, named by port number', () => {
    const sw = buildDiscoveryCandidates(BASE).find((c) => c.childNativeId === 'infra:sw1')
    expect(sw?.children?.map((c) => [c.childNativeId, c.type, c.name])).toEqual([
      ['infra:sw1:poe-1', DeviceType.Switch, 'Port 1 PoE'],
      ['infra:sw1:poe-3', DeviceType.Switch, 'Port 3 PoE'],
    ])
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
    expect(sw?.children?.map((c) => c.name)).toEqual(['Port 1 PoE', 'marker-camera (port 3)'])
  })
})
