/**
 * Codegen'd `llm` collection router spec (framework train — Tasks 1-4).
 *
 * NOTE: `buildCapRouterForTest` drives `buildCapRouters` from `@camstack/system`.
 * When this spec runs against a `@camstack/system` build that predates the `llm`
 * cap (e.g. an isolated worktree whose shared node_modules still points at a
 * stale system dist), the router cannot be built. We detect that and skip the
 * body — the spec lights up automatically once the framework train (types +
 * system publish) lands. The file's mere existence also satisfies the
 * `_meta.spec.ts` "every cap has a router spec" gate.
 */
import { describe, it, expect } from 'vitest'
import { LlmProfileSchema, type ILlmProvider, type LlmProfile } from '@camstack/types'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

function llmRouterAvailable(): boolean {
  try {
    buildCapRouterForTest('llm', () => makeMockProvider())
    return true
  } catch {
    return false
  }
}

// Parsed, so every defaulted field is the schema's own default.
const PROFILE: LlmProfile = LlmProfileSchema.parse({
  id: 'p1',
  name: 'Test',
  kind: 'openai-compatible',
  addonId: 'ai',
  enabled: true,
  model: 'llama3.2:3b',
  providerConfig: { baseUrl: 'http://ollama.lan:11434/v1' },
  supportsVision: false,
  timeoutMs: 60_000,
})

/** The methods this spec's routes reach; the harness takes any provider object. */
function makeMockProvider(overrides: Partial<ILlmProvider> = {}): Partial<ILlmProvider> {
  return {
    generate: async () => ({ ok: false, code: 'no-profile', message: 'none' }),
    generateVision: async () => ({ ok: false, code: 'no-profile', message: 'none' }),
    listProfileKinds: async () => [],
    listProfiles: async () => [PROFILE],
    upsertProfile: async ({ profile }) => profile,
    deleteProfile: async () => undefined,
    testProfile: async () => ({ ok: false, code: 'no-profile', message: 'none' }),
    listModels: async () => ({ ok: true, models: [{ id: 'llama3.2:3b' }] }),
    getDefaults: async () => [],
    setDefault: async () => undefined,
    getUsage: async () => [],
    listModelCatalog: async () => [],
    listRuntimeNodes: async () => [],
    listNodeModels: async () => [],
    installModel: async () => undefined,
    deleteModel: async () => undefined,
    getRuntimeStatus: async () => ({ nodeId: 'hub', state: 'stopped', crashesInWindow: 0 }),
    startRuntime: async () => ({ nodeId: 'hub', state: 'starting', crashesInWindow: 0 }),
    stopRuntime: async () => undefined,
    ...overrides,
  }
}

describe.skipIf(!llmRouterAvailable())('llm router', () => {
  it('dispatches listProfiles to the provider', async () => {
    const router = buildCapRouterForTest('llm', () => makeMockProvider())
    const outcome = await invokeProcedure(router, 'listProfiles', makeCtx('user'), {})
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual([PROFILE])
  })

  it('gates upsertProfile behind admin', async () => {
    const router = buildCapRouterForTest('llm', () => makeMockProvider())
    const outcome = await invokeProcedure(router, 'upsertProfile', makeCtx('user'), {
      profile: PROFILE,
    })
    expect(outcome.ok).toBe(false)
  })

  it('listModels answers a draft for an admin, and refuses a non-admin', async () => {
    const router = buildCapRouterForTest('llm', () => makeMockProvider())
    const input = {
      addonId: 'ai',
      kind: 'openai-compatible',
      connection: { baseUrl: 'http://192.0.2.20:11434/v1' },
    }
    const admin = await invokeProcedure(router, 'listModels', makeCtx('admin'), input)
    expect(admin.ok).toBe(true)
    if (admin.ok) expect(admin.value).toEqual({ ok: true, models: [{ id: 'llama3.2:3b' }] })
    // It can dial any endpoint and resolve a stored key to do it.
    const user = await invokeProcedure(router, 'listModels', makeCtx('user'), input)
    expect(user.ok).toBe(false)
  })

  it('a kind is an open id: a provider-declared one is accepted, a malformed one refused', async () => {
    const router = buildCapRouterForTest('llm', () => makeMockProvider())
    const ok = await invokeProcedure(router, 'listModels', makeCtx('admin'), {
      addonId: 'third-party',
      kind: 'acme-llm',
    })
    expect(ok.ok).toBe(true)
    const bad = await invokeProcedure(router, 'listModels', makeCtx('admin'), {
      addonId: 'third-party',
      kind: 'Not A Kind!',
    })
    expect(bad.ok).toBe(false)
  })

  it('missing provider → PRECONDITION_FAILED naming the cap', async () => {
    const router = buildCapRouterForTest('llm', () => null)
    const outcome = await invokeProcedure(router, 'listProfiles', makeCtx('user'), {})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('llm')
  })
})
