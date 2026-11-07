/**
 * `suggestionMinCosine` and `minFaceConfidence` leave the cluster row, on real SQLite in the
 * canonical `addon-settings` layout. Each retired key is announced with the value it held, both are
 * deleted, a marked neighbour and the declared keys survive, and a second run neither announces nor
 * writes (D222, D662, D987).
 */
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import {
  ADDON_MIGRATIONS,
  type PipelineAnalyticsMigrationPorts,
  RETIRE_FACE_KEYS_MIGRATION_ID,
} from '../index.js'
import { makeNcWorld } from './support/nc-records-world.js'

const OWNER = 'pipeline-analytics'

async function analytics(seed: Record<string, unknown>) {
  const { ncPorts } = await makeNcWorld()
  const announced: Array<{ key: string; was: unknown }> = []
  const fixture = settingsFixture<PipelineAnalyticsMigrationPorts>({
    addonId: OWNER,
    catalogue: ADDON_MIGRATIONS.filter((m) => m.meta.id === RETIRE_FACE_KEYS_MIGRATION_ID),
    seed,
    neighbour: 'keep-me',
    // Only the retirement migration is offered: the other ports are never reached.
    ports: (rows) => ({
      ...ncPorts,
      listDeviceIds: async () => [],
      readDeviceField: async () => new Map(),
      readStored: rows.readStored,
      announceRetired: async (key, was) => {
        announced.push({ key, was })
      },
    }),
  })
  return { fixture, announced }
}

const value = (row: Record<string, unknown> | undefined): unknown => row?.['value']

describe('pipeline-analytics retire-face-keys', () => {
  it('announces and deletes both retired keys, keeps every other row, and is idempotent', async () => {
    const { fixture, announced } = await analytics({
      suggestionMinCosine: 0.33,
      minFaceConfidence: 0.85,
      similarityThreshold: 0.45,
      unknownMarked: { mark: 'survive' },
    })
    const first = await fixture.boot()
    expect(first.failed).toEqual([])
    expect(first.applied).toContain(RETIRE_FACE_KEYS_MIGRATION_ID)
    const rows = fixture.rows()
    expect(rows['pipeline-analytics.suggestionMinCosine']).toBeUndefined()
    expect(rows['pipeline-analytics.minFaceConfidence']).toBeUndefined()
    expect(value(rows['pipeline-analytics.similarityThreshold'])).toBe(0.45)
    expect(value(rows['pipeline-analytics.unknownMarked'])).toEqual({ mark: 'survive' })
    expect(value(rows['other-addon.suggestionMinCosine'])).toBe('keep-me')
    expect(announced).toEqual([
      { key: 'suggestionMinCosine', was: 0.33 },
      { key: 'minFaceConfidence', was: 0.85 },
    ])

    const again = await fixture.boot()
    expect(again.failed).toEqual([])
    expect(announced).toHaveLength(2)
  })

  it('writes nothing and announces nothing when neither key was stored', async () => {
    const { fixture, announced } = await analytics({ similarityThreshold: 0.45 })
    const report = await fixture.boot()
    expect(report.failed).toEqual([])
    expect(value(fixture.rows()['pipeline-analytics.similarityThreshold'])).toBe(0.45)
    expect(announced).toEqual([])
  })
})
