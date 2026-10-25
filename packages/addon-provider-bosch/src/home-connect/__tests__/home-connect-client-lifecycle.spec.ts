import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createScriptedHomeConnectWire,
  createSilentHomeConnectWire,
  type ScriptedHomeConnectWire,
  type ScriptedWireScript,
} from '../home-connect-fake-wire.js'
import {
  createHomeConnectWsClient,
  HOME_CONNECT_INFO_PREFIX,
  HOME_CONNECT_NETWORK_PREFIX,
  type HomeConnectLinkState,
} from '../home-connect-ws-client.js'
import { dishwasherCompactJson, FX, HA_ID } from './dishwasher-iddf-fixture.js'

const deviceDescription = dishwasherCompactJson

/** A factory that hands out one scripted wire per call and remembers them. */
function wires(scripts: readonly ScriptedWireScript[]) {
  const made: ScriptedHomeConnectWire[] = []
  return {
    made,
    factory: () => {
      const script = scripts[Math.min(made.length, scripts.length - 1)] ?? {}
      const wire = createScriptedHomeConnectWire(script)
      made.push(wire)
      return wire
    },
  }
}

function makeClient(factory: () => ScriptedHomeConnectWire) {
  const client = createHomeConnectWsClient(
    { host: 'bosch-dw', psk: 'psk', mode: 'TLS', deviceDescription: deviceDescription() },
    {
      wireFactory: factory,
      backoffMs: [100, 200],
      keepaliveMs: 0,
      resolveAddress: async (host) => host,
      random: () => 0.5,
    },
  )
  const links: HomeConnectLinkState[] = []
  client.onLinkChange((_haId, state) => links.push(state))
  return { client, links }
}

afterEach(() => {
  vi.useRealTimers()
})

const RUNNING = { mandatoryValues: [{ uid: FX.operationState, value: 3 }] }

