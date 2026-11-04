/**
 * `exportTo:<id>` / `mediaRole:<id>` move from the export's addon store to the integration of
 * their broker (D985). Real SQLite for the store, an in-memory integrations api for the instances.
 */
import { describe, expect, it } from 'vitest'
import { fakeIntegrations } from '../../../__tests__/fake-integrations.js'
import { settingsFixture } from '../../../__tests__/settings-fixture.js'
import { haInstanceSettingsPortsOver } from '../../../migrations/legacy-integration-rows.js'
import { ADDON_MIGRATIONS } from '../index.js'

const COPY = 'homeassistant-export/2026-11-03-per-broker-flags-to-integration'
const DROP = 'homeassistant-export/2026-11-03-drop-per-broker-flags'
const PREFIXES = ['exportTo:', 'mediaRole:']

function start(
  stored: Record<string, unknown>,
  instances: Record<string, Record<string, unknown>> = {
    int_a: { brokerId: 'ha_a', mark: 'A' },
    int_b: { brokerId: 'ha_b', mark: 'B' },
  },
) {
  const world = fakeIntegrations(instances)
  let rows: () => Record<string, Record<string, unknown>> = () => ({})
  const f = settingsFixture(
    'homeassistant-export',
    ADDON_MIGRATIONS.filter((m) => [COPY, DROP].includes(m.meta.id)),
    () => ({
      readStored: async () =>
        Object.fromEntries(
          Object.entries(rows()).flatMap(([id, row]) =>
            id.startsWith('homeassistant-export.')
              ? [[id.slice('homeassistant-export.'.length), Reflect.get(row, 'value')]]
              : [],
          ),
        ),
      ...haInstanceSettingsPortsOver(world.api),
      warn: () => undefined,
      putLinks: async () => 'exists',
      readTargets: async () => new Map(),
      putTarget: async () => 'exists',
      deleteLinks: async () => undefined,
      clearSettingKeys: async () => undefined,
      readLinks: async () => new Map(),
    }),
    stored,
    'keep-me',
  )
  rows = f.rows
  return { f, world }
}

const legacyLeft = (rows: Record<string, unknown>): string[] =>
  Object.keys(rows).filter((id) => PREFIXES.some((p) => id.startsWith(`homeassistant-export.${p}`)))

describe('homeassistant-export per-broker flags: store to integration', () => {
  it('copies each flag to its broker integration, then drops the keys after the read-back', async () => {
    const { f, world } = start({
      'exportTo:ha_a': true,
      'mediaRole:ha_a': 'publicEndpoint',
      'exportTo:ha_b': false,
      keep: { mark: 'survive' },
    })
    const report = await f.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toContain(COPY)
    expect(report.applied).toContain(DROP)
    expect(world.settingsOf('int_a')).toMatchObject({
      exportTo: true,
      mediaRole: 'publicEndpoint',
      mark: 'A',
      brokerId: 'ha_a',
    })
    expect(world.settingsOf('int_b')).toMatchObject({
      exportTo: false,
      mark: 'B',
    })
    expect(world.settingsOf('int_b')?.['mediaRole']).toBeUndefined()
    expect(legacyLeft(f.rows())).toEqual([])
    expect(f.rows()['homeassistant-export.keep']).toBeDefined()
    expect(f.rows()['other-addon.exportTo:ha_a']).toBeDefined()
  })

  it('two-instance marker: a flag on A is invisible on B', async () => {
    const { f, world } = start({ 'exportTo:ha_a': true })
    await f.boot()
    expect(world.settingsOf('int_a')?.['exportTo']).toBe(true)
    expect(world.settingsOf('int_b')?.['exportTo']).toBeUndefined()
  })

  it('an existing instance value is never overwritten, and the differing key stays parked', async () => {
    const { f, world } = start(
      { 'exportTo:ha_a': true },
      {
        int_a: { brokerId: 'ha_a', exportTo: false },
        int_b: { brokerId: 'ha_b' },
      },
    )
    await f.boot()
    expect(world.settingsOf('int_a')?.['exportTo']).toBe(false)
    expect(f.rows()['homeassistant-export.exportTo:ha_a']).toBeDefined()
  })

  it('a key of a deleted broker is skipped and parked, never recreated', async () => {
    const { f, world } = start({ 'exportTo:ha_gone': true })
    const report = await f.boot()
    expect(report.failed).toEqual([])
    expect(world.writes()).toBe(0)
    expect(f.rows()['homeassistant-export.exportTo:ha_gone']).toBeDefined()
  })

  it('two integrations linking one broker are an ambiguity and throw', async () => {
    const { f, world } = start(
      { 'exportTo:ha_a': true },
      { int_a: { brokerId: 'ha_a' }, int_a2: { brokerId: 'ha_a' } },
    )
    const report = await f.boot()
    expect(report.failed).toContain(COPY)
    expect(world.writes()).toBe(0)
    expect(f.rows()['homeassistant-export.exportTo:ha_a']).toBeDefined()
  })

  it('a second run is a no-op', async () => {
    const { f, world } = start({ 'exportTo:ha_a': true })
    await f.boot()
    const writes = world.writes()
    expect((await f.boot()).failed).toEqual([])
    expect(world.writes()).toBe(writes)
  })
})
