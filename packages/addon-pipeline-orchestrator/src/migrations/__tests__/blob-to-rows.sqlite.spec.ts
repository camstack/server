/**
 * The orchestrator's three id-keyed maps become rows, on real SQLite in the canonical layouts
 * (`addon-settings` node rows carrying `nodeId`, `addon-device-settings` device rows). A MARKED
 * field of every node and every camera must arrive with its exact value, a node that only one map
 * holds and a camera must arrive too, an existing row is never overwritten, a failed read or a
 * malformed map writes nothing, and a second run is a no-op.
 */
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import type { BlobToRowsPorts } from '../blob-to-rows.js'
import {
  ADDON_MIGRATIONS,
  AGENT_SETTINGS_TO_NODE_ROWS_ID,
  CAMERA_SETTINGS_TO_DEVICE_ROWS_ID,
  DROP_BINDINGS_MIGRATION_FLAG_ID,
  NODE_BINDINGS_TO_NODE_ROWS_ID,
  PIPELINE_ORCHESTRATOR_ID,
} from '../index.js'

const ID = PIPELINE_ORCHESTRATOR_ID
const NEIGHBOUR = 'keep-me'

const BINDINGS = {
  hub: { 'detection-pipeline': 'addon-pipeline', 'face-detection': 'addon-faces' },
  'agent-1': { 'detection-pipeline': 'addon-pipeline-gpu' },
  'only-bindings': { 'detection-pipeline': 'addon-lonely' },
}
const AGENTS = {
  hub: {
    maxCameras: 6,
    detectWeight: 3,
    inferenceDevices: { 'cpu:0': { enabled: true, steps: { detect: { modelId: 'yolo-hub' } } } },
    futureField: { mark: 'survive-hub' },
  },
  'agent-1': { maxCameras: null, detectWeight: 5, reachableHost: '10.0.0.7' },
  'only-agents': { maxCameras: 2 },
}
const CAMERAS = {
  '101': {
    stepToggles: { 'face-detection': false },
    stepSettings: { 'object-detection': { minConfidence: 0.42, mark: 'cam-101' } },
  },
  '202': { stepToggles: { 'plate-detection': true } },
}
const ALL_IDS = [
  NODE_BINDINGS_TO_NODE_ROWS_ID,
  AGENT_SETTINGS_TO_NODE_ROWS_ID,
  CAMERA_SETTINGS_TO_DEVICE_ROWS_ID,
]

const seeded = (
  extra: Record<string, unknown> = {},
  portsOver: Partial<BlobToRowsPorts> = {},
  deviceSeed: Record<string, Record<string, unknown>> = {},
) =>
  settingsFixture<BlobToRowsPorts>({
    addonId: ID,
    catalogue: ADDON_MIGRATIONS,
    seed: {
      nodeBindings: BINDINGS,
      agentSettings: AGENTS,
      cameraSettings: CAMERAS,
      unknownMarked: { mark: 'survive' },
      ...extra,
    },
    deviceSeed,
    neighbour: NEIGHBOUR,
    ports: (rows) => ({
      readStored: rows.readStored,
      readDeviceField: rows.readDeviceField,
      ...portsOver,
    }),
  })

const nodeRow = (field: string, nodeId: string, value: unknown) => ({
  addonId: ID,
  key: `${field}@${nodeId}`,
  value,
  nodeId,
})

