/**
 * The harness tRPC transport: every query and mutation is answered from the
 * fixture files (`resolveFixture`), after a 5 ms tick so loading states still
 * happen. Subscriptions never emit. Unanswered query paths are collected in
 * `window.__uiShotsMissing` — the runner reports them per shot.
 */
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { resolveFixture } from '../fixtures-runtime'

declare global {
  interface Window {
    __uiShotsMissing: Set<string>
    __uiShotsCalls: string[]
  }
}
window.__uiShotsMissing = window.__uiShotsMissing ?? new Set()
window.__uiShotsCalls = window.__uiShotsCalls ?? []

const fakeLink: TRPCLink<never> =
  () =>
  ({ op }) =>
    observable((observer) => {
      if (op.type === 'subscription') return () => undefined
      const mutation = op.type === 'mutation'
      window.__uiShotsCalls.push(`${mutation ? 'mut:' : ''}${op.path}`)
      const r = resolveFixture(op.path, op.input, mutation)
      if (!r.found && !mutation) window.__uiShotsMissing.add(op.path)
      const timer = setTimeout(() => {
        if (r.error !== undefined) {
          observer.error({
            message: r.error,
            data: { code: 'BAD_REQUEST' },
            shape: { message: r.error },
          } as never)
          return
        }
        observer.next({ result: { type: 'data', data: r.value } } as never)
        observer.complete()
      }, 5)
      return () => clearTimeout(timer)
    })

let client: ReturnType<typeof createTRPCClient> | null = null
export function fakeClient(): ReturnType<typeof createTRPCClient> {
  client ??= createTRPCClient({ links: [fakeLink] })
  return client
}
