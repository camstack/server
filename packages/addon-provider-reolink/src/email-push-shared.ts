/**
 * Leaf constants + helpers shared by the email-push server, its settings
 * schema, and the per-camera Auto-configure flow. Kept dependency-free
 * (no addon imports) so both `email-push-bridge.ts` and `reolink-camera.ts`
 * can import it without forming an import cycle.
 */

/**
 * Manager-side parameters a camera needs to point its email config at
 * the provider's SMTP server. Produced by the provider (which owns the
 * addon settings) and consumed by the camera's Auto-configure flow.
 */
export interface EmailPushManagerSetupParams {
  readonly managerHost: string
  readonly managerPort: number
  readonly domain: string
  readonly recipientLocalPart: string
  readonly authUsername?: string
  readonly authPassword?: string
}

/**
 * Resolver the provider injects into each `ReolinkCamera` so the camera's
 * Auto-configure action can fetch the live manager-side SMTP params
 * without holding a direct provider reference. Returns `null` when the
 * server is disabled, has no resolvable LAN host, or the camera is not
 * eligible.
 */
export type EmailPushParamsResolver = () => Promise<EmailPushManagerSetupParams | null>

/** The lib's email-push classifier output (mirrors
 *  `EmailPushEvent.inferredType` — kept here so the mapping below stays
 *  dependency-free and testable without loading the SMTP/lib module). */
export type EmailPushInferredType =
  | 'motion'
  | 'people'
  | 'vehicle'
  | 'animal'
  | 'face'
  | 'package'
  | 'doorbell'
  | 'other'

/** The `type` field of a `ReolinkSimpleEvent` the camera's
 *  `handleSimpleEvent` accepts from the email-push bridge. */
export type EmailPushSimpleEventType =
  | 'motion'
  | 'people'
  | 'vehicle'
  | 'animal'
  | 'face'
  | 'package'
  | 'doorbell'

/**
 * Map the lib's email-push classifier output onto the `ReolinkSimpleEvent`
 * types the camera should be fed. AI subtypes + motion pass through;
 * anything unrecognised collapses to plain `motion` so a wake is never
 * silently dropped.
 *
 * Returns a LIST rather than a single type because of `doorbell`. The
 * camera's `handleSimpleEvent` emits `ProviderMotion` for `motion`
 * and for every AI class, but the `doorbell` branch emits ONLY
 * `DoorbellOnPressed` and returns. An email is the sole signal a sleeping
 * battery camera can send, so a doorbell-classified email mapped to
 * `doorbell` alone rang the bell and left motion, recording and
 * notification rules blind — the exact "silently dropped wake" this mapping
 * exists to prevent. Pairing it with `motion` keeps the doorbell semantic
 * AND the wake.
 */
export function mapInferredTypeToSimpleEvents(
  inferred: EmailPushInferredType,
): readonly EmailPushSimpleEventType[] {
  switch (inferred) {
    case 'people':
    case 'vehicle':
    case 'animal':
    case 'face':
    case 'package':
    case 'motion':
      return [inferred]
    case 'doorbell':
      return ['doorbell', 'motion']
    case 'other':
    default:
      return ['motion']
  }
}

/** Default SMTP listen port. Avoid privileged 25; Reolink firmwares are
 *  happy on any port the email config points at. */
export const DEFAULT_EMAIL_PUSH_PORT = 2525

/** Virtual mail domain — only used to extract the camera id from the
 *  recipient (`cam-<id>@<domain>`). Never resolved via DNS. */
export const DEFAULT_EMAIL_PUSH_DOMAIN = 'camstack.local'

/** Reolink snapshots fit comfortably; 25 MB covers video attachments
 *  too without letting a runaway upload exhaust memory. */
export const DEFAULT_EMAIL_PUSH_MAX_MESSAGE_BYTES = 25 * 1024 * 1024
