/** Deleted 2026-11-14, #545: the hub-to-integration migration. Installs that ran it keep the applied row. */
export const ECOWITT_RETIRED_MIGRATION_IDS: readonly string[] = [
  'provider-ecowitt/2026-11-01-hub-to-integration-gateway',
]

export {
  ECOWITT_ROWS_TO_RECORD_ID,
  ECOWITT_ROWS_TO_RECORD_MIGRATION,
} from './integration-rows-to-record.js'
