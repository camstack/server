/**
 * `native: true` — how a FORKED WRAPPER reaches the per-device native behind
 * its own capability name.
 *
 * ## The failure these pin
 *
 * A wrapper and its natives share one cap name. While the wrapper lived in
 * hub-main that was harmless: it resolved the native through the hub's
 * `CapabilityRegistry`, which knows which is which. Move the wrapper into a
 * runner (the snapshot split) and every generic route out of that process
 * resolves the name the way every OTHER caller does — to the wrapper. The
 * wrapper calls itself, the second entry joins the first's single flight, and
 * the call waits forever on a promise only it can settle. Nothing throws,
 * nothing logs; the vendor native is simply never invoked and every camera
 * silently degrades to the ffmpeg fallback (or hangs).
 *
 * The fix is that the INTENT travels: `native: true` on the cap-call-out.
 * Two things have to honour it, and each is pinned below.
 *   1. `LocalChildRegistry` must not short-circuit the call to a local sibling
 *      — including the caller's own child, which is what `resolveChildId`
 *      returns for a deviceId-less descriptor.
 *   2. `createParentUnownedCallHandler` must answer from the ONE native
 *      authority (`resolveNative`, wired to `CapabilityRegistry`), and FAIL
 *      when there is no native rather than falling back to cap-name routing.
 *
 * The failure message is load-bearing too: wrappers match it to decide
 * "absent native → run my own strategy" rather than "the camera is broken".
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import { createParentUnownedCallHandler } from '../../transport/parent-unowned-call.js'
import type { CapRoute } from '../../transport/cap-route.js'
import type { CapRouteResolver } from '../../transport/cap-route-resolver.js'
import { HubNodeRegistry } from '../../moleculer/node-registry.js'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'
import type { LocalTransportClient, LocalChannel } from '../../transport/local-transport.js'
import type { CapCallMessage, ChildCapDescriptor } from '../../transport/child-cap-protocol.js'
import type { ServiceBroker } from 'moleculer'

const nid = (): string => `native-test-${process.pid}-${Math.random().toString(36).slice(2)}`

/**
 * The exact predicate the snapshot wrapper uses to tell "no native for this
 * device" apart from "the native failed". Copied verbatim from
 * `builtins/snapshot/snapshot.addon.ts` so a reworded error surfaces HERE
 * rather than as a camera that quietly stops using its vendor snapshot.
 */
function isAbsentNativeError(msg: string): boolean {
  return msg.includes('no provider for') || msg.includes('no native provider for capability')
}

async function makeChild(
  nodeId: string,
  childId: string,
  caps: readonly ChildCapDescriptor[],
): Promise<{ client: LocalTransportClient; channel: LocalChannel }> {
  const client = createLocalTransport().createClient(nodeId)
  const channel = await client.connect()
  channel.onRequest(async (body) => {
    const msg = body as CapCallMessage
    if (msg.kind === 'cap-call') return { servedBySibling: childId, method: msg.method }
    throw new Error(`unexpected ${(msg as { kind: string }).kind}`)
  })
  await channel.request({ kind: 'register', childId, caps })
  return { client, channel }
}

function nodeRegistryFake(): HubNodeRegistry {
  return { listNativeCapEntriesForDevice: () => [] } as unknown as HubNodeRegistry
}

function brokerFake(): ServiceBroker {
  return {
    nodeID: 'hub',
    call: vi.fn(async () => {
      throw new Error('broker fallback must not be reached for a native call')
    }),
    waitForServices: vi.fn(async () => undefined),
    registry: { getServiceList: () => [] },
  } as unknown as ServiceBroker
}

describe('LocalChildRegistry — `native: true` never resolves to a sibling', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []
  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  it('sends a native call to onUnownedCall even when the CALLER itself owns the cap name', async () => {
    const nodeId = nid()
    const seen: CapCallInput[] = []
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      onUnownedCall: async (input) => {
        seen.push(input)
        return { routedByParent: true }
      },
    })
    await registry.start()

    // The wrapper runner: it PROVIDES `snapshot` as a deviceId-less singleton.
    // That descriptor is exactly what `resolveChildId('snapshot', 7)` falls
    // back to when no device-scoped owner is registered — i.e. itself.
    const wrapper = await makeChild(nodeId, 'snapshot', [
      { capName: 'snapshot', mode: 'singleton' },
    ])
    clients.push(wrapper.client)

    const result = await wrapper.channel.request({
      kind: 'cap-call-out',
      capName: 'snapshot',
      method: 'getSnapshot',
      args: { deviceId: 7 },
      deviceId: 7,
      native: true,
    })

    expect(result).toEqual({ routedByParent: true })
    expect(seen).toEqual([
      {
        capName: 'snapshot',
        method: 'getSnapshot',
        args: { deviceId: 7 },
        deviceId: 7,
        native: true,
        // The wrapper runner's own registered childId — same mechanism as
        // the non-native case, unaffected by the native-routing flag.
        callerAddonId: 'snapshot',
      },
    ])
  })

  it('WITHOUT the flag the same call is short-circuited back to the caller (the bug)', async () => {
    const nodeId = nid()
    const onUnownedCall = vi.fn(async () => ({ routedByParent: true }))
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      onUnownedCall,
    })
    await registry.start()

    const wrapper = await makeChild(nodeId, 'snapshot', [
      { capName: 'snapshot', mode: 'singleton' },
    ])
    clients.push(wrapper.client)

    const result = await wrapper.channel.request({
      kind: 'cap-call-out',
      capName: 'snapshot',
      method: 'getSnapshot',
      args: { deviceId: 7 },
      deviceId: 7,
    })

    // Answered by the wrapper's own child — in production that is the wrapper
    // re-entering itself. This is the behaviour `native: true` exists to avoid,
    // and it stays correct for every ordinary sibling call.
    expect(result).toEqual({ servedBySibling: 'snapshot', method: 'getSnapshot' })
    expect(onUnownedCall).not.toHaveBeenCalled()
  })
})

