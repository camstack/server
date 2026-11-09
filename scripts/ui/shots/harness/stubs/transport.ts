/**
 * The harness tRPC transport: every query and mutation is answered from the
 * fixture files (`resolveFixture`), after a 5 ms tick so loading states still
 * happen. Subscriptions never emit. Unanswered query paths are collected in
 * `window.__uiShotsMissing` — the runner reports them per shot.
 */
import { fakeSystemClient } from '@admin/modules/device-detail/__tests__/fake-system-client'
import type { SystemTrpcClient } from '@camstack/ui-library'
import { resolveFixture } from '../fixtures-runtime'

declare global {
  interface Window {
    __uiShotsMissing: Set<string>
    __uiShotsCalls: string[]
  }
}
window.__uiShotsMissing = window.__uiShotsMissing ?? new Set()
window.__uiShotsCalls = window.__uiShotsCalls ?? []

let client: SystemTrpcClient | null = null
export function fakeClient(): SystemTrpcClient {
  client ??= fakeSystemClient((call) => {
    window.__uiShotsCalls.push(`${call.mutation ? 'mut:' : ''}${call.path}`)
    const r = resolveFixture(call.path, call.input, call.mutation)
    if (!r.found && !call.mutation) window.__uiShotsMissing.add(call.path)
    if (r.hang === true) return { kind: 'hang' }
    if (r.error !== undefined) return { kind: 'error', message: r.error }
    return { kind: 'data', value: r.value }
  }, 5)
  return client
}
