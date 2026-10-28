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
 * spins a local reverse-proxy to Amazon's login page on `127.0.0.1:proxyPort`; the
 * operator never reaches it directly — the hub's login proxy (D955) opens it at
 * `/addon/import-alexa/vendor-login/…` under the hub's own HTTPS origin. The port only has to
 * be free on the hub's loopback.
 */
export const alexaProxyLoginSchema = z.object({
  proxyPort: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(1).max(65535).default(3456),
    )
    .describe('Loopback port the local Amazon-login proxy listens on (never exposed)'),
})
export type AlexaProxyLogin = z.infer<typeof alexaProxyLoginSchema>

/**
 * The Echo notification targets this addon owns. Speech signs in as an import
 * broker, so a target is only the Echo it speaks on and how.
 */
export const alexaEchoTargetSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** The broker (Amazon account) the Echo belongs to; '' until one is chosen. */
  brokerId: z.string().default(''),
  echoId: z.string(),
  mode: z.enum(['speak', 'announce']),
  volume: z.number(),
  respectDnd: z.boolean(),
})
export type AlexaEchoTarget = z.infer<typeof alexaEchoTargetSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stored Echo targets; a row that no longer parses is dropped, never guessed. */
export function readEchoTargets(config: { echoTargets?: unknown }): readonly AlexaEchoTarget[] {
  const raw = config.echoTargets
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row) => {
    const parsed = alexaEchoTargetSchema.safeParse(isRecord(row) ? row : {})
    return parsed.success ? [parsed.data] : []
  })
}

/** Top-level addon config — broker entries + the proxy-login settings. */
export const alexaAddonConfigSchema = z.object({
  brokers: z.array(AlexaBrokerEntrySchema).default([]),
  proxyLogin: alexaProxyLoginSchema.default({ proxyPort: 3456 }),
  echoTargets: z.array(alexaEchoTargetSchema).default([]),
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

/**
 * Allowlist of real Amazon regional domains that alexa-remote2 is known to
 * support. An enum (not a free-form string) keeps the value from ever naming an
 * arbitrary host: alexa-remote2 uses it as a raw domain suffix.
 */
export const AMAZON_DOMAINS = [
  'amazon.com',
  'amazon.it',
  'amazon.de',
  'amazon.co.uk',
  'amazon.fr',
  'amazon.es',
  'amazon.ca',
  'amazon.com.au',
  'amazon.co.jp',
  'amazon.in',
  'amazon.com.br',
  'amazon.com.mx',
] as const

export type AmazonDomain = (typeof AMAZON_DOMAINS)[number]

/** The country each domain serves; the first match for a country prefills the form. */
const AMAZON_DOMAIN_BY_COUNTRY: Readonly<Record<string, AmazonDomain>> = {
  US: 'amazon.com',
  IT: 'amazon.it',
  DE: 'amazon.de',
  AT: 'amazon.de',
  GB: 'amazon.co.uk',
  FR: 'amazon.fr',
  ES: 'amazon.es',
  CA: 'amazon.ca',
  AU: 'amazon.com.au',
  JP: 'amazon.co.jp',
  IN: 'amazon.in',
  BR: 'amazon.com.br',
  MX: 'amazon.com.mx',
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
          'Sign in with your Amazon account to link it. This is an unofficial integration: Amazon can change or break it without notice, and it may violate Amazon ToS. State is polled, not pushed.',
        descriptionKey: 'import-alexa:connection.s_alexa-account.description',
        columns: 1,
        fields: [
          {
            type: 'select',
            key: 'amazonDomain',
            label: 'Amazon domain (region)',
            labelKey: 'import-alexa:connection.s_alexa-account.amazonDomain.label',
            options: AMAZON_DOMAINS.map((value) => ({ value, label: value })),
            default: 'amazon.com',
            defaultByCountry: AMAZON_DOMAIN_BY_COUNTRY,
          },
          {
            type: 'password',
            key: 'cookie',
            label: 'Cookie blob (filled by the sign-in)',
            labelKey: 'import-alexa:connection.s_alexa-account.cookie.label',
            showToggle: true,
            filledBySignIn: true,
          },
          {
            type: 'password',
            key: 'refreshToken',
            label: 'Refresh token (alternative to the sign-in)',
            labelKey: 'import-alexa:connection.s_alexa-account.refreshToken.label',
            showToggle: true,
            filledBySignIn: true,
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
