/**
 * An in-process addon calling a DEVICE-scoped cap.
 *
 * The hub's own `ctx.api` chain was `localProviderLink → brokerTransportLink`:
 * a provider in this very process, then the Moleculer registry. Forked addon
 * children are BROKER-LESS (UDS), so a device provider like hikvision's `ptz`
 * advertises nothing on the bus — the lookup found no candidate and fell back
 * to the `<cap>.<cap>.<method>` shape this file already documents as broken.
 * The autotrack builtin logged `Service 'ptz.ptz.getOptions' is not found`
 * forty-eight times in a row and, with `moveImpulseMs` unreadable, refused to
 * move a camera it was switched on for (2026-09-18).
 *
 * The hub HAS the authority that can route `(cap, deviceId)` into another
 * child: `CapRouteResolver`, reached by `callCapabilityOnNode`. This link is
 * the seam that lets an in-process addon use it, and it is deliberately narrow
 * — only a cap the definitions call `scope: 'device'`, only when the call
 * actually carries a `deviceId`. Everything else passes through untouched, so
 * nothing that worked before changes.
 */
import { describe, expect, it, vi } from 'vitest'
import { createTRPCClient } from '@trpc/client'
import { deviceCapResolverLink } from '../trpc-links.js'

interface Dispatched {
  readonly capName: string
  readonly method: string
  readonly input: unknown
}

function clientWith(
  dispatch: (capName: string, method: string, input: unknown) => Promise<unknown>,
  deviceScoped: ReadonlySet<string>,
  tail: () => Promise<unknown>,
): { ptz: { getOptions: { query: (input: unknown) => Promise<unknown> } } } {
  const terminal = () => () =>
    // A stand-in for `brokerTransportLink`: whatever is NOT intercepted lands here.
    ({
      subscribe: (observer: { next: (v: unknown) => void; complete: () => void }) => {
        void tail().then((data) => {
          observer.next({ result: { type: 'data', data } })
          observer.complete()
        })
        return { unsubscribe: () => undefined }
      },
    }) as never
  return createTRPCClient({
    links: [
      deviceCapResolverLink(dispatch, (capName) => deviceScoped.has(capName)),
      terminal as never,
    ],
  }) as never
}

describe('deviceCapResolverLink', () => {
  it('routes a device-scoped cap call through the resolver', async () => {
    const seen: Dispatched[] = []
    const client = clientWith(
      async (capName, method, input) => {
        seen.push({ capName, method, input })
        return { moveImpulseMs: 500 }
      },
      new Set(['ptz']),
      async () => {
        throw new Error('the terminal link must not be reached')
      },
    )
    const out = await client.ptz.getOptions.query({ deviceId: 1438 })
    expect(out).toEqual({ moveImpulseMs: 500 })
    expect(seen).toEqual([{ capName: 'ptz', method: 'getOptions', input: { deviceId: 1438 } }])
  })

  it('passes a SYSTEM-scoped cap straight through — nothing that worked changes', async () => {
    const dispatch = vi.fn()
    const client = clientWith(dispatch, new Set(['ptz']), async () => ({ entries: [] }))
    const out = await (
      client as unknown as {
        deviceManager: { getBindings: { query: (i: unknown) => Promise<unknown> } }
      }
    ).deviceManager.getBindings.query({ deviceId: 1438 })
    expect(out).toEqual({ entries: [] })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('passes through a device-scoped call with NO deviceId — there is nothing to route on', async () => {
    const dispatch = vi.fn()
    const client = clientWith(dispatch, new Set(['ptz']), async () => ({ fell: 'through' }))
    const out = await (
      client as unknown as { ptz: { getOptions: { query: (i: unknown) => Promise<unknown> } } }
    ).ptz.getOptions.query({})
    expect(out).toEqual({ fell: 'through' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('surfaces the resolver’s own error instead of a service-not-found', async () => {
    const client = clientWith(
      async () => {
        throw new Error('ptz not routable to node hub/provider-hikvision: node-offline')
      },
      new Set(['ptz']),
      async () => ({ never: true }),
    )
    await expect(client.ptz.getOptions.query({ deviceId: 1438 })).rejects.toThrow(/node-offline/)
  })
})
