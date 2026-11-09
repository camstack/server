/**
 * `caller: 'scoped'` — a method open to every session whose provider filters on the caller.
 *
 * The identity is the server-derived one of `caller: 'required'`. What differs is the door: an
 * ADMIN passes as it always did; a NON-admin passes only on a call pinned to one addon whose
 * provider the server says serves user-scoped rows (`admitsUserCaller`). Everything else is
 * FORBIDDEN, so a cap that adopts the flag stays admin-only until its provider opts in.
 */

import { method, type CapabilityDefinition } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildOneCapRouter,
  type CapRouterPrimitives,
  type CapRouterServices,
  type ProcedureBuilder,
} from '../cap-router-builder.js'

// ── Recording doubles (mirrors cap-router-builder.spec.ts) ──────────────

interface RecordedProcedure {
  kind: 'query' | 'mutation' | 'subscription'
  call: (input: unknown, ctx: unknown) => unknown
}

function makeProcedureBuilder(): ProcedureBuilder {
  const builder: ProcedureBuilder = {
    input() {
      return builder
    },
    output() {
      return builder
    },
    query(resolver) {
      const proc: RecordedProcedure = {
        kind: 'query',
        call: (input, ctx) => resolver({ input, ctx }),
      }
      return proc
    },
    mutation(resolver) {
      const proc: RecordedProcedure = {
        kind: 'mutation',
        call: (input, ctx) => resolver({ input, ctx }),
      }
      return proc
    },
    subscription(resolver) {
      const proc: RecordedProcedure = {
        kind: 'subscription',
        call: (input, ctx) => resolver({ input, ctx }),
      }
      return proc
    },
  }
  return builder
}

function makePrimitives(): CapRouterPrimitives {
  return {
    router: (procs) => procs,
    procedures: {
      public: makeProcedureBuilder(),
      protected: makeProcedureBuilder(),
      admin: makeProcedureBuilder(),
    },
    iterableSubscription: <T>(subscribe: (push: (value: T) => void) => () => void) => {
      async function* gen(): AsyncGenerator<T> {
        const values: T[] = []
        const unsub = subscribe((v) => values.push(v))
        try {
          for (const v of values) yield v
        } finally {
          unsub()
        }
      }
      return gen()
    },
  }
}

interface CallRecord {
  cap: string
  method: string
  args: unknown[]
  nodeId: string | 'local'
}

interface ServicesDouble {
  services: CapRouterServices
  calls: CallRecord[]
}

function makeServices(extra: Partial<CapRouterServices> = {}): ServicesDouble {
  const calls: CallRecord[] = []
  const makeProvider = (
    cap: string,
    nodeId: string,
  ): Record<string, (...a: unknown[]) => unknown> =>
    new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (typeof prop !== 'string') return undefined
          return (...args: unknown[]) => {
            calls.push({ cap, method: prop, args, nodeId })
            return { ok: true }
          }
        },
      },
    )
  const base: CapRouterServices = {
    getLocalProvider: (cap) => makeProvider(cap, 'local'),
    remoteProxy: (cap, nodeId) => makeProvider(cap, nodeId),
    noProvider: (cap, nodeId) => {
      throw new Error(`noProvider:${cap}:${nodeId ?? ''}`)
    },
    noNodeRouting: (cap) => {
      throw new Error(`noNodeRouting:${cap}`)
    },
    badRequest: (m) => {
      throw new Error(`badRequest:${m}`)
    },
    unauthorized: (m) => {
      throw new Error(`unauthorized:${m}`)
    },
  }
  return { services: { ...base, ...extra }, calls }
}

const scopedCap = {
  name: 'scoped-fixture',
  scope: 'system',
  mode: 'collection',
  methods: {
    listThings: method(z.looseObject({}), z.array(z.unknown()), { caller: 'scoped' }),
  },
} as const satisfies CapabilityDefinition

type Router = Record<string, RecordedProcedure>
const build = (services: CapRouterServices): Router =>
  buildOneCapRouter(scopedCap, makePrimitives(), services) as Router
const adminCtx = { user: { id: 'user-7', isAdmin: true } }
const viewerCtx = { user: { id: 'user-9', isAdmin: false } }
const forbid = (m: string): never => {
  throw new Error(`forbidden:${m}`)
}

describe("caller: 'scoped' — default-deny for a non-admin", () => {
  it('lets a non-admin through on an admitted, addon-pinned call, with the server caller', async () => {
    const { services, calls } = makeServices({
      forbidden: forbid,
      admitsUserCaller: async () => true,
    })
    await build(services).listThings!.call(
      { addonId: 'notifiers', caller: { userId: 'spoof', isAdmin: true } },
      viewerCtx,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toEqual({ caller: { userId: 'user-9', isAdmin: false } })
  })

  it('refuses a non-admin when the provider does not admit user callers', async () => {
    const { services, calls } = makeServices({
      forbidden: forbid,
      admitsUserCaller: async () => false,
    })
    await expect(build(services).listThings!.call({ addonId: 'other' }, viewerCtx)).rejects.toThrow(
      /^forbidden:/,
    )
    expect(calls).toHaveLength(0)
  })

  it('refuses a non-admin when the server offers no admission check at all', async () => {
    const { services, calls } = makeServices({ forbidden: forbid })
    await expect(
      build(services).listThings!.call({ addonId: 'notifiers' }, viewerCtx),
    ).rejects.toThrow(/^forbidden:/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a non-admin on an unpinned (fan-out) call even if the provider admits', async () => {
    const { services, calls } = makeServices({
      forbidden: forbid,
      admitsUserCaller: async () => true,
    })
    await expect(build(services).listThings!.call({}, viewerCtx)).rejects.toThrow(/^forbidden:/)
    expect(calls).toHaveLength(0)
  })

  it('lets an admin through unpinned, as before', async () => {
    const { services, calls } = makeServices({ forbidden: forbid })
    await build(services).listThings!.call({}, adminCtx)
    expect(calls[0]!.args[0]).toEqual({ caller: { userId: 'user-7', isAdmin: true } })
  })
})
