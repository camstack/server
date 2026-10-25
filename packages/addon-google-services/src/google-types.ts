import { z } from 'zod'

/** One Google account connection (broker entry). Credentials for the OAuth
 *  *app* live here; tokens live in durable oauthAccounts state keyed by id. */
export const GoogleBrokerEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  clientId: z.string().default(''),
  clientSecret: z.string().default('').meta({ secret: true }),
  /**
   * @deprecated Per-broker filter; import selection lives on addon
   * `calendarIds` (Connectivity → Calendars). Kept for migrate only.
   */
  calendarFilter: z.string().default(''),
  /** Default From for Gmail send — usually the connected account email. */
  fromAddress: z.string().default(''),
  fromName: z.string().default(''),
})
export type GoogleBrokerEntry = z.infer<typeof GoogleBrokerEntrySchema>

export const GoogleServicesConfigSchema = z.object({
  brokers: z.array(GoogleBrokerEntrySchema).default([]),
  /**
   * Stamped calendar ids (`brokerId:googleCalendarId`) to import.
   * Empty = import none. Edited under Connectivity → Calendars.
   */
  calendarIds: z.array(z.string()).default([]),
  /** @deprecated Pre-broker singleton — cleared after migrateLegacyToBrokers. */
  clientId: z.string().optional(),
  /** @deprecated Pre-broker singleton — cleared after migrateLegacyToBrokers. */
  clientSecret: z.string().optional().meta({ secret: true }),
  /** @deprecated Pre-broker singleton — cleared after migrateLegacyToBrokers. */
  calendarFilter: z.string().optional(),
  /** @deprecated Pre-broker singleton — cleared after migrateLegacyToBrokers. */
  fromAddress: z.string().optional(),
  /** @deprecated Pre-broker singleton — cleared after migrateLegacyToBrokers. */
  fromName: z.string().optional(),
})
export type GoogleServicesConfig = z.infer<typeof GoogleServicesConfigSchema>

export const DEFAULT_GOOGLE_CONFIG: GoogleServicesConfig = GoogleServicesConfigSchema.parse({})

/** Flat pre-broker config (singleton). Parsed only for one-shot migration. */
export const LegacyGoogleFlatConfigSchema = GoogleServicesConfigSchema

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

/** Per-broker OAuth tokens (durable state `oauthAccounts`). */
export const GoogleOauthAccountSchema = z.object({
  id: z.string().min(1),
  refreshToken: z.string().default('').meta({ secret: true }),
  accessToken: z.string().default('').meta({ secret: true }),
  accessExpiresAt: z.number().default(0),
  accountEmail: z.string().default(''),
  /**
   * Google refused the refresh token (`invalid_grant`): it is dead and only a
   * new sign-in replaces it. Set where the refusal is seen, cleared by the
   * OAuth callback that stores a fresh token — so the status, the Sign-in
   * button and the alert all read the same fact.
   */
  needsReauth: z.boolean().default(false),
})
export type GoogleOauthAccount = z.infer<typeof GoogleOauthAccountSchema>
/** What callers may hand over: defaults (`needsReauth`) are filled by the schema. */
export type GoogleOauthAccountInput = z.input<typeof GoogleOauthAccountSchema>

export const GoogleOauthAccountsStateSchema = z.object({
  accounts: z.array(GoogleOauthAccountSchema).default([]),
})
export type GoogleOauthAccountsState = z.infer<typeof GoogleOauthAccountsStateSchema>

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
