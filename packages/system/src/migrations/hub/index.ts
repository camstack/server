/**
 * The hub-store migration catalogue (D986): every migration the hub applies to
 * `camstack.db`, `events.db` and `history.db` at boot, in declaration order.
 *
 * Empty on purpose in the first release of the engine: the engine ships and is
 * proven on test migrations, and each real conversion arrives with the shape
 * change that needs it, as one entry here with a spec that asserts a marked
 * field survived. The ids are never reused or removed once released.
 */
import type { HubMigration } from '../../builtins/sqlite-storage/migrations/migration-types.js'

export const HUB_MIGRATIONS: readonly HubMigration[] = []
