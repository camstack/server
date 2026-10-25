/**
 * An UNPAIRED agent serves no mesh reader at all (D857). It holds no certificate, so a plain
 * Moleculer TCP reader on its port would take a msgpack REQUEST from any LAN host
 * ($agent.deploy, $process.spawnRunner): remote code execution. The transport is the TLS one
 * with `hubOnlyPeers` and no material, which reaches nobody and accepts nobody.
 */
import { createServer, connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { createAgentTransport } from '../../moleculer/broker-factory.js'
import { TlsTcpTransporter } from '../../moleculer/mesh-mtls/tls-tcp-transporter.js'

const brokers: ServiceBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.stop()
})

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'))
      s.close(() => resolve(addr.port))
    })
  })
}

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('error', () => resolve(true))
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

describe('an unpaired agent', () => {
  it('uses the hub-only TLS transporter, never a clear TCP descriptor', () => {
    const transport = createAgentTransport({ nodeID: 'agent-1', mode: 'agent' })
    expect(transport.kind).toBe('tls')
    expect(transport.transporter).toBeInstanceOf(TlsTcpTransporter)
    expect(Reflect.get(transport.transporter, 'hubOnlyPeers')).toBe(true)
  })

  it('listens on no port: its mesh port refuses a connection', async () => {
    const port = await freePort()
    const transport = createAgentTransport({
      nodeID: 'agent-1',
      mode: 'agent',
      agentListenPort: port,
    })
    const broker = new ServiceBroker({
      nodeID: 'agent-1',
      logger: false,
      transporter: transport.transporter as never,
    })
    brokers.push(broker)
    await broker.start()
    expect(await refused(port)).toBe(true)
  })
})
