/**
 * Persisted shapes for the Google Home Export addon.
 *
 * The linked accounts live in the `google-links` record and what is exposed in the
 * `google-exports` record, one of each per instance (`export-records.ts`). There is
 * no sidecar file and no second registry — the same conclusion
 * `addon-export-alexa` reached after deleting its `<dataDir>/alexa/*.json`
 * layer.
 *
 * **Nothing here is a credential, and nothing here may become one.** The addon
 * holds no Google secret: account linking is the hub's own OAuth server, and
 * proactive Report State (the one part of the Google contract that needs a
 * HomeGraph service-account key) is not implemented. Before adding such a
 * field, read docs/decisions/adr-0269-a-google-export-that-holds-no-google-credential.md — a `type: 'password'` settings field
 * masks in the UI only, and `addonSettings.getGlobalSettings` returns the
 * stored value in plaintext to any admin caller.
 */
import { ExportSetupSchema } from '@camstack/types'
import type { z } from 'zod'

export interface ExposedDeviceEntry {
  readonly deviceId: number
  readonly exposedAt: number
}

/**
 * A Google account that completed linking.
 *
 * `userId` is the CAMSTACK user our own OAuth server minted the token for — not
 * a Google identifier. Nothing here ever learns which Google account linked:
 * Google hands us back our own token and we never call a Google profile
 * endpoint. Two Google accounts linked by the same operator are therefore
 * indistinguishable, which is why the link is recorded per camstack user.
 *
 * Written on SYNC (the first thing a completed link does) and dropped on
 * `action.devices.DISCONNECT`.
 */
export interface LinkedAccount {
  readonly userId: string
  readonly username: string
  readonly linkedAt: number
}

/**
 * The addon keeps no global setting: every instance, its exposure and its link ledger are
 * records. A key written here would be a second copy of one of them.
 */
export type GoogleExportSettings = Record<string, never>

export const DEFAULT_SETTINGS: GoogleExportSettings = {}

/** Generic `device-export` setup block — copyable console rows. */
export type ExportSetup = z.infer<typeof ExportSetupSchema>
