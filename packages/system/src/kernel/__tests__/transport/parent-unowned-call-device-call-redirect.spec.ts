/**
 * The PARENT-ROUTED entry for a device-scoped call a redirect takes over
 * (D963): `createParentUnownedCallHandler` routes by name STRAIGHT to the
 * owning runner, so before routing it asks the registry's redirect through the
 * one shared `answerDeviceCallRedirect`. A covered call that is redirected is
 * answered from the redirect and the resolver is never consulted; a call that
 * is not covered, or that nothing takes over, routes exactly as before.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ServiceBroker } from 'moleculer'
import type { DeviceCall, DeviceCallAnswer } from '@camstack/types'
import { createParentUnownedCallHandler } from '../../transport/parent-unowned-call.js'
import type { DeviceCallRedirectHook } from '../../transport/device-call-redirect.js'
import type { CapRoute } from '../../transport/cap-route.js'
import type { CapRouteResolver } from '../../transport/cap-route-resolver.js'
import type { HubNodeRegistry, NodeNativeCapEntry } from '../../moleculer/node-registry.js'

const DEVICE = 12

function nodeRegistryFake(): HubNodeRegistry {
  const fake = { listNativeCapEntriesForDevice: (): readonly NodeNativeCapEntry[] => [] }
  // Structural subset the handler reads; documented test boundary as in the sibling spec.
  return fake as unknown as HubNodeRegistry
}

function brokerFake(): ServiceBroker {
  const broker = {
    nodeID: 'hub',
    call: vi.fn(async () => {
      throw new Error('broker must not be consulted')
    }),
    waitForServices: vi.fn(async () => undefined),
    registry: { getServiceList: () => [] },
  }
  return broker as unknown as ServiceBroker
}

function routingResolver() {
  const invoked: { method: string; args: unknown }[] = []
  const route: CapRoute = {
    kind: 'hub-in-process',
    capName: 'media-player',
    ref: { invoke: async () => undefined },
  }
  const resolveCapRoute = vi.fn(() => route)
  const resolver = {
    resolveCapRoute,
    dispatch: vi.fn(async (_route: CapRoute, method: string, args: unknown) => {
      invoked.push({ method, args })
      return 'native'
    }),
  }
  // The handler only calls resolveCapRoute + dispatch; documented test boundary.
  return { resolver: resolver as unknown as CapRouteResolver, resolveCapRoute, invoked }
}

function hook(answer: (call: DeviceCall) => DeviceCallAnswer | Error): {
  hook: DeviceCallRedirectHook
  seen: DeviceCall[]
} {
  const seen: DeviceCall[] = []
  return {
    seen,
    hook: {
      covers: (cap, method) => cap === 'media-player' && method === 'play',
      attempt: async (call) => {
        seen.push(call)
        const out = answer(call)
        if (out instanceof Error) throw out
        return out
      },
    },
  }
}

function handlerOver(h: DeviceCallRedirectHook, resolver: CapRouteResolver) {
  return createParentUnownedCallHandler({
    getResolver: () => resolver,
    broker: brokerFake(),
    nodeRegistry: nodeRegistryFake(),
    deviceCallRedirect: h,
  })
}

describe('createParentUnownedCallHandler — a device call a redirect takes over (D963)', () => {
  it('answers a redirected call from the redirect; the route resolver is never consulted', async () => {
    const { resolver, resolveCapRoute } = routingResolver()
    const { hook: h, seen } = hook(() => ({ kind: 'redirected', result: 'sent' }))
    await expect(
      handlerOver(
        h,
        resolver,
      )({ capName: 'media-player', method: 'play', args: { deviceId: DEVICE } }),
    ).resolves.toBe('sent')
    expect(resolveCapRoute).not.toHaveBeenCalled()
    expect(seen).toEqual([
      { capName: 'media-player', method: 'play', deviceId: DEVICE, args: { deviceId: DEVICE } },
    ])
  })

  it('routes as before when nothing takes the call over', async () => {
    const { resolver, invoked } = routingResolver()
    const { hook: h } = hook(() => ({ kind: 'not-redirected' }))
    await expect(
      handlerOver(
        h,
        resolver,
      )({ capName: 'media-player', method: 'play', args: { deviceId: DEVICE } }),
    ).resolves.toBe('native')
    expect(invoked).toHaveLength(1)
  })

  it('does not ask about a method the hook does not cover', async () => {
    const { resolver } = routingResolver()
    const { hook: h, seen } = hook(() => ({ kind: 'redirected', result: 'no' }))
    await handlerOver(
      h,
      resolver,
    )({
      capName: 'media-player',
      method: 'getStatus',
      args: { deviceId: DEVICE },
    })
    expect(seen).toEqual([])
  })

  it('a failing redirect fails the call — the native cap does not silently run in its place', async () => {
    const { resolver, resolveCapRoute } = routingResolver()
    const { hook: h } = hook(() => new Error('board is off'))
    await expect(
      handlerOver(
        h,
        resolver,
      )({ capName: 'media-player', method: 'play', args: { deviceId: DEVICE } }),
    ).rejects.toThrow('board is off')
    expect(resolveCapRoute).not.toHaveBeenCalled()
  })
})