describe('pipeline-orchestrator maps to rows', () => {
  it('writes one node row per node and one device row per camera, values exact', async () => {
    const f = seeded()
    const report = await f.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toEqual(expect.arrayContaining(ALL_IDS))
    const rows = f.rows()
    for (const [nodeId, entry] of Object.entries(BINDINGS)) {
      expect(rows[`${ID}.nodeBindings@${nodeId}`]).toEqual(nodeRow('nodeBindings', nodeId, entry))
    }
    for (const [nodeId, entry] of Object.entries(AGENTS)) {
      expect(rows[`${ID}.agentSettings@${nodeId}`]).toEqual(nodeRow('agentSettings', nodeId, entry))
    }
    // A node only one map holds gets a row in that map's field only.
    expect(rows[`${ID}.agentSettings@only-bindings`]).toBeUndefined()
    expect(rows[`${ID}.nodeBindings@only-agents`]).toBeUndefined()
    const devices = f.deviceRows()
    for (const [deviceId, entry] of Object.entries(CAMERAS)) {
      expect(devices[`${ID}:${deviceId}.cameraSettings`]).toEqual({
        addonId: ID,
        deviceId,
        key: 'cameraSettings',
        value: entry,
      })
    }
    // The copied maps are deleted by the catalogue's last step (drop-moved-maps.sqlite.spec.ts);
    // a field the migrations do not know survives byte for byte.
    expect(rows[`${ID}.agentSettings`]).toBeUndefined()
    expect(rows[`${ID}.unknownMarked`]?.['value']).toEqual({ mark: 'survive' })
    expect(rows['other-addon.agentSettings']?.['value']).toBe(NEIGHBOUR)
    expect(devices['other-addon:101.cameraSettings']).toBeUndefined()
  })

  it('a second run is a no-op', async () => {
    const f = seeded()
    await f.boot()
    const rows = JSON.stringify(f.rows())
    const devices = JSON.stringify(f.deviceRows())
    expect((await f.boot()).failed).toEqual([])
    expect(JSON.stringify(f.rows())).toBe(rows)
    expect(JSON.stringify(f.deviceRows())).toBe(devices)
  })

  it('never overwrites a row the reading build already wrote', async () => {
    const f = seeded(
      { 'agentSettings@hub': { maxCameras: 99 } },
      {},
      { '202': { cameraSettings: { stepToggles: { 'plate-detection': false } } } },
    )
    await f.boot()
    expect(f.rows()[`${ID}.agentSettings@hub`]?.['value']).toEqual({ maxCameras: 99 })
    expect(f.rows()[`${ID}.agentSettings@agent-1`]?.['value']).toEqual(AGENTS['agent-1'])
    expect(f.deviceRows()[`${ID}:202.cameraSettings`]?.['value']).toEqual({
      stepToggles: { 'plate-detection': false },
    })
    expect(f.deviceRows()[`${ID}:101.cameraSettings`]?.['value']).toEqual(CAMERAS['101'])
  })

  it('a failed read writes nothing and fails the migration', async () => {
    const f = seeded(
      {},
      {
        readStored: async () => {
          throw new Error('store unreadable')
        },
      },
    )
    const before = JSON.stringify(f.rows())
    const report = await f.boot()
    // The first step of the catalogue reads the same store and fails; the engine then blocks
    // every later step of the owner, so no mover runs at all.
    expect(report.failed).toEqual([DROP_BINDINGS_MIGRATION_FLAG_ID])
    expect(report.applied).toEqual([])
    expect(JSON.stringify(f.rows())).toBe(before)
    expect(f.deviceRows()).toEqual({})
  })

  it('a failed device read writes no device row', async () => {
    const f = seeded(
      {},
      {
        readDeviceField: async () => {
          throw new Error('device store unreadable')
        },
      },
    )
    const report = await f.boot()
    expect(report.failed).toEqual([CAMERA_SETTINGS_TO_DEVICE_ROWS_ID])
    expect(f.deviceRows()).toEqual({})
  })

  it('a malformed map copies nothing of it, not even the entries that are fine', async () => {
    const f = seeded({ agentSettings: { hub: { maxCameras: 1 }, broken: 'not an object' } })
    const report = await f.boot()
    expect(report.failed).toContain(AGENT_SETTINGS_TO_NODE_ROWS_ID)
    expect(f.rows()[`${ID}.agentSettings@hub`]).toBeUndefined()
  })

  it('skips the ghost node ids the orchestrator itself refuses to persist', async () => {
    const f = seeded({ agentSettings: { hub: { maxCameras: 1 }, undefined: { maxCameras: 2 } } })
    expect((await f.boot()).failed).toEqual([])
    expect(f.rows()[`${ID}.agentSettings@hub`]).toBeDefined()
    expect(f.rows()[`${ID}.agentSettings@undefined`]).toBeUndefined()
  })

  it('an install that never stored the maps plans nothing', async () => {
    const f = settingsFixture<BlobToRowsPorts>({
      addonId: ID,
      catalogue: ADDON_MIGRATIONS,
      seed: { enabledNodes: ['hub'] },
      neighbour: NEIGHBOUR,
      ports: (rows) => ({
        readStored: rows.readStored,
        readDeviceField: rows.readDeviceField,
      }),
    })
    expect((await f.boot()).failed).toEqual([])
    expect(f.deviceRows()).toEqual({})
    expect(Object.keys(f.rows()).filter((id) => id.includes('@'))).toEqual([])
  })
})
