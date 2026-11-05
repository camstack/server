/**
 * ESPHome integrations as typed records (planning#416, D1007), over the real in-memory records
 * engine: the rows-to-record migration gives every board its own id and its own encryption key and
 * password, the board list reads and writes the record, and a board left out of a save releases
 * only its own secrets.
 */
import {
  type IntegrationRowsApi,
  makeInMemoryRecords,
  REDACTED_SECRET,
  recordSecretRef,
} from '@camstack/types'
import { integrationRowsPortsOverApi } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { espBrokersEntryKind } from '../broker-record-kinds.js'
import type { EspBrokerEntry, EspConnection } from '../config.js'
import {
  buildEspBoardsStore,
  buildEspInstances,
  espConnectionsEntryKind,
} from '../esphome-instances.js'
import { EspIntegrationBoards, type EspBoardSessions } from '../esphome-integration-boards.js'
import {
  ESPHOME_ROWS_TO_RECORD_ID,
  ESPHOME_ROWS_TO_RECORD_MIGRATION,
  type EspRowsPorts,
} from '../migrations/index.js'
import { captureLogger } from './fake-ctx.js'

const ADDON = 'provider-esphome'
const KIND = espConnectionsEntryKind.name

function board(id: string, mark: string) {
  return {
    id,
    host: `${mark}.local`,
    port: 6053,
    name: `Board ${mark}`,
    encryptionKey: `KEY-${mark}`,
    password: `PW-${mark}`,
  }
}

const INTEGRATIONS = [
  { id: 'int_0041', addonId: ADDON, name: 'Upstairs' },
  { id: 'int_0042', addonId: ADDON, name: 'Garage' },
  { id: 'int_0099', addonId: 'provider-other', name: 'Not ESPHome' },
] as const

const ROWS: Record<string, Record<string, unknown>> = {
  int_0041: {
    boards: [board('esp_a1', 'a1'), board('esp_a2', 'a2')],
    brokerId: 'esp_legacy',
    legacyUnread: 'mark-unread',
  },
  int_0042: { boards: [board('esp_b1', 'b1'), board('esp_b2', 'b2')] },
  int_0099: { host: '10.9.9.9' },
}

const LEGACY: EspBrokerEntry = {
  id: 'esp_legacy',
  name: 'Old kitchen relay',
  connection: { host: 'old-kitchen.local', port: 6054, noisePsk: 'KEY-old', password: 'PW-old' },
  integrationId: 'int_0041',
}
const ORPHAN: EspBrokerEntry = {
  id: 'esp_orphan',
  name: 'Unlinked',
  connection: { host: 'orphan.local', port: 6053, noisePsk: 'KEY-orphan', password: '' },
}

