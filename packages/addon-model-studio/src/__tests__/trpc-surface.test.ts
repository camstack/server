/**
 * The page's tRPC surface check accepts the client the HOST really passes.
 *
 * The host hands every addon page `AddonPageProps.trpc`, a vanilla
 * `TRPCClient<AppRouter>`. tRPC builds that client as nested Proxies over a
 * FUNCTION target, so `typeof client.addons` is `'function'` and
 * `'mutate' in client.addons.custom` is `false`. A check written against plain
 * objects refused the real client on every call and the page showed
 * "unexpected tRPC client shape" in the hub, while the specs — which pass
 * plain-object fakes — stayed green.
 */
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import type { AppRouter } from '@camstack/types'
import { observable } from '@trpc/server/observable'
import type { AddonPageProps } from '@camstack/ui-library'
import { describe, expect, it } from 'vitest'
import { listCustomModels, MODEL_STUDIO_TRPC_CONTRACT, requireTrpcMember } from '../ui/api.js'

interface RecordedCall {
  readonly path: string
  readonly input: unknown
}

function realClient(calls: RecordedCall[]): AddonPageProps['trpc'] {
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        calls.push({ path: op.path, input: op.input })
        observer.next({ result: { type: 'data', data: [] } })
        observer.complete()
        return () => undefined
      })
  return createTRPCClient<AppRouter>({ links: [link] })
}

describe('the Model Studio tRPC surface', () => {
  it('accepts the real tRPC client the host passes, and calls through it', async () => {
    const calls: RecordedCall[] = []
    const trpc = realClient(calls)

    for (const member of MODEL_STUDIO_TRPC_CONTRACT) {
      expect(() => requireTrpcMember(trpc, member)).not.toThrow()
    }
    await expect(listCustomModels(trpc)).resolves.toEqual([])
    expect(calls.map((c) => c.path)).toEqual(['addons.custom'])
  })

  it('names the member a client is missing', () => {
    const partial = {
      addons: { custom: { mutate: async () => ({}) } },
      pipelineExecutor: {},
    }
    expect(() => requireTrpcMember(partial, 'addons.custom.mutate')).not.toThrow()
    expect(() => requireTrpcMember(partial, 'pipelineExecutor.getSchema.query')).toThrow(
      /pipelineExecutor\.getSchema\.query/,
    )
    expect(() => requireTrpcMember(null, 'live.onEvent.subscribe')).toThrow(
      /live\.onEvent\.subscribe/,
    )
  })
})
