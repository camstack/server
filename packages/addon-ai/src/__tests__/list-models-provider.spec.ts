/**
 * `llm.listModels` on the provider (D893): an UNSAVED draft is listed with the
 * key the operator typed; an existing profile whose draft leaves the key
 * untouched is listed with the STORED key, resolved server-side — and in both
 * cases the answer never contains the key. Plus the provider owning
 * `providerConfig` on save, and the kind's one secret field. Every key below
 * is fabricated.
 */
import type { LlmClient } from '../client/llm-client.js'
import type { LlmGenerateResult, LlmProfile, ManagedModelCatalogEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DefaultsStore } from '../defaults-store.js'
import { secretFieldOfDescriptor } from '../kinds/provider-config.js'
import { ProfileStore } from '../profile-store.js'
import { createLlmProvider } from '../provider.js'
import { REDACTED_MARKER } from '../secrets.js'
import type { UsageFilter, UsageRecorder, UsageRowInput } from '../usage/usage-port.js'
import { makeAiRecords } from './support/fake-records.js'
import { fakeRuntimeClient } from './support/fake-runtime.js'
import { makeProfile } from './support/profile.js'

const STORED_KEY = 'fake-stored-key-0001'
const DRAFT_KEY = 'fake-draft-key-0002'

class NoUsage implements UsageRecorder {
  async record(_row: UsageRowInput): Promise<void> {}
  async rollup(_filter: UsageFilter): Promise<never[]> {
    return []
  }
}

const OK: LlmGenerateResult = {
  ok: true,
  text: 'ok',
  model: 'm',
  usage: { inputTokens: 1, outputTokens: 1 },
  truncated: false,
  latencyMs: 1,
}
const client: LlmClient = {
  supports: () => true,
  generate: async () => OK,
  openStream: async () => ({ kind: 'unsupported' }),
}

const CATALOG: readonly ManagedModelCatalogEntry[] = [
  {
    id: 'qwen-vl',
    label: 'Qwen VL',
    family: 'qwen',
    purpose: 'vision',
    url: 'https://example.com/qwen.gguf',
    sha256: 'abc',
    sizeBytes: 1,
    quantization: 'Q4_K_M',
    minRamBytes: 1,
    contextSizeDefault: 8192,
  },
]

async function setup(rows: readonly LlmProfile[] = []) {
  const world = await makeAiRecords()
  const store = ProfileStore.of(world.records)
  for (const row of rows) await store.upsert(row)
  const auths: string[] = []
  const urls: string[] = []
  const listModelsFetch: typeof fetch = async (input, init) => {
    urls.push(String(input))
    auths.push(new Headers(init?.headers).get('authorization') ?? '<none>')
    return new Response(JSON.stringify({ data: [{ id: 'gpt-listed' }] }), {
      status: 200,
    })
  }
  const { runtime } = fakeRuntimeClient()
  const provider = createLlmProvider({
    store,
    defaults: DefaultsStore.of(world.records),
    client,
    usage: new NoUsage(),
    listModelsFetch,
    runtime,
    catalog: CATALOG,
  })
  return { world, store, provider, auths, urls }
}

const stored = makeProfile({
  id: 'cloud',
  kind: 'openai',
  baseUrl: undefined,
  apiKey: STORED_KEY,
})

