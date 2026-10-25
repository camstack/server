/**
 * child-addon-call-dispatch (F3) — unit tests for the addon-runner-side
 * dispatcher that resolves hub→child addon-level calls (routes / custom).
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createChildAddonCallDispatch } from '../../moleculer/child-addon-call-dispatch.js'
import type { ChildAddonCallDispatchDeps } from '../../moleculer/child-addon-call-dispatch.js'
import { CustomActionRegistry } from '../../custom-action-registry.js'
import { customAction } from '@camstack/types'
import type { CustomActionsSpec } from '@camstack/types'

describe('createChildAddonCallDispatch', () => {
  it('routes: returns getRoutes() with handler functions STRIPPED', async () => {
    const routeProvider = {
      id: 'export-alexa',
      getRoutes: () => [
        {
          method: 'GET',
          path: '/start',
          access: 'public',
          rateLimit: 'auth',
          handler: async () => {},
        },
        {
          method: 'POST',
          path: '/cb',
          access: 'authenticated',
          description: 'callback',
          handler: async () => {},
        },
      ],
    }
    const dispatch = createChildAddonCallDispatch({
      getRouteProvider: () => routeProvider,
      customActions: new CustomActionRegistry(),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as ChildAddonCallDispatchDeps)

    const result = await dispatch({ addonId: 'export-alexa', target: 'routes' })

    // Handlers gone; method/path/access/description/rateLimit preserved —
    // the hub must see a route's rate limit to apply it before the handler.
    expect(result).toEqual([
      { method: 'GET', path: '/start', access: 'public', rateLimit: 'auth' },
      { method: 'POST', path: '/cb', access: 'authenticated', description: 'callback' },
    ])
  })

  it('routes: throws a clear error when the addon has no addon-routes provider', async () => {
    const dispatch = createChildAddonCallDispatch({
      getRouteProvider: () => null,
      customActions: new CustomActionRegistry(),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as ChildAddonCallDispatchDeps)
    await expect(dispatch({ addonId: 'no-routes', target: 'routes' })).rejects.toThrow(
      /no addon-routes provider/,
    )
  })

  it('custom: dispatches to the registered handler and returns its result', async () => {
    const catalog: CustomActionsSpec = {
      runBenchmark: customAction(
        z.object({ iterations: z.number() }),
        z.object({ ran: z.number() }),
      ),
    }
    const handler = vi.fn(async (input: unknown) => {
      const args = input as { iterations: number }
      return { ran: args.iterations }
    })
    const registry = new CustomActionRegistry()
    registry.registerAddon('benchmark', catalog, (action, input) => {
      expect(action).toBe('runBenchmark')
      return handler(input)
    })

    const dispatch = createChildAddonCallDispatch({
      getRouteProvider: () => null,
      customActions: registry,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as ChildAddonCallDispatchDeps)

    const result = await dispatch({
      addonId: 'benchmark',
      target: 'custom',
      action: 'runBenchmark',
      args: { iterations: 7 },
    })

    expect(handler).toHaveBeenCalledWith({ iterations: 7 })
    expect(result).toEqual({ ran: 7 })
  })

  it('custom: forwards call.caller to the handler as its second argument', async () => {
    const catalog: CustomActionsSpec = {
      deleteMine: customAction(z.object({ id: z.string() }), z.object({ ok: z.boolean() }), {
        caller: 'required',
      }),
    }
    const seen: { caller?: { userId: string; isAdmin: boolean } } = {}
    const registry = new CustomActionRegistry()
    registry.registerAddon('notifiers', catalog, (_action, _input, caller) => {
      seen.caller = caller
      return Promise.resolve({ ok: true })
    })

    const dispatch = createChildAddonCallDispatch({
      getRouteProvider: () => null,
      customActions: registry,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as ChildAddonCallDispatchDeps)

    await dispatch({
      addonId: 'notifiers',
      target: 'custom',
      action: 'deleteMine',
      args: { id: 'x' },
      caller: { userId: 'user-42', isAdmin: false },
    })

    expect(seen.caller).toEqual({ userId: 'user-42', isAdmin: false })
  })

  it('custom: passes caller=undefined when the hub forwarded none (legacy / not-opted-in)', async () => {
    const catalog: CustomActionsSpec = {
      runBenchmark: customAction(z.object({ n: z.number() }), z.object({ ran: z.number() })),
    }
    const seen: { called: boolean; caller?: unknown } = { called: false }
    const registry = new CustomActionRegistry()
    registry.registerAddon('benchmark', catalog, (_action, input, caller) => {
      seen.called = true
      seen.caller = caller
      return Promise.resolve({ ran: (input as { n: number }).n })
    })

    const dispatch = createChildAddonCallDispatch({
      getRouteProvider: () => null,
      customActions: registry,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as ChildAddonCallDispatchDeps)

    await dispatch({
      addonId: 'benchmark',
      target: 'custom',
      action: 'runBenchmark',
      args: { n: 3 },
    })

    expect(seen.called).toBe(true)
    expect(seen.caller).toBeUndefined()
  })

  it('custom: throws a clear error for an unknown action', async () => {
    const dispatch = createChildAddonCallDispatch({
      getRouteProvider: () => null,
      customActions: new CustomActionRegistry(),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as ChildAddonCallDispatchDeps)
    await expect(
      dispatch({ addonId: 'benchmark', target: 'custom', action: 'nope' }),
    ).rejects.toThrow(/no custom action "nope"/)
  })

  it('custom: throws when the action name is missing', async () => {
    const dispatch = createChildAddonCallDispatch({
      getRouteProvider: () => null,
      customActions: new CustomActionRegistry(),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as ChildAddonCallDispatchDeps)
    await expect(dispatch({ addonId: 'benchmark', target: 'custom' })).rejects.toThrow(
      /missing action name/,
    )
  })

  it("data-planes: returns the addon's published endpoint descriptors", async () => {
    const endpoints = [
      {
        prefix: 'playback',
        access: 'admin' as const,
        baseUrl: 'http://127.0.0.1:51234',
        secret: 'abc',
      },
    ]
    const dispatch = createChildAddonCallDispatch({
      getRouteProvider: () => null,
      customActions: new CustomActionRegistry(),
      getDataPlanes: (addonId: string) => (addonId === 'recorder' ? endpoints : []),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as ChildAddonCallDispatchDeps)
    await expect(dispatch({ addonId: 'recorder', target: 'data-planes' })).resolves.toEqual(
      endpoints,
    )
    await expect(dispatch({ addonId: 'other', target: 'data-planes' })).resolves.toEqual([])
  })
})
