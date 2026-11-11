/**
 * The retired `respectDnd` switch is removed from every Echo target record and from any row still
 * in the `echoTargets` setting. Driven the way the addon drives it: the catalogue through
 * `runAddonMigrations` against a ledger, the records the real engine in memory. A marked record
 * proves every other field survives; a rerun reports `already-done` and writes nothing.
 *
 * The in-memory engine's `put` replaces the stored body exactly as the SQLite engine does
 * (`ON CONFLICT … DO UPDATE SET data = excluded.data` in `records-engine.ts`), so a key left out of
 * the body is gone in production too — no merge to hide it.
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
import type { EchoDndStripped } from '../strip-echo-target-respect-dnd.js'
import {
  ADDON_MIGRATIONS,
  type AlexaMigrationPorts,
  STRIP_ECHO_TARGET_RESPECT_DND_ID,
} from '../index.js'

const MARK = 'kitchen echo, kept as written'

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
  const setting = { rows: initialRows, writes: 0 }
  const logged: EchoDndStripped[][] = []
  const echo = {
    ...echoRecordPortsOver(memory.records, silentLogger),
    echoDndStripped: (changed: readonly EchoDndStripped[]) => {
      logged.push([...changed])
    },
  }
  const ports: Pick<AlexaMigrationPorts, 'readRows' | 'writeRows'> & typeof echo = {
    readRows: async () => setting.rows,
    writeRows: async (rows) => {
      setting.rows = rows
      setting.writes += 1
    },
    ...echo,
  }
  const run = (host: AddonMigrationHost) =>
    runAddonMigrations(
      host,
      defineAddonMigrations(
        ADDON_MIGRATIONS.filter((m) => m.meta.id === STRIP_ECHO_TARGET_RESPECT_DND_ID),
        // The other ports are not part of this run.
        Object.assign(Object.create(null), ports),
      ),
      silentLogger,
    )
  return { setting, echo, run, logged }
}

const MARKED_RECORD = {
  name: MARK,
  enabled: false,
  brokerId: 'alexa_001',
  echoId: 'echo-k',
  respectDnd: false,
}

describe('strip-echo-target-respect-dnd', () => {
  it('removes respectDnd from a record and keeps every other field, the switch still off', async () => {
    const w = await world([])
    await w.echo.writeEchoRecord('echo-kitchen', MARKED_RECORD)
    await w.echo.writeEchoRecord('echo-hall', {
      name: 'Hall',
      enabled: true,
      echoId: 'echo-h',
    })
    const { host, outcomes } = ledgerHost()
    expect((await w.run(host)).failed).toEqual([])
    const kitchen = await w.echo.readEchoRecord('echo-kitchen')
    expect(kitchen).toMatchObject({
      name: MARK,
      enabled: false,
      brokerId: 'alexa_001',
      echoId: 'echo-k',
    })
    expect(kitchen).not.toHaveProperty('respectDnd')
    expect(await w.echo.readEchoRecord('echo-hall')).toMatchObject({
      name: 'Hall',
      enabled: true,
      echoId: 'echo-h',
    })
    expect(outcomes.get(STRIP_ECHO_TARGET_RESPECT_DND_ID)).toMatchObject({
      result: {
        outcome: 'done',
        summary: { records: 2, stripped: 1, settingRows: 0, wasOff: 1 },
      },
    })
    // The operator can find the target that now goes quiet in DND by id and name.
    expect(w.logged).toEqual([[{ id: 'echo-kitchen', name: MARK, wasOff: true }]])
  })

  it('strips it from a row still in the setting, keeping the rest of the row', async () => {
    const w = await world([{ ...MARKED_RECORD, id: 'echo-kitchen' }, 'not-a-row'])
    await w.run(ledgerHost().host)
    expect(w.setting.rows).toEqual([
      {
        id: 'echo-kitchen',
        name: MARK,
        enabled: false,
        brokerId: 'alexa_001',
        echoId: 'echo-k',
      },
      'not-a-row',
    ])
  })

  it('a rerun reports already-done and writes nothing', async () => {
    const w = await world([{ ...MARKED_RECORD, id: 'echo-kitchen' }])
    await w.echo.writeEchoRecord('echo-kitchen', MARKED_RECORD)
    await w.run(ledgerHost().host)
    const writes = w.setting.writes
    const second = ledgerHost()
    await w.run(second.host)
    expect(w.setting.writes).toBe(writes)
    expect(w.logged).toHaveLength(1)
    expect(second.outcomes.get(STRIP_ECHO_TARGET_RESPECT_DND_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.echo.readEchoRecord('echo-kitchen')).toMatchObject({
      name: MARK,
    })
  })
})
