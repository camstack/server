import type { AddonMigration } from '@dominevo/types'
import {
  AUTOMATION_CONFIRMED_VIEW_ID,
  regenerateAutomationsConfirmedView,
} from './automation-confirmed-view.js'
import {
  CUSTOMIZE_KIND_DISCRIMINANT_ID,
  stampCustomizeKinds,
} from './customize-kind-discriminant.js'
import { dropFountainDrinkCounters, FOUNTAIN_DRINK_DROP_ID } from './fountain-drink-drop.js'
import { HELPER_TO_CUSTOMIZE_ID, rewriteHelpersToCustomize } from './helper-to-customize.js'
import {
  type CoreBlocksMigrationPorts,
  PUMP_CYCLE_SPLIT_ID,
  splitPumpCycleFromFountain,
} from './pump-cycle-split.js'
import { addTagIds, CORE_BLOCKS_TAG_IDS_ID, type TagIdsPorts } from './tag-ids.js'
import { TAGS_AS_RECORDS_ID, type TagsAsRecordsPorts, writeTagRecords } from './tags-as-records.js'

import {
  dropRemotePowerMode,
  REMOTE_COLOUR_ROLES_ID,
  REMOTE_POWER_DROP_ID,
  type RemoteMigrationPorts,
  renameRemoteColourRoles,
} from './remote-config-migrations.js'

export { AUTOMATION_CONFIRMED_VIEW_ID } from './automation-confirmed-view.js'
export { CUSTOMIZE_KIND_DISCRIMINANT_ID } from './customize-kind-discriminant.js'
export { FOUNTAIN_DRINK_DROP_ID } from './fountain-drink-drop.js'
export {
  REMOTE_COLOUR_ROLES_ID,
  REMOTE_POWER_DROP_ID,
  remoteMigrationPortsOver,
  type RemoteMigrationPorts,
} from './remote-config-migrations.js'

/** Everything the core-blocks catalogue touches: the block rows, and the stored remotes and templates. */
export type CoreBlocksCatalogPorts = CoreBlocksMigrationPorts &
  RemoteMigrationPorts &
  TagIdsPorts &
  TagsAsRecordsPorts
export { HELPER_TO_CUSTOMIZE_ID } from './helper-to-customize.js'
export { CORE_BLOCKS_TAG_IDS_ID, tagIdsPortsOver, type TagIdsPorts } from './tag-ids.js'
export {
  TAGS_AS_RECORDS_ID,
  tagsAsRecordsPortsOver,
  type TagsAsRecordsPorts,
} from './tags-as-records.js'
export {
  coreBlocksMigrationPorts,
  PUMP_CYCLE_SPLIT_ID,
  type CoreBlocksMigrationPorts,
  type StoredBlockRow,
} from './pump-cycle-split.js'

/** The `core-blocks` catalogue (D987): offered to the engine when the hub-resident addon initialises. */
/** The device manager's step (a ledger id, not an import: addons never import each other). */
const DEVICE_MANAGER_TAG_IDS_ID = 'device-manager/2026-11-23-device-tag-ids'
const RULE_TAG_IDS_ID = 'pipeline-analytics/2026-11-23-rule-tag-ids'

export const ADDON_MIGRATIONS: readonly AddonMigration<CoreBlocksCatalogPorts>[] = [
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
  {
    meta: {
      id: REMOTE_POWER_DROP_ID,
      owner: 'core-blocks',
      level: 'addon-state',
      seq: 4,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Drop the stored power mode (toggle or discrete) from each remote configuration: the Power key and an explicit on / off now follow the bindings',
      fixtureMark:
        'the default transmitter and a source name of each remote, which the migration does not know',
    },
    procedure: dropRemotePowerMode,
  },
  {
    meta: {
      id: REMOTE_COLOUR_ROLES_ID,
      owner: 'core-blocks',
      level: 'addon-state',
      seq: 5,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Rename the lettered colour keys custom:color_a..d to the colour roles custom:color_red..blue in each remote (bindings, custom buttons, sequence sources) and in each stored layout, which keeps the letter on a coloured key',
      fixtureMark: 'the binding action of each lettered key and the label of each layout button',
    },
    procedure: renameRemoteColourRoles,
  },
  {
    meta: {
      id: AUTOMATION_CONFIRMED_VIEW_ID,
      owner: 'core-blocks',
      level: 'addon-state',
      seq: 6,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Regenerate each stored generated automation from its embedded recipe so it reads what the device reported, never a command the hub still holds; code edited by hand is left as it is and logged',
      fixtureMark: 'the block createdBy and name, which the migration does not know',
    },
    procedure: regenerateAutomationsConfirmedView,
  },
  {
    meta: {
      id: CORE_BLOCKS_TAG_IDS_ID,
      owner: 'core-blocks',
      level: 'addon-state',
      seq: 7,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Add the ids of its tags to each block, scheduler, template and action beside the kept names, derived from the folded name',
      fixtureMark:
        'the name and the enabled flag of each record, which the migration does not know',
    },
    procedure: addTagIds,
  },
  {
    meta: {
      id: TAGS_AS_RECORDS_ID,
      owner: 'core-blocks',
      level: 'addon-state',
      seq: 8,
      // The owner steps that wrote `tagIds`: a tag record exists under the id they used.
      dependsOn: [CORE_BLOCKS_TAG_IDS_ID, DEVICE_MANAGER_TAG_IDS_ID, RULE_TAG_IDS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Write one tags record per tag in use or styled, carrying the colour and icon of its style, then delete the tag style rows',
      fixtureMark: 'the colour and icon of each styled tag',
    },
    procedure: writeTagRecords,
  },
  {
    meta: {
      id: CUSTOMIZE_KIND_DISCRIMINANT_ID,
      owner: 'core-blocks',
      level: 'addon-state',
      seq: 9,
      dependsOn: [PUMP_CYCLE_SPLIT_ID, HELPER_TO_CUSTOMIZE_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Stamp the Customize kind (power-source, lock-door-sensor, follow-switch) on each stored feature recognised so far only by its shape, so the readers need no shape check',
      fixtureMark: 'the block createdBy and name, which the migration does not know',
    },
    procedure: stampCustomizeKinds,
  },
]