describe('listModels — draft vs saved secret', () => {
  it('an unsaved draft is listed with the key the operator typed', async () => {
    const { provider, auths } = await setup()
    const result = await provider.listModels({
      addonId: 'ai',
      kind: 'openai',
      connection: { apiKey: DRAFT_KEY },
    })
    expect(result).toEqual({ ok: true, models: [{ id: 'gpt-listed' }] })
    expect(auths).toEqual([`Bearer ${DRAFT_KEY}`])
  })

  it('an existing profile with an UNTOUCHED key is listed with the stored key — never returned', async () => {
    const { provider, auths, urls } = await setup([stored])
    const result = await provider.listModels({
      addonId: 'ai',
      kind: 'openai',
      profileId: 'cloud',
      // What the editor sends: the redacted read, with an edited base URL.
      connection: {
        apiKey: REDACTED_MARKER,
        baseUrl: 'https://gw.example.com/v1',
      },
    })
    expect(auths).toEqual([`Bearer ${STORED_KEY}`])
    expect(urls).toEqual(['https://gw.example.com/v1/models'])
    expect(JSON.stringify(result)).not.toContain(STORED_KEY)
  })

  it('a saved profile with no draft is listed from what is stored', async () => {
    const { provider, auths } = await setup([stored])
    await provider.listModels({
      addonId: 'ai',
      kind: 'openai',
      profileId: 'cloud',
    })
    expect(auths).toEqual([`Bearer ${STORED_KEY}`])
  })

  it('a stored key the keychain cannot serve is `auth`, and nothing is dialled keyless', async () => {
    const { world, provider, auths } = await setup([stored])
    world.keychain.setLocked(true)
    const result = await provider.listModels({
      addonId: 'ai',
      kind: 'openai',
      profileId: 'cloud',
      connection: { apiKey: REDACTED_MARKER },
    })
    expect(result).toMatchObject({ ok: false, code: 'auth' })
    expect(auths).toEqual([])
  })

  it('a stored profile of ANOTHER kind lends no key', async () => {
    const { provider, auths } = await setup([stored])
    await provider.listModels({
      addonId: 'ai',
      kind: 'openai-compatible',
      profileId: 'cloud',
      connection: {
        baseUrl: 'http://192.0.2.20:11434/v1',
        apiKey: REDACTED_MARKER,
      },
    })
    // The list, then the local-server probe (`/api/tags`): neither carries a key.
    expect(auths.length).toBeGreaterThan(0)
    expect(auths.every((a) => a === '<none>')).toBe(true)
  })

  it('Apple answers its static list; an unknown kind is `invalid`', async () => {
    const { provider } = await setup()
    expect(await provider.listModels({ addonId: 'ai', kind: 'apple-foundation' })).toEqual({
      ok: true,
      models: [{ id: 'apple-system', label: 'Apple on-device model' }],
    })
    expect(await provider.listModels({ addonId: 'ai', kind: 'not-ours' })).toMatchObject({
      ok: false,
      code: 'invalid',
    })
  })

  it('managed-local answers its catalogue, with vision from the entry', async () => {
    const { provider } = await setup()
    expect(await provider.listModels({ addonId: 'ai', kind: 'managed-local' })).toEqual({
      ok: true,
      models: [
        {
          id: 'qwen-vl',
          label: 'Qwen VL',
          contextLength: 8192,
          features: { vision: true },
        },
      ],
    })
  })
})

describe('upsertProfile — the provider owns providerConfig', () => {
  it('refuses a custom endpoint without a base URL', async () => {
    const { provider } = await setup()
    await expect(
      provider.upsertProfile({
        profile: makeProfile({
          id: 'x',
          kind: 'openai-compatible',
          baseUrl: undefined,
        }),
      }),
    ).rejects.toThrow(/base URL/)
  })

  it('refuses a kind it does not serve', async () => {
    const { provider } = await setup()
    await expect(
      provider.upsertProfile({
        profile: makeProfile({ id: 'x', kind: 'not-ours' }),
      }),
    ).rejects.toThrow(/serves no kind/)
  })

  it('refuses a managed-local profile with no model reference', async () => {
    const { provider } = await setup()
    await expect(
      provider.upsertProfile({
        profile: makeProfile({
          id: 'x',
          kind: 'managed-local',
          baseUrl: undefined,
          providerConfig: { nodeId: 'hub' },
        }),
      }),
    ).rejects.toThrow(/model/)
  })
})

describe('a kind has ONE secret field, by schema type', () => {
  const base = {
    kind: 'two-keys',
    label: 'two keys',
    icon: 'plug',
    features: { vision: false, tools: false, streaming: false },
    visionEditable: true,
    modelCatalog: 'none' as const,
    profileFields: [],
  }
  it('the password field of the schema is the secret, whatever its name', () => {
    expect(
      secretFieldOfDescriptor({
        ...base,
        connectionSchema: {
          sections: [
            {
              id: 'c',
              title: 'c',
              fields: [{ type: 'password', key: 'token', label: 't' }],
            },
          ],
        },
      }),
    ).toBe('token')
  })
  it('two secret fields are refused — the row has one keychain slot', () => {
    expect(() =>
      secretFieldOfDescriptor({
        ...base,
        connectionSchema: {
          sections: [
            {
              id: 'c',
              title: 'c',
              fields: [
                { type: 'password', key: 'a', label: 'a' },
                { type: 'password', key: 'b', label: 'b' },
              ],
            },
          ],
        },
      }),
    ).toThrow(/2 secret fields/)
  })
})
