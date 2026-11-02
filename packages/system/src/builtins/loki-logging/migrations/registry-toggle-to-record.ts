/**
 * Loki's on/off moves from the `log-destination` registry toggle (D777) to the record's own
 * `enabled` (D996). A provider the registry holds OFF is carried to a record that is off, and the
 * registry toggle is turned back on, so the operator has ONE switch and it is the visible one.
 *
 * Idempotent and crash-safe: the record is written first (a rerun sees it already off and only
 * turns the registry on); a registry that cannot be read writes nothing (D49); a provider that is
 * not registered yet FAILS the migration (tolerated) so the addon retries after registration.
 */
import type { MigrationProcedureResult } from '@camstack/types'

/** What the hub's capability registry says about Loki's `log-destination` provider. */
export type RegistryState = 'active' | 'inactive' | 'unregistered'

export interface RegistryToggleMigrationPorts {
  /** The registry state of this addon's `log-destination` provider. Throws when it cannot be read. */
  readRegistryState(): Promise<RegistryState>
  /** The destinations record, or null when there is none. */
  findToggleRecord(): Promise<{ readonly id: string; readonly enabled: boolean } | null>
  /** Patch the record to `enabled: false`. */
  disableRecord(id: string): Promise<void>
  /** Turn the registry toggle back on. */
  enableRegistry(): Promise<void>
}

export async function moveRegistryToggleToRecord(
  ports: RegistryToggleMigrationPorts,
): Promise<MigrationProcedureResult> {
  const state = await ports.readRegistryState()
  if (state === 'active') return { outcome: 'already-done', summary: { carried: false } }
  if (state === 'unregistered') {
    throw new Error('the log-destination provider is not registered yet')
  }
  const record = await ports.findToggleRecord()
  // Nothing to carry the "off" to: the registry toggle stays the only switch there is.
  if (record === null) return { outcome: 'already-done', summary: { carried: false } }
  if (record.enabled) await ports.disableRecord(record.id)
  await ports.enableRegistry()
  return { outcome: 'done', summary: { carried: true, integrationId: record.id } }
}
