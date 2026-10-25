import { afterEach, describe, expect, it } from 'vitest'
import type {
  CapCallInput,
  EventSubUpdateMessage,
  RegisterMessage,
} from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import type { LocalChildRegistryOptions } from '../../transport/local-child-registry.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'

const nid = () => `hub-test-${process.pid}-${Math.random().toString(36).slice(2)}`

describe('LocalChildClient', () => {
  let registry: LocalChildRegistry | null = null
  let child: LocalChildClient | null = null
  afterEach(async () => {
    await child?.close()
    child = null
    await registry?.close()
    registry = null
  })

  it('registers its caps and serves a routed cap call', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    child = new LocalChildClient({
      nodeId,
      childId: 'reolink',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async (call) => ({ ran: call.method, args: call.args }),
    })
    await child.start()

    expect(registry.resolveChildId('ptz')).toBe('reolink')
    await expect(
      registry.callCap({ capName: 'ptz', method: 'move', args: { pan: 2 } }),
    ).resolves.toEqual({ ran: 'move', args: { pan: 2 } })
  })

  it('forwards deviceId to dispatch for device-scoped caps', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    let seen: CapCallInput | null = null
    child = new LocalChildClient({
      nodeId,
      childId: 'reolink',
      caps: [{ capName: 'motion-zones', mode: 'collection', deviceId: 15 }],
      dispatch: async (call) => {
        seen = call
        return 'ok'
      },
    })
    await child.start()

    await registry.callCap({ capName: 'motion-zones', method: 'getStatus', args: {}, deviceId: 15 })
    expect(seen).toEqual({ capName: 'motion-zones', method: 'getStatus', args: {}, deviceId: 15 })
  })

  it('forwards the addonId provider-selection hint to dispatch (grouped runners)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    // Three co-located addons registering the same collection cap (the auth
    // group shape): without the hint the runner can only ever resolve the
    // first-registered provider — dropping it here made auth.listLoginMethods
    // return magic-link's payload three times.
    let seen: CapCallInput | null = null
    child = new LocalChildClient({
      nodeId,
      childId: 'auth',
      caps: [{ capName: 'login-method', mode: 'collection' }],
      dispatch: async (call) => {
        seen = call
        return 'ok'
      },
    })
    await child.start()

    await registry.callCap({
      capName: 'login-method',
      method: 'getLoginMethods',
      args: {},
      addonId: 'auth-oidc',
    })
    expect(seen).toEqual({
      capName: 'login-method',
      method: 'getLoginMethods',
      args: {},
      addonId: 'auth-oidc',
    })
  })

  it('propagates a dispatch error to the caller', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    child = new LocalChildClient({
      nodeId,
      childId: 'reolink',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => {
        throw new Error('camera offline')
      },
    })
    await child.start()

    await expect(registry.callCap({ capName: 'ptz', method: 'move', args: {} })).rejects.toThrow(
      'camera offline',
    )
  })

  it('throws if start() is called twice without close()', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    child = new LocalChildClient({
      nodeId,
      childId: 'reolink',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => 'ok',
    })
    await child.start()
    await expect(child.start()).rejects.toThrow('already started')
  })

  it('drops from the registry when the client closes', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    child = new LocalChildClient({
      nodeId,
      childId: 'reolink',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => 'ok',
    })
    await child.start()
    expect(registry.resolveChildId('ptz')).toBe('reolink')

    await child.close()
    child = null
    await new Promise((r) => setTimeout(r, 30))
    expect(registry.resolveChildId('ptz')).toBeNull()
  })

  it('updateCaps re-registers and adds new caps while preserving existing ones', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    child = new LocalChildClient({
      nodeId,
      childId: 'reolink',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => 'ok',
    })
    await child.start()

    expect(registry.resolveChildId('ptz')).toBe('reolink')

    await child.updateCaps([
      { capName: 'ptz', mode: 'singleton' },
      { capName: 'motion-zones', mode: 'collection', deviceId: 15 },
    ])

    expect(registry.resolveChildId('ptz')).toBe('reolink')
    expect(registry.resolveChildId('motion-zones', 15)).toBe('reolink')
  })

  it('updateCaps removes caps that are no longer in the new manifest', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    child = new LocalChildClient({
      nodeId,
      childId: 'reolink',
      caps: [
        { capName: 'ptz', mode: 'singleton' },
        { capName: 'motion-zones', mode: 'collection', deviceId: 15 },
      ],
      dispatch: async () => 'ok',
    })
    await child.start()

    expect(registry.resolveChildId('ptz')).toBe('reolink')
    expect(registry.resolveChildId('motion-zones', 15)).toBe('reolink')

    await child.updateCaps([{ capName: 'ptz', mode: 'singleton' }])

    expect(registry.resolveChildId('ptz')).toBe('reolink')
    expect(registry.resolveChildId('motion-zones', 15)).toBeNull()
  })

  it('updateCaps before start() buffers the caps so start() registers them (device-restore race)', async () => {
    // Native device caps (ptz/motion-zones) register on device-restore, which
    // can race AHEAD of the UDS connect completing. A pre-start updateCaps must
    // NOT throw and must NOT be lost — start() sends the latest buffered set.
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    child = new LocalChildClient({
      nodeId,
      childId: 'reolink',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => 'ok',
    })

    // Called BEFORE start() — must resolve (buffer), not reject.
    await expect(
      child.updateCaps([
        { capName: 'ptz', mode: 'singleton' },
        { capName: 'motion-zones', mode: 'collection', deviceId: 15 },
      ]),
    ).resolves.toBeUndefined()

    await child.start()

    // start() must have sent the BUFFERED (latest) set, not the constructor caps.
    expect(registry.resolveChildId('ptz')).toBe('reolink')
    expect(registry.resolveChildId('motion-zones', 15)).toBe('reolink')
  })

  // ── callOut (child→parent outbound cap-call) ──────────────────────────────

  it('callOut routes to a sibling child that owns the cap', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    // childB owns motion-zones for device 15
    const childB = new LocalChildClient({
      nodeId,
      childId: 'child-b',
      caps: [{ capName: 'motion-zones', mode: 'collection', deviceId: 15 }],
      dispatch: async (call) => ({ ok: true, m: call.method }),
    })
    await childB.start()

    // childA owns ptz and will callOut to motion-zones
    child = new LocalChildClient({
      nodeId,
      childId: 'child-a',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => 'ok',
    })
    await child.start()

    const result = await child.callOut({
      capName: 'motion-zones',
      method: 'getStatus',
      args: {},
      deviceId: 15,
    })
    expect(result).toEqual({ ok: true, m: 'getStatus' })

    await childB.close()
  })

  it('callOut invokes the onUnownedCall fallback when no sibling owns the cap', async () => {
    const nodeId = nid()
    const opts: LocalChildRegistryOptions = {
      server: createLocalTransport().createServer(nodeId),
      onUnownedCall: async (_input) => 'from-fallback',
    }
    registry = new LocalChildRegistry(opts.server, opts.onUnownedCall)
    await registry.start()

    child = new LocalChildClient({
      nodeId,
      childId: 'child-a',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => 'ok',
    })
    await child.start()

    const result = await child.callOut({ capName: 'nope', method: 'x', args: {} })
    expect(result).toBe('from-fallback')
  })

  it('callOut rejects with a clear error when no sibling owns the cap and no fallback is set', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    child = new LocalChildClient({
      nodeId,
      childId: 'child-a',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => 'ok',
    })
    await child.start()

    await expect(child.callOut({ capName: 'nope', method: 'x', args: {} })).rejects.toThrow(
      'UDS_NO_ROUTE',
    )
  })

  it('callOut before start() throws a clear error', async () => {
    child = new LocalChildClient({
      nodeId: nid(),
      childId: 'reolink',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => 'ok',
    })

    await expect(child.callOut({ capName: 'ptz', method: 'move', args: {} })).rejects.toThrow(
      'LocalChildClient: callOut before start',
    )
  })

  // ── event-pattern declaration (subscription-filtered fan-out, T3) ─────────
  //
  // A raw capturing server records the `register` request frames (to inspect
  // `eventPatterns`) and the fire-and-forget `event-sub` emit frames.

  interface CapturingServer {
    readonly nodeId: string
    readonly registers: RegisterMessage[]
    readonly eventSubs: EventSubUpdateMessage[]
    close(): Promise<void>
  }

  async function startCapturingServer(): Promise<CapturingServer> {
    const nodeId = nid()
    const server = createLocalTransport().createServer(nodeId)
    const registers: RegisterMessage[] = []
    const eventSubs: EventSubUpdateMessage[] = []
    server.onConnection((channel) => {
      channel.onRequest(async (body) => {
        const msg = body as RegisterMessage
        if (msg.kind === 'register') {
          registers.push(msg)
          return { ok: true }
        }
        throw new Error(`unexpected request kind ${(msg as { kind: string }).kind}`)
      })
      channel.onEvent((body) => {
        const msg = body as EventSubUpdateMessage
        if (msg.kind === 'event-sub') eventSubs.push(msg)
      })
    })
    await server.listen()
    return { nodeId, registers, eventSubs, close: () => server.close() }
  }

  it('pre-start updateEventPatterns ride the register frame (race-free boot)', async () => {
    const server = await startCapturingServer()
    try {
      child = new LocalChildClient({
        nodeId: server.nodeId,
        childId: 'reolink',
        caps: [{ capName: 'ptz', mode: 'singleton' }],
        dispatch: async () => 'ok',
      })
      // Framework + addon subscriptions land BEFORE start() completes.
      child.updateEventPatterns('reolink', ['device.bindings-changed', 'system.ready-state'])
      await child.start()

      expect(server.registers).toHaveLength(1)
      expect(server.registers[0]!.eventPatterns).toEqual([
        'device.bindings-changed',
        'system.ready-state',
      ])
      // No separate event-sub needed at boot — the register carried the set.
      expect(server.eventSubs).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('post-start updateEventPatterns emits exactly one event-sub per union change', async () => {
    const server = await startCapturingServer()
    try {
      child = new LocalChildClient({
        nodeId: server.nodeId,
        childId: 'reolink',
        caps: [{ capName: 'ptz', mode: 'singleton' }],
        dispatch: async () => 'ok',
      })
      await child.start()
      await new Promise((r) => setTimeout(r, 20))

      child.updateEventPatterns('reolink', ['system.ready-state'])
      child.updateEventPatterns('reolink', ['system.ready-state']) // unchanged → no emit
      child.updateEventPatterns('reolink', ['system.ready-state', 'agent.offline']) // changed → emit
      await new Promise((r) => setTimeout(r, 20))

      expect(server.eventSubs).toHaveLength(2)
      expect(server.eventSubs[0]!.patterns).toEqual(['system.ready-state'])
      expect(server.eventSubs[1]!.patterns).toEqual(['agent.offline', 'system.ready-state'])
    } finally {
      await server.close()
    }
  })

  it('two owners union their pattern sets (group-runner correctness)', async () => {
    const server = await startCapturingServer()
    try {
      child = new LocalChildClient({
        nodeId: server.nodeId,
        childId: 'group',
        caps: [{ capName: 'ptz', mode: 'singleton' }],
        dispatch: async () => 'ok',
      })
      await child.start()
      await new Promise((r) => setTimeout(r, 20))

      child.updateEventPatterns('addon-a', ['a.one'])
      child.updateEventPatterns('addon-b', ['b.two'])
      await new Promise((r) => setTimeout(r, 20))

      // Last emit carries the union of both owners.
      expect(server.eventSubs.at(-1)!.patterns).toEqual(['a.one', 'b.two'])
    } finally {
      await server.close()
    }
  })

  it('updateCaps re-carries the current event-pattern set in its register frame', async () => {
    const server = await startCapturingServer()
    try {
      child = new LocalChildClient({
        nodeId: server.nodeId,
        childId: 'reolink',
        caps: [{ capName: 'ptz', mode: 'singleton' }],
        dispatch: async () => 'ok',
      })
      child.updateEventPatterns('reolink', ['system.ready-state'])
      await child.start()

      await child.updateCaps([
        { capName: 'ptz', mode: 'singleton' },
        { capName: 'osd', mode: 'singleton' },
      ])

      expect(server.registers).toHaveLength(2)
      // The re-register atomically re-declares the current subscription set.
      expect(server.registers[1]!.eventPatterns).toEqual(['system.ready-state'])
    } finally {
      await server.close()
    }
  })
})
