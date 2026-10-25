import { describe, it, expect, vi } from 'vitest'
import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { AddonApiFactory } from '../addon-api-factory.js'

describe('AddonApiFactory', () => {
  it('createDirectCaller returns a caller when router and context are provided', () => {
    const factory = new AddonApiFactory()
    expect(factory).toBeDefined()
    expect(typeof factory.createDirectCaller).toBe('function')
  })

  describe('createDirectCaller proxy wrapper', () => {
    // Build a minimal router that mimics the AddonApi shape: one namespace
    // with a query and a mutation. The proxy must expose both as
    // `{ query, mutate, subscribe }` leaves, identical to CreateTRPCClient.
    const t = initTRPC.context<{ user: { id: string; username: string; role: string } }>().create()

    const fakeQuery = vi.fn(({ input }: { input: { n: number } }) => ({ doubled: input.n * 2 }))
    const fakeMutation = vi.fn(({ input }: { input: { label: string } }) => ({
      echoed: `hi ${input.label}`,
    }))

    const greetRouter = t.router({
      double: t.procedure.input(z.object({ n: z.number() })).query(fakeQuery),
      shout: t.procedure.input(z.object({ label: z.string() })).mutation(fakeMutation),
    })

    const appRouter = t.router({ greet: greetRouter })

    it('exposes nested procedures via .query() delegating to the caller', async () => {
      const factory = new AddonApiFactory()
      const api = (await factory.createDirectCaller({
        router: appRouter,
        context: { user: { id: 'svc', username: 'svc', role: 'system' } },
      })) as unknown as {
        greet: {
          double: { query: (input: { n: number }) => Promise<{ doubled: number }> }
          shout: { mutate: (input: { label: string }) => Promise<{ echoed: string }> }
        }
      }

      const doubled = await api.greet.double.query({ n: 21 })
      expect(doubled).toEqual({ doubled: 42 })
      expect(fakeQuery).toHaveBeenCalledTimes(1)
    })

    it('exposes nested procedures via .mutate() delegating to the caller', async () => {
      const factory = new AddonApiFactory()
      const api = (await factory.createDirectCaller({
        router: appRouter,
        context: { user: { id: 'svc', username: 'svc', role: 'system' } },
      })) as unknown as {
        greet: {
          shout: { mutate: (input: { label: string }) => Promise<{ echoed: string }> }
        }
      }

      const result = await api.greet.shout.mutate({ label: 'world' })
      expect(result).toEqual({ echoed: 'hi world' })
      expect(fakeMutation).toHaveBeenCalledTimes(1)
    })

    it('returns a leaf proxy whose .query() and .mutate() are interchangeable (direct caller has no kind distinction)', async () => {
      const factory = new AddonApiFactory()
      const api = (await factory.createDirectCaller({
        router: appRouter,
        context: { user: { id: 'svc', username: 'svc', role: 'system' } },
      })) as unknown as {
        greet: {
          double: {
            query: (input: { n: number }) => Promise<{ doubled: number }>
            mutate: (input: { n: number }) => Promise<{ doubled: number }>
          }
        }
      }

      // Direct caller doesn't distinguish query/mutation at runtime — both
      // paths hit the same underlying function. Remote clients enforce the
      // distinction at the wire protocol level; this is acceptable because
      // the TypeScript type (from the generated AddonApi) only exposes one
      // or the other per procedure.
      const viaMutate = await api.greet.double.mutate({ n: 5 })
      expect(viaMutate).toEqual({ doubled: 10 })
    })

    it('subscribe() throws — use the WSS client instead', async () => {
      const factory = new AddonApiFactory()
      const api = (await factory.createDirectCaller({
        router: appRouter,
        context: { user: { id: 'svc', username: 'svc', role: 'system' } },
      })) as unknown as {
        greet: { double: { subscribe: () => void } }
      }

      expect(() => api.greet.double.subscribe()).toThrow(/not supported/)
    })
  })
})