async function setup(legacy: readonly EspBrokerEntry[] = [LEGACY, ORPHAN]) {
  const engine = makeInMemoryRecords(ADDON)
  await engine.records.declare({
    brokers: espBrokersEntryKind,
    connections: espConnectionsEntryKind,
  })
  const brokers = engine.records.kind(espBrokersEntryKind)
  for (const entry of legacy) {
    const { id, name, connection, integrationId } = entry
    await brokers.put(
      { id, data: { name, connection, ...(integrationId ? { integrationId } : {}) } },
      { ifRev: 0 },
    )
  }
  const rows = new Map(Object.entries(ROWS).map(([id, r]) => [id, structuredClone(r)]))
  const rowKeychain = new Set(
    Object.entries(ROWS).flatMap(([id, r]) =>
      (Array.isArray(r['boards']) ? r['boards'] : []).flatMap((b: { id: string }) => [
        `${id}/boards[${b.id}].encryptionKey`,
        `${id}/boards[${b.id}].password`,
      ]),
    ),
  )
  const warnings: string[] = []
  const api: IntegrationRowsApi = {
    list: async () => INTEGRATIONS.map((i) => ({ ...i })),
    readLegacyIntegrationRows: async ({ integrationId: id }) => structuredClone(rows.get(id) ?? {}),
    clearLegacyIntegrationRows: async ({ integrationId: id }) => {
      rows.set(id, {})
      for (const entry of rowKeychain) if (entry.startsWith(`${id}/`)) rowKeychain.delete(entry)
    },
  }
  const handle = engine.records.kind(espConnectionsEntryKind)
  const ports: EspRowsPorts = {
    ...integrationRowsPortsOverApi({
      api,
      records: engine.records.kind({
        name: KIND,
        declaration: espConnectionsEntryKind.declaration,
        schema: z.record(z.string(), z.unknown()),
      }),
      log: { warn: (m) => warnings.push(m) },
    }),
    listLegacy: async () => {
      const out: EspBrokerEntry[] = []
      for (const record of (await brokers.query({ limit: 100 })).records) {
        const resolved = await brokers.getResolved(record.id)
        if (resolved === null) continue
        out.push({
          id: record.id,
          name: resolved.data.name,
          connection: resolved.data.connection,
          ...(resolved.data.integrationId ? { integrationId: resolved.data.integrationId } : {}),
        })
      }
      return out
    },
    removeLegacy: async (ids) => {
      for (const id of ids) await brokers.delete(id)
    },
  }
  const instances = buildEspInstances(engine.records, { onChanged: async () => undefined })
  const store = buildEspBoardsStore(engine.records, instances)
  return { engine, brokers, handle, rows, rowKeychain, warnings, ports, instances, store }
}

type World = Awaited<ReturnType<typeof setup>>

async function secretOf(w: World, integrationId: string, boardId: string, field: string) {
  const ref = recordSecretRef(ADDON, KIND, integrationId, `boards[${boardId}].${field}`)
  const answer = (await w.engine.secrets.resolve([ref]))[ref]
  return answer?.kind === 'value' ? answer.value : null
}

async function boardsOf(w: World, integrationId: string) {
  return (await w.handle.getResolved(integrationId))?.data.boards ?? []
}

