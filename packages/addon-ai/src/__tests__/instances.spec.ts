/**
 * LLM profiles served as `integration-instances`. The records world is the real facade over an
 * in-memory transport, so a key that was not routed through the keychain fails here. Every key is
 * fabricated.
 */
import {
  isSecretFieldView,
  isSecretMarker,
  type LlmGenerateResult,
  recordSecretRef,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { LlmClient } from '../client/llm-client.js'
import { DefaultsStore } from '../defaults-store.js'
import { createLlmInstances } from '../instances.js'
import { AI_KIND_DESCRIPTORS } from '../kinds/descriptors.js'
import { ProfileStore } from '../profile-store.js'
import { buildLlmProvider } from '../provider.js'
import { resolveProfile } from '../resolve-profile.js'
import { REDACTED_MARKER } from '../secrets.js'
import type { UsageRecorder } from '../usage/usage-port.js'
import { makeAiRecords } from './support/fake-records.js'

const KEY = 'fake-key-instances-0001'
const NEW_KEY = 'fake-key-instances-0002'
const URL_MARK = 'https://gw.example.com/marked-91c2/v1'

const OK: LlmGenerateResult = {
  ok: true,
  text: 'ok',
  model: 'm',
  usage: { inputTokens: 1, outputTokens: 1 },
  truncated: false,
  latencyMs: 7,
}

const NO_USAGE: UsageRecorder = {
  record: async () => {},
  rollup: async () => [],
}

async function world(
  answer: () => Promise<LlmGenerateResult> = async () => OK,
  testBudgetMs?: number,
) {
  const w = await makeAiRecords()
  const store = ProfileStore.of(w.records)
  const client: LlmClient = {
    supports: () => true,
    generate: async () => answer(),
    openStream: async () => ({ kind: 'unsupported' }),
  }
  const { profiles } = buildLlmProvider({
    store,
    defaults: DefaultsStore.of(w.records),
    client,
    usage: NO_USAGE,
  })
  const instances = createLlmInstances({
    store,
    profiles,
    records: w.records,
    ...(testBudgetMs !== undefined ? { testBudgetMs } : {}),
  })
  return { w, store, instances }
}

const rawRow = (w: Awaited<ReturnType<typeof world>>['w'], id: string) =>
  w.tables.get('llm-profiles')?.get(id)?.data

async function createKeyed(instances: Awaited<ReturnType<typeof world>>['instances']) {
  return instances.createInstance({
    id: 'a',
    name: 'Cloud',
    kind: 'anthropic',
    values: {
      model: 'claude-x',
      baseUrl: URL_MARK,
      apiKey: KEY,
      temperature: 0.4,
    },
  })
}

describe('llm profiles as integration-instances', () => {
  it('serves every descriptor kind, configured for the llm function cap', async () => {
    const { instances } = await world()
    const described = await instances.describe()
    expect(described.kinds?.map((k) => k.id)).toEqual(AI_KIND_DESCRIPTORS.map((d) => d.kind))
    expect(described.kinds?.every((k) => k.functionCap === 'llm' && k.canTest === true)).toBe(true)
    expect(described).toMatchObject({
      canTest: true,
      instanceMode: 'multiple',
      mintsId: true,
    })
  })

  it('names the widgets a kind draws itself, and only on the kinds that have one', async () => {
    const { instances } = await world()
    const described = await instances.describe()
    const widgetsOf = (id: string) => described.kinds?.find((k) => k.id === id)?.widgets
    expect(widgetsOf('managed-local')).toEqual([{ id: 'ai/managed-model', placement: 'model' }])
    expect(widgetsOf('apple-foundation')).toEqual([
      { id: 'ai/apple-node', placement: 'connection' },
    ])
    expect(widgetsOf('openai')).toBeUndefined()
  })

  it('carries a managed model reference as modelRef, apart from the display model id', async () => {
    const { instances } = await world()
    const modelRef = { kind: 'catalog', catalogId: 'llm-qwen2.5-1.5b-instruct-q4' }
    await instances.createInstance({
      id: 'm',
      name: 'Local',
      kind: 'managed-local',
      values: { nodeId: 'hub', model: 'Qwen 1.5B', modelRef },
    })
    const [listed] = await instances.listInstances()
    expect(listed?.formValues.model).toBe('Qwen 1.5B')
    expect(listed?.formValues.modelRef).toEqual(modelRef)
    await instances.updateInstance({ id: 'm', values: { model: 'Qwen renamed' } })
    const [kept] = await instances.listInstances()
    expect(kept?.formValues.modelRef).toEqual(modelRef)
  })

  it('stores the key in the keychain and lists it as a view, flat beside the provider fields', async () => {
    const { w, instances } = await world()
    await createKeyed(instances)
    expect(isSecretMarker(rawRow(w, 'a')?.['apiKey'])).toBe(true)
    expect([...w.keychain.values.entries()]).toEqual([
      [recordSecretRef('ai', 'llm-profiles', 'a', 'apiKey'), KEY],
    ])
    const [listed] = await instances.listInstances()
    expect(listed).toMatchObject({
      id: 'a',
      name: 'Cloud',
      kind: 'anthropic',
      enabled: true,
    })
    expect(listed?.formValues.baseUrl).toBe(URL_MARK)
    expect(listed?.formValues.temperature).toBe(0.4)
    expect(isSecretFieldView(listed?.formValues.apiKey)).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(KEY)
  })

  it('keeps the key when the patch omits it, sends the view back, or the redaction token', async () => {
    const { w, instances } = await world()
    await createKeyed(instances)
    const [listed] = await instances.listInstances()
    await instances.updateInstance({ id: 'a', values: { model: 'renamed-1' } })
    await instances.updateInstance({
      id: 'a',
      values: { model: 'renamed-2', apiKey: '' },
    })
    await instances.updateInstance({
      id: 'a',
      values: { model: 'renamed-3', apiKey: listed?.formValues.apiKey },
    })
    await instances.updateInstance({
      id: 'a',
      values: { model: 'renamed-4', apiKey: REDACTED_MARKER },
    })
    expect(rawRow(w, 'a')?.['model']).toBe('renamed-4')
    expect([...w.keychain.values.values()]).toEqual([KEY])
  })

  it('replaces the key on a new string and clears it on $secretClear', async () => {
    const { w, store, instances } = await world()
    await createKeyed(instances)
    await instances.updateInstance({ id: 'a', values: { apiKey: NEW_KEY } })
    expect([...w.keychain.values.values()]).toEqual([NEW_KEY])
    expect((await store.getById('a'))?.providerConfig.apiKey).toBe(NEW_KEY)
    await instances.updateInstance({
      id: 'a',
      values: { apiKey: { $secretClear: true } },
    })
    expect(w.keychain.values.size).toBe(0)
    expect(rawRow(w, 'a')?.['apiKey']).toBeUndefined()
  })

  it('refuses a profile the kind does not accept, the way the old save did', async () => {
    const { instances } = await world()
    await expect(
      instances.createInstance({
        id: 'bad',
        name: 'No URL',
        kind: 'openai-compatible',
        values: { model: 'x' },
      }),
    ).rejects.toThrow(/base URL/)
  })

  it('switches a profile off without touching its key, and deletes row and key together', async () => {
    const { w, instances } = await world()
    await createKeyed(instances)
    await instances.setInstanceEnabled({ id: 'a', enabled: false })
    expect(rawRow(w, 'a')?.['enabled']).toBe(false)
    expect(rawRow(w, 'a')?.['model']).toBe('claude-x')
    expect([...w.keychain.values.values()]).toEqual([KEY])
    await instances.deleteInstance({ id: 'a' })
    expect(rawRow(w, 'a')).toBeUndefined()
    expect(w.keychain.values.size).toBe(0)
  })

  it('the switch flips the field profile resolution reads, and never invents a profile', async () => {
    const { store, instances } = await world()
    await createKeyed(instances)
    const resolve = async () =>
      resolveProfile(await store.list(), [], { profileId: 'a', consumer: 'spec', purpose: 'text' })
    expect((await resolve()).ok).toBe(true)
    await instances.setInstanceEnabled({ id: 'a', enabled: false })
    expect((await store.getById('a'))?.enabled).toBe(false)
    expect((await resolve()).ok).toBe(false)
    await instances.setInstanceEnabled({ id: 'a', enabled: true })
    expect((await resolve()).ok).toBe(true)
    await expect(instances.setInstanceEnabled({ id: 'ghost', enabled: true })).rejects.toThrow(
      /not found/,
    )
    expect(await store.getById('ghost')).toBeNull()
  })

  it('a create with no values is a disabled draft, and the form follows the stored kind', async () => {
    const { w, instances } = await world()
    const { id } = await instances.createInstance({
      name: 'Draft',
      kind: 'apple-foundation',
    })
    expect(id).toMatch(/^llm-/)
    expect(rawRow(w, id)?.['enabled']).toBe(false)
    const form = await instances.instanceFormSchema({ id, kind: undefined })
    const keys = form.sections.flatMap((s) => s.fields.map((f) => f.key))
    expect(keys).toContain('name')
    expect(keys).not.toContain('baseUrl')
  })
})

describe('testInstance', () => {
  it('a model that answers is validated', async () => {
    const { instances } = await world()
    await createKeyed(instances)
    expect(await instances.testInstance?.({ id: 'a', values: {} })).toMatchObject({
      success: true,
      status: 'validated',
      latencyMs: 7,
    })
  })

  it('a refused key is rejected, an unreachable endpoint is inconclusive', async () => {
    const refused = await world(async () => ({
      ok: false,
      code: 'auth',
      message: 'bad key',
    }))
    await createKeyed(refused.instances)
    expect(await refused.instances.testInstance?.({ id: 'a', values: {} })).toMatchObject({
      success: false,
      status: 'rejected',
    })
    const down = await world(async () => ({
      ok: false,
      code: 'unavailable',
      message: 'refused',
    }))
    await createKeyed(down.instances)
    expect(await down.instances.testInstance?.({ id: 'a', values: {} })).toMatchObject({
      success: false,
      status: 'inconclusive',
    })
  })

  it('a model still loading past the budget is inconclusive, named as such', async () => {
    const slow = await world(() => new Promise<LlmGenerateResult>(() => {}), 20)
    await createKeyed(slow.instances)
    expect(await slow.instances.testInstance?.({ id: 'a', values: {} })).toMatchObject({
      success: false,
      status: 'inconclusive',
      error: expect.stringContaining('may still be loading'),
    })
  })

  it('an unsaved profile has nothing to test', async () => {
    const { instances } = await world()
    expect(await instances.testInstance?.({ id: null, values: {} })).toMatchObject({
      success: false,
      status: 'unsupported',
    })
  })
})
