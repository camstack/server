/**
 * The fixed HomeKit setup code pairs a controller with the bridge: a credential. It was a plain
 * text setting, stored inline in the settings row; it is a `password` field now (D783), and a
 * password lives in the keychain with a marker in the row. This procedure moves a stored inline
 * code there, through the operator write path (the one that stores an inline value of a
 * pre-keychain addon as a keychain secret).
 *
 * Idempotent: an absent, empty or already marker-backed code is `already-done`, so a crash
 * between the keychain write and the ledger row costs nothing on the rerun.
 */
import { isSecretMarker, type MigrationProcedureResult } from '@camstack/types'
import type { HubNodeFieldsPorts } from './hub-node-fields.js'

export interface FixedPinPorts extends HubNodeFieldsPorts {
  /** Store the code as the operator would have: the keychain holds it, the row holds a marker. */
  storeFixedPin(pin: string): Promise<void>
}

export async function moveFixedPinToKeychain(
  ports: FixedPinPorts,
): Promise<MigrationProcedureResult> {
  const stored = (await ports.readStored(['fixedPin']))['fixedPin']
  if (typeof stored !== 'string' || stored === '' || isSecretMarker(stored)) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  await ports.storeFixedPin(stored)
  return { outcome: 'done', summary: { moved: true } }
}
