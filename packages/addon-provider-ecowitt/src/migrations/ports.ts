import type { IntegrationMigrationPorts, SavedDevice } from '@camstack/types'

/**
 * What the Ecowitt hub migration touches outside itself: the shared integration ports plus the
 * two things only this addon knows how to do. A spec binds it to an in-memory fake.
 */
export interface EcowittMigrationPorts extends IntegrationMigrationPorts {
  /** Every persisted row of this addon, with its blob: the hub, its containers, their sensors. */
  listSavedDevices(): Promise<readonly SavedDevice[]>
  /**
   * Bring these rows to life now, top-level (the migration un-parents the containers so the hub
   * can be retired without cascading). Starts the integration's client first.
   */
  restoreRows(rows: readonly SavedDevice[]): Promise<void>
}
