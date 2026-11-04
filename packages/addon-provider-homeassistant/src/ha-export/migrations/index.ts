import type { AddonMigration } from '@camstack/types'
import { type DropPublicBaseUrlPorts, planDropPublicBaseUrl } from './drop-public-base-url.js'
import {
  copyFlagsToIntegrations,
  type PerBrokerFlagsPorts,
  planDropPerBrokerFlags,
} from './per-broker-flags.js'
import {
  type DropLinksAndCachePorts,
  dropLinksAndCache,
  moveLinksToTargets,
  type TargetsFromLinksPorts,
} from './targets-from-links.js'
import {
  type DropMovedLinksPorts,
  type LinksMigrationPorts,
  moveLinksToRecords,
  planDropMovedLinks,
} from './links-to-record.js'

export type { DropPublicBaseUrlPorts } from './drop-public-base-url.js'
export type {
  DropMovedLinksPorts,
  LinksMigrationPorts,
} from './links-to-record.js'
export type { PerBrokerFlagsPorts } from './per-broker-flags.js'
export type {
  DropLinksAndCachePorts,
  TargetsFromLinksPorts,
} from './targets-from-links.js'

/** Everything the `homeassistant-export` catalogue reads and writes. */
export type HaExportMigrationPorts = DropPublicBaseUrlPorts &
  PerBrokerFlagsPorts &
  LinksMigrationPorts &
  DropMovedLinksPorts &
  TargetsFromLinksPorts &
  DropLinksAndCachePorts

export const LINKS_TO_RECORD_ID = 'homeassistant-export/2026-11-04-links-to-record'
export const DROP_MOVED_LINKS_ID = 'homeassistant-export/2026-11-04-drop-moved-links'
export const TARGETS_FROM_LINKS_ID = 'homeassistant-export/2026-11-04-targets-from-links'
export const DROP_LINKS_AND_CACHE_ID = 'homeassistant-export/2026-11-04-drop-links-and-cache'

/** The `homeassistant-export` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<HaExportMigrationPorts>[] = [
  {
    meta: {
      id: 'homeassistant-export/2026-11-02-drop-public-base-url',
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description:
        'Delete the retired publicBaseUrl setting; each instance now chooses a hub address role',
      fixtureMark: 'the reconcile interval the migration does not know',
    },
    plan: planDropPublicBaseUrl,
  },
  {
    meta: {
      id: 'homeassistant-export/2026-11-03-per-broker-flags-to-integration',
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Copy each exportTo:<broker> and mediaRole:<broker> key to the settings of the integration that links the broker',
      fixtureMark: 'the broker link stored beside the flags of an integration',
    },
    procedure: copyFlagsToIntegrations,
  },
  {
    meta: {
      id: 'homeassistant-export/2026-11-03-drop-per-broker-flags',
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 3,
      dependsOn: ['homeassistant-export/2026-11-03-per-broker-flags-to-integration'],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the per-broker keys once the integration shows the same flag',
      fixtureMark: 'a legacy flag parked when the integration holds a different one',
    },
    plan: planDropPerBrokerFlags,
  },
  {
    meta: {
      id: LINKS_TO_RECORD_ID,
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 4,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Move each instance export switch, media role and exported devices into its ha-export-links record; the record is read back before anything is deleted',
      fixtureMark: 'the reconcile interval the migration does not know',
    },
    procedure: moveLinksToRecords,
  },
  {
    meta: {
      id: DROP_MOVED_LINKS_ID,
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 5,
      dependsOn: [LINKS_TO_RECORD_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'plan',
      description:
        'Delete the membership, exportTo and mediaRole keys once the records hold what they carried',
      fixtureMark: 'the reconcile interval the migration does not know',
    },
    plan: planDropMovedLinks,
  },
  {
    meta: {
      id: TARGETS_FROM_LINKS_ID,
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 6,
      dependsOn: [LINKS_TO_RECORD_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Turn each ha-export-links record into an export target under a minted id that names its Home Assistant connection, carrying the switch, media role, devices and reconcile interval; read back before anything is deleted',
      fixtureMark: 'the exported entities the migration does not touch',
    },
    procedure: moveLinksToTargets,
  },
  {
    meta: {
      id: DROP_LINKS_AND_CACHE_ID,
      owner: 'homeassistant-export',
      level: 'addon-state',
      seq: 7,
      dependsOn: [TARGETS_FROM_LINKS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Delete each ha-export-links record whose target holds the same devices, then the reconcileIntervalSec and knownBrokers settings',
      fixtureMark: 'the exported entities the migration does not touch',
    },
    procedure: dropLinksAndCache,
  },
]
