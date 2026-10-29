/**
 * The parent side of producer-side suppression: the registry tells each child
 * which categories SOMEONE ELSE wants — sibling children plus the hub's own
 * in-process subscribers — and re-tells it whenever that changes. Without an
 * installed source (agents) it sends nothing, so those children fail open.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { EventInterestMessage } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import type { LocalChannel, LocalTransportClient } from '../../transport/local-transport.js'

const nid = () => `hub-test-${process.pid}-${Math.random().toString(36).slice(2)}`
const flush = () => new Promise((r) => setTimeout(r, 30))

interface Child {
  readonly client: LocalTransportClient
  readonly channel: LocalChannel
  readonly interest: (readonly string[] | null)[]
}

async function connect(
  nodeId: string,
  childId: string,
  eventPatterns: readonly string[] | undefined,
): Promise<Child> {
  const client = createLocalTransport().createClient(nodeId)
  const channel = await client.connect()
  const interest: (readonly string[] | null)[] = []
  channel.onRequest(async () => 'ok')
  channel.onEvent((body) => {
    const msg = body as EventInterestMessage // wire-boundary: trusted local UDS channel
    if (msg.kind === 'event-interest') interest.push(msg.patterns)
  })
  const caps = [{ capName: 'noop', mode: 'singleton' as const }]
  await channel.request(
    eventPatterns === undefined
      ? { kind: 'register', childId, caps }
      : { kind: 'register', childId, caps, eventPatterns },
  )
  return { client, channel, interest }
}

describe('LocalChildRegistry — event interest push', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []
  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  async function start(): Promise<{ nodeId: string; registry: LocalChildRegistry }> {
    const nodeId = nid()
    const created = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    registry = created
    await created.start()
    return { nodeId, registry: created }
  }

  it('sends nothing while no interest source is installed (agents fail open)', async () => {
    const { nodeId } = await start()
    const a = await connect(nodeId, 'a', ['pipeline.*'])
    clients.push(a.client)
    await flush()
    expect(a.interest).toEqual([])
  })

  it('tells a child what its siblings and the hub want, never its own set', async () => {
    const { nodeId, registry: r } = await start()
    r.setEventInterestSource(() => ['admin.live'])
    const a = await connect(nodeId, 'a', ['pipeline.*'])
    const b = await connect(nodeId, 'b', ['device.*'])
    clients.push(a.client, b.client)
    await flush()

    expect(a.interest.at(-1)).toEqual(expect.arrayContaining(['admin.live', 'device.*']))
    expect(a.interest.at(-1)).not.toContain('pipeline.*')
    expect(b.interest.at(-1)).toEqual(expect.arrayContaining(['admin.live', 'pipeline.*']))
    expect(b.interest.at(-1)).not.toContain('device.*')
  })

  it('re-tells the others when a child changes its subscriptions', async () => {
    const { nodeId, registry: r } = await start()
    r.setEventInterestSource(() => [])
    const a = await connect(nodeId, 'a', [])
    const b = await connect(nodeId, 'b', [])
    clients.push(a.client, b.client)
    await flush()
    expect(a.interest.at(-1)).toEqual([])

    b.channel.emit({ kind: 'event-sub', patterns: ['pipeline.trace'] })
    await flush()
    expect(a.interest.at(-1)).toEqual(['pipeline.trace'])
  })

  it('re-tells everyone when the hub-local interest changes', async () => {
    const { nodeId, registry: r } = await start()
    let hub: readonly string[] = []
    r.setEventInterestSource(() => hub)
    const a = await connect(nodeId, 'a', [])
    clients.push(a.client)
    await flush()
    expect(a.interest.at(-1)).toEqual([])

    hub = ['stream-broker.metrics-snapshot']
    r.refreshEventInterest()
    await flush()
    expect(a.interest.at(-1)).toEqual(['stream-broker.metrics-snapshot'])
  })

  it('fails open (null) while any OTHER child is undeclared', async () => {
    const { nodeId, registry: r } = await start()
    r.setEventInterestSource(() => [])
    const a = await connect(nodeId, 'a', [])
    const legacy = await connect(nodeId, 'legacy', undefined)
    clients.push(a.client, legacy.client)
    await flush()
    expect(a.interest.at(-1)).toBeNull()
  })

  it('does not repeat an unchanged set', async () => {
    const { nodeId, registry: r } = await start()
    r.setEventInterestSource(() => ['x.y'])
    const a = await connect(nodeId, 'a', [])
    clients.push(a.client)
    await flush()
    const before = a.interest.length
    r.refreshEventInterest()
    r.refreshEventInterest()
    await flush()
    expect(a.interest.length).toBe(before)
  })
})
