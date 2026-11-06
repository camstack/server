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
import { alexaNotifyRecordKinds, echoRecordPortsOver } from '../../speak/echo-store.js'
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
  const echo = echoRecordPortsOver(memory.records)
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

  it('a record that does not read back is undone and the setting is unchanged', async () => {
    const w = await world([OFF_ECHO])
    // A store that accepts the write but reads nothing back.
    const lying = { ...w.ports, readEchoRecord: async () => null }
    const { host } = ledgerHost()
    const report = await w.run(host, lying)
    expect(report.failed.length).toBe(1)
    expect(w.setting.rows).toEqual([OFF_ECHO])
    expect(w.memory.tables.get('notify-alexa-echo')?.size ?? 0).toBe(0)
  })
})
