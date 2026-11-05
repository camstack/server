/**
 * `enabled` -> `faceRecognitionEnabled` + `stationarySuppressionEnabled`, on real SQLite in the
 * canonical `addon-settings` / `addon-device-settings` layout. The stored value lands in both new
 * keys (today's behaviour is unchanged), `enabled` is gone, a marked neighbour survives, a new key
 * already stored is not overwritten, and a second run is a no-op.
 */
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import {
  ADDON_MIGRATIONS,
  type PipelineAnalyticsMigrationPorts,
  SPLIT_ENABLED_KEY_MIGRATION_ID,
} from '../index.js'
import { makeNcWorld } from './support/nc-records-world.js'

const OWNER = 'pipeline-analytics'

async function analytics(input: {
  readonly seed: Record<string, unknown>
  readonly deviceSeed?: Record<string, Record<string, unknown>>
}) {
  const { ncPorts } = await makeNcWorld()
  const deviceIds = (): number[] =>
    Object.keys(fixture.deviceRows()).flatMap((id) => {
      const match = /^pipeline-analytics:(\d+)\./.exec(id)
      return match?.[1] === undefined ? [] : [Number(match[1])]
    })
  const fixture = settingsFixture<PipelineAnalyticsMigrationPorts>({
    addonId: OWNER,
    catalogue: ADDON_MIGRATIONS,
    seed: input.seed,
    neighbour: 'keep-me',
    ...(input.deviceSeed !== undefined ? { deviceSeed: input.deviceSeed } : {}),
    ports: (rows) => ({
      // The template migration of the same catalogue runs over empty kinds.
      ...ncPorts,
      readStored: rows.readStored,
      listDeviceIds: async () => [...new Set(deviceIds())],
      readDeviceField: rows.readDeviceField,
    }),
  })
  return fixture
}

const value = (row: Record<string, unknown> | undefined): unknown => row?.['value']

describe('pipeline-analytics split-enabled-key', () => {
  it.each([
    true,
    false,
  ])('copies the cluster `enabled` = %s into both keys and drops it', async (stored) => {
    const f = await analytics({
      seed: { enabled: stored, unknownMarked: { mark: 'survive' } },
    })
    const report = await f.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toContain(SPLIT_ENABLED_KEY_MIGRATION_ID)
    const rows = f.rows()
    expect(value(rows['pipeline-analytics.faceRecognitionEnabled'])).toBe(stored)
    expect(value(rows['pipeline-analytics.stationarySuppressionEnabled'])).toBe(stored)
    expect(rows['pipeline-analytics.enabled']).toBeUndefined()
    expect(value(rows['pipeline-analytics.unknownMarked'])).toEqual({
      mark: 'survive',
    })
    expect(value(rows['other-addon.enabled'])).toBe('keep-me')
  })

  it('copies a camera`s own `enabled` into both of its keys and leaves other cameras and fields', async () => {
    const f = await analytics({
      seed: { postProcessingNodeId: 'hub' },
      deviceSeed: {
        '7': { enabled: false, suppressIou: 0.61 },
        '9': { suppressIou: 0.4 },
      },
    })
    const report = await f.boot()
    expect(report.failed).toEqual([])
    const rows = f.deviceRows()
    expect(value(rows['pipeline-analytics:7.faceRecognitionEnabled'])).toBe(false)
    expect(value(rows['pipeline-analytics:7.stationarySuppressionEnabled'])).toBe(false)
    expect(rows['pipeline-analytics:7.enabled']).toBeUndefined()
    expect(value(rows['pipeline-analytics:7.suppressIou'])).toBe(0.61)
    expect(value(rows['pipeline-analytics:9.suppressIou'])).toBe(0.4)
    expect(rows['pipeline-analytics:9.stationarySuppressionEnabled']).toBeUndefined()
    expect(value(rows['other-addon:7.enabled'])).toBe('keep-me')
  })

  it('never overwrites a new key that is already stored', async () => {
    const f = await analytics({
      seed: { enabled: false, faceRecognitionEnabled: true },
    })
    await f.boot()
    const rows = f.rows()
    expect(value(rows['pipeline-analytics.faceRecognitionEnabled'])).toBe(true)
    expect(value(rows['pipeline-analytics.stationarySuppressionEnabled'])).toBe(false)
    expect(rows['pipeline-analytics.enabled']).toBeUndefined()
  })

  it('is a no-op on an install that never stored `enabled`, and on a second run', async () => {
    const empty = await analytics({ seed: { postProcessingNodeId: 'hub' } })
    const before = JSON.stringify(empty.rows())
    await empty.boot()
    expect(JSON.stringify(empty.rows())).toBe(before)

    const f = await analytics({
      seed: { enabled: false },
      deviceSeed: { '7': { enabled: true } },
    })
    await f.boot()
    const once = JSON.stringify([f.rows(), f.deviceRows()])
    await f.boot()
    expect(JSON.stringify([f.rows(), f.deviceRows()])).toBe(once)
  })
})
