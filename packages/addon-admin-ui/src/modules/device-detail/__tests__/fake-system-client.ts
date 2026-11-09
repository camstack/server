import type { AppRouter } from '@camstack/sdk'
import type { SystemTrpcClient } from '@camstack/ui-library'
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'

/** What a stand-in hub says to one call: a value, an error, or nothing ever. */
export type FakeAnswer =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'hang' }

export interface FakeCall {
  readonly path: string
  readonly input: unknown
  readonly mutation: boolean
}

/**
 * The one typed fake of the System tRPC client for specs and the shot harness:
 * every query and mutation is answered by `answer`, after `delayMs`; subscriptions
 * never emit. It is built on the real router type, so no call site casts it.
 */
export function fakeSystemClient(
  answer: (call: FakeCall) => FakeAnswer,
  delayMs = 0,
): SystemTrpcClient {
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') return () => undefined
        const result = answer({ path: op.path, input: op.input, mutation: op.type === 'mutation' })
        if (result.kind === 'hang') return () => undefined
        const timer = setTimeout(() => {
          if (result.kind === 'error') {
            observer.error(TRPCClientError.from<AppRouter>(new Error(result.message)))
            return
          }
          observer.next({ result: { type: 'data', data: result.value } })
          observer.complete()
        }, delayMs)
        return () => clearTimeout(timer)
      })
  return createTRPCClient<AppRouter>({ links: [link] })
}
