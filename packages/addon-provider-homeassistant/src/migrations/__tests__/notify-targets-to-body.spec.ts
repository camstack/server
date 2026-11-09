/**
 * The Home Assistant notify targets move from the `ha-notification-targets` record kind (a free-form
 * `config` blob) to the `notify-homeassistant` record kind (epic #440, step 6). The fixture is a target
 * that is SWITCHED OFF: it must stay off and keep the id a notification rule names. Driven the way the
 * addon drives it: the catalogue through `runAddonMigrations`, the records the real engine in memory.
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
import { haNotifyRecordKinds, HaTargetStore } from '../../ha-notification-output.js'
import {
  type HaNotifyPorts,
  haLegacyTargetsOver,
  haNotifyPortsOver,
  haRetiredTargetKinds,
} from '../notify-targets-to-body.js'
import { ADDON_MIGRATIONS, HA_NOTIFY_TARGETS_TO_BODY_ID } from '../index.js'

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

const OLD = haRetiredTargetKinds['ha-notification-targets']

async function world() {
  const memory = makeInMemoryRecords('provider-homeassistant')
  await memory.records.declare({
    ...haNotifyRecordKinds,
    'ha-notification-targets': OLD,
  })
  const oldKind = memory.records.kind(OLD)
  const store = HaTargetStore.of(memory.records, {
    logger: silentLogger,
    legacy: haLegacyTargetsOver(memory.records, silentLogger),
  })
  const run = (
    host: AddonMigrationHost,
    wrap: (ports: HaNotifyPorts) => HaNotifyPorts = (p) => p,
  ) =>
    runAddonMigrations(
      host,
      defineAddonMigrations(
        ADDON_MIGRATIONS.filter((m) => m.meta.id === HA_NOTIFY_TARGETS_TO_BODY_ID),
        Object.assign(Object.create(null), wrap(haNotifyPortsOver(memory.records, silentLogger))),
      ),
      silentLogger,
    )
  return { memory, store, oldKind, run }
}

describe('homeassistant notify-targets-to-body', () => {
  it('moves a switched-off target flat: same id, still off, the broker link and service kept', async () => {
    const w = await world()
    await w.oldKind.put({
      id: 'ha-1',
      data: {
        name: 'Pixel',
        kind: 'homeassistant',
        addonId: 'provider-homeassistant',
        enabled: false,
        config: { brokerId: 'ha_001', service: 'mobile_app_pixel_7' },
      },
    })
    const { host, outcomes } = ledgerHost()
    expect((await w.run(host)).failed).toEqual([])
    expect(await w.store.getById('ha-1')).toMatchObject({
      id: 'ha-1',
      kind: 'homeassistant',
      enabled: false,
      name: 'Pixel',
      config: { brokerId: 'ha_001', service: 'mobile_app_pixel_7' },
    })
    expect(await w.oldKind.get('ha-1')).toBeNull()
    expect(outcomes.get(HA_NOTIFY_TARGETS_TO_BODY_ID)).toMatchObject({
      result: { outcome: 'done', summary: { converted: 1 } },
    })
  })

  it('a rerun is already-done', async () => {
    const w = await world()
    const second = ledgerHost()
    await w.run(second.host)
    expect(second.outcomes.get(HA_NOTIFY_TARGETS_TO_BODY_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
  })

  it('a target that fails to move is NOT recorded applied: it stays served from the retired kind and moves on the rerun, switch intact', async () => {
    const w = await world()
    for (const [id, enabled] of [
      ['ha-bad', false],
      ['ha-good', true],
    ] as const) {
      await w.oldKind.put({
        id,
        data: {
          name: id,
          kind: 'homeassistant',
          addonId: 'provider-homeassistant',
          enabled,
          config: { brokerId: 'ha_001', service: `notify_${id}` },
        },
      })
    }
    const first = ledgerHost()
    const failedRun = await w.run(first.host, (ports) => ({
      notifyRows: {
        ...ports.notifyRows,
        writeNew: async (kind, id, body) => {
          if (id === 'ha-bad') throw new Error('records engine refused')
          await ports.notifyRows.writeNew(kind, id, body)
        },
      },
    }))
    expect(failedRun.failed).toEqual([HA_NOTIFY_TARGETS_TO_BODY_ID])
    expect(first.outcomes.has(HA_NOTIFY_TARGETS_TO_BODY_ID)).toBe(false)
    expect(await w.oldKind.get('ha-good')).toBeNull()
    expect(await w.oldKind.get('ha-bad')).not.toBeNull()
    expect(await w.store.getById('ha-bad')).toMatchObject({ enabled: false })

    const second = ledgerHost()
    expect((await w.run(second.host)).failed).toEqual([])
    expect(await w.oldKind.get('ha-bad')).toBeNull()
    expect(await w.store.getById('ha-bad')).toMatchObject({
      enabled: false,
      config: { service: 'notify_ha-bad' },
    })
    expect((await w.store.list()).map((t) => t.id).sort()).toEqual(['ha-bad', 'ha-good'])
  })
})
