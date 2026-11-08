/**
 * D1022 hook A — the hub tRPC mount reports a device command with the principal
 * from the request context, and only that.
 *
 * Driven through `buildOneCapRouter` with a synthetic cap carrying the name of a
 * real vocabulary cap (`switch`), the same recording doubles as the other
 * cap-router specs.
 */
import {
  method,
  type CapabilityDefinition,
  type DeviceCommandObservation,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildOneCapRouter,
  type CapRouterPrimitives,
  type CapRouterServices,
  type ProcedureBuilder,
} from '../cap-router-builder.js'

interface RecordedProcedure {
  call: (input: unknown, ctx: unknown) => unknown
}

function makeProcedureBuilder(): ProcedureBuilder {
  const builder: ProcedureBuilder = {
    input: () => builder,
    output: () => builder,
    query: (resolver) => ({ call: (input: unknown, ctx: unknown) => resolver({ input, ctx }) }),
    mutation: (resolver) => ({ call: (input: unknown, ctx: unknown) => resolver({ input, ctx }) }),
    subscription: (resolver) => ({ call: (input: unknown, ctx: unknown) => resolver({ input, ctx }) }),
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
    // `setState` is a vocabulary action of `switch`; `getState` is a query.
    setState: method(z.object({ deviceId: z.number(), on: z.boolean() }), z.object({ ok: z.boolean() }), {
      kind: 'mutation',
    }),
    getState: method(z.object({ deviceId: z.number() }), z.object({ on: z.boolean() })),
    // Not a vocabulary action: a mutation that is not a command.
    rename: method(z.object({ deviceId: z.number(), label: z.string() }), z.object({ ok: z.boolean() }), {
      kind: 'mutation',
    }),
  },
} as const satisfies CapabilityDefinition

function makeServices(
  observed: DeviceCommandObservation[],
  providerCall: () => unknown = () => ({ ok: true }),
  withObserver = true,
): CapRouterServices {
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
    ...(withObserver ? { commandObserver: (obs: DeviceCommandObservation) => void observed.push(obs) } : {}),
  }
}

function router(services: CapRouterServices): Record<string, RecordedProcedure> {
  return buildOneCapRouter(switchCap, primitives, services) as Record<string, RecordedProcedure>
}

const sessionCtx = {
  req: {},
  user: { id: 'u1', username: 'ada', isAdmin: true, auditTag: 'session', credentialId: 'sess-1' },
}

describe('hub mount command observer (D1022)', () => {
  it('reports a vocabulary mutation once, with the principal from the context', async () => {
    const observed: DeviceCommandObservation[] = []
    await router(makeServices(observed)).setState!.call({ deviceId: 7, on: true }, sessionCtx)
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      deviceId: 7,
      capName: 'switch',
      method: 'setState',
      args: { deviceId: 7, on: true },
      actor: { kind: 'user', userId: 'u1', username: 'ada', credential: 'session', credentialId: 'sess-1' },
    })
  })

  it('never reports a query or a mutation that is not a command', () => {
    const observed: DeviceCommandObservation[] = []
    const r = router(makeServices(observed))
    r.getState!.call({ deviceId: 7 }, sessionCtx)
    r.rename!.call({ deviceId: 7, label: 'x' }, sessionCtx)
    expect(observed).toEqual([])
  })

  it('takes the actor from the context, never from the arguments', async () => {
    const observed: DeviceCommandObservation[] = []
    await router(makeServices(observed)).setState!.call(
      {
        deviceId: 7,
        on: true,
        actor: { kind: 'user', userId: 'root', username: 'root', credential: 'session' },
        origin: { kind: 'scheduler', schedulerId: 'forged' },
      },
      sessionCtx,
    )
    expect(observed[0]?.actor).toMatchObject({ kind: 'user', userId: 'u1' })
  })

  it('attributes a call with no HTTP request behind it to the mesh node', async () => {
    const observed: DeviceCommandObservation[] = []
    await router(makeServices(observed)).setState!.call(
      { deviceId: 7, on: true },
      { user: { id: 'agent-2', username: 'agent-2', isAdmin: true } },
    )
    expect(observed[0]?.actor).toEqual({ kind: 'node', nodeId: 'agent-2' })
  })

  it('reports no actor it cannot name', async () => {
    const observed: DeviceCommandObservation[] = []
    await router(makeServices(observed)).setState!.call({ deviceId: 7, on: true }, { req: {} })
    expect(observed).toEqual([])
  })

  it('reports the command before the provider runs and settles the outcome with the call', async () => {
    const observed: DeviceCommandObservation[] = []
    const seenAtCall: number[] = []
    const services = makeServices(observed, () => {
      seenAtCall.push(observed.length)
      return Promise.reject(new Error('device unreachable'))
    })
    await expect(
      Promise.resolve(router(services).setState!.call({ deviceId: 7, on: true }, sessionCtx)),
    ).rejects.toThrow('device unreachable')
    expect(seenAtCall).toEqual([1])
    await expect(observed[0]?.outcome).rejects.toThrow('device unreachable')
  })

  it('settles the outcome as resolved when the provider answers', async () => {
    const observed: DeviceCommandObservation[] = []
    await router(makeServices(observed)).setState!.call({ deviceId: 7, on: true }, sessionCtx)
    await expect(observed[0]?.outcome).resolves.toBeUndefined()
  })

  it('stays silent, and the call still works, without an observer', async () => {
    const observed: DeviceCommandObservation[] = []
    const r = router(makeServices(observed, () => ({ ok: true }), false))
    await expect(Promise.resolve(r.setState!.call({ deviceId: 7, on: true }, sessionCtx))).resolves.toEqual({ ok: true })
    expect(observed).toEqual([])
  })

  it('does not let a throwing observer fail the call', async () => {
    const services = makeServices([])
    const throwing: CapRouterServices = {
      ...services,
      commandObserver: () => {
        throw new Error('observer broke')
      },
    }
    await expect(
      Promise.resolve(router(throwing).setState!.call({ deviceId: 7, on: true }, sessionCtx)),
    ).resolves.toEqual({ ok: true })
  })
})