describe('createParentUnownedCallHandler — the native branch', () => {
  it('calls the native provider and injects deviceId into the args', async () => {
    const getSnapshot = vi.fn(async () => ({ base64: 'AAA', contentType: 'image/jpeg' }))
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      resolveNative: (capName, deviceId) =>
        capName === 'snapshot' && deviceId === 102 ? { getSnapshot } : null,
    })

    const out = await handler({
      capName: 'snapshot',
      method: 'getSnapshot',
      args: { streamId: 'high' },
      deviceId: 102,
      native: true,
    })

    expect(out).toEqual({ base64: 'AAA', contentType: 'image/jpeg' })
    expect(getSnapshot).toHaveBeenCalledWith({ streamId: 'high', deviceId: 102 })
  })

  it('never consults the resolver — that is the path that returns the wrapper', async () => {
    const resolveCapRoute = vi.fn((): CapRoute => {
      throw new Error('resolver must not be consulted for a native call')
    })
    const resolver = { resolveCapRoute, dispatch: vi.fn() } as unknown as CapRouteResolver
    const handler = createParentUnownedCallHandler({
      getResolver: () => resolver,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      resolveNative: () => ({ getSnapshot: async () => ({ ok: true }) }),
    })

    await expect(
      handler({
        capName: 'snapshot',
        method: 'getSnapshot',
        args: { deviceId: 102 },
        deviceId: 102,
        native: true,
      }),
    ).resolves.toEqual({ ok: true })
    expect(resolveCapRoute).not.toHaveBeenCalled()
  })

  it('fails — with a message the wrapper reads as ABSENT — when no native owns the device', async () => {
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      resolveNative: () => null,
    })

    const err = await handler({
      capName: 'snapshot',
      method: 'getSnapshot',
      args: { deviceId: 42 },
      deviceId: 42,
      native: true,
    }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    )

    expect(err).not.toBeNull()
    expect(isAbsentNativeError(err?.message ?? '')).toBe(true)
    expect(err?.message).toContain('42')
  })

  it('fails as ABSENT when the native exists but does not implement the method', async () => {
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      resolveNative: () => ({ invalidateCache: async () => undefined }),
    })

    const err = await handler({
      capName: 'snapshot',
      method: 'getSnapshot',
      args: { deviceId: 9 },
      deviceId: 9,
      native: true,
    }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    )

    expect(isAbsentNativeError(err?.message ?? '')).toBe(true)
  })

  it('an AGENT (no native authority of its own) forwards the flag to the hub', async () => {
    const forwardToHub = vi.fn(async () => ({ fromHub: true }))
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      forwardToHub,
    })

    const out = await handler({
      capName: 'snapshot',
      method: 'getSnapshot',
      args: { deviceId: 5 },
      deviceId: 5,
      native: true,
    })

    expect(out).toEqual({ fromHub: true })
    expect(forwardToHub).toHaveBeenCalledWith({
      capName: 'snapshot',
      method: 'getSnapshot',
      args: { deviceId: 5 },
      deviceId: 5,
      native: true,
    })
  })

  it('refuses a native call with no deviceId rather than routing it by cap name', async () => {
    const resolveCapRoute = vi.fn((): CapRoute => {
      throw new Error('resolver must not be consulted')
    })
    const handler = createParentUnownedCallHandler({
      getResolver: () => ({ resolveCapRoute, dispatch: vi.fn() }) as unknown as CapRouteResolver,
      broker: brokerFake(),
      nodeRegistry: nodeRegistryFake(),
      resolveNative: () => ({ getSnapshot: async () => ({ ok: true }) }),
    })

    await expect(
      handler({ capName: 'snapshot', method: 'getSnapshot', args: {}, native: true }),
    ).rejects.toThrow(/no native provider for capability/)
    expect(resolveCapRoute).not.toHaveBeenCalled()
  })
})
