/**
 * The legacy `brokerId` row moves onto the broker record (planning#416), driven the way the addon
 * drives it: the catalogue entry executed over the real ports on an in-memory records world and a
 * fake migration-only door. A marked broker field proves the stamp touches nothing else.
 */
import {
  type AddonMigrationHost,
  type AddonMigration,
  defineAddonMigrations,
  type IntegrationRowsApi,
  type IScopedLogger,
  makeInMemoryRecords,
  runAddonMigrations,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { alexaBrokersEntryKind } from '../../broker-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  INTEGRATION_ROWS_TO_RECORD_ID,
  alexaIntegrationRowsPorts,
} from '../index.js'

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

const ACCOUNT = {
  amazonDomain: 'amazon.it',
  cookie: 'c',
  refreshToken: 'r',
  macDms: '',
  pollIntervalMs: 60_000,
}
const MARK = 'the living room account, kept as written'

async function world(rows: Readonly<Record<string, unknown>> | null) {
  const mem = makeInMemoryRecords('import-alexa')
  await mem.records.declare({ brokers: alexaBrokersEntryKind })
  const handle = mem.records.kind(alexaBrokersEntryKind)
  let held: Record<string, unknown> = { ...rows }
  let clears = 0
  const warnings: string[] = []
  const api: IntegrationRowsApi = {
    list: async () =>
      rows === null ? [] : [{ id: 'int_0035', addonId: 'import-alexa', name: 'Alexa' }],
    readLegacyIntegrationRows: async () => ({ ...held }),
    clearLegacyIntegrationRows: async () => {
      held = {}
      clears += 1
    },
  }
  const ports = alexaIntegrationRowsPorts({
    api,
    records: mem.records,
    secrets: null,
    warn: (m) => warnings.push(m),
  })
  const migration: AddonMigration<typeof ports> | undefined = ADDON_MIGRATIONS.find(
    (m) => m.meta.id === INTEGRATION_ROWS_TO_RECORD_ID,
  )
  if (migration === undefined) throw new Error('the migration is not in the catalogue')
  const run = async () => {
    const outcomes: unknown[] = []
    const host: AddonMigrationHost = {
      declareOwner: async (input) => ({
        bootId: 'boot',
        snapshot: 'none' as const,
        steps: input.metas.map((m) => ({
          id: m.id,
          action: 'run' as const,
          state: 'pending' as const,
        })),
      }),
      startMigration: async () => ({
        proceed: true,
        state: 'pending' as const,
        reason: null,
      }),
      finishMigration: async ({ result }) => {
        outcomes.push(result)
        return { status: 'applied' as const, error: null, rowsChanged: 0 }
      },
    }
    const report = await runAddonMigrations(
      host,
      defineAddonMigrations([migration], ports),
      silentLogger,
    )
    return { report, outcomes }
  }
  return { handle, run, warnings, rows: () => held, clears: () => clears }
}

describe('import-alexa integration-rows-to-record', () => {
  it('is a block-owner copy migration after the flatten one', () => {
    const meta = ADDON_MIGRATIONS.find((m) => m.meta.id === INTEGRATION_ROWS_TO_RECORD_ID)?.meta
    expect(meta).toMatchObject({ onFailure: 'block-owner', seq: 3 })
    expect(meta?.dependsOn).toEqual(['import-alexa/2026-11-04-flatten-broker-records'])
  })

  it('stamps the link on an unlinked broker, keeps its fields and clears the rows', async () => {
    const w = await world({ brokerId: 'alexa_002' })
    await w.handle.put({ id: 'alexa_002', data: { ...ACCOUNT, name: MARK } }, { ifRev: 0 })
    const { report } = await w.run()
    expect(report.failed).toEqual([])
    expect((await w.handle.get('alexa_002'))?.data).toMatchObject({
      name: MARK,
      amazonDomain: 'amazon.it',
      integrationId: 'int_0035',
    })
    expect(w.rows()).toEqual({})
  })

  it('leaves a broker that already names an integration, warns, and clears the rows', async () => {
    const w = await world({ brokerId: 'alexa_002' })
    await w.handle.put(
      { id: 'alexa_002', data: { ...ACCOUNT, name: MARK, integrationId: 'int_other' } },
      { ifRev: 0 },
    )
    await w.run()
    expect((await w.handle.get('alexa_002'))?.data).toMatchObject({
      integrationId: 'int_other',
    })
    expect(w.warnings.join('\n')).toContain('already names integration')
    expect(w.rows()).toEqual({})
  })

  it('a brokerId that names no broker links nothing, warns, and clears the rows', async () => {
    const w = await world({ brokerId: 'alexa_404' })
    await w.run()
    expect((await w.handle.query({ limit: 10 })).records).toEqual([])
    expect(w.warnings.join('\n')).toContain('names no broker record')
    expect(w.rows()).toEqual({})
  })

  it('an empty door (store dropped or no integration) is a no-op, and a rerun too', async () => {
    const dropped = await world({})
    const first = await dropped.run()
    expect(first.outcomes).toMatchObject([{ result: { outcome: 'already-done' } }])
    expect(dropped.clears()).toBe(0)

    const w = await world({ brokerId: 'alexa_002' })
    await w.handle.put({ id: 'alexa_002', data: { ...ACCOUNT, name: MARK } }, { ifRev: 0 })
    await w.run()
    const rev = (await w.handle.get('alexa_002'))?.rev
    const again = await w.run()
    expect(again.outcomes).toMatchObject([{ result: { outcome: 'already-done' } }])
    expect(w.clears()).toBe(1)
    expect((await w.handle.get('alexa_002'))?.rev).toBe(rev)

    const none = await world(null)
    expect((await none.run()).outcomes).toMatchObject([{ result: { outcome: 'already-done' } }])
  })
})
