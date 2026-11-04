import type { IntegrationMigrationPorts, SavedDevice } from '@camstack/types'

/**
 * What the VeSync hub migration touches outside itself. A spec binds it to a fake; the
 * addon binds it to the kernel. The record ports are how the account is written and read
 * back in the same boot that creates the integration.
 */
export interface VeSyncMigrationPorts extends IntegrationMigrationPorts {
  /** Every persisted row of this addon: the hub, its purifiers, their accessories. */
  listSavedDevices(): Promise<readonly SavedDevice[]>
  /**
   * Bring these rows to life now, top-level (the migration un-parents the purifiers so
   * the hub can be retired without cascading).
   */
  restoreRows(rows: readonly SavedDevice[]): Promise<void>
  /**
   * Put the account record under the integration id. `exists` when one is already there
   * (never overwritten). The password goes through the keychain.
   */
  putAccountRecord(
    integrationId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<'created' | 'exists'>
  /** The account record with secrets resolved, or null when absent. Throws when locked. */
  readAccountRecord(integrationId: string): Promise<Readonly<Record<string, unknown>> | null>
}
