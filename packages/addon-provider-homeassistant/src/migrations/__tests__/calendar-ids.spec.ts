/**
 * The shared calendar set becomes each Home Assistant instance's own (D985), then the shared
 * setting is dropped after a read-back. Real SQLite for the addon settings, an in-memory
 * integrations api for the instances, through the production port binding.
 */
import type { FlattenRowPorts } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { fakeIntegrations } from '../../__tests__/fake-integrations.js'
import { settingsFixture } from '../../__tests__/settings-fixture.js'
import { haInstanceSettingsPortsOver } from '../legacy-integration-rows.js'
import { ADDON_MIGRATIONS } from '../index.js'

const NO_FLATTEN_PORTS: FlattenRowPorts = {
  listNested: async () => [],
  readResolved: async () => ({}),
  patch: async () => undefined,
}
const COPY = 'provider-homeassistant/2026-11-03-calendar-ids-to-integration'
const DROP = 'provider-homeassistant/2026-11-03-drop-shared-calendar-ids'
const SHARED = ['calendar.work', 'calendar.home']

function start(
  stored: Record<string, unknown> = { calendarIds: SHARED, other: { mark: 'survive' } },
  instances: Record<string, Record<string, unknown>> = {
    int_a: { brokerId: 'ha_a', mark: 'A' },
    int_b: { brokerId: 'ha_b', mark: 'B' },
  },
) {
  const world = fakeIntegrations(instances)
  const f = settingsFixture(
    'provider-homeassistant',
    ADDON_MIGRATIONS.filter((m) => m.meta.id === COPY || m.meta.id === DROP),
    (readStored) => ({
      readStored,
      ...haInstanceSettingsPortsOver(world.api),
      readInstance: async () => null,
      patchInstance: async () => false,
      ...NO_FLATTEN_PORTS,
    }),
    stored,
    'keep-me',
  )
  return { f, world }
}

describe('provider-homeassistant calendar ids: shared set to each integration', () => {
  it('copies the shared set to every integration, then drops the shared row after the read-back', async () => {
    const { f, world } = start()
    expect(await f.boot()).toEqual({ failed: [], applied: [COPY, DROP] })
    expect(world.settingsOf('int_a')?.['calendarIds']).toEqual(SHARED)
    expect(world.settingsOf('int_b')?.['calendarIds']).toEqual(SHARED)
    expect(f.rows()['provider-homeassistant.calendarIds']).toBeUndefined()
  })

  it('a marked field survives: the broker link, an unknown settings key, unrelated rows', async () => {
    const { f, world } = start()
    await f.boot()
    expect(world.settingsOf('int_a')).toMatchObject({ brokerId: 'ha_a', mark: 'A' })
    expect(world.settingsOf('int_b')).toMatchObject({ brokerId: 'ha_b', mark: 'B' })
    expect(f.rows()['provider-homeassistant.other']).toBeDefined()
    expect(f.rows()['other-addon.calendarIds']).toBeDefined()
  })

  it('two-instance marker: a value on A is invisible on B', async () => {
    const { f, world } = start(
      { calendarIds: SHARED },
      {
        int_a: { brokerId: 'ha_a', calendarIds: ['calendar.only-a'] },
        int_b: { brokerId: 'ha_b' },
      },
    )
    await f.boot()
    expect(world.settingsOf('int_a')?.['calendarIds']).toEqual(['calendar.only-a'])
    expect(world.settingsOf('int_b')?.['calendarIds']).toEqual(SHARED)
  })

  it('an existing per-instance set is never overwritten, and the shared row stays parked', async () => {
    const { f } = start(
      { calendarIds: SHARED },
      { int_a: { brokerId: 'ha_a', calendarIds: ['calendar.mine'] }, int_b: { brokerId: 'ha_b' } },
    )
    await f.boot()
    expect(f.rows()['provider-homeassistant.calendarIds']).toBeDefined()
  })

  it('an integration deleted before the copy is skipped, never recreated', async () => {
    const { f, world } = start()
    const patchWhileGone = world.remove
    patchWhileGone('int_b')
    const report = await f.boot()
    expect(report.failed).toEqual([])
    expect(world.settingsOf('int_b')).toBeUndefined()
    expect(world.settingsOf('int_a')?.['calendarIds']).toEqual(SHARED)
  })

  it('a malformed shared value is an ambiguity: the copy fails and nothing is written', async () => {
    const { f, world } = start({ calendarIds: 'calendar.work' })
    const report = await f.boot()
    expect(report.failed).toContain(COPY)
    expect(world.writes()).toBe(0)
    expect(f.rows()['provider-homeassistant.calendarIds']).toBeDefined()
  })

  it('a second run is a no-op', async () => {
    const { f, world } = start()
    await f.boot()
    const writes = world.writes()
    const second = await f.boot()
    expect(second.failed).toEqual([])
    expect(world.writes()).toBe(writes)
  })
})
