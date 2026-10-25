/**
 * $hub-cap-fwd — unit tests for the hub-side agent→hub cap-forward service and
 * the agent-side forwardToHub fallback in parent-unowned-call.
 *
 * Covers:
 *   - forward action narrows params and invokes the hub's onUnownedCall
 *   - forward passes deviceId/nodeId hints through; omits them when absent
 *   - invalid params (missing capName/method) throw
 *   - parent-unowned-call: agent path forwards a resolver-miss cap to the hub
 *     (forwardToHub) instead of the raw broker; hub path keeps brokerCallForCap
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createHubCapForwardService,
  HUB_CAP_FWD_SERVICE,
  HUB_CAP_FWD_ACTION,
} from '../../transport/hub-cap-forward.js'
import type { HubUnownedCallHandler } from '../../transport/hub-cap-forward.js'
import { createParentUnownedCallHandler } from '../../transport/parent-unowned-call.js'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'

// A minimal Moleculer Context stand-in: only `params` is read by the handler.
function ctxWith(params: unknown): { params: unknown } {
  return { params }
}

// Extract the forward handler from the built ServiceSchema without unsafe casts.
function forwardHandlerOf(
  onUnowned: HubUnownedCallHandler,
): (ctx: { params: unknown }) => Promise<unknown> {
  const schema = createHubCapForwardService(onUnowned)
  const actions = schema.actions ?? {}
  const forward = actions['forward']
  // Moleculer types an action entry as `boolean | ActionSchema` (a `false`
  // disables it), so anything non-object carries no handler at all.
  if (typeof forward !== 'object' || forward === null || forward.handler === undefined) {
    throw new Error('forward action or handler missing')
  }
  return forward.handler as unknown as (ctx: { params: unknown }) => Promise<unknown>
}

describe('$hub-cap-fwd service', () => {
  it('exposes the expected service + action names', () => {
    expect(HUB_CAP_FWD_SERVICE).toBe('$hub-cap-fwd')
    expect(HUB_CAP_FWD_ACTION).toBe('$hub-cap-fwd.forward')
    expect(createHubCapForwardService(async () => null).name).toBe('$hub-cap-fwd')
  })

  it('narrows params and invokes onUnownedCall with capName/method/args', async () => {
    const seen: CapCallInput[] = []
    const onUnowned: HubUnownedCallHandler = async (input) => {
      seen.push(input)
      return { ok: true }
    }
    const handler = forwardHandlerOf(onUnowned)
    const result = await handler(
      ctxWith({ capName: 'stream-broker', method: 'listAllProfileSlots', args: undefined }),
    )
    expect(result).toEqual({ ok: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.capName).toBe('stream-broker')
    expect(seen[0]?.method).toBe('listAllProfileSlots')
    expect(seen[0]?.deviceId).toBeUndefined()
    expect(seen[0]?.nodeId).toBeUndefined()
  })

  it('passes deviceId + nodeId routing hints through', async () => {
    const seen: CapCallInput[] = []
    const handler = forwardHandlerOf(async (input) => {
      seen.push(input)
      return null
    })
    await handler(
      ctxWith({
        capName: 'switch',
        method: 'getStatus',
        args: { deviceId: 7 },
        deviceId: 7,
        nodeId: 'agent-a',
      }),
    )
    expect(seen[0]?.deviceId).toBe(7)
    expect(seen[0]?.nodeId).toBe('agent-a')
  })

  it('drops a forged `caller` from the forwarded args (D802)', async () => {
    // `keychainAdmin.reveal` reads `input.caller.userId`: a mesh peer that
    // could set it would reveal any secret as any admin.
    const seen: CapCallInput[] = []
    const handler = forwardHandlerOf(async (input) => {
      seen.push(input)
      return null
    })
    await handler(
      ctxWith({
        capName: 'keychain-admin',
        method: 'reveal',
        args: {
          ref: 'secret://system/global/clusterSecret',
          caller: { userId: 'u', isAdmin: true },
        },
      }),
    )
    expect(seen[0]?.args).toEqual({ ref: 'secret://system/global/clusterSecret' })
  })

  it('throws on invalid params (missing capName/method)', async () => {
    const handler = forwardHandlerOf(async () => null)
    await expect(handler(ctxWith({ method: 'x', args: null }))).rejects.toThrow(
      /capName and method/,
    )
    await expect(handler(ctxWith(null))).rejects.toThrow(/capName and method/)
  })
})

describe('parent-unowned-call forwardToHub (agent path)', () => {
  const baseDeps = {
    getResolver: () => null,
    // Broker must NOT be used on the agent forward path.
    broker: {
      call: vi.fn(async () => {
        throw new Error('broker.call must not be used when forwardToHub is set')
      }),
    } as never,
    nodeRegistry: {
      listNativeCapEntriesForDevice: () => [],
    } as never,
  }

  it('forwards a singleton resolver-miss cap to the hub, not the broker', async () => {
    // Declare the parameter so the recorded call tuple keeps its `CapCallInput`
    // element — a param-less `vi.fn` records `[]` and the assertion below could
    // not reach `calls[0][0]`.
    const forwardToHub = vi.fn(async (_input: CapCallInput) => ['slot-a', 'slot-b'])
    const handler = createParentUnownedCallHandler({ ...baseDeps, forwardToHub })
    const out = await handler({
      capName: 'stream-broker',
      method: 'listAllProfileSlots',
      args: undefined,
    })
    expect(out).toEqual(['slot-a', 'slot-b'])
    expect(forwardToHub).toHaveBeenCalledTimes(1)
    expect(forwardToHub.mock.calls[0]?.[0]).toMatchObject({
      capName: 'stream-broker',
      method: 'listAllProfileSlots',
    })
  })
})
