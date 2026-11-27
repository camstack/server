import { describe, expect, it } from 'vitest'
import type { Z2mConnection } from '../z2m-client.js'
import { Z2mSession, type Z2mSessionSink } from '../z2m-session.js'
import type { Z2mDevice, Z2mState } from '../z2m-protocol.js'
import { bridgeDevicesPayload, bridgeInfoPayload } from './fixtures/z2m-fixtures.js'
import { FakeNet, ManualTimers, recordingLogger } from './fakes.js'

const DOOR = '0x00158d0001a2b3c4'

function harness() {
  const net = new FakeNet()
  const log = {
    connection: [] as Z2mConnection[],
    bridge: [] as Array<boolean | null>,
    tables: [] as Array<readonly string[]>,
    states: [] as Array<{ ieee: string; merged: Z2mState; delta: Z2mState }>,
    availability: [] as Array<{ ieee: string; online: boolean }>,
  }
  const sink: Z2mSessionSink = {
    connection: (s) => log.connection.push(s),
    bridge: (_info, online) => log.bridge.push(online),
    devices: (table: ReadonlyMap<string, Z2mDevice>) => log.tables.push([...table.keys()]),
    state: (ieee, merged, delta) => log.states.push({ ieee, merged, delta }),
    availability: (ieee, online) => log.availability.push({ ieee, online }),
  }
  const session = new Z2mSession({
    integrationId: 'z2m-1',
    endpoint: { host: 'z2m.lan', port: 8080, tls: false, token: null },
    logger: recordingLogger(),
    sink,
    factory: net.factory,
    timers: new ManualTimers(),
  })
  session.start()
  net.last.open()
  return { net, log, session }
}

describe('Z2mSession', () => {
  it('learns the bridge, the device table and the network from what the server pushes on connect', () => {
    const { net, log, session } = harness()
    net.last.push('bridge/state', { state: 'online' })
    net.last.push('bridge/info', bridgeInfoPayload)
    net.last.push('bridge/devices', bridgeDevicesPayload)
    expect(log.bridge.at(-1)).toBe(true)
    expect(session.bridgeInfo?.network?.channel).toBe(15)
    expect(session.bridgeInfo?.network?.pan_id).toBe(6754)
    expect(log.tables.at(-1)).toContain(DOOR)
    expect(session.deviceOf(DOOR)?.friendly_name).toBe('door_front')
  })

  it('merges partial state messages and hands the delta alone to the sink', () => {
    const { net, log } = harness()
    net.last.push('bridge/devices', bridgeDevicesPayload)
    net.last.push('door_front', { contact: true, battery: 90 })
    net.last.push('door_front', { contact: false })
    expect(log.states.at(-1)?.merged).toEqual({ contact: false, battery: 90 })
    expect(log.states.at(-1)?.delta).toEqual({ contact: false })
  })

  it('holds a state that arrives before the table names the device, then delivers it', () => {
    const { net, log } = harness()
    net.last.push('door_front', { contact: true })
    expect(log.states).toHaveLength(0)
    net.last.push('bridge/devices', bridgeDevicesPayload)
    expect(log.states.map((s) => s.ieee)).toEqual([DOOR])
  })

  it('treats the first state after connecting as a replay: its action is not a button press', () => {
    const { net, log } = harness()
    net.last.push('bridge/devices', bridgeDevicesPayload)
    net.last.push('door_front', { action: 'single', battery: 80 })
    net.last.push('door_front', { action: 'double' })
    expect(log.states[0]?.delta).toEqual({ battery: 80 })
    expect(log.states[0]?.merged['action']).toBe('single')
    expect(log.states[1]?.delta).toEqual({ action: 'double' })
  })

  it('keeps the previous table when bridge/devices does not parse (D49)', () => {
    const { net, session } = harness()
    net.last.push('bridge/devices', bridgeDevicesPayload)
    net.last.push('bridge/devices', [{ ieee_address: 5 }])
    expect(session.deviceOf(DOOR)).not.toBeNull()
  })

  it('follows a rename: the command goes to the CURRENT friendly name of the same ieee', () => {
    const { net, session } = harness()
    net.last.push('bridge/devices', bridgeDevicesPayload)
    session.command(DOOR, { state: 'ON' })
    net.last.push(
      'bridge/devices',
      bridgeDevicesPayload.map((d) =>
        d.ieee_address === DOOR ? { ...d, friendly_name: 'door_garden' } : d,
      ),
    )
    session.command(DOOR, { state: 'OFF' })
    expect(net.last.sentEnvelopes().map((e) => e.topic)).toEqual([
      'door_front/set',
      'door_garden/set',
    ])
  })

  it('reads per-device availability, with the legacy bare-string form too', () => {
    const { net, log, session } = harness()
    net.last.push('bridge/devices', bridgeDevicesPayload)
    net.last.push('door_front/availability', { state: 'offline' })
    expect(session.availabilityOf(DOOR)).toBe(false)
    net.last.push('door_front/availability', 'online')
    expect(log.availability.at(-1)).toEqual({ ieee: DOOR, online: true })
  })

  it('refuses a command for a device the server does not list', () => {
    const { session } = harness()
    expect(() => session.command('0xdead', { state: 'ON' })).toThrow('does not list')
  })
})
