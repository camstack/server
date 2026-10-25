import { z } from 'zod'
import type { ConfigUISchema } from '@camstack/types'
import type { AlexaCredentials } from './alexa-client.js'

/**
 * Alexa account connection settings for ONE broker (= one Amazon account).
 *
 * v1 uses the unofficial alexa-remote2 cookie / refresh-token flow. The operator
 * supplies the Amazon domain/region and either a captured cookie blob or a
 * refresh token (the proxy-login UX captures one of these). State is poll-only,
 * so a configurable poll interval is included.
 */
export const alexaConnectionSchema = z.object({
  /** Amazon domain/region. */
  amazonDomain: z.string().min(1).default('amazon.com').describe('Amazon domain (region)'),
  /**
   * Captured cookie material — either a raw cookie string OR the full
   * `cookieData` JSON registration blob produced by alexa-remote2's standalone
   * proxy login (preferred: it carries the refresh token + lets the session
   * auto-refresh). This is the primary auth input.
   */
  cookie: z
    .string()
    .default('')
    .describe('Captured Alexa cookie / cookieData blob (from proxy login)')
    .meta({ secret: true }),
  /**
   * Refresh token. NOTE: a bare refresh token alone is NOT sufficient to init
   * alexa-remote2 — supply the full cookie / cookieData blob (which embeds it).
   * Retained for provenance / forward-compat.
   */
  refreshToken: z
    .string()
    .default('')
    .describe('Alexa refresh token (must be inside cookie blob)')
    .meta({ secret: true }),
  /** Device-registration secret some flows need. */
  macDms: z.string().default('').describe('macDms device-registration secret (optional)'),
  /** Poll interval for state sync (Alexa has no clean 3rd-party push). */
  pollIntervalMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(15_000).max(3_600_000).default(60_000),
    )
    .describe('State poll interval (ms) — conservative to avoid Amazon throttling'),
})

export type AlexaConnection = z.infer<typeof alexaConnectionSchema>

/** Translate a stored connection into the client's credentials shape. */
export function connectionToCredentials(conn: AlexaConnection): AlexaCredentials {
  return {
    amazonDomain: conn.amazonDomain,
    ...(conn.cookie.length > 0 ? { cookie: conn.cookie } : {}),
    ...(conn.refreshToken.length > 0 ? { refreshToken: conn.refreshToken } : {}),
    ...(conn.macDms.length > 0 ? { macDms: conn.macDms } : {}),
  }
}

/** A single registered Alexa account ("broker"). */
export const AlexaBrokerEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  connection: alexaConnectionSchema,
  integrationId: z.string().optional(),
})
export type AlexaBrokerEntry = z.infer<typeof AlexaBrokerEntrySchema>

/**
 * Interactive proxy-login settings (addon-global, not per-broker). alexa-remote2
 * spins a local reverse-proxy to Amazon's login page on `proxyHost:proxyPort`;
 * the operator opens that URL and logs in. `proxyHost` MUST be the host:port the
 * operator's browser uses (alexa-cookie2 rewrites Amazon URLs to absolute
 * `http://<proxyHost>:<proxyPort>/...`), so it is a directly-reachable host —
 * the hub's LAN IP/hostname — NOT behind the hub's HTTPS data-plane mount.
 * Empty `proxyHost` ⇒ auto-detect the host's primary non-loopback IPv4 at
 * login-start time.
 */
export const alexaProxyLoginSchema = z.object({
  proxyHost: z
    .string()
    .default('')
    .describe('Host/IP the browser uses to reach the login proxy (blank = auto-detect)'),
  proxyPort: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1).max(65535).default(3456),
    )
    .describe('Port the local Amazon-login proxy listens on (must be reachable)'),
})
export type AlexaProxyLogin = z.infer<typeof alexaProxyLoginSchema>

/** Top-level addon config — broker entries + the proxy-login settings. */
export const alexaAddonConfigSchema = z.object({
  brokers: z.array(AlexaBrokerEntrySchema).default([]),
  proxyLogin: alexaProxyLoginSchema.default({ proxyHost: '', proxyPort: 3456 }),
})
export type AlexaAddonConfig = z.infer<typeof alexaAddonConfigSchema>

/** Narrow an `unknown` to a shallow plain-object record (cast-free boundary). */
function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return {}
}

/** Coerce a loose settings blob through the connection schema, applying defaults. */
export function settingsToAlexaConnection(settings: unknown): AlexaConnection {
  return alexaConnectionSchema.parse(toRecord(settings))
}

/** Hand-written connection form for the broker/integration creation UI. */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'alexa-account',
        title: 'Amazon Alexa account',
        titleKey: 'import-alexa:connection.s_alexa-account.title',
        description:
          'Link an Amazon account via the unofficial Alexa client. Supply a captured cookie OR a refresh token. NOTE: this is an unofficial integration — Amazon can change or break it without notice, and it may violate Amazon ToS. State is polled, not pushed.',
        descriptionKey: 'import-alexa:connection.s_alexa-account.description',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'amazonDomain',
            label: 'Amazon domain (region)',
            labelKey: 'import-alexa:connection.s_alexa-account.amazonDomain.label',
            placeholder: 'amazon.com',
            default: 'amazon.com',
          },
          {
            type: 'password',
            key: 'cookie',
            label: 'Cookie blob (from proxy login)',
            labelKey: 'import-alexa:connection.s_alexa-account.cookie.label',
            showToggle: true,
          },
          {
            type: 'password',
            key: 'refreshToken',
            label: 'Refresh token (alternative to cookie)',
            labelKey: 'import-alexa:connection.s_alexa-account.refreshToken.label',
            showToggle: true,
          },
          {
            type: 'number',
            key: 'pollIntervalMs',
            label: 'State poll interval (ms)',
            labelKey: 'import-alexa:connection.s_alexa-account.pollIntervalMs.label',
            min: 15_000,
            max: 3_600_000,
            default: 60_000,
          },
        ],
      },
    ],
  }
}
