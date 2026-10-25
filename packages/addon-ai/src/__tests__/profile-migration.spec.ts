/**
 * D893 — stored profile rows of the flat shape move to `providerConfig`, and
 * NOTHING is lost on the way: every flat field of a marked fixture is found
 * again in `providerConfig`, every common field is untouched, and the API key
 * is served from the SAME keychain ref before and after (the slot is not
 * moved, so no secret is copied). Every value below is fabricated.
 */
import { type LlmProfile, recordSecretRef } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { migrateProfileBody } from '../profile-migration.js'
import { ProfileStore } from '../profile-store.js'
import { makeAiRecords } from './support/fake-records.js'

const KEY = 'fake-key-migration-0001'
/** A value nothing else in the suite uses, so finding it proves it SURVIVED. */
const MARK = 'marked-7f3a'

const COMMON = {
  addonId: 'ai',
  enabled: true,
  supportsVision: true,
  temperature: 0.3,
  topK: 17,
  systemPrompt: `be brief ${MARK}`,
  timeoutMs: 61_000,
  connectTimeoutMs: 11_000,
  firstTokenTimeoutMs: 121_000,
  idleTimeoutMs: 59_000,
  retry: { enabled: true, maxAttempts: 3 },
  toolsEnabled: true,
}

const FLAT_HTTP = {
  ...COMMON,
  name: 'flat anthropic',
  kind: 'anthropic',
  model: 'claude-x',
  baseUrl: `https://gw.example.com/${MARK}/v1`,
  extraHeaders: { 'x-mark': MARK },
}

const RUNTIME = {
  nodeId: `agent-${MARK}`,
  engine: 'llama-cpp',
  model: { kind: 'catalog', catalogId: 'qwen-mark' },
  extraArgs: ['--jinja'],
  contextSize: 8192,
  gpuLayers: 33,
  parallel: 2,
  flashAttention: true,
  mlock: false,
  noMmap: false,
  autoStart: true,
  idleStopMinutes: 12,
}

const FLAT_MANAGED = {
  ...COMMON,
  name: 'flat managed',
  kind: 'managed-local',
  model: 'qwen-mark',
  runtime: RUNTIME,
}

const FLAT_APPLE = {
  ...COMMON,
  name: 'flat apple',
  kind: 'apple-foundation',
  model: 'apple-system',
  appleFoundation: { nodeId: `mac-${MARK}` },
}

async function seeded() {
  const world = await makeAiRecords()
  const ref = recordSecretRef('ai', 'llm-profiles', 'http', 'apiKey')
  world.keychain.values.set(ref, KEY)
  world.seed('llm-profiles', { id: 'http', data: { ...FLAT_HTTP, apiKey: { $secret: ref, v: 1 } } })
  world.seed('llm-profiles', { id: 'managed', data: FLAT_MANAGED })
  world.seed('llm-profiles', { id: 'apple', data: FLAT_APPLE })
  return { world, ref, store: ProfileStore.of(world.records) }
}

function rawRow(world: Awaited<ReturnType<typeof makeAiRecords>>, id: string) {
  return world.tables.get('llm-profiles')?.get(id)?.data
}

function byId(profiles: readonly LlmProfile[], id: string): LlmProfile {
  const found = profiles.find((p) => p.id === id)
  if (found === undefined) throw new Error(`no profile ${id}`)
  return found
}

describe('migrateProfileBody (pure)', () => {
  it('moves every flat field into providerConfig and leaves the common ones alone', () => {
    const { body, changed } = migrateProfileBody({ ...FLAT_HTTP })
    expect(changed).toBe(true)
    expect(body).not.toHaveProperty('baseUrl')
    expect(body).not.toHaveProperty('extraHeaders')
    expect(body.providerConfig).toEqual({
      baseUrl: FLAT_HTTP.baseUrl,
      extraHeaders: [{ name: 'x-mark', value: MARK }],
    })
    for (const [key, value] of Object.entries(COMMON)) expect(body[key]).toEqual(value)
  })

  it('spreads a managed runtime and lifts an Apple node', () => {
    expect(migrateProfileBody({ ...FLAT_MANAGED }).body.providerConfig).toEqual(RUNTIME)
    expect(migrateProfileBody({ ...FLAT_APPLE }).body.providerConfig).toEqual({
      nodeId: `mac-${MARK}`,
    })
  })

  it('is idempotent: a migrated body comes back unchanged', () => {
    const once = migrateProfileBody({ ...FLAT_MANAGED }).body
    const twice = migrateProfileBody(once)
    expect(twice.changed).toBe(false)
    expect(twice.body).toBe(once)
  })
})

describe('ProfileStore.migrateLegacyRows', () => {
  it('rewrites the stored rows, keeps the key on the SAME ref, and loses nothing', async () => {
    const { world, ref, store } = await seeded()
    const before = await store.list()

    expect(await store.migrateLegacyRows()).toBe(3)

    // The ROWS changed shape — not just the read view.
    for (const id of ['http', 'managed', 'apple']) {
      const row = rawRow(world, id)
      for (const flat of ['baseUrl', 'extraHeaders', 'runtime', 'appleFoundation']) {
        expect(row).not.toHaveProperty(flat)
      }
      expect(row).toHaveProperty('providerConfig')
    }
    // The key slot is untouched: still a marker on the record's own ref, and
    // the keychain holds the one value under it — nothing was copied.
    expect(rawRow(world, 'http')?.apiKey).toEqual({ $secret: ref, v: 1 })
    expect([...world.keychain.values.entries()]).toEqual([[ref, KEY]])
    expect(JSON.stringify(rawRow(world, 'http'))).not.toContain(KEY)

    const after = await store.list()
    expect(after).toEqual(before)
    const http = byId(after, 'http')
    expect(http.providerConfig).toEqual({
      baseUrl: FLAT_HTTP.baseUrl,
      extraHeaders: [{ name: 'x-mark', value: MARK }],
      apiKey: KEY,
    })
    expect(http.systemPrompt).toBe(`be brief ${MARK}`)
    expect(http.retry).toEqual({ enabled: true, maxAttempts: 3 })
    expect(byId(after, 'managed').providerConfig).toMatchObject(RUNTIME)
    expect(byId(after, 'apple').providerConfig).toEqual({ nodeId: `mac-${MARK}` })
  })

  it('a second run changes nothing', async () => {
    const { store } = await seeded()
    await store.migrateLegacyRows()
    expect(await store.migrateLegacyRows()).toBe(0)
  })

  it('runs with the keychain LOCKED — it never reads a key to move a row', async () => {
    const { world, ref, store } = await seeded()
    world.keychain.setLocked(true)
    expect(await store.migrateLegacyRows()).toBe(3)
    world.keychain.setLocked(false)
    expect(rawRow(world, 'http')?.apiKey).toEqual({ $secret: ref, v: 1 })
    expect(byId(await store.list(), 'http').providerConfig.apiKey).toBe(KEY)
  })

  it('a flat row reads correctly BEFORE the boot rewrite ran', async () => {
    const { store } = await seeded()
    const http = byId(await store.list(), 'http')
    expect(http.providerConfig.baseUrl).toBe(FLAT_HTTP.baseUrl)
    expect(http.providerConfig.apiKey).toBe(KEY)
  })
})
