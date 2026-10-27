/**
 * Persisted shapes for the Google Home Export addon.
 *
 * All of it lives on `this.config` (the kernel's typed addon store). There is
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

export interface GoogleExportSettings {
  /**
   * Public HTTPS origin of this hub. Used for ONE thing: rendering the three
   * URLs the operator must paste into the Actions console (fulfillment,
   * authorize, token). Nothing routes on it — Google calls the fulfillment URL
   * it was configured with, directly.
   *
   * Defaults, when EMPTY, to the first publicly routable HTTPS address the
   * `network-access` cap reports. A value already here is never overwritten —
   * see `public-hub-url.ts`, which owns that policy.
   */
  readonly publicHubUrl: string
  /**
   * The address auto-detection last saw, whether or not it was adopted. Hidden
   * state; exists so the settings panel can distinguish a derived value from
   * one the operator typed, and can offer the detected alternative when they
   * disagree. Never a fallback for `publicHubUrl` — a blank field is the honest
   * answer when detection found nothing.
   */
  readonly detectedPublicHubUrl: string
  /** Operator-curated device list. Hidden state, written via `device-export`. */
  readonly exposed: readonly ExposedDeviceEntry[]
  /** Accounts that completed linking. Hidden state. */
  readonly linkedAccounts: readonly LinkedAccount[]
}

export const DEFAULT_SETTINGS: GoogleExportSettings = {
  publicHubUrl: '',
  detectedPublicHubUrl: '',
  exposed: [],
  linkedAccounts: [],
}

/** Generic `device-export` setup block — copyable console rows. */
export type ExportSetup = z.infer<typeof ExportSetupSchema>
