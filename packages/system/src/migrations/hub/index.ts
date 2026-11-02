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

export const HUB_MIGRATIONS: readonly HubMigration[] = [
  ADDON_SETTINGS_NODE_ID_MIGRATION,
  INTEGRATION_ADDON_ID_BARE_MIGRATION,
]
