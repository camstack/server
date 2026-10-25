/**
 * The chain from a real UDS socket to the `[mem]` line, end to end.
 *
 * The counters live on `SocketChannel`; the attribution to a PEER lives on
 * `LocalChildRegistry`, because the registry is the only thing that knows a
 * socket belongs to `pipeline-analytics` rather than to some fd. Every unit
 * above this point can be green while the two are not actually joined, so this
 * spec drives real sockets: a registry, a real child, a real cap call, a real
 * fan-out event.
 */
import type { SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapCallMessage, ChildCapDescriptor } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import type { LocalChannel, LocalTransportClient } from '../../transport/local-transport.js'
import { createSocketPlaneReader } from '../../socket-plane-report.js'
import { socketDirectionMessages } from '../../transport/socket-traffic.js'

const nid = (): string => `hub-traffic-${process.pid}-${Math.random().toString(36).slice(2)}`

async function makeFakeChild(
  nodeId: string,
  childId: string,
  caps: readonly ChildCapDescriptor[],
): Promise<{ client: LocalTransportClient; channel: LocalChannel }> {
  const client = createLocalTransport().createClient(nodeId)
  const channel = await client.connect()
  channel.onRequest(async (body) => {
    const msg = body as CapCallMessage // wire-boundary: trusted local UDS channel
    if (msg.kind === 'cap-call') return { called: msg.method }
    throw new Error(`unexpected request kind ${(msg as { kind: string }).kind}`)
  })
  channel.onEvent(() => {})
  await channel.request({ kind: 'register', childId, caps })
  return { client, channel }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

describe('the registry attributes socket traffic to the peer that owns the channel', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []
  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  it('counts a cap call as a `req` out and a `res` back, on the named child', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    const child = await makeFakeChild(nodeId, 'pipeline-analytics', [
      { capName: 'ptz', mode: 'singleton' },
    ])
    clients.push(child.client)

    await registry.callCap({ capName: 'ptz', method: 'move', args: { pan: 1 } })
    await settle()

    const traffic = registry.getChildSocketTraffic('pipeline-analytics')
    expect(traffic).not.toBeNull()
    // Parent → child: the cap call. Plus the register ACK, which is a `res`.
    expect(traffic?.tx.reqMessages).toBe(1)
    expect(traffic?.tx.resMessages).toBe(1)
    // Child → parent: the register request, and the cap call's answer.
    expect(traffic?.rx.reqMessages).toBe(1)
    expect(traffic?.rx.resMessages).toBe(1)
    // Bytes are real bytes off a real socket, not a placeholder.
    expect(traffic?.tx.reqBytes ?? 0).toBeGreaterThan(0)
    expect(traffic?.rx.resBytes ?? 0).toBeGreaterThan(0)
  })

  it('a fan-out event lands on `evt`, and nowhere else', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    const child = await makeFakeChild(nodeId, 'ml', [{ capName: 'infer', mode: 'singleton' }])
    clients.push(child.client)

    const before = registry.getChildSocketTraffic('ml')?.tx.reqMessages ?? -1
    const event: SystemEvent = {
      id: 'evt-socket-traffic',
      timestamp: new Date(),
      source: { type: 'core', id: 'hub' },
      category: 'system.ready-state',
      data: {},
    }
    registry.broadcastEventToChildren(event, 'hub')
    await settle()

    const traffic = registry.getChildSocketTraffic('ml')
    expect(traffic?.tx.evtMessages).toBe(1)
    // An idle addon's whole cost is this one kind — that is the finding the
    // split exists to make visible, so it must not leak into req/res.
    expect(traffic?.tx.reqMessages).toBe(before)
    expect(traffic?.tx.resMessages).toBe(1)
  })

  it('an unknown child is null — absent is not the same as silent', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    expect(registry.getChildSocketTraffic('never-connected')).toBeNull()
  })

  it('the plane reader reaches the same numbers through the registry', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    const child = await makeFakeChild(nodeId, 'recorder', [
      { capName: 'recording', mode: 'singleton' },
    ])
    clients.push(child.client)
    await registry.callCap({ capName: 'recording', method: 'listSegments', args: {} })
    await settle()

    const bound = registry
    const read = createSocketPlaneReader({ registry: () => bound })
    const counters = read()
    expect(counters?.peersConnected).toBe(1)
    expect(counters?.peers.map((p) => p.peerId)).toEqual(['recorder'])
    const peer = counters?.peers[0]
    expect(peer === undefined ? 0 : socketDirectionMessages(peer.tx)).toBeGreaterThan(0)
    expect(peer === undefined ? 0 : socketDirectionMessages(peer.rx)).toBeGreaterThan(0)
  })
})