describe('esphome rows-to-record migration', () => {
  it('is declared with the id the brief names and blocks its owner', () => {
    expect(ESPHOME_ROWS_TO_RECORD_ID).toBe('provider-esphome/2026-11-05-integration-rows-to-record')
    expect(ESPHOME_ROWS_TO_RECORD_MIGRATION.meta.onFailure).toBe('block-owner')
    expect(espConnectionsEntryKind.declaration.secretPaths.sort()).toEqual([
      'boards[].encryptionKey',
      'boards[].password',
    ])
    expect(espConnectionsEntryKind.declaration.secretArrayKeys).toEqual({ boards: 'id' })
  })

  it('every board keeps its id and exactly its own secrets, and the rows are cleared', async () => {
    const w = await setup()
    const result = await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    expect(result).toMatchObject({ outcome: 'done' })

    const upstairs = await boardsOf(w, 'int_0041')
    expect(upstairs.map((b) => b.id)).toEqual(['esp_a1', 'esp_a2', 'esp_legacy'])
    expect(upstairs[0]).toEqual(board('esp_a1', 'a1'))
    expect(upstairs[1]).toEqual(board('esp_a2', 'a2'))
    expect(await boardsOf(w, 'int_0042')).toEqual([board('esp_b1', 'b1'), board('esp_b2', 'b2')])
    for (const [integrationId, id, mark] of [
      ['int_0041', 'esp_a1', 'a1'],
      ['int_0041', 'esp_a2', 'a2'],
      ['int_0042', 'esp_b1', 'b1'],
      ['int_0042', 'esp_b2', 'b2'],
    ] as const) {
      expect(await secretOf(w, integrationId, id, 'encryptionKey')).toBe(`KEY-${mark}`)
      expect(await secretOf(w, integrationId, id, 'password')).toBe(`PW-${mark}`)
    }
    // A board's key is never reachable under another integration or board.
    expect(await secretOf(w, 'int_0042', 'esp_a1', 'encryptionKey')).toBeNull()

    expect(w.rows.get('int_0041')).toEqual({})
    expect(w.rows.get('int_0042')).toEqual({})
    expect(w.rows.get('int_0099')).toEqual(ROWS['int_0099'])
    expect([...w.rowKeychain]).toEqual([])
    expect(await w.handle.get('int_0099')).toBeNull()
  })

  it('stores no secret in the record body itself', async () => {
    const w = await setup()
    await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    const stored = (await w.handle.get('int_0042'))?.data.boards ?? []
    expect(stored.map((b) => [b.encryptionKey, b.password])).toEqual([
      [REDACTED_SECRET, REDACTED_SECRET],
      [REDACTED_SECRET, REDACTED_SECRET],
    ])
  })

  it('the old single-board record joins the integration that named it; one nothing names stays', async () => {
    const w = await setup()
    await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    const joined = (await boardsOf(w, 'int_0041')).find((b) => b.id === 'esp_legacy')
    expect(joined).toMatchObject({
      host: 'old-kitchen.local',
      port: 6054,
      encryptionKey: 'KEY-old',
      password: 'PW-old',
    })
    expect(await w.brokers.get('esp_legacy')).toBeNull()
    expect(await w.brokers.get('esp_orphan')).not.toBeNull()
    const said = w.warnings.join('\n')
    expect(said).toContain('esp_orphan')
    expect(said).toContain('legacyUnread')
    for (const secret of ['KEY-', 'PW-', 'mark-unread']) expect(said).not.toContain(secret)
  })

  it('is a no-op on a rerun', async () => {
    const w = await setup()
    await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    const snapshot = JSON.stringify([await boardsOf(w, 'int_0041'), await boardsOf(w, 'int_0042')])
    const again = await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    expect(again).toMatchObject({ outcome: 'already-done' })
    expect(JSON.stringify([await boardsOf(w, 'int_0041'), await boardsOf(w, 'int_0042')])).toBe(
      snapshot,
    )
  })

  it('a record that lost a secret is not trusted: the rows stay and the move stops', async () => {
    const w = await setup()
    const lossy: EspRowsPorts = {
      ...w.ports,
      readRecord: async (id) => {
        const back = await w.ports.readRecord(id)
        const boards = back?.['boards']
        if (back === null || !Array.isArray(boards)) return back
        return {
          ...back,
          boards: boards.map((b: Record<string, unknown>) => ({ ...b, encryptionKey: undefined })),
        }
      },
    }
    await expect(ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(lossy)).rejects.toThrow()
    expect(w.rows.get('int_0041')).toEqual(ROWS['int_0041'])
    expect(w.rowKeychain.size).toBeGreaterThan(0)
  })

  it('refuses a board row it cannot carry, naming the integration and the board only', async () => {
    const w = await setup()
    w.rows.set('int_0042', { boards: [{ id: 'esp_b1', host: '', encryptionKey: 'KEY-secret' }] })
    const err = await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports).catch((e: unknown) => e)
    expect(String(err)).toContain('int_0042')
    expect(String(err)).toContain('esp_b1')
    expect(String(err)).not.toContain('KEY-secret')
    expect(w.rows.get('int_0042')).toEqual({
      boards: [{ id: 'esp_b1', host: '', encryptionKey: 'KEY-secret' }],
    })
  })
})

