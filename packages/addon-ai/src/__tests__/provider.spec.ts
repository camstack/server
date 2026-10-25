import type {
  ConfigUISchema,
  LlmGenerateResult,
  LlmProfile,
  LlmRuntimeCompleteInput,
  ManagedRuntimeConfig,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { LlmCallRequest, LlmClient } from '../client/llm-client.js'
import { DefaultsStore } from '../defaults-store.js'
import { ProfileStore } from '../profile-store.js'
import { createLlmProvider, type RuntimeClient } from '../provider.js'
import { REDACTED_MARKER } from '../secrets.js'
import { makeAiRecords } from './support/fake-records.js'
import type { UsageFilter, UsageRecorder, UsageRowInput } from '../usage/usage-port.js'
import { makeProfile } from './support/profile.js'

function profile(id: string, overrides: Record<string, unknown> = {}): LlmProfile {
  return makeProfile({ id, name: id, supportsVision: true, ...overrides })
}

class FakeUsage implements UsageRecorder {
  readonly rows: UsageRowInput[] = []
  async record(row: UsageRowInput): Promise<void> {
    this.rows.push(row)
  }
  async rollup(_filter: UsageFilter): Promise<never[]> {
    return []
  }
}

interface FakeClientHandle {
  readonly client: LlmClient
  readonly calls: Array<{ request: LlmCallRequest; timeoutMs: number }>
}

/**
 * The transport seam, scripted.
 *
 * It records the request the PROVIDER built, which is what every assertion
 * about profile defaults, per-call overrides and retry policy reads. The
 * provider's job ends at that request — what the library then puts on the wire
 * is `llm-client.spec.ts`'s problem.
 */
function fakeClient(result?: LlmGenerateResult): FakeClientHandle {
  const calls: Array<{ request: LlmCallRequest; timeoutMs: number }> = []
  const client: LlmClient = {
    supports: (kind) => kind === 'openai' || kind === 'openai-compatible',
    generate: async (request, timeoutMs) => {
      calls.push({ request, timeoutMs })
      return (
        result ?? {
          ok: true,
          text: 'answer',
          model: 'llama3.2:3b',
          usage: { inputTokens: 11, outputTokens: 4 },
          truncated: false,
          latencyMs: 5,
        }
      )
    },
    openStream: async () => ({ kind: 'unsupported' }),
  }
  return { client, calls }
}

async function seededStores(profiles: LlmProfile[], consumerDefault?: string) {
  const { records } = await makeAiRecords()
  const store = ProfileStore.of(records)
  const defaults = DefaultsStore.of(records)
  for (const p of profiles) await store.upsert(p)
  if (consumerDefault !== undefined) await defaults.set({ consumer: 'ai-summary' }, consumerDefault)
  return { store, defaults }
}

describe('createLlmProvider.generate', () => {
  it('happy path: resolves the default, calls the client, ok + ONE usage row', async () => {
    const { store, defaults } = await seededStores([profile('a')], 'a')
    const usage = new FakeUsage()
    const { client, calls } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage,
    })
    const result = await provider.generate({ consumer: 'ai-summary', prompt: 'q' })
    expect(result).toMatchObject({
      ok: true,
      text: 'answer',
      usage: { inputTokens: 11, outputTokens: 4 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.request.prompt).toBe('q')
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      ok: true,
      consumer: 'ai-summary',
      profileId: 'a',
      imageCount: 0,
    })
  })

  it('no usable profile → no-profile result AND a usage row', async () => {
    const { store, defaults } = await seededStores([])
    const usage = new FakeUsage()
    const { client } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage,
    })
    const result = await provider.generate({ consumer: 'ai-summary', prompt: 'q' })
    expect(result).toMatchObject({ ok: false, code: 'no-profile' })
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ ok: false, errorCode: 'no-profile' })
  })

  it('a client error result is returned verbatim and still writes its row', async () => {
    const { store, defaults } = await seededStores([profile('a')], 'a')
    const usage = new FakeUsage()
    const { client } = fakeClient({
      ok: false,
      code: 'timeout',
      message: 'timed out after 60000ms',
    })
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage,
    })
    expect(await provider.generate({ consumer: 'ai-summary', prompt: 'q' })).toMatchObject({
      ok: false,
      code: 'timeout',
    })
    expect(usage.rows[0]).toMatchObject({ ok: false, errorCode: 'timeout' })
  })

  it('budget gate returning an error short-circuits with that err + row', async () => {
    const { store, defaults } = await seededStores([profile('a')], 'a')
    const usage = new FakeUsage()
    const { client, calls } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage,
      budget: { check: async () => ({ ok: false, code: 'budget-exceeded', message: 'over' }) },
    })
    const result = await provider.generate({ consumer: 'ai-summary', prompt: 'q' })
    expect(result).toMatchObject({ ok: false, code: 'budget-exceeded' })
    expect(usage.rows[0]).toMatchObject({ ok: false, errorCode: 'budget-exceeded' })
    // A denied budget must never reach the provider's endpoint.
    expect(calls).toHaveLength(0)
  })
})

