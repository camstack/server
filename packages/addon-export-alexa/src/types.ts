/**
 * Shared data shapes for the Alexa export addon.
 *
 * These describe the entries persisted in the kernel's addon-store (via
 * `this.config.exposed`, `this.config.linkedAccounts`, and
 * `this.config.tokens`). They used to back JSON files under
 * `<dataDir>/alexa/`; that layer is gone — the typed config blob is the
 * persistence surface now.
 */
import type { CamProfile } from '@camstack/types'

/**
 * Per-device export settings — operator-edited preferences attached to
 * an exposed device. Shared shape across export addons (HAP / Alexa
 * mirror it; HA-MQTT extends it with discoveryPrefix / entityIdPattern
 * overrides).
 */
export interface ExportDeviceSettings {
  /**
   * Preferred broker stream id used when the Alexa Lambda dials a feed
   * for this device. `'auto'` lets the orchestrator pick the best
   * available profile (today: first enabled entry).
   */
  readonly streamPreference: 'auto' | string
  /**
   * Which camstack stream profile slot the Alexa Lambda reads when pulling
   * a live feed. Maps to the broker source selector.
   * Defaults to `'high'` (the primary/highest-quality slot).
   */
  readonly sourceProfile?: CamProfile
  /**
   * Whether we may DECODE AND RE-ENCODE this camera's stream for the Echo.
   *
   * ON unless the operator says otherwise, and ABSENT means ON — the field did
   * not exist for entries persisted before it. It is not a quality knob: it
   * says what the operator is willing to SPEND. A transcode is a decode plus an
   * encode per session, and on this hub a concurrent HEVC decode is what
   * exhausted the VAAPI device.
   *
   * With it off, only a source the Echo can take AS IS qualifies
   * (`scoreAlexaSource`), and a camera that publishes nothing suitable is
   * REFUSED out loud rather than transcoded behind the operator's back.
   */
  readonly allowTranscode?: boolean
}

export const DEFAULT_DEVICE_SETTINGS: ExportDeviceSettings = {
  streamPreference: 'auto',
  sourceProfile: 'high',
}

export interface ExposedDeviceEntry {
  readonly deviceId: number
  readonly exposedAt: number
  /** Per-device export settings. Optional for back-compat with old entries. */
  readonly settings?: ExportDeviceSettings
}

export interface LinkedAccount {
  /**
   * The CAMSTACK user id our own OAuth provider minted, read off the bearer
   * token's `userId` claim.
   *
   * NOT an Amazon identifier, despite keying everything Amazon-facing. Nothing
   * in this system ever learns which Amazon account completed the link:
   * Alexa's account-linking contract hands us our own token back, we never call
   * `api.amazon.com/user/profile`, and the `oauth_sessions` row carries the
   * same camstack user. Two Amazon accounts linked by the same hub operator are
   * therefore indistinguishable here — which is exactly why the unlink control
   * is all-or-nothing rather than per-account.
   */
  readonly userId: string
  readonly username: string
  readonly linkedAt: number
}

/**
 * The Amazon push grant this hub holds for one linked account (D753).
 *
 * Normally a BROKER grant: `brokerUrl` + `brokerCredential` identify the link
 * at the skill's Lambda, which alone holds the LWA refresh token and client
 * secret, and `accessToken` is the short-lived Event Gateway token it last
 * handed out. The hub renews it by asking the broker — it holds no secret.
 *
 * A LEGACY grant (`refreshToken` set, no credential) is what a pre-D753 Lambda
 * delivered. The hub cannot renew it (it has no client secret any more); it is
 * migrated to the broker as soon as the broker's URL is known, and the refresh
 * token is then deleted.
 */
export interface LwaTokenEntry {
  readonly userId: string
  readonly accessToken: string
  readonly expiresAt: number
  readonly receivedAt: number
  /** Legacy only — present until migrated to the broker. */
  readonly refreshToken?: string
  /** Origin of the skill Lambda's broker. */
  readonly brokerUrl?: string
  /** Per-link broker credential (`csb1.<linkId>.<secret>`). Sensitive. */
  readonly brokerCredential?: string
}

/** What a writer supplies; `receivedAt` is stamped by the store. The entry is
 *  REPLACED, so a writer passes every field it wants kept. */
export interface UpsertLwaTokenInput {
  readonly userId: string
  readonly accessToken: string
  readonly expiresAt: number
  readonly refreshToken?: string
  readonly brokerUrl?: string
  readonly brokerCredential?: string
}

/** A grant the hub can renew through the broker. */
export function isBrokerGrant(
  t: LwaTokenEntry,
): t is LwaTokenEntry & { readonly brokerUrl: string; readonly brokerCredential: string } {
  return typeof t.brokerUrl === 'string' && typeof t.brokerCredential === 'string'
}
