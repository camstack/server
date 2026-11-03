import type { AddonMigration, MigrationProcedureResult } from '@camstack/types'
import { type DropKeysPorts, planDropKeys } from './drop-keys.js'

export const PROVIDER_ONVIF_ID = 'provider-onvif'
export const DROP_DEFAULT_CREDENTIALS_ID = 'provider-onvif/2026-11-03-drop-default-credentials'
export const DROP_DEFAULT_CREDENTIAL_KEYS_ID =
  'provider-onvif/2026-11-03-drop-default-credential-keys'

/** The retired addon-wide credentials: nothing reads them, each camera holds its own. */
export const DEFAULT_CREDENTIAL_KEYS: readonly string[] = ['defaultUsername', 'defaultPassword']

export interface OnvifMigrationPorts extends DropKeysPorts {
  /** Remove the keychain value and the marker of `defaultPassword` (`clearSecrets`). */
  clearDefaultPassword(): Promise<void>
}

/**
 * First the keychain: the password's value and marker go through `clearSecrets`, so no secret is
 * orphaned in the keychain when the row is deleted. Idempotent: no stored password is
 * `already-done`.
 */
async function clearDefaultPassword(ports: OnvifMigrationPorts): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored(['defaultPassword'])
  if (!('defaultPassword' in stored))
    return { outcome: 'already-done', summary: { cleared: false } }
  await ports.clearDefaultPassword()
  return { outcome: 'done', summary: { cleared: true } }
}

/** The `provider-onvif` catalogue (D987): offered to the engine when the addon initialises. */
export const ADDON_MIGRATIONS: readonly AddonMigration<OnvifMigrationPorts>[] = [
  {
    meta: {
      id: DROP_DEFAULT_CREDENTIALS_ID,
      owner: PROVIDER_ONVIF_ID,
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description: 'Clear the retired default password from the keychain',
      fixtureMark: 'a camera list the migration does not know',
    },
    procedure: clearDefaultPassword,
  },
  {
    meta: {
      id: DROP_DEFAULT_CREDENTIAL_KEYS_ID,
      owner: PROVIDER_ONVIF_ID,
      level: 'addon-state',
      seq: 2,
      dependsOn: [DROP_DEFAULT_CREDENTIALS_ID],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'plan',
      description: 'Delete the retired default username and password rows',
      fixtureMark: 'a camera list the migration does not know',
    },
    plan: (ports) => planDropKeys(PROVIDER_ONVIF_ID, DEFAULT_CREDENTIAL_KEYS, ports),
  },
]
