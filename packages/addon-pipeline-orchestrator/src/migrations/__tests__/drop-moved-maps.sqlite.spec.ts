/**
 * The three id-keyed maps the movers copied into rows (`nodeBindings`, `agentSettings`,
 * `cameraSettings`) are deleted, on real SQLite in the canonical `addon-settings` layout —
 * and only once every mover is applied: a map a mover refused is the only copy of its data.
 */
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import type { BlobToRowsPorts } from '../blob-to-rows.js'
import {
  ADDON_MIGRATIONS,
  CAMERA_SETTINGS_TO_DEVICE_ROWS_ID,
  DROP_MOVED_MAPS_ID,
  PIPELINE_ORCHESTRATOR_ID,
} from '../index.js'

const ID = PIPELINE_ORCHESTRATOR_ID
const BINDINGS = { hub: { 'detection-pipeline': 'addon-pipeline' } }
const AGENTS = { hub: { maxCameras: 6, futureField: { mark: 'survive-hub' } } }
const CAMERAS = { '101': { stepToggles: { 'face-detection': false }, mark: 'cam-101' } }

const seeded = (over: Record<string, unknown> = {}) =>
  settingsFixture<BlobToRowsPorts>({
    addonId: ID,
    catalogue: ADDON_MIGRATIONS,
    seed: {
      nodeBindings: BINDINGS,
      agentSettings: AGENTS,
      cameraSettings: CAMERAS,
      unknownMarked: { mark: 'survive' },
      ...over,
    },
    neighbour: 'keep-me',
    ports: (rows) => ({ readStored: rows.readStored, readDeviceField: rows.readDeviceField }),
  })

describe('pipeline-orchestrator drop-moved-maps', () => {
  it('deletes the three maps after the movers, and nothing else', async () => {
    const f = seeded()
    const report = await f.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toContain(DROP_MOVED_MAPS_ID)
    const rows = f.rows()
    expect(rows[`${ID}.nodeBindings`]).toBeUndefined()
    expect(rows[`${ID}.agentSettings`]).toBeUndefined()
    expect(rows[`${ID}.cameraSettings`]).toBeUndefined()
    // The rows the movers wrote are the data now: they carry the marked fields.
    expect(rows[`${ID}.nodeBindings@hub`]?.['value']).toEqual(BINDINGS.hub)
    expect(rows[`${ID}.agentSettings@hub`]?.['value']).toEqual(AGENTS.hub)
    expect(f.deviceRows()[`${ID}:101.cameraSettings`]?.['value']).toEqual(CAMERAS['101'])
    expect(rows[`${ID}.unknownMarked`]?.['value']).toEqual({ mark: 'survive' })
    expect(rows['other-addon.agentSettings']?.['value']).toBe('keep-me')
    expect(rows['other-addon.nodeBindings']?.['value']).toBe('keep-me')
  })

  it('keeps every map while a mover has not applied: the map is the only copy', async () => {
    // A malformed cameraSettings map makes its mover refuse.
    const f = seeded({ cameraSettings: { '101': 'not-an-object' } })
    const report = await f.boot()
    expect(report.failed).toContain(CAMERA_SETTINGS_TO_DEVICE_ROWS_ID)
    expect(report.applied).not.toContain(DROP_MOVED_MAPS_ID)
    const rows = f.rows()
    expect(rows[`${ID}.cameraSettings`]?.['value']).toEqual({ '101': 'not-an-object' })
    expect(rows[`${ID}.agentSettings`]?.['value']).toEqual(AGENTS)
    expect(rows[`${ID}.nodeBindings`]?.['value']).toEqual(BINDINGS)
  })

  it('is a no-op on an install that never stored the maps, and on a second run', async () => {
    const f = settingsFixture<BlobToRowsPorts>({
      addonId: ID,
      catalogue: ADDON_MIGRATIONS,
      seed: { unknownMarked: { mark: 'survive' } },
      neighbour: 'keep-me',
      ports: (rows) => ({ readStored: rows.readStored, readDeviceField: rows.readDeviceField }),
    })
    expect((await f.boot()).failed).toEqual([])
    const once = JSON.stringify(f.rows())
    expect((await f.boot()).failed).toEqual([])
    expect(JSON.stringify(f.rows())).toBe(once)
  })
})
