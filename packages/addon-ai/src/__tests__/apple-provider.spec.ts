/**
 * The hub's `apple-foundation` profile kind.
 *
 * Pinned here: it runs on the node the profile names; a GUARDRAIL refusal is a
 * distinct, logged outcome after which the provider tries the caller's next
 * profile (a model refusal is an answer and is not retried); what the backend
 * can do (`supportsVision`) is stamped from the node, never taken from the
 * form; identity/biometric consumers never reach it.
 */
import type { LlmGenerateResult, LlmProfile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { LlmClient } from '../client/llm-client.js'
import { DefaultsStore } from '../defaults-store.js'
import { ProfileStore } from '../profile-store.js'
import { AppleNodeMirror } from '../apple-node-mirror.js'
import { createLlmProvider } from '../provider.js'
import { makeAiRecords } from './support/fake-records.js'
import type { UsageFilter, UsageRecorder, UsageRowInput } from '../usage/usage-port.js'
import { fakeRuntimeClient, OK_RESULT } from './support/fake-runtime.js'
import { createTestLogger, makeTestLogger } from './support/logger.js'
import { makeProfile } from './support/profile.js'

class FakeUsage implements UsageRecorder {
  readonly rows: UsageRowInput[] = []
  async record(row: UsageRowInput): Promise<void> {
    this.rows.push(row)
  }
  async rollup(_filter: UsageFilter): Promise<never[]> {
    return []
  }
}

const CLOUD_ANSWER: LlmGenerateResult = {
  ok: true,
  text: 'cloud answer',
  model: 'gpt',
  usage: { inputTokens: 9, outputTokens: 3 },
  truncated: false,
  latencyMs: 40,
}

function cloudClient(): { client: LlmClient; calls: number[] } {
  const calls: number[] = []
  const client: LlmClient = {
    supports: () => true,
    generate: async () => {
      calls.push(1)
      return CLOUD_ANSWER
    },
    openStream: async () => ({ kind: 'unsupported' }),
  }
  return { client, calls }
}

const GUARDRAIL: LlmGenerateResult = {
  ok: false,
  code: 'refusal',
  message: 'Apple guardrail refused the request: unsafe',
  refusalSource: 'guardrail',
}

function afmProfile(overrides: Record<string, unknown> = {}): LlmProfile {
  return makeProfile({
    id: 'afm',
    name: 'Apple on the Mac',
    kind: 'apple-foundation',
    model: 'apple-system',
    baseUrl: undefined,
    appleFoundation: { nodeId: 'mac' },
    ...overrides,
  })
}

async function setup(opts: {
  profiles: LlmProfile[]
  consumerDefault?: string
  textDefault?: string
  runtime?: ReturnType<typeof fakeRuntimeClient>
  logger?: ReturnType<typeof createTestLogger>
  /** `false` = the mirror has not refreshed yet (every node unknown). */
  prime?: boolean
}) {
  const { records } = await makeAiRecords()
  const store = ProfileStore.of(records)
  const defaults = DefaultsStore.of(records)
  for (const p of opts.profiles) await store.upsert(p)
  if (opts.consumerDefault !== undefined) {
    await defaults.set({ consumer: 'notifier-narration' }, opts.consumerDefault)
  }
  if (opts.textDefault !== undefined) await defaults.set({ purpose: 'text' }, opts.textDefault)
  const usage = new FakeUsage()
  const cloud = cloudClient()
  const runtime = opts.runtime ?? fakeRuntimeClient()
  const appleNodes = new AppleNodeMirror({ source: runtime.runtime, logger: makeTestLogger() })
  // What the background refresh would have produced by now.
  if (opts.prime !== false) await appleNodes.refresh()
  const provider = createLlmProvider({
    store,
    defaults,
    client: cloud.client,
    usage,
    runtime: runtime.runtime,
    appleNodes,
    logger: opts.logger?.logger ?? makeTestLogger(),
  })
  return { provider, usage, cloud, runtime, store, appleNodes }
}

describe('apple-foundation dispatch', () => {
  it('runs on the node the profile names, never on the hub client', async () => {
    const { provider, runtime, cloud, usage } = await setup({
      profiles: [afmProfile()],
      textDefault: 'afm',
    })
    const result = await provider.generate({
      consumer: 'notifier-narration',
      prompt: 'porta aperta alle 18:05',
      requestId: 'r1',
      timeoutMs: 8_000,
    })
    expect(result).toMatchObject({ ok: true, model: 'apple-system' })
    expect(runtime.calls.completeApple).toHaveLength(1)
    expect(runtime.calls.completeApple[0]).toMatchObject({
      nodeId: 'mac',
      input: { prompt: 'porta aperta alle 18:05', requestId: 'r1', timeoutMs: 8_000 },
    })
    expect(cloud.calls).toHaveLength(0)
    expect(usage.rows[0]).toMatchObject({ ok: true, profileId: 'afm', kind: 'apple-foundation' })
  })

  it('a GUARDRAIL refusal falls back to the next profile, and says so', async () => {
    const handle = createTestLogger()
    const runtime = fakeRuntimeClient({ completeApple: async () => GUARDRAIL })
    const { provider, cloud, usage } = await setup({
      profiles: [afmProfile(), makeProfile({ id: 'cloud', name: 'cloud' })],
      consumerDefault: 'afm',
      textDefault: 'cloud',
      runtime,
      logger: handle,
    })
    const result = await provider.generate({ consumer: 'notifier-narration', prompt: 'q' })
    expect(result).toEqual(CLOUD_ANSWER)
    expect(cloud.calls).toHaveLength(1)
    // One row per profile that was actually called: the refusal is a real
    // call on the Apple profile and its error rate must show it.
    expect(usage.rows.map((r) => [r.profileId, r.ok, r.errorCode])).toEqual([
      ['afm', false, 'refusal'],
      ['cloud', true, undefined],
    ])
    const line = handle.entries.find((e) => e.message.includes('guardrail'))
    expect(line?.extras?.meta).toMatchObject({
      profileId: 'afm',
      fallbackProfileId: 'cloud',
      consumer: 'notifier-narration',
    })
  })

  it('a guardrail refusal with no further profile is returned as a distinct refusal', async () => {
    const handle = createTestLogger()
    const runtime = fakeRuntimeClient({ completeApple: async () => GUARDRAIL })
    const { provider } = await setup({
      profiles: [afmProfile()],
      textDefault: 'afm',
      runtime,
      logger: handle,
    })
    const result = await provider.generate({ consumer: 'notifier-narration', prompt: 'q' })
    expect(result).toMatchObject({ ok: false, code: 'refusal', refusalSource: 'guardrail' })
    expect(
      handle.entries.some((e) => e.level === 'warn' && e.message.includes('no fallback')),
    ).toBe(true)
  })

  it('a caller that NAMED the Apple profile gets the refusal — its prompt goes nowhere else', async () => {
    const handle = createTestLogger()
    const runtime = fakeRuntimeClient({ completeApple: async () => GUARDRAIL })
    const { provider, cloud, usage } = await setup({
      profiles: [afmProfile(), makeProfile({ id: 'cloud', name: 'cloud' })],
      consumerDefault: 'cloud',
      textDefault: 'cloud',
      runtime,
      logger: handle,
    })
    const result = await provider.generate({
      consumer: 'notifier-narration',
      profileId: 'afm',
      prompt: 'q',
    })
    expect(result).toMatchObject({ ok: false, code: 'refusal', refusalSource: 'guardrail' })
    expect(cloud.calls).toHaveLength(0)
    expect(usage.rows).toHaveLength(1)
    expect(handle.entries.some((e) => e.message.includes('explicitly chosen'))).toBe(true)
  })

  it('testProfile on the Apple profile reports ITS refusal, never another profile passing', async () => {
    const runtime = fakeRuntimeClient({ completeApple: async () => GUARDRAIL })
    const { provider, cloud } = await setup({
      profiles: [afmProfile(), makeProfile({ id: 'cloud', name: 'cloud' })],
      textDefault: 'cloud',
      runtime,
    })
    const result = await provider.testProfile({ addonId: 'ai', profileId: 'afm' })
    expect(result).toMatchObject({ ok: false, refusalSource: 'guardrail' })
    expect(cloud.calls).toHaveLength(0)
  })

  it('a MODEL refusal is an answer, not a backend fault — no fallback', async () => {
    const runtime = fakeRuntimeClient({
      completeApple: async () => ({
        ok: false,
        code: 'refusal',
        message: 'the model declined',
        refusalSource: 'model',
      }),
    })
    const { provider, cloud } = await setup({
      profiles: [afmProfile(), makeProfile({ id: 'cloud', name: 'cloud' })],
      consumerDefault: 'afm',
      textDefault: 'cloud',
      runtime,
    })
    const result = await provider.generate({ consumer: 'notifier-narration', prompt: 'q' })
    expect(result).toMatchObject({ ok: false, refusalSource: 'model' })
    expect(cloud.calls).toHaveLength(0)
  })

  it('an identity/biometric consumer never reaches Apple Foundation Models', async () => {
    const { provider, runtime } = await setup({ profiles: [afmProfile()] })
    const result = await provider.generate({
      consumer: 'face-identity',
      profileId: 'afm',
      prompt: 'who is this',
    })
    expect(result).toMatchObject({ ok: false, code: 'bad-request' })
    expect(runtime.calls.completeApple).toHaveLength(0)
  })

  it.each([
    'interface-text',
    'surface-report',
    'notifier-narration',
  ])('a tag that merely CONTAINS "face" (%s) is not an identity consumer', async (consumer) => {
    const { provider, runtime } = await setup({ profiles: [afmProfile()] })
    await provider.generate({ consumer, profileId: 'afm', prompt: 'q' })
    expect(runtime.calls.completeApple).toHaveLength(1)
  })

  it.each([
    'face',
    'face-recognition',
    'person_reid',
    're-id',
    'biometrics',
  ])('%s is refused', async (consumer) => {
    const { provider, runtime } = await setup({ profiles: [afmProfile()] })
    const result = await provider.generate({ consumer, profileId: 'afm', prompt: 'q' })
    expect(result).toMatchObject({ ok: false, code: 'bad-request' })
    expect(runtime.calls.completeApple).toHaveLength(0)
  })

  it('a vision call never resolves to a profile whose node reported no image input', async () => {
    const { provider, runtime } = await setup({ profiles: [afmProfile()] })
    const result = await provider.generateVision({
      consumer: 'notifier-narration',
      profileId: 'afm',
      prompt: 'q',
      images: [{ bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }],
    })
    expect(result).toMatchObject({ ok: false, code: 'bad-request' })
    expect(runtime.calls.completeApple).toHaveLength(0)
  })

  it('llm.cancel reaches the Apple generation on its node', async () => {
    let finish: (r: LlmGenerateResult) => void = () => {}
    const runtime = fakeRuntimeClient({
      completeApple: () =>
        new Promise<LlmGenerateResult>((resolve) => {
          finish = resolve
        }),
    })
    const { provider } = await setup({ profiles: [afmProfile()], textDefault: 'afm', runtime })
    const pending = provider.generate({ consumer: 'x', prompt: 'q', requestId: 'r7' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await provider.cancel({ requestId: 'r7' })
    expect(runtime.calls.cancel).toEqual([{ nodeId: 'mac', requestId: 'r7' }])
    finish(OK_RESULT)
    await pending
  })
})

describe('apple-foundation profile rows', () => {
  it('upsert stamps the model and takes supportsVision from the NODE, not the form', async () => {
    const { provider } = await setup({ profiles: [] })
    const saved = await provider.upsertProfile({
      profile: afmProfile({ model: 'whatever', supportsVision: true }),
    })
    expect(saved).toMatchObject({ model: 'apple-system', supportsVision: false })
  })

  it('a node that reports image input makes the row vision-capable', async () => {
    const runtime = fakeRuntimeClient({
      appleAvailability: async () => ({
        state: 'available',
        osVersion: '27.0',
        contextSize: 8192,
        languages: ['it-IT'],
        imageInput: true,
      }),
    })
    const { provider } = await setup({ profiles: [], runtime })
    expect(await provider.upsertProfile({ profile: afmProfile() })).toMatchObject({
      supportsVision: true,
    })
  })

  it('a node that cannot be asked is NOT vision-capable (unknown is not yes)', async () => {
    const runtime = fakeRuntimeClient({
      appleAvailability: async () => {
        throw new Error('offline')
      },
    })
    const { provider } = await setup({ profiles: [], runtime })
    expect(
      await provider.upsertProfile({ profile: afmProfile({ supportsVision: true }) }),
    ).toMatchObject({ supportsVision: false })
  })

  it('supportsVision follows the node NOW, not the value stored at save', async () => {
    let imageInput = false
    const runtime = fakeRuntimeClient({
      appleAvailability: async () => ({
        state: 'available',
        osVersion: '27.0',
        contextSize: 8192,
        languages: ['it-IT'],
        imageInput,
      }),
    })
    const { provider, appleNodes } = await setup({ profiles: [], runtime })
    await provider.upsertProfile({ profile: afmProfile() })
    expect((await provider.listProfiles({}))[0]?.supportsVision).toBe(false)
    imageInput = true // the node was upgraded; nobody re-saved the profile
    await appleNodes.refresh() // the mirror's background refresh
    expect((await provider.listProfiles({}))[0]?.supportsVision).toBe(true)
    const vision = await provider.generateVision({
      consumer: 'notifier-narration',
      profileId: 'afm',
      prompt: 'q',
      images: [{ bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }],
    })
    expect(vision).toMatchObject({ ok: true })
    expect(runtime.calls.completeApple).toHaveLength(1)
  })

  it('a node that REPORTS it is not a Mac cannot be saved on the row', async () => {
    const runtime = fakeRuntimeClient({
      appleAvailability: async () => ({ state: 'unsupported-platform', platform: 'linux' }),
    })
    const { provider } = await setup({ profiles: [], runtime })
    await expect(provider.upsertProfile({ profile: afmProfile() })).rejects.toThrow(/cannot run/)
  })

  it('an apple-foundation row with no node is refused', async () => {
    const { provider } = await setup({ profiles: [] })
    await expect(
      provider.upsertProfile({ profile: afmProfile({ appleFoundation: undefined }) }),
    ).rejects.toThrow(/node/)
  })

  it('the kind is offered, lists its one model, and every runtime node reports its Apple state', async () => {
    const runtime = fakeRuntimeClient({
      listRuntimeNodeIds: async () => ['mac', 'hub'],
      appleAvailability: async (nodeId) => {
        if (nodeId === 'hub') throw new Error('timeout')
        return {
          state: 'unavailable',
          reason: 'appleIntelligenceNotEnabled',
          osVersion: '26.3.1',
          detail: 'off',
        }
      },
    })
    const { provider } = await setup({ profiles: [afmProfile()], runtime })
    const kinds = await provider.listProfileKinds({})
    expect(kinds.map((k) => k.kind)).toContain('apple-foundation')
    expect(
      await provider.listModels({ addonId: 'ai', kind: 'apple-foundation', profileId: 'afm' }),
    ).toEqual({ ok: true, models: [{ id: 'apple-system', label: 'Apple on-device model' }] })
    const nodes = await provider.listRuntimeNodes({})
    expect(nodes.find((n) => n.nodeId === 'mac')?.apple).toMatchObject({
      state: 'unavailable',
      reason: 'appleIntelligenceNotEnabled',
    })
    // A node that did not answer carries NO apple field — the UI says unknown.
    expect(nodes.find((n) => n.nodeId === 'hub')?.apple).toBeUndefined()
  })

  it('a node the registry reports OFFLINE is never dialled', async () => {
    const runtime = fakeRuntimeClient({ listRegisteredRuntimeNodeIds: async () => ['hub'] })
    const { provider, appleNodes } = await setup({
      profiles: [afmProfile()],
      textDefault: 'afm',
      runtime,
    })
    await appleNodes.refresh() // absent from two answered reads: offline, not a blip
    const result = await provider.generate({ consumer: 'x', prompt: 'q' })
    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect(runtime.calls.completeApple).toHaveLength(0)
  })
})

describe('an Apple node that never answers blocks nothing (N1)', () => {
  /** Rejects if `work` has not settled within `ms` — the assertion is the time. */
  function within<T>(ms: number, work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error(`still waiting after ${String(ms)} ms`)), ms)
      }),
    ])
  }

  it('a vision call to a cloud profile and listProfiles answer at once', async () => {
    const runtime = fakeRuntimeClient({
      appleAvailability: () => new Promise(() => {}),
    })
    const { provider, cloud } = await setup({
      profiles: [afmProfile(), makeProfile({ id: 'cloud', name: 'cloud', supportsVision: true })],
      runtime,
      prime: false,
    })
    const vision = await within(
      200,
      provider.generateVision({
        consumer: 'notifier-rules',
        profileId: 'cloud',
        prompt: 'q',
        images: [{ bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }],
      }),
    )
    expect(vision).toEqual(CLOUD_ANSWER)
    expect(cloud.calls).toHaveLength(1)
    const rows = await within(200, provider.listProfiles({}))
    // Unknown is not yes.
    expect(rows.find((r) => r.id === 'afm')?.supportsVision).toBe(false)
  })

  it('saving an Apple profile never waits on its node either', async () => {
    const runtime = fakeRuntimeClient({ appleAvailability: () => new Promise(() => {}) })
    const { provider } = await setup({ profiles: [], runtime, prime: false })
    expect(await within(200, provider.upsertProfile({ profile: afmProfile() }))).toMatchObject({
      supportsVision: false,
    })
  })
})

describe('a cancel that arrives before its generation registered (m2)', () => {
  it('stops the call when it would start, on the hub', async () => {
    const { provider, runtime } = await setup({ profiles: [afmProfile()], textDefault: 'afm' })
    await provider.cancel({ requestId: 'early' })
    const result = await provider.generate({ consumer: 'x', prompt: 'q', requestId: 'early' })
    expect(result).toEqual({ ok: false, code: 'timeout', message: 'the call was cancelled' })
    expect(runtime.calls.completeApple).toHaveLength(0)
  })

  it('also for a cloud call, which registers only inside the client path', async () => {
    const { provider, cloud } = await setup({
      profiles: [makeProfile({ id: 'cloud', name: 'cloud' })],
      textDefault: 'cloud',
    })
    await provider.cancel({ requestId: 'early-cloud' })
    const result = await provider.generate({ consumer: 'x', prompt: 'q', requestId: 'early-cloud' })
    expect(result).toMatchObject({ ok: false, code: 'timeout' })
    expect(cloud.calls).toHaveLength(0)
  })
})
