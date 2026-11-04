/**
 * The installation name the addon kept in its settings (`bridgeName`) is the NAME of the default
 * instance record now: every bridge is a record and a record carries its own name. The identity
 * migration already used `bridgeName` as the record's label when it created it; this pass covers
 * a record that exists under another name (the name was changed in the old form after the record
 * was created, or the record predates the label), and proves the patch by reading the record back.
 *
 * Idempotent: an absent or empty `bridgeName`, an absent record or a record that already carries
 * the name is `already-done`. The setting itself is deleted by a later migration, once this one
 * has read it.
 */
import type { MigrationProcedureResult } from '@camstack/types'
import type { HapBridgeBody } from '../hap-instance-kinds.js'

export interface BridgeNameToInstancePorts {
  /** The legacy bridge name; '' when none was stored. Throws when unreadable. */
  readBridgeName(): Promise<string>
  /** The default record, secrets resolved; null when absent. */
  readDefaultRecord(): Promise<HapBridgeBody | null>
  /** Patch the default record's name. */
  patchDefaultName(name: string): Promise<void>
}

export async function moveBridgeNameToInstance(
  ports: BridgeNameToInstancePorts,
): Promise<MigrationProcedureResult> {
  const name = (await ports.readBridgeName()).trim()
  if (name === '') return { outcome: 'already-done', summary: { renamed: false } }
  const held = await ports.readDefaultRecord()
  if (held === null || held.name === name) {
    return { outcome: 'already-done', summary: { renamed: false } }
  }
  await ports.patchDefaultName(name)
  const after = await ports.readDefaultRecord()
  if (after === null || after.name !== name) {
    throw new Error('the HomeKit default instance does not carry the name it adopted')
  }
  return { outcome: 'done', summary: { renamed: true } }
}
