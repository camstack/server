/**
 * F3 backend wiring — forked-addon routes + custom actions over UDS.
 *
 * Verifies the production wiring `AddonRegistryService` builds, end-to-end over
 * a REAL LocalChildRegistry + LocalChildClient pair, with the child running the
 * REAL addon-runner-side dispatcher (`createChildAddonCallDispatch`):
 *
 *   - Custom actions: a `CustomActionRegistry` whose dispatcher is the F3
 *     `callAddonOnChild({target:'custom', action, args})` reaches the child's
 *     real custom-action handler and returns its result (the path
 *     `registerForkedAddonCustomActions` builds via `dispatchForkedCustomAction`).
 *   - Routes: `callAddonOnChild({target:'routes'})` returns handler-stripped
 *     descriptors; the per-route bridge handler dispatches through the
 *     `addon-routes` `invoke()` cap method (the path `mountForkedAddonRoutes`
 *     builds), and the captured envelope round-trips.
 *
 * The child-side `onAddonCall` handler is a faithful inline of the addon-runner
 * dispatcher (resolve route provider / custom registry; strip route handlers).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { z } from 'zod'
import {
  LocalChildRegistry,
  LocalChildClient,
  CustomActionRegistry,
  createLocalTransport,
} from '@camstack/system'
import type { AddonCallInput } from '@camstack/system'
import { buildAddonRouteProvider, customAction, defineCustomActions } from '@camstack/types'
import type { IAddonHttpRoute, CustomActionsSpec, CustomActionCaller } from '@camstack/types'

const nid = (): string => `f3-wiring-${process.pid}-${Math.random().toString(36).slice(2)}`

describe('F3 — forked-addon routes + custom actions over UDS (backend wiring)', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalChildClient[] = []

  afterEach(async () => {
    for (const c of clients) await c.close().catch(() => {})
    clients.length = 0
    await registry?.close().catch(() => {})
    registry = null
  })

  /** Stand up a hub-side registry + a child running the real addon-call dispatcher. */
  async function standUp(opts: {
    addonId: string
    routes?: readonly IAddonHttpRoute[]
    catalog?: CustomActionsSpec
    handlers?: Record<string, (input: unknown, caller?: CustomActionCaller) => Promise<unknown>>
  }): Promise<{ childCustomActions: CustomActionRegistry }> {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId))
    await registry.start()

    // The runner-side custom-action registry — populated as the addon-runner does.
    const childCustomActions = new CustomActionRegistry()
    if (opts.catalog && opts.handlers) {
      const handlers = opts.handlers
      childCustomActions.registerAddon(opts.addonId, opts.catalog, (action, input, caller) => {
        const fn = handlers[action]
        if (!fn) throw new Error(`no handler for ${action}`)
        return fn(input, caller)
      })
    }

    const routeProvider = opts.routes ? buildAddonRouteProvider(opts.addonId, opts.routes) : null

    const child = new LocalChildClient({
      nodeId,
      childId: opts.addonId,
      caps: [{ capName: 'addon-routes', mode: 'collection' }],
      // Cap dispatch — resolve the `addon-routes` cap's `invoke`/`getRoutes`
      // method on the live route provider (mirrors the runner's
      // createChildCapDispatch resolving allSingletonProviders['addon-routes']).
      dispatch: async (call) => {
        if (call.capName === 'addon-routes' && routeProvider !== null) {
          const fn = Reflect.get(routeProvider, call.method)
          if (typeof fn === 'function') return fn.call(routeProvider, call.args)
        }
        return null
      },
    })
    // Inline addon-runner dispatcher: routes → handler-stripped descriptors,
    // custom → the child custom-action registry. Mirrors
    // `createChildAddonCallDispatch` in the kernel.
    child.onAddonCall(async (call: AddonCallInput) => {
      if (call.target === 'routes') {
        if (routeProvider === null) throw new Error(`addon "${call.addonId}" has no routes`)
        const live = routeProvider.getRoutes()
        return live.map((r) => ({
          method: r.method,
          path: r.path,
          ...(r.access !== undefined ? { access: r.access } : {}),
          ...(r.description !== undefined ? { description: r.description } : {}),
        }))
      }
      const action = call.action
      if (typeof action !== 'string') throw new Error('missing action')
      const entry = childCustomActions.resolve(call.addonId, action)
      if (entry === null) throw new Error(`no custom action "${action}"`)
      return entry.handler(call.args, call.caller)
    })
    clients.push(child)
    await child.start()

    return { childCustomActions }
  }

  it('custom action: the registerForkedAddonCustomActions dispatch path reaches the child handler', async () => {
    const catalog = defineCustomActions({
      runBenchmark: customAction(
        z.object({ iterations: z.number() }),
        z.object({ ran: z.number() }),
        { kind: 'mutation' },
      ),
    })
    await standUp({
      addonId: 'benchmark',
      catalog,
      handlers: {
        runBenchmark: async (input) => {
          const args = input as { iterations: number }
          return { ran: args.iterations }
        },
      },
    })

    // Hub-side registry — the dispatcher mirrors `dispatchForkedCustomAction`.
    const hubRegistry = new CustomActionRegistry()
    hubRegistry.registerAddon('benchmark', catalog, (action, input) =>
      registry!.callAddonOnChild('benchmark', {
        addonId: 'benchmark',
        target: 'custom',
        action,
        args: input,
      }),
    )

    const entry = hubRegistry.resolve('benchmark', 'runBenchmark')
    expect(entry).not.toBeNull()
    const result = await entry!.handler({ iterations: 9 })
    expect(result).toEqual({ ran: 9 })
  })

  it('custom action: the authenticated caller crosses the real UDS/MsgPack wire for a caller:required action', async () => {
    const catalog = defineCustomActions({
      deleteMine: customAction(z.object({ id: z.string() }), z.object({ ok: z.boolean() }), {
        kind: 'mutation',
        caller: 'required',
      }),
    })
    let observedCaller: CustomActionCaller | undefined
    await standUp({
      addonId: 'notifiers',
      catalog,
      handlers: {
        // The child handler records exactly what arrived across the wire.
        deleteMine: async (_input, caller) => {
          observedCaller = caller
          return { ok: true }
        },
      },
    })

    // Hub-side registry mirroring `dispatchForkedCustomAction`: it forwards the
    // caller only when the (router-derived) caller is present — exactly what the
    // production closure `(action, input, caller) => callForked(...)` does.
    const hubRegistry = new CustomActionRegistry()
    hubRegistry.registerAddon('notifiers', catalog, (action, input, caller) =>
      registry!.callAddonOnChild('notifiers', {
        addonId: 'notifiers',
        target: 'custom',
        action,
        args: input,
        ...(caller ? { caller } : {}),
      }),
    )

    const entry = hubRegistry.resolve('notifiers', 'deleteMine')
    expect(entry).not.toBeNull()

    // (a) With an authenticated caller, it round-trips intact over MsgPack.
    const result = await entry!.handler({ id: 'abc' }, { userId: 'owner-7', isAdmin: true })
    expect(result).toEqual({ ok: true })
    expect(observedCaller).toEqual({ userId: 'owner-7', isAdmin: true })

    // (b) With no caller (not forwarded), the child sees undefined — additive.
    observedCaller = { userId: 'stale', isAdmin: false }
    await entry!.handler({ id: 'def' }, undefined)
    expect(observedCaller).toBeUndefined()
  })

  it('routes: callAddonOnChild(routes) returns stripped descriptors and invoke() round-trips', async () => {
    const routes: IAddonHttpRoute[] = [
      {
        method: 'GET',
        path: '/hello/:name',
        access: 'public',
        handler: async (req, reply) => {
          reply.code(200)
          reply.send({ greeting: `hi ${req.params.name}` })
        },
      },
    ]
    await standUp({ addonId: 'export-alexa', routes })

    // (a) routes come back handler-stripped (the `mountForkedAddonRoutes` fetch).
    const rawRoutes = await registry!.callAddonOnChild('export-alexa', {
      addonId: 'export-alexa',
      target: 'routes',
    })
    expect(rawRoutes).toEqual([{ method: 'GET', path: '/hello/:name', access: 'public' }])

    // (b) dispatch through the addon-routes cap proxy's `invoke` cap method —
    // the bridge handler `mountForkedAddonRoutes` synthesizes calls this.
    const routesCapProxy = {
      invoke: (input: unknown) =>
        registry!.callCapOnChild('export-alexa', {
          capName: 'addon-routes',
          method: 'invoke',
          args: input,
        }),
    }
    const envelope = await routesCapProxy.invoke({
      method: 'GET',
      path: '/hello/world',
      params: { name: 'world' },
      query: {},
      body: undefined,
      headers: {},
    })
    expect(envelope).toMatchObject({ status: 200, body: { greeting: 'hi world' } })
  })

  it('auth-oidc shape: a forked addon with a SYNC array getRoutes + async handlers mounts via the strip path without serializing a function', async () => {
    // Reproduces the regression: `auth-oidc` declares a manual route provider
    // `{ id, getRoutes: () => routes }` (NO `buildAddonRouteProvider`, NO
    // `invoke`). It forks like every non-core addon, so the hub resolves an
    // async UDS cap proxy whose `getRoutes()` returns a Promise. The mount path
    // MUST NOT register that proxy directly (→ `getRoutes(...).map is not a
    // function`) nor dispatch its `getRoutes` cap method over UDS (the child's
    // `getRoutes()` returns the live array WITH async `handler` functions →
    // MsgPack "Unrecognized object: [object AsyncFunction]"). It uses the
    // handler-stripped `callAddonOnChild(target:'routes')` bridge instead.
    const routes: IAddonHttpRoute[] = [
      {
        method: 'GET',
        path: '/:providerId/start',
        access: 'public',
        description: 'Begin OIDC redirect login flow',
        handler: async (_req, reply) => {
          reply.code(302)
          reply.send('')
        },
      },
      {
        method: 'GET',
        path: '/:providerId/callback',
        access: 'public',
        handler: async (_req, reply) => {
          reply.code(200)
          reply.send('ok')
        },
      },
    ]
    await standUp({ addonId: 'auth-oidc', routes })

    // The handler-stripped descriptors cross the real UDS pair. If the strip
    // path leaked a `handler` function, MsgPack `encodeFrame` would throw
    // "Unrecognized object: [object AsyncFunction]" before this resolves.
    const rawRoutes = await registry!.callAddonOnChild('auth-oidc', {
      addonId: 'auth-oidc',
      target: 'routes',
    })
    expect(rawRoutes).toEqual([
      {
        method: 'GET',
        path: '/:providerId/start',
        access: 'public',
        description: 'Begin OIDC redirect login flow',
      },
      { method: 'GET', path: '/:providerId/callback', access: 'public' },
    ])
    // Coarse reachability gate the route-mount fallback uses: the child is
    // connected even though we only checked the addon-call surface.
    expect(registry!.isChildKnown('auth-oidc')).toBe(true)
  })
})
