import { describe, expect, it } from 'vitest'
import { Z2mHub } from '../z2m-hub.js'
import { meshProviderFor } from '../z2m-mesh.js'
import { bridgeDevicesPayload, bridgeInfoPayload, networkMapData } from './fixtures/z2m-fixtures.js'
import { FakeNet, ManualTimers, recordingLogger } from './fakes.js'

const COORD = '0x00124b0000000000'
const DOOR = '0x00158d0001a2b3c4'
const WEATHER = '0x00158d0002d4e5f6'
const PLUG = '0x00158d0003aaaaaa'

function harness() {
  const net = new FakeNet()
  const hub = new Z2mHub()
  hub.connect(
    'z2m-1',
    { host: 'z2m.lan', port: 8080, tls: false, token: null },
    recordingLogger(),
    {
      factory: net.factory,
      timers: new ManualTimers(),
    },
  )
  net.last.open()
  net.last.push('bridge/info', bridgeInfoPayload)
  net.last.push('bridge/devices', [
    ...bridgeDevicesPayload,
    {
      ieee_address: PLUG,
      type: 'Router',
      friendly_name: 'plug_hall',
      supported: true,
      power_source: 'Mains (single phase)',
      definition: { model: 'TS011F', vendor: 'Tuya', description: 'Plug', exposes: [] },
    },
  ])
  hub.bindDevice('z2m-1', COORD, 1)
  hub.bindDevice('z2m-1', DOOR, 2)
  hub.bindDevice('z2m-1', WEATHER, 3)
  hub.bindDevice('z2m-1', PLUG, 4)
  const mesh = meshProviderFor(hub, 'z2m-1', () => 1_000)
  const answerScan = (): void => {
    const sent = net.last.sentEnvelopes().filter((e) => e.topic === 'bridge/request/networkmap')
    const last = sent[sent.length - 1]
    net.last.push('bridge/response/networkmap', {
      data: networkMapData,
      status: 'ok',
      transaction: last?.payload['transaction'],
    })
  }
  const scans = (): number =>
    net.last.sentEnvelopes().filter((e) => e.topic === 'bridge/request/networkmap').length
  return { net, hub, mesh, answerScan, scans }
}

describe('device-mesh over Zigbee2MQTT', () => {
  it('answers from the device table without scanning: no map yet, no links, readAt null', async () => {
    const h = harness()
    const topology = await h.mesh.getTopology({ deviceId: 1 })
    expect(h.scans()).toBe(0)
    expect(topology.readAt).toBeNull()
    expect(topology.network).toBeNull()
    expect(topology.links).toEqual([])
    const door = topology.nodes.find((n) => n.nodeKey === DOOR)
    expect(door).toMatchObject({
      deviceId: 2,
      role: 'sleepy-end-device',
      power: 'battery',
      transport: 'zigbee',
    })
    expect(topology.nodes.find((n) => n.nodeKey === COORD)).toMatchObject({
      role: 'coordinator',
      deviceId: 1,
    })
    expect(topology.nodes.find((n) => n.nodeKey === PLUG)).toMatchObject({
      role: 'router',
      power: 'mains',
    })
  })

  it('refresh scans once, counts routers read, failures and the end devices it never queried', async () => {
    const h = harness()
    const pending = h.mesh.refresh({ deviceId: 1 })
    expect(h.scans()).toBe(1)
    h.answerScan()
    await expect(pending).resolves.toEqual({ readNodes: 2, failedNodes: 0, skippedNodes: 2 })
    const topology = await h.mesh.getTopology({ deviceId: 1 })
    expect(topology.readAt).toBe(1_000)
    expect(topology.links).toHaveLength(3)
    expect(topology.links.find((l) => l.from === WEATHER)).toMatchObject({ kind: 'route', lqi: 60 })
    expect(topology.links.find((l) => l.from === DOOR)).toMatchObject({
      kind: 'neighbor',
      lqi: 120,
    })
    expect(topology.nodes.find((n) => n.nodeKey === PLUG)?.lqi).toBe(120)
  })

  it('joins a scan already in flight instead of starting a second one', async () => {
    const h = harness()
    const a = h.mesh.refresh({ deviceId: 1 })
    const b = h.mesh.readNow({ deviceId: 2 })
    expect(h.scans()).toBe(1)
    h.answerScan()
    await a
    expect((await b).readOk).toBe(true)
  })

  it('readNow reports a failed scan without throwing, and keeps the held diagnostics', async () => {
    const h = harness()
    const pending = h.mesh.readNow({ deviceId: 2 })
    const sent = h.net.last.sentEnvelopes().find((e) => e.topic === 'bridge/request/networkmap')
    h.net.last.push('bridge/response/networkmap', {
      data: {},
      status: 'error',
      error: 'busy',
      transaction: sent?.payload['transaction'],
    })
    const result = await pending
    expect(result.readOk).toBe(false)
    expect(result.error).toContain('busy')
    expect(result.diagnostics.vendor).toBe('Aqara')
  })

  it('diagnostics name the product and carry a node the scan could not read as a fault', async () => {
    const h = harness()
    const pending = h.mesh.refresh({ deviceId: 1 })
    h.answerScan()
    await pending
    const diagnostics = await h.mesh.getNodeDiagnostics({ deviceId: 3 })
    expect(diagnostics).toMatchObject({
      vendor: 'Aqara',
      product: 'WSDCGQ11LM',
      networkFaults: ['lqi'],
      wifi: null,
    })
    await expect(h.mesh.getNodeDiagnostics({ deviceId: 99 })).rejects.toThrow(
      /not a Zigbee2MQTT node/,
    )
  })
})
