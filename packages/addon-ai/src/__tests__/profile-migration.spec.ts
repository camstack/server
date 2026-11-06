/**
 * D893 — stored profile rows of the flat shape move to `providerConfig`, and
 * NOTHING is lost on the way: every flat field of a marked fixture is found
 * again in `providerConfig`, every common field is untouched, and the API key
 * is served from the SAME keychain ref before and after (the slot is not
 * moved, so no secret is copied). Every value below is fabricated.
 */
import {
  defineAddonMigrations,
  isSecretMarker,
  type LlmProfile,
  type MigrationOwnerResult,
  recordSecretRef,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { migrateProfileBody } from '../profile-migration.js'
import { ADDON_MIGRATIONS, PROFILE_RAW_KEYS_TO_KEYCHAIN_ID } from '../migrations/index.js'
import { ProfileStore } from '../profile-store.js'
import { aiRecordKinds } from '../record-kinds.js'
import { readAllRows } from '../record-pages.js'
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

/** The migration bound to the world's records, the way the addon binds it. */
function runnerOver(world: Awaited<ReturnType<typeof makeAiRecords>>, readFails = false) {
  const handle = world.records.kind(aiRecordKinds['llm-profiles'])
  const warnings: string[] = []
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, {
    listRows: async () => {
      if (readFails) throw new Error('records unreadable')
      return (await readAllRows(handle)).map((row) => ({ id: row.id, data: row.data }))
    },
    putRow: async (id: string, data: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the migration hands over a row it validated against the profile schema
      await handle.put({ id, data: data as never })
    },
    warn: (message: string) => {
      warnings.push(message)
    },
  })
  const run = async (): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === PROFILE_RAW_KEYS_TO_KEYCHAIN_ID)
    if (entry === undefined) throw new Error('migration not in the catalogue')
    return entry.execute()
  }
  return { run, warnings }
}

describe('ai/2026-11-06-profile-raw-keys-to-keychain', () => {
  it('rewrites the stored rows, keeps the key on the SAME ref, and loses nothing', async () => {
    const { world, ref, store } = await seeded()
    const before = await store.list()

    await runnerOver(world).run()

    // The ROWS changed shape - not just the read view.
    for (const id of ['http', 'managed', 'apple']) {
      const row = rawRow(world, id)
      for (const flat of ['baseUrl', 'extraHeaders', 'runtime', 'appleFoundation']) {
        expect(row).not.toHaveProperty(flat)
      }
      expect(row).toHaveProperty('providerConfig')
    }
    // The key slot is untouched: still a marker on the record's own ref, and
    // the keychain holds the one value under it - nothing was copied.
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
    const { world } = await seeded()
    const { run } = runnerOver(world)
    expect(await run()).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const rows = JSON.stringify([...(world.tables.get('llm-profiles')?.values() ?? [])])
    expect(await run()).toMatchObject({ kind: 'procedure', result: { outcome: 'already-done' } })
    expect(JSON.stringify([...(world.tables.get('llm-profiles')?.values() ?? [])])).toBe(rows)
  })

  it('runs with the keychain LOCKED - it never reads a key to move a row', async () => {
    const { world, ref, store } = await seeded()
    world.keychain.setLocked(true)
    await runnerOver(world).run()
    world.keychain.setLocked(false)
    expect(rawRow(world, 'http')?.apiKey).toEqual({ $secret: ref, v: 1 })
    expect(byId(await store.list(), 'http').providerConfig.apiKey).toBe(KEY)
  })

  it('a plaintext key in providerConfig becomes a keychain marker that reads back equal', async () => {
    const world = await makeAiRecords()
    world.seed('llm-profiles', {
      id: 'raw',
      data: {
        ...COMMON,
        name: 'raw key',
        kind: 'anthropic',
        model: 'claude-x',
        providerConfig: { baseUrl: `https://gw.example.com/${MARK}`, apiKey: KEY },
      },
    })
    await runnerOver(world).run()
    const row = rawRow(world, 'raw')
    expect(isSecretMarker(row?.apiKey)).toBe(true)
    expect(JSON.stringify(row)).not.toContain(KEY)
    expect(row?.providerConfig).toEqual({ baseUrl: `https://gw.example.com/${MARK}` })
    expect([...world.keychain.values.values()]).toEqual([KEY])
    expect((await ProfileStore.of(world.records).getById('raw'))?.providerConfig.apiKey).toBe(KEY)
  })

  it('a row that already holds a marker is left byte for byte', async () => {
    const { world, ref } = await seeded()
    await runnerOver(world).run()
    const settled = JSON.stringify(world.tables.get('llm-profiles')?.get('http'))
    await runnerOver(world).run()
    expect(JSON.stringify(world.tables.get('llm-profiles')?.get('http'))).toBe(settled)
    expect([...world.keychain.values.entries()]).toEqual([[ref, KEY]])
  })

  it('a disabled profile stays disabled and a default selection survives', async () => {
    const world = await makeAiRecords()
    world.seed('llm-profiles', {
      id: 'off',
      data: { ...FLAT_HTTP, enabled: false, apiKey: KEY },
    })
    world.seed('llm-defaults', {
      id: 'purpose:vision',
      data: { selector: { purpose: 'vision' }, profileId: 'off' },
    })
    const defaultsBefore = JSON.stringify(world.tables.get('llm-defaults')?.get('purpose:vision'))
    await runnerOver(world).run()
    expect(rawRow(world, 'off')?.enabled).toBe(false)
    expect(rawRow(world, 'off')?.systemPrompt).toBe(`be brief ${MARK}`)
    expect(JSON.stringify(world.tables.get('llm-defaults')?.get('purpose:vision'))).toBe(
      defaultsBefore,
    )
    expect((await ProfileStore.of(world.records).getById('off'))?.enabled).toBe(false)
  })

  it('a list that cannot be read writes nothing', async () => {
    const { world } = await seeded()
    const before = JSON.stringify([...(world.tables.get('llm-profiles')?.values() ?? [])])
    await expect(runnerOver(world, true).run()).resolves.toMatchObject({ kind: 'failed' })
    expect(JSON.stringify([...(world.tables.get('llm-profiles')?.values() ?? [])])).toBe(before)
  })

  it('a flat row reads correctly BEFORE the boot rewrite ran', async () => {
    const { store } = await seeded()
    const http = byId(await store.list(), 'http')
    expect(http.providerConfig.baseUrl).toBe(FLAT_HTTP.baseUrl)
    expect(http.providerConfig.apiKey).toBe(KEY)
  })
})