describe('protocol client link lifecycle', () => {
  it('a dropped socket turns every value unknown, is announced, and is re-opened with backoff', async () => {
    vi.useFakeTimers()
    const w = wires([RUNNING, { mandatoryValues: [{ uid: FX.operationState, value: 6 }] }])
    const { client, links } = makeClient(w.factory)
    await client.connect()
    expect(client.getLinkState(HA_ID)).toBe('connected')
    expect(client.getFeatures(HA_ID).get('BSH.Common.Status.OperationState')).toBe('Run')

    w.made[0]?.dropFromAppliance()

    expect(client.getLinkState(HA_ID)).toBe('disconnected')
    expect(client.getFeatures(HA_ID).size).toBe(0)
    expect(links.at(-1)).toBe('disconnected')

    await vi.advanceTimersByTimeAsync(100)

    expect(w.made).toHaveLength(2)
    expect(client.getLinkState(HA_ID)).toBe('connected')
    expect(client.getFeatures(HA_ID).get('BSH.Common.Status.OperationState')).toBe('Finished')
    client.close()
  })

  it('a refused first connect closes what it opened, reports the failure, retries, and recovers', async () => {
    vi.useFakeTimers()
    const w = wires([{ failConnect: true }, RUNNING])
    const { client, links } = makeClient(w.factory)

    await expect(client.connect()).rejects.toThrow(/refused/)
    expect(client.getLinkState(HA_ID)).toBe('disconnected')
    expect(w.made[0]?.open).toBe(false)

    await vi.advanceTimersByTimeAsync(100)

    expect(client.getLinkState(HA_ID)).toBe('connected')
    expect(links).toContain('connected')
    expect(client.getFeatures(HA_ID).get('BSH.Common.Status.OperationState')).toBe('Run')
    client.close()
  })

  it('keeps retrying with a growing, bounded delay while the appliance stays unreachable', async () => {
    vi.useFakeTimers()
    const w = wires([{ failConnect: true }])
    const { client } = makeClient(w.factory)
    await expect(client.connect()).rejects.toThrow()
    expect(w.made).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(100) // attempt 2 after 100 ms
    expect(w.made).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(w.made).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1) // attempt 3 after 200 ms
    expect(w.made).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(200) // the last delay repeats
    expect(w.made).toHaveLength(4)
    client.close()
  })

  it('a connect() that wins the race cancels the pending retry: one session, not two', async () => {
    vi.useFakeTimers()
    const w = wires([{ failConnect: true }, RUNNING])
    const { client } = makeClient(w.factory)
    await expect(client.connect()).rejects.toThrow()
    await client.connect() // the owner retried by hand before the timer fired
    expect(client.getLinkState(HA_ID)).toBe('connected')
    const made = w.made.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(w.made).toHaveLength(made)
    client.close()
  })

  it('close() during the address lookup leaves nothing connected behind', async () => {
    vi.useFakeTimers()
    const w = wires([RUNNING])
    let release: (host: string) => void = () => undefined
    const client = createHomeConnectWsClient(
      { host: 'bosch-dw', psk: 'psk', mode: 'TLS', deviceDescription: deviceDescription() },
      {
        wireFactory: w.factory,
        backoffMs: [100],
        keepaliveMs: 1_000,
        resolveAddress: () => new Promise<string>((resolve) => (release = resolve)),
      },
    )
    const connecting = client.connect().catch(() => undefined)
    client.close()
    release('bosch-dw')
    await connecting
    expect(w.made).toHaveLength(0)
    expect(client.getLinkState(HA_ID)).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('close() during the handshake closes the session that was being built', async () => {
    vi.useFakeTimers()
    const silent = createSilentHomeConnectWire()
    const client = createHomeConnectWsClient(
      { host: 'bosch-dw', psk: 'psk', mode: 'TLS', deviceDescription: deviceDescription() },
      {
        wireFactory: () => silent,
        backoffMs: [100],
        keepaliveMs: 1_000,
        resolveAddress: async (host) => host,
      },
    )
    const connecting = client.connect().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0) // the handshake is now waiting on the appliance
    expect(silent.open).toBe(true)
    client.close()
    await vi.advanceTimersByTimeAsync(50)
    await connecting
    expect(silent.open).toBe(false)
    expect(client.getLinkState(HA_ID)).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retry delays are jittered around the backoff', async () => {
    vi.useFakeTimers()
    const w = wires([{ failConnect: true }])
    const client = createHomeConnectWsClient(
      { host: 'bosch-dw', psk: 'psk', mode: 'TLS', deviceDescription: deviceDescription() },
      {
        wireFactory: w.factory,
        backoffMs: [1000],
        keepaliveMs: 0,
        resolveAddress: async (host) => host,
        random: () => 0, // the low end: -20 %
      },
    )
    await expect(client.connect()).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(799)
    expect(w.made).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(w.made).toHaveLength(2)
    client.close()
  })

  it('close() ends the lifecycle: no timer is left and nothing reconnects', async () => {
    vi.useFakeTimers()
    const w = wires([RUNNING])
    const { client } = makeClient(w.factory)
    await client.connect()
    w.made[0]?.dropFromAppliance()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    client.close()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(w.made).toHaveLength(1)
  })

  it('refuses a write while the link is down instead of acting on stale state', async () => {
    vi.useFakeTimers()
    const w = wires([RUNNING])
    const { client } = makeClient(w.factory)
    await client.connect()
    w.made[0]?.dropFromAppliance()
    await expect(client.setFeature(HA_ID, 'BSH.Common.Setting.ChildLock', true)).rejects.toThrow(
      /not connected/,
    )
    client.close()
  })

  it('publishes /ci/info and /ni/info fields as features, so nothing the appliance sends is lost', async () => {
    const w = wires([
      {
        mandatoryValues: [],
        ciInfo: { vib: 'SMV4HCX48E/01', softwareVersion: '3.1.2' },
        niInfo: { ssid: 'home', rssi: -61 },
      },
    ])
    const { client } = makeClient(w.factory)
    await client.connect()
    const features = client.getFeatures(HA_ID)
    expect(features.get(`${HOME_CONNECT_INFO_PREFIX}vib`)).toBe('SMV4HCX48E/01')
    expect(features.get(`${HOME_CONNECT_INFO_PREFIX}softwareVersion`)).toBe('3.1.2')
    expect(features.get(`${HOME_CONNECT_NETWORK_PREFIX}ssid`)).toBe('home')
    expect(features.get(`${HOME_CONNECT_NETWORK_PREFIX}rssi`)).toBe(-61)
    client.close()
  })

  it('an IDDF that arrives late is swapped in and the values are re-read', async () => {
    const w = wires([{ mandatoryValues: [{ uid: FX.operationState, value: 3 }] }])
    const client = createHomeConnectWsClient(
      {
        host: 'bosch-dw',
        psk: 'psk',
        mode: 'TLS',
        deviceDescription: { info: { deviceID: HA_ID, deviceType: 'Dishwasher', model: 'M' } },
      },
      {
        wireFactory: w.factory,
        backoffMs: [100],
        keepaliveMs: 0,
        resolveAddress: async (host) => host,
      },
    )
    await client.connect()
    expect(client.getDescription(HA_ID)?.state).toBe('missing')
    expect(client.getFeatures(HA_ID).size).toBe(0)

    await client.setDescription(HA_ID, deviceDescription())

    expect(client.getDescription(HA_ID)?.state).toBe('complete')
    expect(client.getFeatures(HA_ID).get('BSH.Common.Status.OperationState')).toBe('Run')
    client.close()
  })
})
