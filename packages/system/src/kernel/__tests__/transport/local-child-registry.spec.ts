import type { SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CapCallMessage,
  ChildCapDescriptor,
  EventSubUpdateMessage,
  ParentEventMessage,
  RegisteredChild,
} from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { CATEGORY_CENSUS_MAX, LocalChildRegistry } from '../../transport/local-child-registry.js'
import type { LocalChannel, LocalTransportClient } from '../../transport/local-transport.js'

const nid = () => `hub-test-${process.pid}-${Math.random().toString(36).slice(2)}`

/** A fake child: connects, serves cap-calls via `capHandler`, then registers (awaits ack). */
async function makeFakeChild(
  nodeId: string,
  childId: string,
  caps: readonly ChildCapDescriptor[],
  capHandler: (msg: CapCallMessage) => Promise<unknown>,
): Promise<{ client: LocalTransportClient; channel: LocalChannel }> {
  const client = createLocalTransport().createClient(nodeId)
  const channel = await client.connect()
  channel.onRequest(async (body) => {
    const msg = body as CapCallMessage // wire-boundary: trusted local UDS channel
    if (msg.kind === 'cap-call') return capHandler(msg)
    throw new Error(`unexpected request kind ${(msg as { kind: string }).kind}`)
  })
  await channel.request({ kind: 'register', childId, caps })
  return { client, channel }
}