describe('createLlmProvider retry policy', () => {
  it('the per-consumer table decides: ai-summary retries, notifier-rules does not', async () => {
    const { store, defaults } = await seededStores([profile('a')])
    await defaults.set({ purpose: 'text' }, 'a')
    const { client, calls } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
    })
    await provider.generate({ consumer: 'ai-summary', prompt: 'q' })
    await provider.generate({ consumer: 'notifier-rules', prompt: 'q' })
    expect(calls[0]?.request.retry).toEqual({ enabled: true, maxAttempts: 3 })
    // The 8-second gate must not spend its budget twice.
    expect(calls[1]?.request.retry).toEqual({ enabled: false, maxAttempts: 1 })
  })

  it('an explicit per-call retry beats the consumer table', async () => {
    const { store, defaults } = await seededStores([profile('a')])
    await defaults.set({ purpose: 'text' }, 'a')
    const { client, calls } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
    })
    await provider.generate({
      consumer: 'notifier-rules',
      prompt: 'q',
      retry: { enabled: true, maxAttempts: 2 },
    })
    expect(calls[0]?.request.retry).toEqual({ enabled: true, maxAttempts: 2 })
  })

  it('a per-call timeoutMs overrides the profile bound', async () => {
    const { store, defaults } = await seededStores([profile('a', { timeoutMs: 60_000 })])
    await defaults.set({ purpose: 'text' }, 'a')
    const { client, calls } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
    })
    await provider.generate({ consumer: 'adhoc-ui', prompt: 'q', timeoutMs: 5_000 })
    expect(calls[0]?.timeoutMs).toBe(5_000)
  })
})

describe('createLlmProvider.generateVision', () => {
  it('threads images to the client and stamps imageCount', async () => {
    const { store, defaults } = await seededStores([profile('a')], 'a')
    const usage = new FakeUsage()
    const { client, calls } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage,
    })
    const result = await provider.generateVision({
      consumer: 'ai-summary',
      prompt: 'describe',
      images: [{ bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }],
    })
    expect(result.ok).toBe(true)
    expect(usage.rows[0]?.imageCount).toBe(1)
    expect(calls[0]?.request.images).toHaveLength(1)
    expect(calls[0]?.request.images?.[0]?.mimeType).toBe('image/jpeg')
  })
})

