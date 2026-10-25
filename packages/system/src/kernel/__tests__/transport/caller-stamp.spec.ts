import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapRouteError, type CapRoute } from '../../transport/cap-route.js'
import { type CapRouteResolver, stampCallerAddonId } from '../../transport/cap-route-resolver.js'
import type { CapCallInput, ChildCapDescriptor } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import {
  createHubCapForwardService,
  type HubCapForwardOptions,
  type HubUnownedCallHandler,
} from '../../transport/hub-cap-forward.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import { createParentUnownedCallHandler } from '../../transport/parent-unowned-call.js'

/**
 * D787: WHO is calling is the transport's stamp, never the caller's claim.
 * The keychain owner-checks on it, so every plane that carries a cap call must
 * stamp (overwrite) or strip — never pass a claim through.
 */

describe('stampCallerAddonId', () => {
  it('a stamp overwrites a claim', () => {
    expect(stampCallerAddonId({ ref: 'r', callerAddonId: 'spoof' }, 'real')).toEqual({
      ref: 'r',
      callerAddonId: 'real',
    })
  })

  it('no stamp strips a claim', () => {
    expect(stampCallerAddonId({ ref: 'r', callerAddonId: 'spoof' }, undefined)).toEqual({
      ref: 'r',
    })
  })

  it('leaves unclaimed args and non-objects alone', () => {
    const args = { ref: 'r' }
    expect(stampCallerAddonId(args, undefined)).toBe(args)
    expect(stampCallerAddonId('x', 'real')).toBe('x')
    expect(stampCallerAddonId([1], 'real')).toEqual([1])
  })
})

function forwardHandler(
  onUnowned: HubUnownedCallHandler,
  options?: HubCapForwardOptions,
): (ctx: { params: unknown; nodeID?: string }) => Promise<unknown> {
  const schema = createHubCapForwardService(onUnowned, options)
  const forward = (schema.actions ?? {})['forward']
  if (typeof forward !== 'object' || forward === null || forward.handler === undefined) {
    throw new Error('forward action missing')
  }
  return forward.handler as unknown as (ctx: {
    params: unknown
    nodeID?: string
  }) => Promise<unknown> // documented boundary: Moleculer's untyped action handler
}

describe('$hub-cap-fwd carries the agent-stamped caller', () => {
  it('passes the envelope caller to the hub routing when the sender hosts it', async () => {
    const seen: CapCallInput[] = []
    const handler = forwardHandler(
      async (input) => {
        seen.push(input)
        return null
      },
      { isCallerOnNode: (node, runner) => node === 'mac-agent' && runner === 'ml' },
    )
    await handler({
      params: { capName: 'keychain', method: 'resolve', args: { refs: [] }, callerAddonId: 'ml' },
      nodeID: 'mac-agent',
    })
    expect(seen[0]?.callerAddonId).toBe('ml')
  })

  it('drops a stamp the sending agent does not host — the call goes on anonymous', async () => {
    const seen: CapCallInput[] = []
    const rejected: string[] = []
    const handler = forwardHandler(
      async (input) => {
        seen.push(input)
        return null
      },
      {
        isCallerOnNode: () => false,
        onRejectedCaller: (node, runner) => rejected.push(`${node}:${runner}`),
      },
    )
    await handler({
      params: { capName: 'keychain', method: 'resolve', args: {}, callerAddonId: 'auth' },
      nodeID: 'unraid-agent',
    })
    expect(seen[0]?.callerAddonId).toBeUndefined()
    expect(rejected).toEqual(['unraid-agent:auth'])
  })

  it('the agent forwards its child stamp to the hub', async () => {
    const forwardToHub = vi.fn(async (_input: CapCallInput) => 'ok')
    const handler = createParentUnownedCallHandler({
      getResolver: () => null,
      broker: { call: vi.fn() } as never,
      nodeRegistry: { listNativeCapEntriesForDevice: () => [] } as never,
      forwardToHub,
    })
    await handler({
      capName: 'keychain',
      method: 'resolve',
      args: { refs: [] },
      callerAddonId: 'ml',
    })
    expect(forwardToHub.mock.calls[0]?.[0]).toMatchObject({ callerAddonId: 'ml' })
  })
})

describe('the sibling short-circuit stamps the caller into the serving child', () => {
  const nid = (): string => `hub-stamp-${process.pid}-${Math.random().toString(36).slice(2)}`
  let registry: LocalChildRegistry | null = null
  const clients: LocalChildClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  async function child(
    nodeId: string,
    childId: string,
    caps: readonly ChildCapDescriptor[],
    received: CapCallInput[],
  ): Promise<LocalChildClient> {
    const client = new LocalChildClient({
      nodeId,
      childId,
      caps,
      dispatch: async (call) => {
        received.push(call)
        return 'ok'
      },
    })
    await client.start()
    clients.push(client)
    return client
  }

  it('a claim in the args is overwritten by the parent-known caller (raw-forward path)', async () => {
    const nodeId = nid()
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
    })
    await registry.start()
    const served: CapCallInput[] = []
    await child(nodeId, 'provider', [{ capName: 'ptz', mode: 'singleton' }], served)
    const caller = await child(nodeId, 'cloudflare-tunnel', [], [])
    await caller.callOut({
      capName: 'ptz',
      method: 'move',
      args: { pan: 1, callerAddonId: 'auth-oidc' },
    })
    expect(served[0]?.args).toEqual({ pan: 1, callerAddonId: 'cloudflare-tunnel' })
  })
})

describe('the hub keeps the stamp across the provider-not-yet-registered retry', () => {
  it('a retried dispatch still carries the caller', async () => {
    vi.useFakeTimers()
    try {
      const route: CapRoute = { kind: 'hub-local-uds', capName: 'keychain', childId: 'x' }
      let calls = 0
      const dispatched: unknown[][] = []
      const resolver = {
        resolveCapRoute: (capName: string): CapRoute => {
          calls += 1
          if (calls === 1)
            throw new CapRouteError(capName, undefined, { reason: 'no-provider', rejected: [] })
          return route
        },
        dispatch: async (...args: unknown[]) => {
          dispatched.push(args)
          return 'ok'
        },
      }
      const handler = createParentUnownedCallHandler({
        getResolver: () => resolver as unknown as CapRouteResolver, // documented test boundary: structural subset
        broker: { call: vi.fn() } as never,
        nodeRegistry: { listNativeCapEntriesForDevice: () => [] } as never,
        isCoreServiceCap: () => false,
      })
      const promise = handler({
        capName: 'keychain',
        method: 'resolve',
        args: { refs: [] },
        callerAddonId: 'tailscale',
      })
      await vi.advanceTimersByTimeAsync(5_000)
      await promise
      expect(dispatched[0]?.[4]).toBe('tailscale')
    } finally {
      vi.useRealTimers()
    }
  })
})