describe('LocalChildRegistry', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []
  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  it('routes a cap call to the child that registered the cap', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const child = await makeFakeChild(
      nodeId,
      'reolink',
      [{ capName: 'ptz', mode: 'singleton' }],
      async (msg) => ({ called: msg.method, args: msg.args }),
    )
    clients.push(child.client)

    await expect(
      registry.callCap({ capName: 'ptz', method: 'move', args: { pan: 1 } }),
    ).resolves.toEqual({ called: 'move', args: { pan: 1 } })
  })

  it('routes by deviceId for device-scoped caps across two children', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const a = await makeFakeChild(
      nodeId,
      'child-a',
      [{ capName: 'motion-zones', mode: 'collection', deviceId: 1 }],
      async () => 'A',
    )
    const b = await makeFakeChild(
      nodeId,
      'child-b',
      [{ capName: 'motion-zones', mode: 'collection', deviceId: 2 }],
      async () => 'B',
    )
    clients.push(a.client, b.client)

    await expect(
      registry.callCap({ capName: 'motion-zones', method: 'getStatus', args: {}, deviceId: 1 }),
    ).resolves.toBe('A')
    await expect(
      registry.callCap({ capName: 'motion-zones', method: 'getStatus', args: {}, deviceId: 2 }),
    ).resolves.toBe('B')
  })

  it('routes a singleton cap call carrying a deviceId arg to the singleton child (regression: pipeline-runner.attachCamera)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    // `pipeline-runner` is a SINGLETON cap; its methods (attachCamera,
    // getCameraMetrics) carry `deviceId` as a method ARGUMENT. A present
    // deviceId must NOT exclude the singleton descriptor — otherwise the
    // call yields no route, falls through to the broker, and hangs.
    const child = await makeFakeChild(
      nodeId,
      'pipeline-runner',
      [{ capName: 'pipeline-runner', mode: 'singleton' }],
      async (msg) => ({ called: msg.method, deviceId: msg.deviceId }),
    )
    clients.push(child.client)

    expect(registry.resolveChildId('pipeline-runner', 5)).toBe('pipeline-runner')
    await expect(
      registry.callCap({
        capName: 'pipeline-runner',
        method: 'attachCamera',
        args: { deviceId: 5 },
        deviceId: 5,
      }),
    ).resolves.toEqual({ called: 'attachCamera', deviceId: 5 })
  })

  it('prefers an exact device-scoped owner over a singleton fallback for the same capName', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const dev = await makeFakeChild(
      nodeId,
      'dev-owner',
      [{ capName: 'dual', mode: 'collection', deviceId: 9 }],
      async () => 'device',
    )
    const singleton = await makeFakeChild(
      nodeId,
      'singleton-owner',
      [{ capName: 'dual', mode: 'singleton' }],
      async () => 'singleton',
    )
    clients.push(dev.client, singleton.client)

    // Exact device match wins; an unowned device falls back to the singleton.
    expect(registry.resolveChildId('dual', 9)).toBe('dev-owner')
    expect(registry.resolveChildId('dual', 99)).toBe('singleton-owner')
  })

  it('active-singleton preference: prefers the operator-selected addon when it maps to a candidate child id (grouped addon selectable)', async () => {
    const nodeId = nid()
    // Two children BOTH provide the singleton cap `turn-provider`:
    //   - a solo runner `static-turn-solo` (childId === addonId)
    //   - a group runner `net-access` hosting the addon `cloudflare-turn`
    // The operator selected `cloudflare-turn` (an addon id). Its runner child
    // id is `net-access` (the group). Without resolving addon→childId the
    // preference silently falls through to first-registered.
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      getActiveSingletonAddonId: (capName) =>
        capName === 'turn-provider' ? 'cloudflare-turn' : null,
      resolveChildIdForAddon: (addonId) => (addonId === 'cloudflare-turn' ? 'net-access' : addonId),
    })
    await registry.start()

    const solo = await makeFakeChild(
      nodeId,
      'static-turn-solo',
      [{ capName: 'turn-provider', mode: 'singleton' }],
      async () => 'solo',
    )
    const group = await makeFakeChild(
      nodeId,
      'net-access',
      [{ capName: 'turn-provider', mode: 'singleton' }],
      async () => 'group',
    )
    clients.push(solo.client, group.client)

    expect(registry.resolveChildId('turn-provider')).toBe('net-access')
  })

  it('active-singleton preference: ungrouped identity resolver picks the preferred addon by its own id (unchanged behaviour)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      getActiveSingletonAddonId: (capName) => (capName === 'webrtc-session' ? 'webrtc-b' : null),
      // no resolveChildIdForAddon → addonId === childId (today's default)
    })
    await registry.start()

    const a = await makeFakeChild(
      nodeId,
      'webrtc-a',
      [{ capName: 'webrtc-session', mode: 'singleton' }],
      async () => 'a',
    )
    const b = await makeFakeChild(
      nodeId,
      'webrtc-b',
      [{ capName: 'webrtc-session', mode: 'singleton' }],
      async () => 'b',
    )
    clients.push(a.client, b.client)

    expect(registry.resolveChildId('webrtc-session')).toBe('webrtc-b')
  })

  it('routes a collection cap to the SPECIFIC child by id, not the first registered (regression: addon-widgets-source aggregation)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    // `addon-widgets-source` is a system COLLECTION cap: multiple forked
    // addons register the SAME capName with no deviceId. The hub aggregator
    // must reach EACH addon's own provider — routing by capName alone
    // collapses every call to the first child, so all addons report the
    // first child's widgets and the rest vanish ("stream-broker-panel not
    // registered"). `callCapOnChild` targets the owning child explicitly.
    const a = await makeFakeChild(
      nodeId,
      'stream-broker',
      [{ capName: 'addon-widgets-source', mode: 'collection' }],
      async (msg) => ({ from: 'stream-broker', method: msg.method }),
    )
    const b = await makeFakeChild(
      nodeId,
      'pipeline-orchestrator',
      [{ capName: 'addon-widgets-source', mode: 'collection' }],
      async (msg) => ({ from: 'pipeline-orchestrator', method: msg.method }),
    )
    clients.push(a.client, b.client)

    expect(registry.childProvides('stream-broker', 'addon-widgets-source')).toBe(true)
    expect(registry.childProvides('pipeline-orchestrator', 'addon-widgets-source')).toBe(true)
    expect(registry.childProvides('does-not-exist', 'addon-widgets-source')).toBe(false)

    await expect(
      registry.callCapOnChild('stream-broker', {
        capName: 'addon-widgets-source',
        method: 'listWidgets',
        args: {},
      }),
    ).resolves.toEqual({ from: 'stream-broker', method: 'listWidgets' })
    await expect(
      registry.callCapOnChild('pipeline-orchestrator', {
        capName: 'addon-widgets-source',
        method: 'listWidgets',
        args: {},
      }),
    ).resolves.toEqual({ from: 'pipeline-orchestrator', method: 'listWidgets' })
  })

  it('callCapOnChild rejects when the named child is absent', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    await expect(
      registry.callCapOnChild('ghost', { capName: 'x', method: 'y', args: {} }),
    ).rejects.toThrow(/ghost/)
  })

  it('childProvides matches a device-scoped descriptor by deviceId on the named child', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    const c = await makeFakeChild(
      nodeId,
      'reolink',
      [{ capName: 'ptz', mode: 'collection', deviceId: 3 }],
      async () => 'ok',
    )
    clients.push(c.client)
    expect(registry.childProvides('reolink', 'ptz', 3)).toBe(true)
    expect(registry.childProvides('reolink', 'ptz', 4)).toBe(false)
  })

  it('isChildKnown reflects UDS connection regardless of which caps are announced', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    expect(registry.isChildKnown('auth-oidc')).toBe(false)
    const c = await makeFakeChild(
      nodeId,
      'auth-oidc',
      [{ capName: 'addon-routes', mode: 'collection' }],
      async () => 'ok',
    )
    clients.push(c.client)
    // Coarser than childProvides: true once the child handshake completed,
    // even before checking a specific cap — the gate the forked route-mount
    // path uses to pick the handler-stripped `callAddonOnChild` bridge.
    expect(registry.isChildKnown('auth-oidc')).toBe(true)
    expect(registry.childProvides('auth-oidc', 'addon-routes')).toBe(true)
    expect(registry.isChildKnown('does-not-exist')).toBe(false)
  })

  it('rejects a cap call when no child provides it', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    await expect(registry.callCap({ capName: 'nope', method: 'x', args: {} })).rejects.toThrow(
      'no local child provides cap "nope"',
    )
  })

  it('atomically replaces a child cap set on re-registration with the same id', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const client = createLocalTransport().createClient(nodeId)
    clients.push(client)
    const channel = await client.connect()
    channel.onRequest(async () => 'ok')

    await channel.request({
      kind: 'register',
      childId: 'c1',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
    })
    expect(registry.resolveChildId('ptz')).toBe('c1')
    expect(registry.resolveChildId('osd')).toBeNull()

    await channel.request({
      kind: 'register',
      childId: 'c1',
      caps: [{ capName: 'osd', mode: 'singleton' }],
    })
    expect(registry.resolveChildId('osd')).toBe('c1')
    expect(registry.resolveChildId('ptz')).toBeNull()
  })

  it('drops a child cap when the child disconnects', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    const gone: string[] = []
    registry.onChildGone((id) => gone.push(id))
    await registry.start()

    const child = await makeFakeChild(
      nodeId,
      'reolink',
      [{ capName: 'ptz', mode: 'singleton' }],
      async () => 'ok',
    )
    expect(registry.resolveChildId('ptz')).toBe('reolink')

    await child.client.close()
    await new Promise((r) => setTimeout(r, 30)) // let the close propagate to the server channel
    expect(registry.resolveChildId('ptz')).toBeNull()
    expect(gone).toEqual(['reolink'])
  })

  // Regression (2026-08-20, mass-update of 30 addons): an addon update replaces
  // a runner. `resolveRunnerId` is deterministic, so the SUCCESSOR connects
  // under the SAME childId and overwrites the map entry — then the predecessor's
  // socket close fired `children.delete(childId)` blind and evicted the LIVE
  // successor. The hub's `onChildGone` then unregistered `recording`,
  // `storage-evictable` and `recording-export` from a perfectly healthy process:
  // 7 hours of "Capability recording provider not available".
  it('ignores the close of a superseded channel when a successor holds the same childId', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    const gone: string[] = []
    registry.onChildGone((id) => gone.push(id))
    await registry.start()

    const oldRunner = await makeFakeChild(
      nodeId,
      'recorder',
      [{ capName: 'recording', mode: 'singleton' }],
      async () => 'old',
    )
    const newRunner = await makeFakeChild(
      nodeId,
      'recorder',
      [{ capName: 'recording', mode: 'singleton' }],
      async () => 'new',
    )
    clients.push(oldRunner.client, newRunner.client)

    // The predecessor's socket closes AFTER the successor handshook.
    await oldRunner.client.close()
    await new Promise((r) => setTimeout(r, 30))

    expect(gone).toEqual([])
    expect(registry.isChildKnown('recorder')).toBe(true)
    expect(registry.resolveChildId('recording')).toBe('recorder')
    await expect(registry.callCap({ capName: 'recording', method: 'x', args: {} })).resolves.toBe(
      'new',
    )
  })

  it('still reports the child gone when the live channel closes after a takeover', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    const gone: string[] = []
    registry.onChildGone((id) => gone.push(id))
    await registry.start()

    const oldRunner = await makeFakeChild(
      nodeId,
      'recorder',
      [{ capName: 'recording', mode: 'singleton' }],
      async () => 'old',
    )
    const newRunner = await makeFakeChild(
      nodeId,
      'recorder',
      [{ capName: 'recording', mode: 'singleton' }],
      async () => 'new',
    )
    clients.push(oldRunner.client, newRunner.client)

    await oldRunner.client.close()
    await new Promise((r) => setTimeout(r, 30))
    await newRunner.client.close()
    await new Promise((r) => setTimeout(r, 30))

    expect(gone).toEqual(['recorder'])
    expect(registry.isChildKnown('recorder')).toBe(false)
    expect(registry.resolveChildId('recording')).toBeNull()
  })

  it('gives each connection a distinct incarnation so a stale teardown is identifiable', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    const registered: RegisteredChild[] = []
    const gone: Array<{ childId: string; incarnation: number }> = []
    registry.onChildRegistered((child) => registered.push(child))
    registry.onChildGone((childId, incarnation) => gone.push({ childId, incarnation }))
    await registry.start()

    const oldRunner = await makeFakeChild(
      nodeId,
      'recorder',
      [{ capName: 'recording', mode: 'singleton' }],
      async () => 'old',
    )
    const newRunner = await makeFakeChild(
      nodeId,
      'recorder',
      [{ capName: 'recording', mode: 'singleton' }],
      async () => 'new',
    )
    clients.push(oldRunner.client, newRunner.client)

    expect(registered).toHaveLength(2)
    expect(registered[0]?.incarnation).not.toBe(registered[1]?.incarnation)
    expect(registry.listChildren()[0]?.incarnation).toBe(registered[1]?.incarnation)

    await newRunner.client.close()
    await new Promise((r) => setTimeout(r, 30))
    expect(gone).toEqual([{ childId: 'recorder', incarnation: registered[1]?.incarnation }])
  })
})