describe('createLlmProvider CRUD', () => {
  it('listProfiles returns REDACTED rows with addonId stamped', async () => {
    const { store, defaults } = await seededStores([
      profile('a', { apiKey: 'sk-secret', kind: 'openai' }),
    ])
    const { client } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
    })
    const rows = await provider.listProfiles({})
    expect(rows[0]?.providerConfig.apiKey).toBe(REDACTED_MARKER)
    expect(rows[0]?.addonId).toBe('ai')
  })

  it('upsertProfile merges secrets (untouched marker keeps stored key) + returns redacted', async () => {
    const { store, defaults } = await seededStores([
      profile('a', { apiKey: 'sk-old', kind: 'openai' }),
    ])
    const { client } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
    })
    const returned = await provider.upsertProfile({
      profile: profile('a', { name: 'renamed', apiKey: REDACTED_MARKER, kind: 'openai' }),
    })
    expect(returned.providerConfig.apiKey).toBe(REDACTED_MARKER)
    expect(returned.name).toBe('renamed')
    const raw = await store.getById('a')
    expect(raw?.providerConfig.apiKey).toBe('sk-old')
  })

  it('a fully configured profile round-trips every tuning field through the store', async () => {
    const rich = profile('rich', {
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      maxTokens: 512,
      contextLength: 8192,
      systemPrompt: 'be terse',
      timeoutMs: 30_000,
      connectTimeoutMs: 4_000,
      firstTokenTimeoutMs: 90_000,
      idleTimeoutMs: 20_000,
      retry: { enabled: true, maxAttempts: 4 },
      toolsEnabled: true,
    })
    const { store, defaults } = await seededStores([rich])
    const { client } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
    })
    const rows = await provider.listProfiles({})
    expect(rows[0]).toMatchObject({
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      maxTokens: 512,
      contextLength: 8192,
      systemPrompt: 'be terse',
      timeoutMs: 30_000,
      connectTimeoutMs: 4_000,
      firstTokenTimeoutMs: 90_000,
      idleTimeoutMs: 20_000,
      retry: { enabled: true, maxAttempts: 4 },
      toolsEnabled: true,
    })
  })

  it('listProfileKinds covers every kind, all addonId-stamped', async () => {
    const { store, defaults } = await seededStores([])
    const { client } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
    })
    const kinds = await provider.listProfileKinds({})
    expect(kinds.map((k) => k.kind).toSorted()).toEqual([
      'anthropic',
      'apple-foundation',
      'google',
      'managed-local',
      'openai',
      'openai-compatible',
    ])
    expect(kinds.every((k) => k.addonId === 'ai')).toBe(true)
  })

  it('every client-served kind exposes the full tuning surface to the editor', async () => {
    const { store, defaults } = await seededStores([])
    const { client } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
    })
    const kinds = await provider.listProfileKinds({})
    const connectionKeys = (kind: string): string[] => {
      const descriptor = kinds.find((k) => k.kind === kind)
      // Documented type boundary: `connectionSchema` crosses the cap as
      // `unknown` (the ConfigSchemaPassthrough precedent) and is re-tightened
      // on read — the admin page does the same at AiProfilesTab.
      const schema = descriptor?.connectionSchema as ConfigUISchema | undefined
      return (schema?.sections ?? []).flatMap((s) => s.fields.map((f) => f.key))
    }
    const fieldsFor = (kind: string): readonly string[] =>
      kinds.find((k) => k.kind === kind)?.profileFields ?? []
    // A field missing here is a field the operator cannot set — the editor is
    // GENERATED from the descriptor, so the assertion belongs on it.
    expect(connectionKeys('openai')).toEqual(['baseUrl', 'apiKey'])
    for (const expected of [
      'temperature',
      'topP',
      'maxTokens',
      'contextLength',
      'systemPrompt',
      'timeoutMs',
      'connectTimeoutMs',
      'firstTokenTimeoutMs',
      'idleTimeoutMs',
      'retry',
      'toolsEnabled',
    ]) {
      expect(fieldsFor('openai')).toContain(expected)
    }
    // …and top-k is offered exactly where the wire carries it: nowhere on the
    // OpenAI family, on both of the others. A knob that changes nothing is
    // worse than a missing one.
    expect(fieldsFor('openai')).not.toContain('topK')
    expect(fieldsFor('openai-compatible')).not.toContain('topK')
    expect(fieldsFor('anthropic')).toContain('topK')
    expect(fieldsFor('google')).toContain('topK')
  })
})

