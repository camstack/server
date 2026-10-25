import { afterEach, describe, expect, it } from 'vitest'
import type { CapUsageCallRecord } from '../../moleculer/cap-usage-registry.js'
import type {
  CapCallInput,
  CapCallMessage,
  ChildCapDescriptor,
  RegisterAck,
} from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { packPayload, unpackPayload } from '../../transport/frame-codec.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import {
  LocalChildRegistry,
  type LocalChildRegistryOptions,
} from '../../transport/local-child-registry.js'
import {
  PayloadReply,
  type LocalChannel,
  type LocalTransportClient,
} from '../../transport/local-transport.js'

/**
 * Raw-forward: a sibling↔sibling cap call crosses the parent WITHOUT the
 * parent decoding or re-encoding what it carries.
 *
 * Every test here drives real `LocalChildClient`s over real UDS sockets
 * through a real `LocalChildRegistry`, and reads the parent's own forward
 * census to tell an opaque forward from a decoded one — nothing asserts on a
 * spy that was handed the answer.
 */

const nid = () => `hub-rawfwd-${process.pid}-${Math.random().toString(36).slice(2)}`

const PCM = (n: number, fill: number): Uint8Array => new Uint8Array(n).fill(fill)

interface Peer {
  readonly client: LocalChildClient
  readonly received: CapCallInput[]
}

async function startChild(
  nodeId: string,
  childId: string,
  caps: readonly ChildCapDescriptor[],
  answer: (call: CapCallInput) => Promise<unknown>,
): Promise<Peer> {
  const received: CapCallInput[] = []
  const client = new LocalChildClient({
    nodeId,
    childId,
    caps,
    dispatch: async (call) => {
      received.push(call)
      return answer(call)
    },
  })
  await client.start()
  return { client, received }
}

