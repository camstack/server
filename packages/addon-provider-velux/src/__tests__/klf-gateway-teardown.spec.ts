import { Connection } from 'klf-200-api'
import { afterEach, describe, expect, it } from 'vitest'
import { KlfGatewayClient } from '../klf-gateway-client.js'
import { FakeKlfGateway, type FakeNode } from './fake-klf-gateway.js'
import { RecordingLogger } from './recording-logger.js'

const PASSWORD = 'correct-horse'

function windowNode(nodeId: number): FakeNode {
  return {
    nodeId,
    name: `Window ${nodeId}`,
    actuatorType: 4,
    actuatorSubType: 1,
    serialHex: `0a0b0c0d0e0f10${nodeId.toString(16).padStart(2, '0')}`,
    positionRaw: 0xc800,
  }
}

let gateway: FakeKlfGateway
let client: KlfGatewayClient | null = null
let logger: RecordingLogger

async function setup(
  nodes: readonly FakeNode[],
  extra: {
    makeConnection?: (tls: { ca: string[]; checkServerIdentity: () => undefined }) => Connection
    statsIntervalMs?: number
  } = {},
): Promise<KlfGatewayClient> {
  gateway = new FakeKlfGateway(PASSWORD, nodes)
  const { certPem } = await gateway.start()
  logger = new RecordingLogger()
  const tls = { ca: [certPem], checkServerIdentity: () => undefined }
  client = new KlfGatewayClient({
    host: '127.0.0.1',
    password: PASSWORD,
    logger,
    tls,
    rainRefreshMs: 600_000,
    ...(extra.statsIntervalMs === undefined ? {} : { statsIntervalMs: extra.statsIntervalMs }),
    ...(extra.makeConnection === undefined
      ? {}
      : { makeConnection: () => extra.makeConnection?.(tls) as never }),
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

afterEach(async () => {
  try {
    await client?.disconnect()
  } finally {
    client = null
    await gateway.stop()
  }
})

describe('KlfGatewayClient session discipline', () => {
  it('sets up as disable, read, enable (the monitor ends up on after the reads)', async () => {
    const c = await setup([windowNode(0)])
    await c.connect()
    const log = gateway.log
    const disable = log.indexOf('HOUSE_STATUS_MONITOR_DISABLE_REQ')
    const read = log.indexOf('GET_ALL_NODES_INFORMATION_REQ')
    const enable = log.indexOf('HOUSE_STATUS_MONITOR_ENABLE_REQ')
    expect(disable).toBeGreaterThanOrEqual(0)
    expect(disable).toBeLessThan(read)
    expect(read).toBeLessThan(enable)
  })

  it('switches the monitor off before closing, on a stop', async () => {
    const c = await setup([windowNode(0)])
    await c.connect()
    await c.disconnect()
    await until(() => gateway.log.includes('CLOSE'))
    const tail = gateway.log.slice(gateway.log.lastIndexOf('HOUSE_STATUS_MONITOR_ENABLE_REQ'))
    expect(tail).toContain('HOUSE_STATUS_MONITOR_DISABLE_REQ')
    expect(tail.indexOf('HOUSE_STATUS_MONITOR_DISABLE_REQ')).toBeLessThan(tail.indexOf('CLOSE'))
    expect(gateway.closedWithMonitorOn).toBe(0)
  })

  it('tries the monitor disable on a session the gateway ended, and never blocks on it', async () => {
    const c = await setup([windowNode(0)])
    await c.connect()
    gateway.dropAll()
    await until(
      () => logger.lines.some((l) => l.message.includes('tearing the session down')),
      9000,
    )
    const line = logger.lines.find((l) => l.message.includes('tearing the session down'))
    expect(line?.extras?.meta).toMatchObject({ path: 'session-ended' })
  })

  it('destroys the socket when the library cannot end it in time', async () => {
    class StuckLogout extends Connection {
      override async logoutAsync(): Promise<void> {
        throw new Error('Timeout')
      }
    }
    const c = await setup([windowNode(0)], {
      makeConnection: (tls) => new StuckLogout('127.0.0.1', tls),
    })
    await c.connect()
    await c.disconnect()
    await until(() => gateway.openConnections === 0)
    expect(logger.lines.some((l) => l.message.includes('socket end timed out'))).toBe(true)
  })

  it('sends one request at a time, even when several are asked at once', async () => {
    const c = await setup([windowNode(0), windowNode(1), windowNode(2)])
    gateway.slowReplies(80)
    await c.connect()
    await Promise.all([c.readVersion(), c.open(0), c.close(1), c.readVersion()])
    await until(() => c.listNodes().every((n) => n.raining === false))
    expect(gateway.peakInFlight).toBe(1)
  })

  it('logs socket open, login, monitor and teardown with the integration tags kept', async () => {
    const c = await setup([windowNode(0)])
    await c.connect()
    await c.disconnect()
    const messages = logger.lines.map((l) => l.message)
    for (const expected of [
      'velux: socket opening',
      'velux: login ok',
      'velux: house status monitor disabled',
      'velux: house status monitor enabled',
      'velux: tearing the session down',
      'velux: socket ended cleanly',
    ]) {
      expect(messages).toContain(expected)
    }
    await until(() => logger.lines.some((l) => l.message === 'velux: socket closed'))
    const closed = logger.lines.find((l) => l.message === 'velux: socket closed')
    expect(closed?.extras?.meta).toMatchObject({ by: 'local' })
  })

  it('writes a per-type request counter line every interval', async () => {
    const c = await setup([windowNode(0)], { statsIntervalMs: 150 })
    await c.connect()
    await c.readVersion()
    await until(() => logger.lines.some((l) => l.message.includes('requests in the last interval')))
    const line = logger.lines.find((l) => l.message.includes('requests in the last interval'))
    expect(JSON.stringify(line?.extras?.meta)).toContain('get-version')
  })
})
