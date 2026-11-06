/**
 * The hub-store migration catalogue (D987): every migration the hub applies to
 * `camstack.db`, `events.db` and `history.db` at boot, in declaration order.
 *
 * The engine shipped empty and is proven on test migrations; each real
 * conversion arrives with the shape change that needs it, as one entry here with
 * a spec that asserts a marked field survived. The ids are never reused or removed once released.
 */
import type { HubMigration } from '../../builtins/sqlite-storage/migrations/migration-types.js'
import { ADDON_SETTINGS_NODE_ID_MIGRATION } from './2026-11-02-addon-settings-node-id.js'
import { INTEGRATION_ADDON_ID_BARE_MIGRATION } from './2026-11-02-integration-addon-id-bare.js'
import { RECORDS_OWNER_GROUP_TO_ADDON_MIGRATION } from './2026-11-02-records-owner-group-to-addon.js'
import { DROP_INTEGRATION_SETTINGS_MIGRATION } from './2026-11-05-drop-integration-settings.js'
import { DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION } from './2026-11-06-drop-legacy-integrations-and-storage-locations.js'

export const HUB_MIGRATIONS: readonly HubMigration[] = [
  ADDON_SETTINGS_NODE_ID_MIGRATION,
  INTEGRATION_ADDON_ID_BARE_MIGRATION,
  RECORDS_OWNER_GROUP_TO_ADDON_MIGRATION,
  DROP_INTEGRATION_SETTINGS_MIGRATION,
  DROP_LEGACY_INTEGRATIONS_AND_STORAGE_LOCATIONS_MIGRATION,
]
