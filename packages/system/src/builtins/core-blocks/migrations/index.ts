import type { AddonMigration } from '@camstack/types'
import {
  type CoreBlocksMigrationPorts,
  PUMP_CYCLE_SPLIT_ID,
  splitPumpCycleFromFountain,
} from './pump-cycle-split.js'

export {
  coreBlocksMigrationPorts,
  PUMP_CYCLE_SPLIT_ID,
  type CoreBlocksMigrationPorts,
  type StoredBlockRow,
} from './pump-cycle-split.js'

/** The `core-blocks` catalogue (D987): offered to the engine when the hub-resident addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<CoreBlocksMigrationPorts>[] = [
  {
    meta: {
      id: PUMP_CYCLE_SPLIT_ID,
      owner: 'core-blocks',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move the pump duty cycle of a stored pet-fountain composition from the pet-fountain feature to a pump-cycle feature',
      fixtureMark: 'the block createdBy and name, which the migration does not know',
    },
    procedure: splitPumpCycleFromFountain,
  },
]
