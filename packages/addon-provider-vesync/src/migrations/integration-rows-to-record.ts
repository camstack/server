/**
 * Every VeSync integration moves from legacy `integration_settings` rows into its own
 * `connections` record (planning#416, D1007). The hub migration writes that record in the
 * same boot; this pass is what clears the rows once the record reads back, and what builds
 * the record when a boot died between creating the integration and putting the record.
 * Devices are not touched.
 */
import { integrationRowsMigration } from '@camstack/types'
import { vesyncConnectionsEntryKind } from '../vesync-instances.js'

const base = integrationRowsMigration({
  addonId: 'provider-vesync',
  date: '2026-11-05',
  kind: vesyncConnectionsEntryKind,
  fixtureMark: 'email',
})

/** Seq 2: the hub migration of the same owner is seq 1. */
export const VESYNC_ROWS_TO_RECORD_MIGRATION = {
  ...base,
  meta: { ...base.meta, seq: 2 },
}

export const VESYNC_ROWS_TO_RECORD_ID = VESYNC_ROWS_TO_RECORD_MIGRATION.meta.id
