import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KlfGatewayClient } from '../klf-gateway-client.js'
import type { VeluxDisconnect, VeluxNode } from '../velux-client-contract.js'
import { FakeKlfGateway, type FakeNode } from './fake-klf-gateway.js'
import { RecordingLogger } from './recording-logger.js'

const PASSWORD = 'correct-horse'
const HALF = 0x6400

const WINDOW: FakeNode = {
  nodeId: 0,
  name: 'Finestra bagno camera',
  actuatorType: 4,
  actuatorSubType: 1,
  serialHex: '0a0b0c0d0e0f1011',
  positionRaw: 0xc800,
}
const SHUTTER: FakeNode = {
  nodeId: 1,
  name: 'Tapparella',
  actuatorType: 2,
  actuatorSubType: 0,
  serialHex: '1a1b1c1d1e1f2021',
  positionRaw: 0,
}
const LIGHT: FakeNode = {
  nodeId: 2,
  name: 'Lamp',
  actuatorType: 6,
  actuatorSubType: 0,
  serialHex: '2a2b2c2d2e2f3031',
  positionRaw: 0,
}

let gateway: FakeKlfGateway
let client: KlfGatewayClient | null = null
let logger: RecordingLogger

async function startGateway(
  nodes: readonly FakeNode[] = [WINDOW, SHUTTER, LIGHT],
  password: string = PASSWORD,
  keepAliveMs?: number,
): Promise<KlfGatewayClient> {
  gateway = new FakeKlfGateway(PASSWORD, nodes)
  const { certPem } = await gateway.start()
  logger = new RecordingLogger()
  client = new KlfGatewayClient({
    host: '127.0.0.1',
    password,
    logger,
    tls: { ca: [certPem], checkServerIdentity: () => undefined },
    rainRefreshMs: 60_000,
    ...(keepAliveMs === undefined ? {} : { keepAliveMs }),
  })
  return client
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeEach(() => {
  client = null
})

afterEach(async () => {
  try {
    await client?.disconnect()
  } finally {
    await gateway.stop()
  }
})

describe('KlfGatewayClient against a scripted gateway', () => {
  it('logs in, reads every node and lists only the covers', async () => {
    const c = await startGateway()
    await c.connect()
    const nodes = c.listNodes()
    expect(nodes.map((n) => n.name)).toEqual(['Finestra bagno camera', 'Tapparella'])
    expect(nodes[0]).toMatchObject({
      nodeId: 0,
      serial: '0a0b0c0d0e0f1011',
      coverClass: 'window',
      position: 0,
      rainSensor: true,
      moving: false,
    })
    expect(nodes[1]).toMatchObject({
      coverClass: 'shutter',
      position: 100,
      rainSensor: false,
    })
  })

  it('refuses a wrong password with a message that never contains it', async () => {
    const secret = 'not-the-password'
    const c = await startGateway([WINDOW], secret)
    const failure = await c.connect().then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(failure).toContain('refused the password')
    expect(failure).not.toContain(secret)
    expect(JSON.stringify(logger.lines)).not.toContain(secret)
  })

  it('dispatches open, close, set-position and stop as wire values (0 = open)', async () => {
    const c = await startGateway()
    await c.connect()
    await c.open(1)
    await c.close(1)
    await c.setPosition(1, 25)
    await c.stop(1)
    expect(gateway.moves).toEqual([
      { nodeIds: [1], mainValueRaw: 0 },
      { nodeIds: [1], mainValueRaw: 0xc800 },
      { nodeIds: [1], mainValueRaw: 38400 },
      { nodeIds: [1], mainValueRaw: 0xd200 },
    ])
  })

  it('rejects a command for a node the gateway does not have', async () => {
    const c = await startGateway()
    await c.connect()
    await expect(c.open(99)).rejects.toThrow(/not available/)
  })

  it('turns a pushed position notification into a node change', async () => {
    const c = await startGateway()
    await c.connect()
    const seen: VeluxNode[] = []
    c.onNodeChanged((n) => seen.push(n))
    gateway.pushPosition(1, HALF, HALF, false)
    await until(() => seen.some((n) => n.nodeId === 1 && n.position === 50))
    expect(c.listNodes().find((n) => n.nodeId === 1)?.position).toBe(50)
  })

  it('reports a node as moving toward its target while the gateway executes', async () => {
    const c = await startGateway()
    await c.connect()
    const seen: VeluxNode[] = []
    c.onNodeChanged((n) => seen.push(n))
    gateway.pushPosition(1, 0x3200, 0xc800, true)
    // The library announces each changed property on its own, so the settled
    // state is the last emission, not the first.
    await until(() => seen.some((n) => n.moving && n.position === 75 && n.targetPosition === 0))
  })

  it('reads rain from the window minimum limitation', async () => {
    const c = await startGateway()
    await c.connect()
    await until(() => c.listNodes()[0]?.raining === false)
    gateway.setLimitationMin(0, 0xc800)
    // a finished movement re-reads the limitation
    gateway.pushPosition(0, 0xc800, 0xc800, false)
    await until(() => c.listNodes()[0]?.raining === true)
  })

  it('reports a session the gateway ended, with a reason, and not one the client closed', async () => {
    const c = await startGateway()
    await c.connect()
    const ended: VeluxDisconnect[] = []
    c.onDisconnected((e) => ended.push(e))
    gateway.dropAll()
    await until(() => ended.length === 1, 9000)
    expect(ended[0]?.reason.length).toBeGreaterThan(0)
    expect(c.listNodes()).toEqual([])
    await expect(c.open(1)).rejects.toThrow(/not available/)
  })

  it('does not report a disconnect when the client itself closes', async () => {
    const c = await startGateway()
    await c.connect()
    const ended: VeluxDisconnect[] = []
    c.onDisconnected((e) => ended.push(e))
    await c.disconnect()
    await new Promise((r) => setTimeout(r, 300))
    expect(ended).toEqual([])
    expect(gateway.openConnections).toBe(0)
  })

  it('keeps the session alive with GW_GET_STATE requests', async () => {
    const c = await startGateway([WINDOW], PASSWORD, 200)
    await c.connect()
    await until(() => gateway.stateRequests.length >= 2)
  })

  it('uses exactly one socket', async () => {
    const c = await startGateway()
    await c.connect()
    expect(gateway.accepted).toBe(1)
  })

  describe('gateway actions', () => {
    it('reads the firmware version the gateway reports', async () => {
      const c = await startGateway()
      gateway.firmware = [0, 2, 0, 0, 71, 0]
      await c.connect()
      expect(await c.readVersion()).toBe('0.2.0.0.71.0')
    })

    it('sends GW_REBOOT_REQ to the gateway on reboot', async () => {
      const c = await startGateway()
      await c.connect()
      await c.reboot()
      expect(gateway.reboots).toBe(1)
    })

    it('refuses version and reboot while no session is up', async () => {
      const c = await startGateway()
      await expect(c.reboot()).rejects.toThrow(/session is down/)
      await expect(c.readVersion()).rejects.toThrow(/session is down/)
    })
  })
})
