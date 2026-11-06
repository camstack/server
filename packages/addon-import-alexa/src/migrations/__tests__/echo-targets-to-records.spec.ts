/**
 * The Echo targets move from the `echoTargets` setting to one `notify-alexa-echo` record each, under
 * the same id, switch carried (epic #440, step 6). Driven the way the addon drives it: the catalogue
 * through `runAddonMigrations`, the records the real engine in memory.
 */
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  type IScopedLogger,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  runAddonMigrations,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  alexaNotifyRecordKinds,
  echoRecordPortsOver,
  echoTargetStoreOver,
  legacyEchoTargetsOver,
} from '../../speak/echo-store.js'
import { ADDON_MIGRATIONS, ECHO_TARGETS_TO_RECORDS_ID } from '../index.js'
import type { AlexaMigrationPorts } from '../index.js'

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

function ledgerHost(): {
  host: AddonMigrationHost
  outcomes: Map<string, MigrationOwnerResult>
} {
  const outcomes = new Map<string, MigrationOwnerResult>()
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
    finishMigration: async ({ id, result }) => {
      if (result.kind === 'failed')
        return {
          status: 'failed' as const,
          error: result.error,
          rowsChanged: 0,
        }
      outcomes.set(id, result)
      return { status: 'applied' as const, error: null, rowsChanged: 0 }
    },
  }
  return { host, outcomes }
}

async function world(initialRows: readonly unknown[]) {
  const memory = makeInMemoryRecords('import-alexa')
  await memory.records.declare(alexaNotifyRecordKinds)
  const setting = { rows: initialRows }
  const echo = echoRecordPortsOver(memory.records, silentLogger)
  const ports: Pick<AlexaMigrationPorts, 'readRows' | 'writeRows'> & typeof echo = {
    readRows: () => setting.rows,
    writeRows: async (rows) => {
      setting.rows = rows
    },
    ...echo,
  }
  const run = (host: AddonMigrationHost, ported: typeof ports = ports) =>
    runAddonMigrations(
      host,
      defineAddonMigrations(
        // Only this migration: it reads the setting and the records, nothing else.
        ADDON_MIGRATIONS.filter((m) => m.meta.id === ECHO_TARGETS_TO_RECORDS_ID),
        // The other ports are not part of this run.
        Object.assign(Object.create(null), ported),
      ),
      silentLogger,
    )
  return { memory, setting, ports, echo, run }
}

const OFF_ECHO = {
  id: 'echo-kitchen',
  name: 'Kitchen echo',
  enabled: false,
  brokerId: 'alexa_001',
  echoId: 'echo-k',
  respectDnd: false,
}

describe('echo-targets-to-records', () => {
  it('moves a disabled Echo target under its id, still off, and clears the setting', async () => {
    const w = await world([OFF_ECHO, { ...OFF_ECHO, id: 'echo-hall', name: 'Hall', enabled: true }])
    const { host, outcomes } = ledgerHost()
    expect((await w.run(host)).failed).toEqual([])
    const row = await w.echo.readEchoRecord('echo-kitchen')
    expect(row).toMatchObject({
      name: 'Kitchen echo',
      enabled: false,
      brokerId: 'alexa_001',
      echoId: 'echo-k',
      respectDnd: false,
    })
    expect(await w.echo.readEchoRecord('echo-hall')).toMatchObject({
      enabled: true,
    })
    expect(w.setting.rows).toEqual([])
    expect(outcomes.get(ECHO_TARGETS_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'done', summary: { converted: 2 } },
    })
  })

  it('a rerun is already-done and never overwrites a record edited since', async () => {
    const w = await world([OFF_ECHO])
    await w.run(ledgerHost().host)
    await w.echo.writeEchoRecord('echo-kitchen', {
      name: 'Renamed',
      enabled: true,
      brokerId: 'alexa_001',
      echoId: 'echo-k',
      respectDnd: false,
    })
    // The setting comes back (a restored backup): the record the operator edited wins.
    w.setting.rows = [OFF_ECHO]
    const second = ledgerHost()
    await w.run(second.host)
    expect(await w.echo.readEchoRecord('echo-kitchen')).toMatchObject({
      name: 'Renamed',
      enabled: true,
    })
    expect(second.outcomes.get(ECHO_TARGETS_TO_RECORDS_ID)).toMatchObject({
      result: { summary: { converted: 0, kept: 1 } },
    })
  })

  it('keeps the setting when a row does not parse, and still moves the others', async () => {
    const w = await world([OFF_ECHO, { id: 'bad' }])
    await w.run(ledgerHost().host)
    expect(await w.echo.readEchoRecord('echo-kitchen')).not.toBeNull()
    expect(w.setting.rows).toHaveLength(2)
  })

  it('a row that does not read back is undone and stays in the setting, served from there; the other moves', async () => {
    const hall = { ...OFF_ECHO, id: 'echo-hall', name: 'Hall', enabled: true }
    const w = await world([OFF_ECHO, hall])
    // A store that accepts the write of one row but reads nothing back for it.
    const lying = {
      ...w.ports,
      readEchoRecord: async (id: string) =>
        id === 'echo-kitchen' ? null : w.echo.readEchoRecord(id),
    }
    const { host, outcomes } = ledgerHost()
    const report = await w.run(host, lying)
    expect(report.failed).toEqual([])
    expect(outcomes.get(ECHO_TARGETS_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'done', summary: { converted: 1, skipped: 1 } },
    })
    // The bad row: no record, still in the setting, and the Echo store serves it from there.
    expect(w.memory.tables.get('notify-alexa-echo')?.has('echo-kitchen')).toBe(false)
    expect(w.setting.rows).toEqual([OFF_ECHO])
    const store = echoTargetStoreOver(w.memory.records, {
      legacy: legacyEchoTargetsOver({
        readRows: () => w.setting.rows,
        writeRows: w.ports.writeRows,
      }),
    })
    expect(await store.getById('echo-kitchen')).toMatchObject({
      enabled: false,
      name: 'Kitchen echo',
    })
    expect((await store.list()).map((t) => t.id).sort()).toEqual(['echo-hall', 'echo-kitchen'])
    // The good row moved.
    expect(await w.echo.readEchoRecord('echo-hall')).toMatchObject({ enabled: true })
  })
})
