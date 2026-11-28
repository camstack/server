/**
 * D1062 — a device command returns only after its follow-up (the scheduler's
 * refresh) ran, at the hub tRPC mount and on an in-process addon's `ctx.api`
 * link. A follow-up that throws never fails the command; a refused command
 * still runs it, then the refusal reaches the caller.
 */
import { method, type CapabilityDefinition } from '@dominevo/types'
import { createTRPCClient } from '@trpc/client'
import { initTRPC } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildOneCapRouter,
  type CapRouterPrimitives,
  type CapRouterServices,
  type ProcedureBuilder,
} from '../cap-router-builder.js'
import {
  type CommandCallOutcome,
  type CommandFollowUp,
  type CommandFollowUpTarget,
} from '../command-follow-up.js'
import { commandObserverLink } from '../command-observation.js'
import { unstable_localLink } from '@trpc/client'

interface RecordedProcedure {
  call: (input: unknown, ctx: unknown) => unknown
}

function makeProcedureBuilder(): ProcedureBuilder {
  const builder: ProcedureBuilder = {
    input: () => builder,
    output: () => builder,
    query: (resolver) => ({ call: (input: unknown, ctx: unknown) => resolver({ input, ctx }) }),
    mutation: (resolver) => ({ call: (input: unknown, ctx: unknown) => resolver({ input, ctx }) }),
    subscription: (resolver) => ({
      call: (input: unknown, ctx: unknown) => resolver({ input, ctx }),
    }),
  }
  return builder
}

const primitives: CapRouterPrimitives = {
  router: (procs) => procs,
  procedures: {
    public: makeProcedureBuilder(),
    protected: makeProcedureBuilder(),
    admin: makeProcedureBuilder(),
  },
  iterableSubscription: () => {
    throw new Error('no subscriptions here')
  },
}

const switchCap = {
  name: 'switch',
  scope: 'device',
  mode: 'singleton',
  methods: {
    setState: method(
      z.object({ deviceId: z.number(), on: z.boolean() }),
      z.object({ ok: z.boolean() }),
      {
        kind: 'mutation',
      },
    ),
    rename: method(
      z.object({ deviceId: z.number(), label: z.string() }),
      z.object({ ok: z.boolean() }),
      {
        kind: 'mutation',
      },
    ),
  },
} as const satisfies CapabilityDefinition

const sessionCtx = {
  req: {},
  user: { id: 'u1', username: 'ada', isAdmin: true, auditTag: 'session' },
}

interface FollowUpLog {
  readonly events: string[]
  readonly followUp: CommandFollowUp
}

/** A follow-up that takes a macrotask, so a caller that does not await it is seen to return first. */
function slowFollowUp(fail = false): FollowUpLog {
  const events: string[] = []
  const followUp = async (
    target: CommandFollowUpTarget,
    outcome: CommandCallOutcome,
  ): Promise<void> => {
    events.push(`follow-up start ${target.capName}.${target.method}#${target.deviceId} ${outcome}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
    events.push('follow-up done')
    if (fail) throw new Error('refresh failed')
  }
  return { events, followUp }
}

function services(log: FollowUpLog, providerCall: () => unknown): CapRouterServices {
  const provider = new Proxy(
    {},
    { get: (_t, prop) => (typeof prop === 'string' ? providerCall : undefined) },
  )
  return {
    getLocalProvider: () => provider,
    remoteProxy: () => provider,
    noProvider: () => {
      throw new Error('noProvider')
    },
    noNodeRouting: () => {
      throw new Error('noNodeRouting')
    },
    badRequest: (m) => {
      throw new Error(`badRequest:${m}`)
    },
    commandObserver: () => undefined,
    commandFollowUp: log.followUp,
  }
}

function mount(svc: CapRouterServices): Record<string, RecordedProcedure> {
  // documented test boundary: the fake builder returns the recorded procedures, as in cap-router-command-observer.spec
  return buildOneCapRouter(switchCap, primitives, svc) as Record<string, RecordedProcedure>
}

describe('hub mount awaits the command follow-up (D1062)', () => {
  it('a command returns after its follow-up', async () => {
    const log = slowFollowUp()
    await mount(services(log, () => ({ ok: true }))).setState!.call(
      { deviceId: 7, on: true },
      sessionCtx,
    )
    log.events.push('returned')
    expect(log.events).toEqual([
      'follow-up start switch.setState#7 ok',
      'follow-up done',
      'returned',
    ])
  })

  it('a follow-up that fails never fails the command', async () => {
    const log = slowFollowUp(true)
    const result = await mount(services(log, () => ({ ok: true }))).setState!.call(
      { deviceId: 7, on: true },
      sessionCtx,
    )
    expect(result).toEqual({ ok: true })
  })

  it('a refused command runs the follow-up, then the refusal reaches the caller', async () => {
    const log = slowFollowUp()
    const call = mount(
      services(log, () => Promise.reject(new Error('refused by the device'))),
    ).setState!.call({ deviceId: 7, on: true }, sessionCtx)
    await expect(call).rejects.toThrow('refused by the device')
    expect(log.events).toEqual(['follow-up start switch.setState#7 failed', 'follow-up done'])
  })

  it('a mutation that is not a command has no follow-up', async () => {
    const log = slowFollowUp()
    await mount(services(log, () => ({ ok: true }))).rename!.call(
      { deviceId: 7, label: 'x' },
      sessionCtx,
    )
    expect(log.events).toEqual([])
  })
})

describe('in-process ctx.api link awaits the command follow-up (D1062)', () => {
  const t = initTRPC.create()
  const appRouter = t.router({
    switch: t.router({
      setState: t.procedure
        .input(z.object({ deviceId: z.number(), on: z.boolean() }))
        .mutation(() => ({ ok: true })),
    }),
  })

  it('the mutation resolves after the follow-up', async () => {
    const log = slowFollowUp()
    const client = createTRPCClient<typeof appRouter>({
      links: [
        commandObserverLink<typeof appRouter>({
          callerAddonId: 'addon-x',
          sink: () => undefined,
          followUp: log.followUp,
        }),
        unstable_localLink({ router: appRouter, createContext: async () => ({}) }),
      ],
    })
    await client.switch.setState.mutate({ deviceId: 7, on: true })
    log.events.push('returned')
    expect(log.events).toEqual([
      'follow-up start switch.setState#7 ok',
      'follow-up done',
      'returned',
    ])
  })
})
