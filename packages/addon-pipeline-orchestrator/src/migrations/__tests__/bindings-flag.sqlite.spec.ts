/**
 * The retired `bindingsMigration_v1_done` flag, on real SQLite in the canonical `addon-settings`
 * layout: its row is deleted, a setting the migration does not know and a neighbour's row of the
 * same key survive, and a second run is a no-op.
 */
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import type { DropKeysPorts } from '../drop-keys.js'
import {
  ADDON_MIGRATIONS,
  DROP_BINDINGS_MIGRATION_FLAG_ID,
  PIPELINE_ORCHESTRATOR_ID,
} from '../index.js'

const orchestrator = (seed: Record<string, unknown>) =>
  settingsFixture<DropKeysPorts>({
    addonId: PIPELINE_ORCHESTRATOR_ID,
    catalogue: ADDON_MIGRATIONS,
    seed,
    neighbour: 'keep-me',
    ports: (rows) => ({ readStored: rows.readStored }),
  })

describe('pipeline-orchestrator drop-bindings-migration-flag', () => {
  it('deletes the flag row and keeps every other row', async () => {
    const f = orchestrator({
      bindingsMigration_v1_done: true,
      enabledNodes: ['hub'],
      unknownMarked: { mark: 'survive' },
    })
    expect(await f.boot()).toEqual({ failed: [], applied: [DROP_BINDINGS_MIGRATION_FLAG_ID] })
    const rows = f.rows()
    expect(rows['pipeline-orchestrator.bindingsMigration_v1_done']).toBeUndefined()
    expect(rows['pipeline-orchestrator.enabledNodes']?.['value']).toEqual(['hub'])
    expect(rows['pipeline-orchestrator.unknownMarked']?.['value']).toEqual({ mark: 'survive' })
    expect(rows['other-addon.bindingsMigration_v1_done']?.['value']).toBe('keep-me')
  })

  it('is a no-op when the flag was never stored, and on a second run', async () => {
    const f = orchestrator({ enabledNodes: ['hub'] })
    await f.boot()
    const once = JSON.stringify(f.rows())
    await f.boot()
    expect(JSON.stringify(f.rows())).toBe(once)
  })
})
