import { z } from 'zod'

/** One Google account connection (broker entry): the OAuth *app* credentials. The account's
 *  session (refresh token, email, scopes) is on the same record: {@link GoogleSessionSchema}. */
export const GoogleBrokerEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  clientId: z.string().default(''),
  clientSecret: z.string().default('').meta({ secret: true }),
  /**
   * @deprecated Per-broker filter; the calendars an account imports are `calendars` records
   * (Connectivity → Calendars). Kept for migrate only.
   */
  calendarFilter: z.string().default(''),
  /** Default From for Gmail send — usually the connected account email. */
  fromAddress: z.string().default(''),
  fromName: z.string().default(''),
})
export type GoogleBrokerEntry = z.infer<typeof GoogleBrokerEntrySchema>

/**
 * The addon keeps no addon-level settings: every account is a `brokers` record, its OAuth session
 * included.
 */
export const GoogleServicesConfigSchema = z.object({})
export type GoogleServicesConfig = z.infer<typeof GoogleServicesConfigSchema>

export const DEFAULT_GOOGLE_CONFIG: GoogleServicesConfig = GoogleServicesConfigSchema.parse({})

export interface GoogleOauthState {
  refreshToken: string
  accessToken: string
  /** Epoch ms when accessToken expires. */
  accessExpiresAt: number
  /** Google account email when known. */
  accountEmail: string
}

export const DEFAULT_OAUTH_STATE: GoogleOauthState = {
  refreshToken: '',
  accessToken: '',
  accessExpiresAt: 0,
  accountEmail: '',
}

/**
 * The OAuth session an account carries ON its `brokers` record (planning#480): the refresh token
 * is a secret field (a keychain marker in the row), the email and the granted scopes are plain.
 */
export const GoogleSessionSchema = z.object({
  refreshToken: z.string().default('').meta({ secret: true }),
  accountEmail: z.string().default(''),
  /** Space-separated scopes Google granted, as its token answer said; '' when unknown. */
  scopes: z.string().default(''),
  /**
   * Google refused the refresh token (`invalid_grant`): it is dead and only a
   * new sign-in replaces it. Set where the refusal is seen, cleared by the
   * OAuth callback that stores a fresh token — so the status, the Sign-in
   * button and the alert all read the same fact.
   */
  needsReauth: z.boolean().default(false),
})
export type GoogleSession = z.infer<typeof GoogleSessionSchema>

/**
 * One account's session at run time: the record's session plus the short-lived access token,
 * which lives in memory only (a restart costs one refresh, never a stored copy).
 */
export const GoogleOauthAccountSchema = GoogleSessionSchema.extend({
  id: z.string().min(1),
  accessToken: z.string().default('').meta({ secret: true }),
  accessExpiresAt: z.number().default(0),
})
export type GoogleOauthAccount = z.infer<typeof GoogleOauthAccountSchema>
/** What callers may hand over: defaults (`needsReauth`, `scopes`) are filled by the schema. */
export type GoogleOauthAccountInput = z.input<typeof GoogleOauthAccountSchema>

export const GOOGLE_BROKER_KIND = 'google'
export const GOOGLE_BROKER_KIND_LABEL = 'Google'

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
export const GOOGLE_GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
/** Needed for account email on Connect / Test (userinfo). */
export const GOOGLE_USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email'
/** Space-separated scopes on Connect (Calendar + Gmail + email). */
export const GOOGLE_OAUTH_SCOPES = `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_GMAIL_SEND_SCOPE} ${GOOGLE_USERINFO_EMAIL_SCOPE}`
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'
export const GOOGLE_GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
/** Lightweight Calendar probe for Test — works with calendar.readonly alone. */
export const GOOGLE_CALENDAR_LIST_URL = `${GOOGLE_CALENDAR_API}/users/me/calendarList?maxResults=1`

export const OAUTH_START_PATH = `/addon/google-services/oauth/start`
export const OAUTH_CALLBACK_SUFFIX = `/addon/google-services/oauth/callback`

/** Build Connect start URL; `brokerId` is required at runtime. Placeholder
 *  `{{brokerId}}` is filled by BrokerForm on the edit dialog. */
export function oauthStartPathForBroker(brokerId: string): string {
  return `${OAUTH_START_PATH}?brokerId=${encodeURIComponent(brokerId)}`
}