describe('the board list reads and writes the record', () => {
  it('reordering a save keeps every board on its own secrets', async () => {
    const w = await setup([])
    await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    const rows = await w.store.read('int_0041')
    await w.store.write('int_0041', rows.toReversed())
    expect((await boardsOf(w, 'int_0041')).map((b) => b.id)).toEqual(['esp_a2', 'esp_a1'])
    expect(await secretOf(w, 'int_0041', 'esp_a1', 'encryptionKey')).toBe('KEY-a1')
    expect(await secretOf(w, 'int_0041', 'esp_a2', 'password')).toBe('PW-a2')
  })

  it('a board left out of a save releases only its own secrets', async () => {
    const w = await setup([])
    await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    const rows = await w.store.read('int_0041')
    await w.store.write(
      'int_0041',
      rows.filter((r) => r['id'] !== 'esp_a1'),
    )
    expect(await secretOf(w, 'int_0041', 'esp_a1', 'encryptionKey')).toBeNull()
    expect(await secretOf(w, 'int_0041', 'esp_a1', 'password')).toBeNull()
    expect(await secretOf(w, 'int_0041', 'esp_a2', 'encryptionKey')).toBe('KEY-a2')
    expect(await secretOf(w, 'int_0042', 'esp_b1', 'encryptionKey')).toBe('KEY-b1')
  })

  it('a board with no key or password saves without one', async () => {
    const w = await setup([])
    await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    const rows = await w.store.read('int_0042')
    await w.store.write('int_0042', [
      ...rows,
      { id: 'esp_b3', host: 'b3.local', port: 6053, name: '', encryptionKey: '', password: '' },
    ])
    const saved = (await boardsOf(w, 'int_0042')).find((b) => b.id === 'esp_b3')
    expect(saved?.host).toBe('b3.local')
    expect(saved?.encryptionKey ?? '').toBe('')
    expect(await secretOf(w, 'int_0042', 'esp_b3', 'encryptionKey')).toBeNull()
  })

  it('the reconcile starts every board of a moved integration on its own key', async () => {
    const w = await setup([])
    await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    const live = new Map<string, EspConnection>()
    const sessions: EspBoardSessions = {
      list: () => [...live.keys()].map((id) => ({ id })),
      createEntry: async (_name, connection, options) => {
        live.set(options.id, connection)
      },
      updateEntry: async (id, connection) => {
        live.set(id, connection)
      },
      removeEntry: async (id) => {
        live.delete(id)
      },
      hasSameConnection: (id, c) => live.get(id)?.noisePsk === c.noisePsk,
    }
    const boards = new EspIntegrationBoards({
      addonId: ADDON,
      api: {
        listIntegrations: async () =>
          INTEGRATIONS.filter((i) => i.addonId === ADDON).map((i) => ({
            id: i.id,
            addonId: i.addonId,
            enabled: true,
          })),
      },
      store: w.store,
      sessions,
      cascadeRemoveDevices: async () => undefined,
      logger: captureLogger([]),
    })
    await boards.reconcile()
    expect([...live.entries()].map(([id, c]) => [id, c.noisePsk, c.password])).toEqual([
      ['esp_a1', 'KEY-a1', 'PW-a1'],
      ['esp_a2', 'KEY-a2', 'PW-a2'],
      ['esp_b1', 'KEY-b1', 'PW-b1'],
      ['esp_b2', 'KEY-b2', 'PW-b2'],
    ])
  })
})

describe('an integration whose form no longer lists boards', () => {
  it('keeps every saved board and its secrets when the instance is renamed', async () => {
    const w = await setup()
    await ESPHOME_ROWS_TO_RECORD_MIGRATION.procedure(w.ports)
    expect(w.instances.instanceFormSchema).toBeDefined()
    const form = await w.instances.instanceFormSchema({ id: 'int_0042' })
    expect(form.sections.flatMap((s) => s.fields)).toEqual([])

    await w.instances.updateInstance({
      id: 'int_0042',
      name: 'Garage 2',
      values: {},
    })

    expect(await boardsOf(w, 'int_0042')).toEqual([board('esp_b1', 'b1'), board('esp_b2', 'b2')])
    expect(await secretOf(w, 'int_0042', 'esp_b1', 'encryptionKey')).toBe('KEY-b1')
  })
})
