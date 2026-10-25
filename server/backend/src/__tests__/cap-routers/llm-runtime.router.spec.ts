/**
 * Codegen'd `llm-runtime` (internal, node-side) router spec (framework train).
 *
 * Same worktree caveat as `llm.router.spec.ts`: skips its body when the
 * `@camstack/system` build predates the cap; the file satisfies `_meta.spec.ts`.
 */

import type { ILlmRuntimeProvider } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

function runtimeRouterAvailable(): boolean {
  try {
    buildCapRouterForTest('llm-runtime', () => makeMockProvider())
    return true
  } catch {
    return false
  }
}

function makeMockProvider(overrides: Partial<ILlmRuntimeProvider> = {}): ILlmRuntimeProvider {
  return {
    complete: async () => ({ ok: false, code: 'no-profile', message: 'none' }),
    ensureStarted: async () => ({ nodeId: 'hub', state: 'starting', crashesInWindow: 0 }),
    stop: async () => undefined,
    status: async () => ({ nodeId: 'hub', state: 'ready', crashesInWindow: 0 }),
    installModel: async () => undefined,
    deleteModel: async () => undefined,
    listLocalModels: async () => [],
    getDiskUsage: async () => ({ nodeId: 'hub', modelsBytes: 0 }),
    cancel: async () => undefined,
    appleAvailability: async () => ({ state: 'unsupported-platform', platform: 'linux' }),
    completeApple: async () => ({ ok: false, code: 'unavailable', message: 'linux' }),
    ...overrides,
  }
}

describe.skipIf(!runtimeRouterAvailable())('llm-runtime router', () => {
  it('dispatches status to the provider', async () => {
    const router = buildCapRouterForTest('llm-runtime', () => makeMockProvider())
    // `status` gained an explicit `auth: 'admin'` in c50d92188 (the 45-procedure
    // internal-cap closure) — a plain 'user' identity is correctly REJECTED now,
    // so the dispatch assertion drives the call as 'admin' (this test predates
    // that change and was left calling as 'user', which went stale/red).
    const outcome = await invokeProcedure(router, 'status', makeCtx('admin'), {})
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toMatchObject({ nodeId: 'hub', state: 'ready' })
  })

  it('gates ensureStarted behind admin', async () => {
    const router = buildCapRouterForTest('llm-runtime', () => makeMockProvider())
    const outcome = await invokeProcedure(router, 'ensureStarted', makeCtx('user'), {
      runtime: {
        nodeId: 'hub',
        engine: 'llama-cpp',
        model: { kind: 'catalog', catalogId: 'x' },
        contextSize: 4096,
        gpuLayers: 0,
        parallel: 1,
        autoStart: false,
        idleStopMinutes: 30,
      },
    })
    expect(outcome.ok).toBe(false)
  })

  it('reports Apple availability to an admin, and to nobody else', async () => {
    const router = buildCapRouterForTest('llm-runtime', () => makeMockProvider())
    const admin = await invokeProcedure(router, 'appleAvailability', makeCtx('admin'), {})
    expect(admin.ok).toBe(true)
    if (admin.ok) expect(admin.value).toEqual({ state: 'unsupported-platform', platform: 'linux' })
    const user = await invokeProcedure(router, 'appleAvailability', makeCtx('user'), {})
    expect(user.ok).toBe(false)
  })

  it('completeApple returns a guardrail refusal WITH its source (the output schema keeps it)', async () => {
    const router = buildCapRouterForTest('llm-runtime', () =>
      makeMockProvider({
        completeApple: async () => ({
          ok: false,
          code: 'refusal',
          message: 'Apple guardrail refused the request',
          refusalSource: 'guardrail',
        }),
      }),
    )
    const outcome = await invokeProcedure(router, 'completeApple', makeCtx('admin'), {
      consumer: 'notifier-narration',
      prompt: 'q',
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toMatchObject({ refusalSource: 'guardrail' })
  })

  it('forwards cancel by requestId', async () => {
    const seen: string[] = []
    const router = buildCapRouterForTest('llm-runtime', () =>
      makeMockProvider({
        cancel: async ({ requestId }) => {
          seen.push(requestId)
        },
      }),
    )
    const outcome = await invokeProcedure(router, 'cancel', makeCtx('admin'), { requestId: 'r1' })
    expect(outcome.ok).toBe(true)
    expect(seen).toEqual(['r1'])
  })
})