describe('createLlmProvider managed-local', () => {
  const runtimeCfg: ManagedRuntimeConfig = {
    nodeId: 'agent-1',
    engine: 'llama-cpp',
    model: { kind: 'catalog', catalogId: 'llm-qwen2.5-1.5b-instruct-q4' },
    contextSize: 4096,
    gpuLayers: 0,
    parallel: 1,
    flashAttention: false,
    mlock: false,
    noMmap: false,
    extraArgs: [],
    autoStart: false,
    idleStopMinutes: 30,
  }

  function fakeRuntime(): {
    runtimeClient: RuntimeClient
    calls: LlmRuntimeCompleteInput[]
    nodes: string[]
  } {
    const calls: LlmRuntimeCompleteInput[] = []
    const nodes: string[] = []
    const runtimeClient: RuntimeClient = {
      complete: async (nodeId, input) => {
        nodes.push(nodeId)
        calls.push(input)
        return {
          ok: true,
          text: 'local',
          model: 'q',
          usage: { inputTokens: 2, outputTokens: 1 },
          truncated: false,
          latencyMs: 3,
        }
      },
      ensureStarted: async () => ({ nodeId: 'agent-1', state: 'ready', crashesInWindow: 0 }),
      stopRuntime: async () => undefined,
      status: async () => ({ nodeId: 'agent-1', state: 'ready', crashesInWindow: 0 }),
      installModel: async () => undefined,
      deleteModel: async () => undefined,
      listLocalModels: async () => [],
      getDiskUsage: async () => ({ nodeId: 'agent-1', modelsBytes: 0 }),
      listRuntimeNodeIds: async () => ['agent-1'],
      listRegisteredRuntimeNodeIds: async () => ['agent-1'],
      completeApple: async () => ({ ok: false, code: 'unavailable', message: 'not in this spec' }),
      cancel: async () => undefined,
      appleAvailability: async () => ({ state: 'unsupported-platform', platform: 'linux' }),
    }
    return { runtimeClient, calls, nodes }
  }

  it('generate on a managed-local profile pins runtime.complete to runtime.nodeId', async () => {
    const managed = profile('m', { kind: 'managed-local', runtime: runtimeCfg })
    const { store, defaults } = await seededStores([managed], 'm')
    const usage = new FakeUsage()
    const { runtimeClient, calls, nodes } = fakeRuntime()
    const { client, calls: clientCalls } = fakeClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage,
      runtime: runtimeClient,
    })
    const result = await provider.generate({ consumer: 'ai-summary', prompt: 'q' })
    expect(result).toMatchObject({ ok: true, text: 'local' })
    expect(nodes).toEqual(['agent-1'])
    expect(calls[0]).toMatchObject({ runtime: runtimeCfg, timeoutMs: 60_000, prompt: 'q' })
    expect(usage.rows[0]).toMatchObject({ ok: true, profileId: 'm' })
    // The managed wire is served ON THE NODE, never by the hub's own client.
    expect(clientCalls).toHaveLength(0)
  })

  it('listRuntimeNodes aggregates status/disk and tolerates an unreachable node', async () => {
    const { store, defaults } = await seededStores([])
    const { runtimeClient } = fakeRuntime()
    const { client } = fakeClient()
    const flaky: RuntimeClient = {
      ...runtimeClient,
      listRuntimeNodeIds: async () => ['agent-1', 'agent-bad'],
      status: async (nodeId) => {
        if (nodeId === 'agent-bad') throw new Error('unreachable')
        return { nodeId, state: 'ready', crashesInWindow: 0 }
      },
    }
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
      runtime: flaky,
    })
    const nodes = await provider.listRuntimeNodes({})
    const bad = nodes.find((n) => n.nodeId === 'agent-bad')
    const good = nodes.find((n) => n.nodeId === 'agent-1')
    expect(good?.reachable).toBe(true)
    expect(bad?.reachable).toBe(false)
  })

  it('installModel falls back to the model-distributor relay when the direct install rejects', async () => {
    const { store, defaults } = await seededStores([])
    const { runtimeClient } = fakeRuntime()
    const { client } = fakeClient()
    const relayed: Array<{ nodeId: string; model: unknown }> = []
    const failing: RuntimeClient = {
      ...runtimeClient,
      installModel: async () => {
        throw new Error('agent has no egress')
      },
    }
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
      runtime: failing,
      distributeModel: async (nodeId, model) => {
        relayed.push({ nodeId, model })
      },
    })
    await provider.installModel({
      nodeId: 'agent-1',
      model: { kind: 'catalog', catalogId: 'llm-qwen2.5-1.5b-instruct-q4' },
    })
    expect(relayed).toEqual([
      { nodeId: 'agent-1', model: { kind: 'catalog', catalogId: 'llm-qwen2.5-1.5b-instruct-q4' } },
    ])
  })
})

