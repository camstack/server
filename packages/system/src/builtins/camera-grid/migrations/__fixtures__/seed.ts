/**
 * The legacy data the camera-grid catalogue meets on a node that last ran a release which kept its
 * grids in the addon settings (`cameraGrids`): written by hand, in the shape that release stored
 * it (including the `width`/`height` rows carried before the canvas was derived), with a MARK in a
 * field a migration that re-built a row would drop (`cells[0].source.x`). The replay and the
 * real-SQLite spec both seed from here.
 */
import type Database from 'better-sqlite3'

export const GRID_SEED_ADDON = 'camera-grid'

/** A laid-out grid with an old canvas size, and a name-only grid that is switched off. */
export const GRID_SEED_ROWS: readonly Record<string, unknown>[] = [
  {
    id: '5d0c3b7a-2e41-4f6b-9a18-7c2e9d1b4a01',
    cameraStableId: 'camera-grid-5d0c3b7a-2e41-4f6b-9a18-7c2e9d1b4a01',
    name: 'Front 2x2',
    enabled: true,
    width: 1920,
    height: 1080,
    fps: 12,
    publishedProfiles: ['mid', 'low'],
    cells: [
      {
        deviceId: 101,
        source: { x: 0.1234, y: 0, width: 0.5, height: 1 },
        cell: { x: 0, y: 0, width: 0.5, height: 1 },
      },
      {
        deviceId: 102,
        source: { x: 0, y: 0, width: 1, height: 1 },
        cell: { x: 0.5, y: 0, width: 0.5, height: 1 },
      },
    ],
  },
  {
    id: '9a8b7c6d-1f2e-4d3c-8b4a-5e6f7a8b9c02',
    cameraStableId: 'camera-grid-9a8b7c6d-1f2e-4d3c-8b4a-5e6f7a8b9c02',
    name: 'Garden',
    enabled: false,
    fps: 10,
    cells: [],
  },
]

/** Write the legacy list the way the settings writer stored it: one `<addonId>.<key>` row. */
export function seedGridLegacySettings(db: Database.Database): void {
  db.prepare('INSERT OR REPLACE INTO "addon-settings" (id, data) VALUES (?, ?)').run(
    `${GRID_SEED_ADDON}.cameraGrids`,
    JSON.stringify({ addonId: GRID_SEED_ADDON, key: 'cameraGrids', value: GRID_SEED_ROWS }),
  )
}
