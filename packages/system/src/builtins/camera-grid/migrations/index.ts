import type { AddonMigration } from '@camstack/types'
import { copyGridsToRecords, type GridMigrationPorts } from './camera-grids-to-records.js'

export {
  gridPortsOver,
  LEGACY_GRIDS_KEY,
  type GridMigrationPorts,
} from './camera-grids-to-records.js'

export const GRIDS_TO_RECORDS_ID = 'camera-grid/2026-11-07-grids-to-records'

/** The `camera-grid` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<GridMigrationPorts>[] = [
  {
    meta: {
      id: GRIDS_TO_RECORDS_ID,
      owner: 'camera-grid',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Copy the addon-level grid list (cameraGrids) into camera-grid records under the same ids, each read back; the legacy key is deleted only once every row has its record',
      fixtureMark: 'cells[0].source.x of a grid row, read back from its record',
    },
    procedure: copyGridsToRecords,
  },
]