describe('createLlmProvider cancellation', () => {
  /**
   * The hole this closes: the gates race a generation against 8 s and free
   * their own slot when the timer wins, but the generation upstream kept
   * running to `profile.timeoutMs` — 60 s by default. On a single-threaded
   * local model the per-camera bound then counted WAITS, not generations, so
   * more work was in flight than the bound believed.
   *
   * `AbortSignal` cannot cross a process boundary; the `requestId` can.
   */
  function cancellableClient(): {
    client: LlmClient
    signals: AbortSignal[]
    finish: () => void
  } {
    const signals: AbortSignal[] = []
    let finish = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const client: LlmClient = {
      supports: () => true,
      generate: async (request) => {
        signals.push(request.signal)
        await gate
        return {
          ok: true,
          text: 'late',
          model: 'm',
          usage: { inputTokens: 1, outputTokens: 1 },
          truncated: false,
          latencyMs: 1,
        }
      },
      openStream: async () => ({ kind: 'unsupported' }),
    }
    return { client, signals, finish }
  }

  it('llm.cancel aborts the signal the client is actually holding', async () => {
    const { store, defaults } = await seededStores([profile('a')], 'a')
    const { client, signals, finish } = cancellableClient()
    const provider = createLlmProvider({
      store,
      defaults,
      client,
      usage: new FakeUsage(),
    })

    const pending = provider.generate({
      consumer: 'ai-summary',
      prompt: 'q',
      requestId: 'req-1',
    })
    await vi.waitFor(() => {
      expect(signals).toHaveLength(1)
    })
    expect(signals[0]?.aborted).toBe(false)

    await provider.cancel({ requestId: 'req-1' })
    // The signal the client is holding — not a copy, not a flag we set here.
    expect(signals[0]?.aborted).toBe(true)

    finish()
    await pending
  })

  it('cancelling an unknown or already-finished id is a silent no-op', async () => {
    const { store, defaults } = await seededStores([profile('a')], 'a')
    const { client } = fakeClient()
    const provider = createLlmProvider({ store, defaults, client, usage: new FakeUsage() })

    // A caller that has given up must never have to handle an error from
    // giving up — including when it gives up a millisecond too late.
    await expect(provider.cancel({ requestId: 'never-existed' })).resolves.toBeUndefined()
    await provider.generate({ consumer: 'ai-summary', prompt: 'q', requestId: 'req-2' })
    await expect(provider.cancel({ requestId: 'req-2' })).resolves.toBeUndefined()
  })

  it('the in-flight registry does not leak — a finished call is forgotten', async () => {
    const { store, defaults } = await seededStores([profile('a')], 'a')
    const { client, signals, finish } = cancellableClient()
    const provider = createLlmProvider({ store, defaults, client, usage: new FakeUsage() })

    const pending = provider.generate({
      consumer: 'ai-summary',
      prompt: 'q',
      requestId: 'req-3',
    })
    await vi.waitFor(() => {
      expect(signals).toHaveLength(1)
    })
    finish()
    await pending

    // Cancelling now must not reach the (completed) controller: a registry that
    // kept entries would be one AbortController per notification, forever, on
    // the hub's longest-lived addon.
    await provider.cancel({ requestId: 'req-3' })
    expect(signals[0]?.aborted).toBe(false)
  })
})
