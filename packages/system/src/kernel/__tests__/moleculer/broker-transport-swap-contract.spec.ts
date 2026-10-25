/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- test file, Moleculer internals */
/**
 * `broker-transport-swap.ts` drives PRIVATE Moleculer members. `moleculer` is pinned exactly in
 * every package.json that uses it, and this spec fails loudly (no socket involved) if an upgrade
 * moves any member or behaviour the swap relies on. It also pins the connect guard.
 */
import { describe, expect, it } from 'vitest'
import { ServiceBroker } from 'moleculer'
import {
  buildTransporter,
  connectBrokerTransport,
  disconnectBrokerTransport,
  installBrokerTransporter,
} from '../../moleculer/broker-transport-swap.js'
import { createAgentTransport } from '../../moleculer/broker-factory.js'

describe('the private Moleculer surface the transport swap relies on', () => {
  it('has every member the swap calls', () => {
    const broker: any = new ServiceBroker({
      nodeID: 'contract',
      transporter: 'Fake',
      logger: false,
    })
    expect(typeof broker.wrapMethod).toBe('function')
    expect(typeof broker.registry.nodes.disconnected).toBe('function')
    expect(typeof broker.registry.nodes.list).toBe('function')
    const transit = broker.transit
    expect(transit.tx).toBeDefined()
    for (const name of ['messageHandler', 'afterConnect', 'connect', 'disconnect']) {
      expect(typeof transit[name], `transit.${name}`).toBe('function')
    }
    for (const name of ['init', 'connect', 'disconnect']) {
      expect(typeof transit.tx[name], `tx.${name}`).toBe('function')
    }
  })

  it('init() of a TCP transporter disables heartbeats; loadUrls() replaces the hub node address', async () => {
    const broker: any = new ServiceBroker({
      nodeID: 'contract2',
      transporter: 'Fake',
      logger: false,
    })
    let heartbeatsDisabled = 0
    const discoverer = broker.registry.discoverer
    const original = discoverer.disableHeartbeat.bind(discoverer)
    discoverer.disableHeartbeat = () => {
      heartbeatsDisabled += 1
      original()
    }
    const first = buildTransporter(
      createAgentTransport({
        nodeID: 'contract2',
        mode: 'agent',
        hubAddress: '10.0.0.1:6000',
        tcpPort: 6000,
      }),
    )
    installBrokerTransporter(broker, first)
    expect(heartbeatsDisabled).toBe(1)
    await (first.tx as any).loadUrls()
    expect(broker.registry.nodes.get('hub').port).toBe(6000)

    const second = buildTransporter(
      createAgentTransport({
        nodeID: 'contract2',
        mode: 'agent',
        hubAddress: '10.0.0.2:7000',
        tcpPort: 7000,
      }),
    )
    installBrokerTransporter(broker, second)
    await (second.tx as any).loadUrls()
    const hub = broker.registry.nodes.get('hub')
    expect(hub.port).toBe(7000)
    expect(hub.hostname ?? hub.ipList?.[0]).toBe('10.0.0.2')
    expect(broker.transit.tx).toBe(second.tx)
  })
})

/** A broker-shaped object whose transit counts what is called on it. */
function fakeBroker(opts: { withDisconnected?: boolean } = {}) {
  const calls: string[] = []
  const tx: any = {
    connected: false,
    connect: async () => calls.push('tx.connect'),
    disconnect: async () => undefined,
    init: () => undefined,
  }
  const transit: any = {
    tx,
    connect: async () => tx.connect(),
    disconnect: async () => calls.push('transit.disconnect'),
    messageHandler: () => undefined,
    afterConnect: async () => undefined,
  }
  const broker: any = {
    nodeID: 'me',
    transit,
    wrapMethod: (_name: string, handler: unknown) => handler,
    registry: {
      nodes: {
        list: () => [{ id: 'hub', available: true }],
        ...(opts.withDisconnected === false ? {} : { disconnected: () => calls.push('forget') }),
      },
    },
  }
  return { broker, calls, tx, transit }
}

function pendingTx(connect: () => Promise<unknown>, calls: string[]) {
  return {
    tx: {
      connected: false,
      init: () => undefined,
      send: () => undefined,
      receive: () => undefined,
      connect,
      disconnect: async () => void calls.push('cleanup'),
    },
  }
}

describe('the swap refuses to drop the wire it cannot re-establish', () => {
  it('aborts BEFORE disconnecting when the node catalog lost `disconnected`', async () => {
    const { broker, calls } = fakeBroker({ withDisconnected: false })
    await expect(disconnectBrokerTransport(broker)).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('connect is single-flight and dies with its transporter', () => {
  it('a second connect while one is in flight shares it; a failed connect is cleaned up before a retry', async () => {
    const { broker, calls, transit } = fakeBroker()
    let starts = 0
    let release: () => void = () => undefined
    const pending: any = pendingTx(() => {
      starts += 1
      return starts === 1
        ? Promise.reject(new Error('EADDRINUSE'))
        : new Promise<void>((resolve) => {
            release = resolve
          })
    }, calls)
    installBrokerTransporter(broker, pending)
    await expect(transit.tx.connect()).rejects.toThrow('EADDRINUSE')
    expect(calls).toContain('cleanup') // the half-started transporter is torn down first
    const a = transit.tx.connect()
    const b = transit.tx.connect()
    expect(starts).toBe(2)
    expect(a).toBe(b)
    release()
    await a
  })

  it('a retry that fires after a swap, or after the wire was dropped, starts nothing', async () => {
    const { broker, calls, transit } = fakeBroker()
    let startsOld = 0
    const old: any = pendingTx(async () => void (startsOld += 1), calls)
    installBrokerTransporter(broker, old)
    const staleConnect = old.tx.connect
    let startsNew = 0
    const next: any = pendingTx(async () => void (startsNew += 1), calls)
    installBrokerTransporter(broker, next)
    await staleConnect() // the old transporter was replaced
    expect(startsOld).toBe(0)
    await transit.tx.connect()
    next.tx.connected = true
    await transit.tx.connect() // already connected: no second start
    expect(startsNew).toBe(1)

    await disconnectBrokerTransport(broker) // drop the wire
    await transit.tx.connect()
    expect(startsNew).toBe(1)
    await connectBrokerTransport(broker)
  })
})