// ---------------------------------------------------------------------------
// cap-call-out node pin: own-node pin routes to the local sibling, other-node
// pin bypasses to onUnownedCall (regression: benchmark pipeline-executor on an
// agent — a pin to the node's OWN id was needlessly bounced to onUnownedCall →
// forwarded to the hub → "no provider registered for cap pipeline-executor").
// ---------------------------------------------------------------------------

describe('LocalChildRegistry — cap-call-out node pin', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  /** Connect a bare caller channel (no register) used to send `cap-call-out`. */
  async function connectCaller(nodeId: string): Promise<LocalChannel> {
    const client = createLocalTransport().createClient(nodeId)
    clients.push(client)
    const channel = await client.connect()
    channel.onRequest(async () => {
      throw new Error('caller received an unexpected inbound request')
    })
    return channel
  }

  /** Register a sibling that owns a singleton cap and echoes the call. */
  async function registerSibling(nodeId: string, capName: string): Promise<void> {
    const sibling = await makeFakeChild(
      nodeId,
      'detection-pipeline',
      [{ capName, mode: 'singleton' }],
      async (msg) => ({ from: 'sibling', method: msg.method }),
    )
    clients.push(sibling.client)
  }

  it('routes a pin to THIS node to the co-resident sibling, NOT onUnownedCall (benchmark on an agent)', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => 'UNOWNED')
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
    })
    await registry.start()
    await registerSibling(nodeId, 'pipeline-executor')

    const caller = await connectCaller(nodeId)
    // Inline `nodeId` pin naming THIS node (the way the benchmark pins a run to
    // the node it is on) — must be served by the co-resident sibling.
    const res = await caller.request({
      kind: 'cap-call-out',
      capName: 'pipeline-executor',
      method: 'runPipeline',
      args: { nodeId, steps: [] },
    })

    expect(res).toEqual({ from: 'sibling', method: 'runPipeline' })
    expect(unowned).not.toHaveBeenCalled()
  })

  it('routes a pin to ANOTHER node through onUnownedCall (pin must win over a same-named local sibling)', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => 'UNOWNED')
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
    })
    await registry.start()
    await registerSibling(nodeId, 'pipeline-executor')

    const caller = await connectCaller(nodeId)
    const res = await caller.request({
      kind: 'cap-call-out',
      capName: 'pipeline-executor',
      method: 'runPipeline',
      args: { nodeId: 'some-other-node', steps: [] },
    })

    // Bypasses the local sibling → onUnownedCall (the resolver would classify it
    // agent-child-forward / remote-moleculer for the pinned node).
    expect(res).toBe('UNOWNED')
    expect(unowned).toHaveBeenCalledOnce()
  })

  it('routes an UNPINNED call to the co-resident sibling (unchanged)', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => 'UNOWNED')
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
    })
    await registry.start()
    await registerSibling(nodeId, 'pipeline-executor')

    const caller = await connectCaller(nodeId)
    const res = await caller.request({
      kind: 'cap-call-out',
      capName: 'pipeline-executor',
      method: 'runPipeline',
      args: { steps: [] },
    })

    expect(res).toEqual({ from: 'sibling', method: 'runPipeline' })
    expect(unowned).not.toHaveBeenCalled()
  })

  it('without ownNodeId (legacy), a pin to this node still bypasses the sibling (behaviour preserved)', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => 'UNOWNED')
    // No `ownNodeId` → the registry can't tell self from other, so ANY pin
    // bypasses the local sibling exactly as before this fix.
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      onUnownedCall: unowned,
    })
    await registry.start()
    await registerSibling(nodeId, 'pipeline-executor')

    const caller = await connectCaller(nodeId)
    const res = await caller.request({
      kind: 'cap-call-out',
      capName: 'pipeline-executor',
      method: 'runPipeline',
      args: { nodeId, steps: [] },
    })

    expect(res).toBe('UNOWNED')
    expect(unowned).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Subscription-filtered event fan-out (T2)
