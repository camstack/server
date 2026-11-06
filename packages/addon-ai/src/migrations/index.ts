import type { AddonMigration } from '@camstack/types'
import { normaliseProfileRows, type ProfileRowsPorts } from './profile-rows.js'

export type { ProfileRowsPorts, ProfileRowState } from './profile-rows.js'

export const PROFILE_RAW_KEYS_TO_KEYCHAIN_ID = 'ai/2026-11-06-profile-raw-keys-to-keychain'

/** The `ai` catalogue (D987): offered to the engine when the addon initialises on the hub. */
export const ADDON_MIGRATIONS: readonly AddonMigration<ProfileRowsPorts>[] = [
  {
    meta: {
      id: PROFILE_RAW_KEYS_TO_KEYCHAIN_ID,
      owner: 'ai',
      level: 'addon-state',
      seq: 1,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'tolerate',
      bodyKind: 'procedure',
      description:
        'Move the provider fields of flat LLM profile rows into providerConfig and any plaintext API key into the keychain, leaving a marker',
      fixtureMark: 'a profile field the migration does not know',
    },
    procedure: normaliseProfileRows,
  },
]
