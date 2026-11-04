/**
 * The retired global knobs of the HomeKit export. `bridgeName` is the instance's name and
 * `fixedPin` was an operator-typed setup code (a bridge's setup code is read-only now and changes
 * only through Regenerate); the bare `interfaceName` is the cluster copy of a setting that is a
 * fact of one node, which the node row carries since the per-node migration.
 *
 * Two bodies, in this order, because a secret must be released before its row goes (the
 * keychain value would be orphaned otherwise):
 *  1. `clearFixedPin` (procedure): the keychain value and marker of `fixedPin`;
 *  2. `planDropGlobalKnobRows` (plan): the rows `bridgeName`, `fixedPin` and the bare
 *     `interfaceName`. The bare interfaceName goes only when the node row exists, so deleting it
 *     can never lose the value. A `@<nodeId>` row is never touched.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import { ADDON_SETTINGS_TABLE, type HubNodeFieldsPorts, nodeKeyOf } from './hub-node-fields.js'

export interface DropGlobalKnobsPorts extends HubNodeFieldsPorts {
  /** Remove the keychain value and the marker of `fixedPin` (`clearSecrets`). */
  clearFixedPin(): Promise<void>
}

export async function clearFixedPin(
  ports: DropGlobalKnobsPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored(['fixedPin'])
  if (!('fixedPin' in stored)) return { outcome: 'already-done', summary: { cleared: false } }
  await ports.clearFixedPin()
  return { outcome: 'done', summary: { cleared: true } }
}

export async function planDropGlobalKnobRows(
  addonId: string,
  ports: HubNodeFieldsPorts,
): Promise<MigrationPlan> {
  const stored = await ports.readStored([
    'bridgeName',
    'fixedPin',
    'interfaceName',
    nodeKeyOf('interfaceName'),
  ])
  const present = ['bridgeName', 'fixedPin', 'interfaceName'].filter(
    (key) => key in stored && (key !== 'interfaceName' || nodeKeyOf('interfaceName') in stored),
  )
  if (present.length === 0) return { edits: [] }
  const rowId = (key: string): string => `${addonId}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [rowId(key), { addonId, key, value: stored[key] }]),
          ),
        ),
      },
    ],
  }
}