// ---------------------------------------------------------------------------

/** A fake child that registers with an optional eventPatterns set and records inbound parent→child events. */
async function makeEventChild(
  nodeId: string,
  childId: string,
  eventPatterns: readonly string[] | undefined,
  caps: readonly ChildCapDescriptor[] = [{ capName: 'noop', mode: 'singleton' }],
): Promise<{ client: LocalTransportClient; channel: LocalChannel; received: SystemEvent[] }> {
  const client = createLocalTransport().createClient(nodeId)
  const channel = await client.connect()
  const received: SystemEvent[] = []
  channel.onRequest(async () => 'ok')
  channel.onEvent((body) => {
    const msg = body as ParentEventMessage
    if (msg.kind === 'event') received.push(msg.event)
  })
  await channel.request(
    eventPatterns === undefined
      ? { kind: 'register', childId, caps }
      : { kind: 'register', childId, caps, eventPatterns },
  )
  return { client, channel, received }
}

function evt(category: string): SystemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    source: { type: 'core', id: 'hub' },
    category,
    data: {},
  }
}

const flush = () => new Promise((r) => setTimeout(r, 20))

describe('LocalChildRegistry — subscription-filtered event fan-out', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  it('a child that declared patterns receives only matching categories', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const c = await makeEventChild(nodeId, 'pipe', ['pipeline.*', 'system.ready-state'])
    clients.push(c.client)

    registry.broadcastEventToChildren(evt('pipeline.trace'), 'hub')
    registry.broadcastEventToChildren(evt('system.ready-state'), 'hub')
    registry.broadcastEventToChildren(evt('device.online'), 'hub') // not subscribed
    await flush()

    expect(c.received.map((e) => e.category)).toEqual(['pipeline.trace', 'system.ready-state'])
  })

  it('a child that declared NO patterns (legacy/undeclared) receives ALL categories (fail-open)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const c = await makeEventChild(nodeId, 'legacy', undefined)
    clients.push(c.client)

    registry.broadcastEventToChildren(evt('pipeline.trace'), 'hub')
    registry.broadcastEventToChildren(evt('device.online'), 'hub')
    await flush()

    expect(c.received.map((e) => e.category)).toEqual(['pipeline.trace', 'device.online'])
  })

  it('an event-sub message replaces the child pattern set', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const c = await makeEventChild(nodeId, 'pipe', ['pipeline.*'])
    clients.push(c.client)

    // Initially only pipeline.* matches.
    registry.broadcastEventToChildren(evt('device.online'), 'hub')
    await flush()
    expect(c.received).toHaveLength(0)

    // Full-set replace → now only device.* matches, pipeline.* dropped.
    const sub: EventSubUpdateMessage = { kind: 'event-sub', patterns: ['device.*'] }
    c.channel.emit(sub)
    await flush()

    registry.broadcastEventToChildren(evt('device.online'), 'hub')
    registry.broadcastEventToChildren(evt('pipeline.trace'), 'hub')
    await flush()
    expect(c.received.map((e) => e.category)).toEqual(['device.online'])
  })

  it('wildcard patterns match with the same semantics as matchesPattern', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const star = await makeEventChild(nodeId, 'star', ['*'])
    const prefix = await makeEventChild(nodeId, 'prefix', ['pipeline.**'])
    clients.push(star.client, prefix.client)

    registry.broadcastEventToChildren(evt('pipeline.deep.trace'), 'hub')
    registry.broadcastEventToChildren(evt('device.online'), 'hub')
    await flush()

    expect(star.received.map((e) => e.category)).toEqual(['pipeline.deep.trace', 'device.online'])
    expect(prefix.received.map((e) => e.category)).toEqual(['pipeline.deep.trace'])
  })

  it('exceptChildId is still honored under filtering', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const a = await makeEventChild(nodeId, 'a', ['device.*'])
    const b = await makeEventChild(nodeId, 'b', ['device.*'])
    clients.push(a.client, b.client)

    registry.broadcastEventToChildren(evt('device.online'), 'hub', 'a')
    await flush()

    expect(a.received).toHaveLength(0) // origin excluded
    expect(b.received.map((e) => e.category)).toEqual(['device.online'])
  })

  it('increments sent (delivered) and suppressed (skipped) counters', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const c = await makeEventChild(nodeId, 'pipe', ['pipeline.*'])
    clients.push(c.client)

    registry.broadcastEventToChildren(evt('pipeline.trace'), 'hub') // sent
    registry.broadcastEventToChildren(evt('device.online'), 'hub') // suppressed
    await flush()

    const stats = registry.getChildEventStats('pipe')
    expect(stats).toEqual({ sent: 1, suppressed: 1 })
  })

  // -------------------------------------------------------------------------
  // D467 — per-CATEGORY production census (which categories are produced, and
  // how many children actually want each one).
  // -------------------------------------------------------------------------

  it('counts ONE broadcast per emit regardless of how many children are connected', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const a = await makeEventChild(nodeId, 'a', ['pipeline.*'])
    const b = await makeEventChild(nodeId, 'b', ['pipeline.*'])
    const c = await makeEventChild(nodeId, 'c', ['device.*'])
    clients.push(a.client, b.client, c.client)

    registry.broadcastEventToChildren(evt('pipeline.trace'), 'hub')
    registry.broadcastEventToChildren(evt('pipeline.trace'), 'hub')
    await flush()

    const cats = registry.categoryFanout()
    expect(cats).toEqual([{ category: 'pipeline.trace', broadcasts: 2, wanted: 4 }])
  })

  it('reports wanted=0 for a category NO child subscribes to (an orphan emit)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const a = await makeEventChild(nodeId, 'a', ['pipeline.*'])
    clients.push(a.client)

    registry.broadcastEventToChildren(evt('device.online'), 'hub')
    registry.broadcastEventToChildren(evt('device.online'), 'hub')
    registry.broadcastEventToChildren(evt('device.online'), 'hub')
    await flush()

    const orphan = registry.categoryFanout().find((s) => s.category === 'device.online')
    expect(orphan).toEqual({ category: 'device.online', broadcasts: 3, wanted: 0 })
  })

  it('bounds the census and REPORTS the overflow instead of dropping it silently', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    for (let i = 0; i < CATEGORY_CENSUS_MAX + 25; i++) {
      registry.broadcastEventToChildren(evt(`synthetic.cat-${i}`), 'hub')
    }

    expect(registry.categoryFanout()).toHaveLength(CATEGORY_CENSUS_MAX)
    expect(registry.categoryCensusOverflow()).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// Per-node aggregate event interest (D2 — cross-node Moleculer filtering)
// ---------------------------------------------------------------------------

describe('LocalChildRegistry — aggregateEventInterest (per-node cross-node interest)', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  it('with NO child ever connected the interest is null (fail-open, not empty)', async () => {
    // HIGH-1 boot-window guard: an empty set would drop 100% of inbound
    // cross-node events between broker.start() and the first child handshake.
    // "Never connected" must be null (fail-open), distinct from declared-empty.
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()
    expect(registry.aggregateEventInterest()).toBeNull()
  })

  it('returns [] only when a connected child declared an explicit empty set', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const c = await makeEventChild(nodeId, 'empty', [])
    clients.push(c.client)
    await flush()

    expect(registry.aggregateEventInterest()).toEqual([])
  })

  it('falls back to null once the last child disconnects (fail-open again)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const c = await makeEventChild(nodeId, 'only', ['pipeline.*'])
    clients.push(c.client)
    await flush()
    expect(registry.aggregateEventInterest()).toEqual(['pipeline.*'])

    await c.client.close()
    await flush()
    expect(registry.aggregateEventInterest()).toBeNull()
  })

  it("is the union of every child's declared patterns", async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const a = await makeEventChild(nodeId, 'a', ['pipeline.*', 'system.ready-state'])
    const b = await makeEventChild(nodeId, 'b', ['device.*', 'pipeline.*'])
    clients.push(a.client, b.client)
    await flush()

    const interest = registry.aggregateEventInterest()
    expect(interest).not.toBeNull()
    expect([...interest!].toSorted()).toEqual(
      ['device.*', 'pipeline.*', 'system.ready-state'].toSorted(),
    )
  })

  it('fails OPEN (null) when ANY child is undeclared', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const a = await makeEventChild(nodeId, 'a', ['pipeline.*'])
    const legacy = await makeEventChild(nodeId, 'legacy', undefined) // undeclared → fail-open
    clients.push(a.client, legacy.client)
    await flush()

    expect(registry.aggregateEventInterest()).toBeNull()
  })

  it('updates when a child changes its subscription via event-sub', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const c = await makeEventChild(nodeId, 'pipe', ['pipeline.*'])
    clients.push(c.client)
    await flush()
    expect(registry.aggregateEventInterest()).toEqual(['pipeline.*'])

    const sub: EventSubUpdateMessage = { kind: 'event-sub', patterns: ['device.*', 'motion.*'] }
    c.channel.emit(sub)
    await flush()
    expect([...registry.aggregateEventInterest()!].toSorted()).toEqual(['device.*', 'motion.*'])
  })

  it('shrinks when an interested child disconnects', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    const a = await makeEventChild(nodeId, 'a', ['pipeline.*'])
    const b = await makeEventChild(nodeId, 'b', ['device.*'])
    clients.push(a.client, b.client)
    await flush()
    expect([...registry.aggregateEventInterest()!].toSorted()).toEqual(['device.*', 'pipeline.*'])

    await b.client.close()
    await flush()
    expect(registry.aggregateEventInterest()).toEqual(['pipeline.*'])
  })
})