describe('raw-forward — the parent routes a sibling call by its envelope alone', () => {
  let registry: LocalChildRegistry | null = null
  const clients: { close(): Promise<void> }[] = []
  const rawClients: LocalTransportClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    for (const c of rawClients) await c.close()
    rawClients.length = 0
    await registry?.close()
    registry = null
  })

  async function startRegistry(
    nodeId: string,
    extra: Omit<LocalChildRegistryOptions, 'server' | 'ownNodeId'> = {},
  ): Promise<LocalChildRegistry> {
    const reg = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      ...extra,
    })
    await reg.start()
    registry = reg
    return reg
  }

  it('forwards args and result between two payload-capable siblings opaquely, values intact', async () => {
    const nodeId = nid()
    const reg = await startRegistry(nodeId)
    const chunk = PCM(13_500, 0x5a)
    const analyzer = await startChild(
      nodeId,
      'audio-analyzer',
      [{ capName: 'audio-analyzer', mode: 'singleton' }],
      async (call) => {
        const args = call.args as { chunk: { data: Uint8Array; sampleRate: number } }
        return {
          level: { rms: 0.5, dbfs: -6 },
          echoLength: args.chunk.data.byteLength,
          echoFirst: args.chunk.data[0],
          pcmBack: PCM(8000, 0x11),
        }
      },
    )
    const orchestrator = await startChild(nodeId, 'pipeline-orchestrator', [], async () => null)
    clients.push(analyzer.client, orchestrator.client)

    const result = (await orchestrator.client.callOut({
      capName: 'audio-analyzer',
      method: 'analyseChunk',
      args: { chunk: { data: chunk, sampleRate: 16_000 }, settings: { minConfidence: 0.3 } },
    })) as { level: { dbfs: number }; echoLength: number; echoFirst: number; pcmBack: Uint8Array }

    expect(result.level.dbfs).toBe(-6)
    expect(result.echoLength).toBe(13_500)
    expect(result.echoFirst).toBe(0x5a)
    expect(result.pcmBack.byteLength).toBe(8000)
    expect(result.pcmBack[7999]).toBe(0x11)
    expect(analyzer.received).toHaveLength(1)
    expect(analyzer.received[0]!.capName).toBe('audio-analyzer')
    expect(analyzer.received[0]!.method).toBe('analyseChunk')
    expect((analyzer.received[0]!.args as { settings: unknown }).settings).toEqual({
      minConfidence: 0.3,
    })
    // The parent's own account of what it did: one opaque forward, no decode.
    expect(reg.readForwardCensus()).toEqual({ raw: 1, decoded: 0 })
  })

  it('still records the call on the cap-usage observer, with caller and provider', async () => {
    const nodeId = nid()
    const seen: CapUsageCallRecord[] = []
    await startRegistry(nodeId, { capUsageObserver: (obs) => seen.push(obs) })
    const provider = await startChild(
      nodeId,
      'prov',
      [{ capName: 'ptz', mode: 'singleton' }],
      async () => 'ok',
    )
    const caller = await startChild(nodeId, 'caller', [], async () => null)
    clients.push(provider.client, caller.client)

    await caller.client.callOut({ capName: 'ptz', method: 'move', args: { pan: 1 } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      callerAddonId: 'caller',
      providerAddonId: 'prov',
      capName: 'ptz',
      methodName: 'move',
    })
  })

  it('a `{ addonId }` selector lifted into the hints still bypasses the sibling, and the parent decodes the args for onUnownedCall', async () => {
    const nodeId = nid()
    const unowned: CapCallInput[] = []
    const reg = await startRegistry(nodeId, {
      onUnownedCall: async (input) => {
        unowned.push(input)
        return { from: 'parent' }
      },
      isAddonPinnedCall: (_cap, _method, args) =>
        typeof (args as { addonId?: unknown })?.addonId === 'string',
    })
    const homematic = await startChild(
      nodeId,
      'provider-homematic',
      [{ capName: 'broker', mode: 'collection' }],
      async () => ({ from: 'sibling' }),
    )
    const caller = await startChild(nodeId, 'caller', [], async () => null)
    clients.push(homematic.client, caller.client)

    const res = await caller.client.callOut({
      capName: 'broker',
      method: 'getBrokerConfig',
      args: { id: 'ha_001', addonId: 'provider-homeassistant' },
    })
    expect(res).toEqual({ from: 'parent' })
    expect(homematic.received).toHaveLength(0)
    expect(unowned).toHaveLength(1)
    expect(unowned[0]!.args).toEqual({ id: 'ha_001', addonId: 'provider-homeassistant' })
    expect(unowned[0]!.callerAddonId).toBe('caller')
    expect(reg.readForwardCensus()).toEqual({ raw: 0, decoded: 1 })
  })

  it('an inline `nodeId` naming another node bypasses the sibling exactly as it did inline', async () => {
    const nodeId = nid()
    const unowned: CapCallInput[] = []
    await startRegistry(nodeId, {
      onUnownedCall: async (input) => {
        unowned.push(input)
        return 'remote'
      },
    })
    const local = await startChild(
      nodeId,
      'probe',
      [{ capName: 'platform-probe', mode: 'singleton' }],
      async () => 'local',
    )
    const caller = await startChild(nodeId, 'caller', [], async () => null)
    clients.push(local.client, caller.client)

    await expect(
      caller.client.callOut({
        capName: 'platform-probe',
        method: 'getCapabilities',
        args: { nodeId: 'agent-a' },
      }),
    ).resolves.toBe('remote')
    expect(local.received).toHaveLength(0)
    expect(unowned[0]!.args).toEqual({ nodeId: 'agent-a' })
    // A pin to THIS node is served by the sibling, opaquely.
    await expect(
      caller.client.callOut({
        capName: 'platform-probe',
        method: 'getCapabilities',
        args: { nodeId },
      }),
    ).resolves.toBe('local')
    expect(local.received).toHaveLength(1)
  })

  it('a target that never declared payload support is sent inline args the parent decoded', async () => {
    const nodeId = nid()
    const reg = await startRegistry(nodeId)
    // A legacy child: raw channel, register frame without `rawForward`.
    const legacy = createLocalTransport().createClient(nodeId)
    const channel = await legacy.connect()
    rawClients.push(legacy)
    const got: { body: unknown; payload: Uint8Array | undefined }[] = []
    channel.onRequest(async (body, payload) => {
      got.push({ body, payload })
      return { legacy: true }
    })
    await channel.request({
      kind: 'register',
      childId: 'old-provider',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
    })
    const caller = await startChild(nodeId, 'caller', [], async () => null)
    clients.push(caller.client)

    await expect(
      caller.client.callOut({ capName: 'ptz', method: 'move', args: { pan: 2 } }),
    ).resolves.toEqual({ legacy: true })
    expect(got).toHaveLength(1)
    expect(got[0]!.payload).toBeUndefined()
    expect((got[0]!.body as CapCallMessage).args).toEqual({ pan: 2 })
    expect(reg.readForwardCensus()).toEqual({ raw: 0, decoded: 1 })
  })

  it('a caller whose parent did not acknowledge payload support sends inline args', async () => {
    const nodeId = nid()
    // A legacy PARENT: acks `register` with `{ ok: true }` and nothing else.
    const server = createLocalTransport().createServer(nodeId)
    const frames: { body: unknown; payload: Uint8Array | undefined }[] = []
    const opened: LocalChannel[] = []
    server.onConnection((ch) => {
      opened.push(ch)
      ch.onRequest(async (body, payload) => {
        const msg = body as { kind: string }
        if (msg.kind === 'register') {
          const ack: RegisterAck = { ok: true }
          return ack
        }
        frames.push({ body, payload })
        return 'parent-answered'
      })
    })
    await server.listen()
    try {
      const client = new LocalChildClient({
        nodeId,
        childId: 'c',
        caps: [],
        dispatch: async () => null,
      })
      await client.start()
      await expect(
        client.callOut({ capName: 'ptz', method: 'move', args: { pan: 3 } }),
      ).resolves.toBe('parent-answered')
      expect(frames).toHaveLength(1)
      expect(frames[0]!.payload).toBeUndefined()
      expect((frames[0]!.body as { args: unknown }).args).toEqual({ pan: 3 })
      await client.close()
    } finally {
      for (const ch of opened) ch.close()
      await server.close()
    }
  })

  it('a void result and a thrown error each travel as they did inline', async () => {
    const nodeId = nid()
    await startRegistry(nodeId)
    const provider = await startChild(
      nodeId,
      'prov',
      [{ capName: 'ptz', mode: 'singleton' }],
      async (call) => {
        if (call.method === 'stop') return undefined
        if (call.method === 'nothing') return null
        throw new Error('ptz: motor jammed')
      },
    )
    const caller = await startChild(nodeId, 'caller', [], async () => null)
    clients.push(provider.client, caller.client)

    await expect(
      caller.client.callOut({ capName: 'ptz', method: 'stop', args: undefined }),
    ).resolves.toBeUndefined()
    await expect(
      caller.client.callOut({ capName: 'ptz', method: 'nothing', args: {} }),
    ).resolves.toBeNull()
    await expect(
      caller.client.callOut({ capName: 'ptz', method: 'move', args: {} }),
    ).rejects.toThrow('ptz: motor jammed')
    // Void args reach the provider as `undefined`, not `null`.
    expect(provider.received[0]!.args).toBeUndefined()
  })

  it('a payload-capable child answers a payload-less request inline (the requester decides the shape)', async () => {
    const nodeId = nid()
    await startRegistry(nodeId)
    const provider = await startChild(
      nodeId,
      'prov',
      [{ capName: 'ptz', mode: 'singleton' }],
      async () => ({
        big: PCM(3000, 1),
      }),
    )
    clients.push(provider.client)
    // A legacy caller on a raw channel, inline args, no payload.
    const legacy = createLocalTransport().createClient(nodeId)
    const channel = await legacy.connect()
    rawClients.push(legacy)
    await channel.request({ kind: 'register', childId: 'old-caller', caps: [] })
    const res = (await channel.request({
      kind: 'cap-call-out',
      capName: 'ptz',
      method: 'move',
      args: { pan: 1 },
    })) as { big: Uint8Array }
    // A plain value, not a PayloadReply — and the bytes intact.
    expect(res.big.byteLength).toBe(3000)
    // The serving sibling is told WHO called — the parent's stamp off the
    // connection, written into the args (D787).
    expect(provider.received[0]!.args).toEqual({ pan: 1, callerAddonId: 'old-caller' })
  })

  it('a payload-capable child answers a payload request WITH a payload, so the parent can forward the answer opaquely', async () => {
    const nodeId = nid()
    // A parent that speaks the wire directly: acks raw-forward and then sends
    // one `cap-call` whose args ride as a payload.
    const server = createLocalTransport().createServer(nodeId)
    const opened: LocalChannel[] = []
    server.onConnection((ch) => {
      opened.push(ch)
      ch.onRequest(async () => {
        const ack: RegisterAck = { ok: true, rawForward: true }
        return ack
      })
    })
    await server.listen()
    try {
      const child = new LocalChildClient({
        nodeId,
        childId: 'prov',
        caps: [{ capName: 'ptz', mode: 'singleton' }],
        dispatch: async (call) => ({ echo: call.args, big: PCM(3000, 9) }),
      })
      await child.start()
      const call: CapCallMessage = {
        kind: 'cap-call',
        capName: 'ptz',
        method: 'move',
        args: undefined,
      }
      const reply = await opened[0]!.request(call, { payload: packPayload({ pan: 4 }) })
      expect(reply).toBeInstanceOf(PayloadReply)
      const value = unpackPayload((reply as PayloadReply).payload) as {
        echo: unknown
        big: Uint8Array
      }
      expect(value.echo).toEqual({ pan: 4 })
      expect(value.big.byteLength).toBe(3000)
      await child.close()
    } finally {
      for (const ch of opened) ch.close()
      await server.close()
    }
  })

  it('acknowledges raw-forward to every child that declares it — there is no switch (D449)', async () => {
    const nodeId = nid()
    await startRegistry(nodeId)
    // A child on a raw channel, so the ack is read exactly as it crosses the
    // wire — a `LocalChildClient` would consume it. The environment carries
    // nothing that could change the answer; there is no variable to set.
    const raw = createLocalTransport().createClient(nodeId)
    const channel = await raw.connect()
    rawClients.push(raw)
    const ack = (await channel.request({
      kind: 'register',
      childId: 'declaring',
      caps: [],
      rawForward: true,
    })) as RegisterAck
    expect(ack).toEqual({ ok: true, rawForward: true })
  })
})
