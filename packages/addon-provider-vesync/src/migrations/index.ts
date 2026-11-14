/** Deleted 2026-11-14, #545: the hub-to-integration migration. Installs that ran it keep the applied row. */
export const VESYNC_RETIRED_MIGRATION_IDS: readonly string[] = [
  'provider-vesync/2026-11-04-hub-to-integration-gateway',
]

export {
  VESYNC_ROWS_TO_RECORD_ID,
  VESYNC_ROWS_TO_RECORD_MIGRATION,
} from './integration-rows-to-record.js'
