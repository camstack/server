/**
 * The gateway used to restart its own power source and kept the time of the last
 * restart in the addon store, one flat key per integration (`powerRestartAt:<id>`).
 * Recovery is now an operator automation on the gateway's `error` cap (D1072), so
 * nothing reads these keys; this removes them. Idempotent: no key left means
 * `already-done`.
 */
import type { AddonProcedureMigration, MigrationProcedureResult } from '@dominevo/types'

export const VELUX_DROP_POWER_RESTART_KEYS_ID = 'provider-velux/2026-11-21-drop-power-restart-keys'

/** The prefix of the retired store keys. */
export const POWER_RESTART_KEY_PREFIX = 'powerRestartAt:'

export interface DropPowerRestartKeysPorts {
  /** Every key of the addon's settings store. */
  storedKeys(): Promise<readonly string[]>
  /** Remove exactly these keys; the others stay. */
  deleteKeys(keys: readonly string[]): Promise<void>
}

export async function dropPowerRestartKeys(
  ports: DropPowerRestartKeysPorts,
): Promise<MigrationProcedureResult> {
  const retired = (await ports.storedKeys()).filter((key) =>
    key.startsWith(POWER_RESTART_KEY_PREFIX),
  )
  if (retired.length === 0) return { outcome: 'already-done', summary: { removed: 0 } }
  await ports.deleteKeys(retired)
  const left = (await ports.storedKeys()).filter((key) => key.startsWith(POWER_RESTART_KEY_PREFIX))
  if (left.length > 0) {
    throw new Error(`the power restart keys ${left.join(', ')} are still stored after the removal`)
  }
  return { outcome: 'done', summary: { removed: retired.length } }
}

export const VELUX_DROP_POWER_RESTART_KEYS_MIGRATION: AddonProcedureMigration<DropPowerRestartKeysPorts> =
  {
    meta: {
      id: VELUX_DROP_POWER_RESTART_KEYS_ID,
      owner: 'provider-velux',
      level: 'addon-state',
      seq: 2,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Remove the retired powerRestartAt:<integration> keys (the time of the last provider-side gateway restart); recovery is an operator automation now',
      fixtureMark: 'powerRestartAt:int_0001',
    },
    procedure: dropPowerRestartKeys,
  }