// ---------------------------------------------------------------------------
// cap-call-out COLLECTION fan-out (D1, 2026-07-30). A child calling a
// `mode:'collection'` cap was short-circuited to ONE local sibling
// (`resolveChildId` picks the first-registered), so it saw a fraction of the
// catalog the hub's own tRPC router returns. `notification-output` has three
// provider siblings; the Notification Center landed on one holding no targets,
// read the empty list as "target deleted", and permanently dead-lettered every
// notification it ever produced. An aggregated collection method must reach
// onUnownedCall, which owns the union across ALL providers (local siblings,
// in-process and remote alike).
// ---------------------------------------------------------------------------

describe('LocalChildRegistry — cap-call-out collection fan-out', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  async function connectCaller(nodeId: string): Promise<LocalChannel> {
    const client = createLocalTransport().createClient(nodeId)
    clients.push(client)
    const channel = await client.connect()
    channel.onRequest(async () => {
      throw new Error('caller received an unexpected inbound request')
    })
    return channel
  }

  async function registerCollectionSibling(
    nodeId: string,
    addonId: string,
    capName: string,
    answer: unknown,
  ): Promise<void> {
    const sibling = await makeFakeChild(
      nodeId,
      addonId,
      [{ capName, mode: 'collection' }],
      async () => answer,
    )
    clients.push(sibling.client)
  }

  it('sends an aggregated collection method to onUnownedCall instead of one sibling', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => [{ id: 'from-every-provider' }])
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
      isAggregatedCollectionMethod: (capName, method) =>
        capName === 'notification-output' && method === 'listTargets',
    })
    await registry.start()
    // The first-registered sibling holds NO targets — exactly the live shape.
    await registerCollectionSibling(nodeId, 'advanced-notifier', 'notification-output', [])
    await registerCollectionSibling(nodeId, 'notifiers', 'notification-output', [{ id: 'zentik' }])

    const caller = await connectCaller(nodeId)
    const res = await caller.request({
      kind: 'cap-call-out',
      capName: 'notification-output',
      method: 'listTargets',
      args: {},
    })

    expect(res).toEqual([{ id: 'from-every-provider' }])
    expect(unowned).toHaveBeenCalledOnce()
  })

  it('keeps routing a NON-aggregated method of the same cap to the local sibling', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => 'UNOWNED')
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
      isAggregatedCollectionMethod: (_capName, method) => method === 'listTargets',
    })
    await registry.start()
    await registerCollectionSibling(nodeId, 'notifiers', 'notification-output', { sent: true })

    const caller = await connectCaller(nodeId)
    const res = await caller.request({
      kind: 'cap-call-out',
      capName: 'notification-output',
      method: 'send',
      args: {},
    })

    expect(res).toEqual({ sent: true })
    expect(unowned).not.toHaveBeenCalled()
  })

  it('sends an { addonId }-pinned call to onUnownedCall instead of the first sibling', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => ({ baseUrl: 'http://ha:8123' }))
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
      isAddonPinnedCall: (_cap, _method, args) =>
        typeof (args as { addonId?: unknown })?.addonId === 'string',
    })
    await registry.start()
    // The live shape: Homematic registers first and answers `null` for a broker
    // it does not own, which the caller cannot tell from "no such broker".
    await registerCollectionSibling(nodeId, 'provider-homematic', 'broker', null)
    await registerCollectionSibling(nodeId, 'provider-homeassistant', 'broker', {
      baseUrl: 'http://ha:8123',
    })

    const caller = await connectCaller(nodeId)
    const res = await caller.request({
      kind: 'cap-call-out',
      capName: 'broker',
      method: 'getBrokerConfig',
      args: { id: 'ha_001', addonId: 'provider-homeassistant' },
    })

    expect(res).toEqual({ baseUrl: 'http://ha:8123' })
    expect(unowned).toHaveBeenCalledOnce()
  })

  it('keeps routing the SAME method to the sibling when it carries no pin', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => 'UNOWNED')
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
      isAddonPinnedCall: (_cap, _method, args) =>
        typeof (args as { addonId?: unknown })?.addonId === 'string',
    })
    await registry.start()
    await registerCollectionSibling(nodeId, 'provider-homematic', 'broker', { from: 'sibling' })

    const caller = await connectCaller(nodeId)
    const res = await caller.request({
      kind: 'cap-call-out',
      capName: 'broker',
      method: 'getBrokerConfig',
      args: { id: 'hm_001' },
    })

    expect(res).toEqual({ from: 'sibling' })
    expect(unowned).not.toHaveBeenCalled()
  })

  it('an explicit pin to ANOTHER node still bypasses the aggregate path', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => 'UNOWNED')
    const isAggregated = vi.fn(() => true)
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
      isAggregatedCollectionMethod: isAggregated,
    })
    await registry.start()
    await registerCollectionSibling(nodeId, 'notifiers', 'notification-output', [])

    const caller = await connectCaller(nodeId)
    const res = await caller.request({
      kind: 'cap-call-out',
      capName: 'notification-output',
      method: 'listTargets',
      args: {},
      nodeId: 'agent-a',
    })

    // Still onUnownedCall (the pin's own route), and the aggregate predicate
    // never decides it — the pin does.
    expect(res).toBe('UNOWNED')
    expect(unowned).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------

