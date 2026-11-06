import type { AddonMigration } from '@camstack/types'
import { dropFountainDrinkCounters, FOUNTAIN_DRINK_DROP_ID } from './fountain-drink-drop.js'
import { HELPER_TO_CUSTOMIZE_ID, rewriteHelpersToCustomize } from './helper-to-customize.js'
import {
  type CoreBlocksMigrationPorts,
  PUMP_CYCLE_SPLIT_ID,
  splitPumpCycleFromFountain,
} from './pump-cycle-split.js'

export { FOUNTAIN_DRINK_DROP_ID } from './fountain-drink-drop.js'
export { HELPER_TO_CUSTOMIZE_ID } from './helper-to-customize.js'
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
  {
    meta: {
      id: HELPER_TO_CUSTOMIZE_ID,
      owner: 'core-blocks',
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Rewrite each stored appliance and heater helper composition into plain Customize features (running-state, power-meter, power-source) with the same threshold, dwells and plugs, and drop the helper spec',
      fixtureMark: 'the marked threshold, start and stop dwell, plug and offSeconds of each helper',
    },
    procedure: rewriteHelpersToCustomize,
  },
  {
    meta: {
      id: FOUNTAIN_DRINK_DROP_ID,
      owner: 'core-blocks',
      level: 'addon-state',
      seq: 3,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Remove the drink counters and the reset-daily-count forward from the pet-fountain feature of each stored fountain composition',
      fixtureMark: 'the block createdBy and name, which the migration does not know',
    },
    procedure: dropFountainDrinkCounters,
  },
]