/**
 * The COLLECTION PROVIDER PIN, over the wire a forked addon really uses.
 *
 * ## Why this file gained a second pin block
 *
 * The block above pins the NODE pin, end to end, through a real channel. There
 * was no equivalent for the provider pin — and between 2026-09-21 and
 * 2026-09-22 one bug was fixed four times because of it:
 *
 *   D592  the hub's tRPC mount          — a forked addon never reaches a mount
 *   D593  the Moleculer transport link  — a hub-local runner is broker-less
 *   D594  the parent's UDS route        — the predicate that gates it saw `{}`
 *   D595  the routing envelope          — which is why it saw `{}`
 *
 * Every one of those fixes was correct, every one was verified by a unit test
 * of the layer it touched, and the operator's clip came back from the wrong
 * provider all four times ("an analytics visit has no file behind it", then
 * "was not minted by the HomeKit source"). What none of them had is THIS: a
 * call issued the way an addon issues it, asserting where it lands.
 *
 * So these cases deliberately do not call `devicePinOf`, `liftRoutingHints` or
 * `pinnedDeviceCollectionCall`. They send a `cap-call-out` frame and look at
 * which side answered. A fix that does not survive that is not a fix.
 */
describe('LocalChildRegistry — cap-call-out PROVIDER pin (D592–D595)', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  async function connectCaller(nodeId: string): Promise<LocalChannel> {
    const client = createLocalTransport().createClient(nodeId)
    clients.push(client)
    const channel = await client.connect()
    channel.onRequest(async () => {
      throw new Error('caller received an unexpected inbound request')
    })
    return channel
  }

  /**
   * The hub's real shape on the day this was written: `export-hap` registers
   * `videoclips` with NO deviceId, so `deviceOwner` misses and
   * `resolveChildId` falls through to `singletonCandidates[0]` — which is
   * whichever child registered first. It registered first here, on purpose.
   */
  async function registerTwoVideoclipsProviders(nodeId: string): Promise<void> {
    for (const childId of ['export-hap', 'provider-reolink'] as const) {
      const child = await makeFakeChild(
        nodeId,
        childId,
        [{ capName: 'videoclips', mode: 'collection' }],
        async () => ({ answeredBy: childId }),
      )
      clients.push(child.client)
    }
  }

  const CLIP_READ = {
    kind: 'cap-call-out' as const,
    capName: 'videoclips',
    method: 'readClipBytes',
    args: {
      deviceId: 3628,
      clipId: 'native:reolink:onboard:0:abc',
      provider: 'provider-reolink',
      profile: 'low',
    },
  }

  it('a pinned read BYPASSES the sibling short-circuit and reaches onUnownedCall', async () => {
    // This is the whole bug in one assertion. Without the pin reaching the
    // bypass predicate, `resolveChildId` answers `export-hap` and the operator
    // gets "was not minted by the HomeKit source" for a Reolink file.
    const nodeId = nid()
    const unowned = vi.fn(async () => ({ answeredBy: 'onUnownedCall' }))
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
      // The production wiring: BOTH pins are recognised here, because a pin
      // this predicate does not see is short-circuited before the routing that
      // would honour it ever runs.
      isAddonPinnedCall: (_cap, _method, hints) =>
        typeof (hints as { provider?: unknown }).provider === 'string',
    })
    await registry.start()
    await registerTwoVideoclipsProviders(nodeId)

    const caller = await connectCaller(nodeId)
    const res = await caller.request(CLIP_READ)

    expect(res).toEqual({ answeredBy: 'onUnownedCall' })
    expect(unowned).toHaveBeenCalledOnce()
  })

  it('the parent is handed the pin AND its device — it can resolve neither alone', async () => {
    const nodeId = nid()
    const seen: unknown[] = []
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: async (input) => {
        seen.push(input.args)
        return { answeredBy: 'onUnownedCall' }
      },
      isAddonPinnedCall: (_cap, _method, hints) =>
        typeof (hints as { provider?: unknown }).provider === 'string',
    })
    await registry.start()
    await registerTwoVideoclipsProviders(nodeId)

    await (await connectCaller(nodeId)).request(CLIP_READ)

    expect(seen[0]).toMatchObject({ deviceId: 3628, provider: 'provider-reolink' })
  })

  it('WITHOUT the pin in the envelope it goes to the first sibling — the bug, verbatim', async () => {
    // The predicate reads the hints; a registry whose envelope does not carry
    // `provider` hands it `{}`. This reproduces exactly what the operator saw
    // for two days, and it is here so the next person can see the difference
    // between the two cases side by side rather than in four ADRs.
    const nodeId = nid()
    const unowned = vi.fn(async () => ({ answeredBy: 'onUnownedCall' }))
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
      isAddonPinnedCall: () => false,
    })
    await registry.start()
    await registerTwoVideoclipsProviders(nodeId)

    const res = await (await connectCaller(nodeId)).request(CLIP_READ)

    expect(res).toEqual({ answeredBy: 'export-hap' })
    expect(unowned).not.toHaveBeenCalled()
  })

  it('an UNPINNED read still reaches a sibling — unchanged, and deliberately so', async () => {
    const nodeId = nid()
    const unowned = vi.fn(async () => ({ answeredBy: 'onUnownedCall' }))
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
      isAddonPinnedCall: (_cap, _method, hints) =>
        typeof (hints as { provider?: unknown }).provider === 'string',
    })
    await registry.start()
    await registerTwoVideoclipsProviders(nodeId)

    const { provider: _dropped, ...unpinned } = CLIP_READ.args
    const res = await (await connectCaller(nodeId)).request({ ...CLIP_READ, args: unpinned })

    expect(res).toEqual({ answeredBy: 'export-hap' })
    expect(unowned).not.toHaveBeenCalled()
  })
})
