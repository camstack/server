import { z } from 'zod'
import {
  type ConfigUISchema,
  isSecretMarker,
  isSecretMarkerLike,
  type IScopedLogger,
} from '@camstack/types'

export const HOME_CONNECT_MODES = ['AES', 'TLS'] as const
export const HomeConnectModeSchema = z.enum(HOME_CONNECT_MODES)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parsed DeviceDescription blob — stored as JSON (`valueType: json`) or legacy string. */
export type HomeConnectDeviceDescription = string | Record<string, unknown>

const homeConnectDeviceDescriptionSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .optional()

/** One appliance's local socket. Not stored on the integration — fetched with the account token. */
export const homeConnectGatewaySchema = z.object({
  host: z.string().min(1),
  psk: z.string().min(1).meta({ secret: true }),
  mode: HomeConnectModeSchema.default('AES'),
  iv64: z.string().optional(),
  deviceDescription: homeConnectDeviceDescriptionSchema,
})

export type HomeConnectGatewayConfig = z.infer<typeof homeConnectGatewaySchema>

/** Setting key of the keychain-stored credentials of every paired appliance. */
export const APPLIANCE_SECRETS_KEY = 'applianceSecrets'

/**
 * The integration-settings keys that hold a credential — what a write from this addon names
 * as `secretKeys` so the hub moves them into the keychain.
 */
export const HOME_CONNECT_SECRET_KEYS: readonly string[] = [
  'token',
  'refresh',
  APPLIANCE_SECRETS_KEY,
]

/** One appliance as persisted in the integration's `appliances` setting: no credential on it. */
export const homeConnectApplianceRowSchema = z.object({
  haId: z.string().min(1),
  name: z.string(),
  type: z.string(),
  host: z.string().min(1),
  mode: HomeConnectModeSchema,
  deviceDescription: homeConnectDeviceDescriptionSchema,
})

export type HomeConnectApplianceRow = z.infer<typeof homeConnectApplianceRowSchema>

/**
 * A row as it may still be found on disk: before the keychain move the pairing key
 * (`psk`) and the AES iv (`iv64`) sat on the row, in a JSON textarea, in the clear.
 * Read once, adopted into the keychain, then never written again.
 */
const legacyApplianceRowSchema = homeConnectApplianceRowSchema.extend({
  psk: z.string().optional(),
  iv64: z.string().optional(),
})

/** What the keychain holds per appliance. */
export const homeConnectApplianceSecretSchema = z.object({
  psk: z.string().min(1),
  iv64: z.string().optional(),
})
export type HomeConnectApplianceSecret = z.infer<typeof homeConnectApplianceSecretSchema>

/** `applianceSecrets`: one string in the keychain, JSON of `haId -> { psk, iv64? }`. */
export const homeConnectApplianceSecretsSchema = z.record(
  z.string(),
  homeConnectApplianceSecretSchema,
)
export type HomeConnectApplianceSecrets = z.infer<typeof homeConnectApplianceSecretsSchema>

/** One appliance in memory: its row and its credential together. */
export const homeConnectStoredApplianceSchema = homeConnectApplianceRowSchema.extend({
  psk: z.string().min(1),
  iv64: z.string().optional(),
})

export type HomeConnectStoredAppliance = z.infer<typeof homeConnectStoredApplianceSchema>

/** The integration is the Home Connect account. Profiles are downloaded once at sign-in. */
export const homeConnectConfigSchema = z.object({
  token: z.string().min(1).describe('Home Connect access token').meta({ secret: true }),
  refresh: z.string().optional().describe('Home Connect refresh token').meta({ secret: true }),
  appliances: z.array(homeConnectStoredApplianceSchema).optional(),
  /** Shown on the sign-in field. The JWT subject, not a credential. */
  accountLabel: z.string().optional(),
})

export type HomeConnectConfig = z.infer<typeof homeConnectConfigSchema>

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}

function legacyRowsOf(raw: unknown): readonly z.infer<typeof legacyApplianceRowSchema>[] {
  const value = parseJsonValue(raw)
  if (!Array.isArray(value)) return []
  const rows: z.infer<typeof legacyApplianceRowSchema>[] = []
  for (const item of value) {
    const parsed = legacyApplianceRowSchema.safeParse(item)
    if (parsed.success) rows.push(parsed.data)
  }
  return rows
}

/** `unresolved` = the keychain holds it but cannot serve it right now: stored, not absent. */
export type ApplianceSecretsRead =
  | { readonly kind: 'secrets'; readonly secrets: HomeConnectApplianceSecrets }
  | { readonly kind: 'unresolved' }
  /** Present but not the JSON map this addon writes: unknown, never "empty". */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'none' }

export function readApplianceSecrets(raw: unknown): ApplianceSecretsRead {
  if (isSecretMarker(raw) || isSecretMarkerLike(raw)) return { kind: 'unresolved' }
  const value = parseJsonValue(raw)
  if (value === undefined || value === null) return { kind: 'none' }
  const parsed = homeConnectApplianceSecretsSchema.safeParse(value)
  return parsed.success ? { kind: 'secrets', secrets: parsed.data } : { kind: 'invalid' }
}

/** Rows plus credentials -> the in-memory appliances. A row with no credential cannot be spoken to and is left out. */
export function mergeApplianceSecrets(
  rows: readonly z.infer<typeof legacyApplianceRowSchema>[],
  secrets: HomeConnectApplianceSecrets,
): readonly HomeConnectStoredAppliance[] {
  const out: HomeConnectStoredAppliance[] = []
  for (const { psk: inlinePsk, iv64: inlineIv, ...row } of rows) {
    const keyed = secrets[row.haId]
    const psk = inlinePsk !== undefined && inlinePsk.length > 0 ? inlinePsk : keyed?.psk
    if (psk === undefined) continue
    const iv64 = inlineIv !== undefined && inlineIv.length > 0 ? inlineIv : keyed?.iv64
    out.push({ ...row, psk, ...(iv64 !== undefined ? { iv64 } : {}) })
  }
  return out
}

/** In-memory appliances -> the credential-free rows and the secrets map to put in the keychain. */
export function splitApplianceSecrets(
  appliances: readonly (HomeConnectApplianceRow & {
    readonly psk?: string
    readonly iv64?: string
  })[],
): {
  readonly rows: readonly HomeConnectApplianceRow[]
  readonly secrets: HomeConnectApplianceSecrets
} {
  const rows: HomeConnectApplianceRow[] = []
  const secrets: Record<string, HomeConnectApplianceSecret> = {}
  for (const { psk, iv64, ...row } of appliances) {
    rows.push(row)
    if (psk !== undefined && psk.length > 0) {
      secrets[row.haId] = {
        psk,
        ...(iv64 !== undefined && iv64.length > 0 ? { iv64 } : {}),
      }
    }
  }
  return { rows, secrets }
}

/**
 * Before `integrations.setSettings`: keep objects as-is (serializes as `json`), parse
 * textarea JSON strings into objects so they are not re-serialized as `string` and
 * corrupted on read by `deserializeSetting(String(object))` — and move any credential
 * still sitting on an appliance row into `applianceSecrets`, so a row is never written
 * with a pairing key on it.
 */
export function homeConnectSettingsForPersist(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...settings }
  delete next['accountEmail']
  delete next['accountPassword']
  delete next['authorizeUrl']
  delete next['verifier']
  delete next['callback']
  delete next['state']
  if (next['refresh'] === '') delete next['refresh']
  const appliancesRaw = next['appliances']
  if (typeof appliancesRaw === 'string' && appliancesRaw.trim().startsWith('[')) {
    try {
      const parsedAppliances: unknown = JSON.parse(appliancesRaw)
      if (Array.isArray(parsedAppliances)) next['appliances'] = parsedAppliances
    } catch {
      // Leave the string; schema validation reports it.
    }
  }
  Object.assign(next, moveInlineSecrets(next))
  const raw = next['deviceDescription']
  if (typeof raw !== 'string') return next
  const trimmed = raw.trim()
  if (trimmed.length === 0) return next
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return next
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isPlainObject(parsed)) {
      return { ...next, deviceDescription: parsed }
    }
  } catch {
    return next
  }
  return next
}

/**
 * The `appliances` / `applianceSecrets` pair with every inline credential moved into the
 * secrets map. An empty object when no row carries one (nothing to move). When the stored
 * secrets are unresolved the map is not rewritten: an addon cannot see what it would replace.
 */
function moveInlineSecrets(settings: Record<string, unknown>): Record<string, unknown> {
  const rows = legacyRowsOf(settings['appliances'])
  const inline = rows.filter((r) => (r.psk ?? '').length > 0 || (r.iv64 ?? '').length > 0)
  if (inline.length === 0) return {}
  const existing = readApplianceSecrets(settings[APPLIANCE_SECRETS_KEY])
  // Locked or unreadable stored secrets: merging over them would overwrite what we cannot see.
  if (existing.kind === 'unresolved' || existing.kind === 'invalid') return {}
  const { rows: stripped, secrets: moved } = splitApplianceSecrets(rows)
  const merged = {
    ...(existing.kind === 'secrets' ? existing.secrets : {}),
    ...moved,
  }
  return {
    appliances: stripped,
    ...(Object.keys(merged).length > 0 ? { [APPLIANCE_SECRETS_KEY]: JSON.stringify(merged) } : {}),
  }
}

/**
 * One-time adopt: the settings that must be written so a pairing key found on an appliance
 * row moves into the keychain. `null` when nothing needs moving. The caller writes it with
 * {@link HOME_CONNECT_SECRET_KEYS} as `secretKeys`.
 */
export function legacyApplianceSecretPatch(settings: Record<string, unknown>): {
  readonly appliances: readonly HomeConnectApplianceRow[]
  readonly applianceSecrets: string
} | null {
  const moved = moveInlineSecrets({
    ...settings,
    appliances: parseJsonValue(settings['appliances']),
  })
  const rows = moved['appliances']
  const secrets = moved[APPLIANCE_SECRETS_KEY]
  if (!Array.isArray(rows) || typeof secrets !== 'string') return null
  const parsedRows: HomeConnectApplianceRow[] = []
  for (const row of rows) {
    const parsed = homeConnectApplianceRowSchema.safeParse(row)
    if (parsed.success) parsedRows.push(parsed.data)
  }
  return { appliances: parsedRows, applianceSecrets: secrets }
}

export function connectionFromSettings(
  settings: Record<string, unknown>,
): HomeConnectConfig | null {
  const normalized = homeConnectSettingsForPersist(settings)
  const rows = legacyRowsOf(normalized['appliances'])
  const secrets = readApplianceSecrets(normalized[APPLIANCE_SECRETS_KEY])
  const withoutAppliances = { ...normalized }
  delete withoutAppliances['appliances']
  delete withoutAppliances[APPLIANCE_SECRETS_KEY]
  const appliances =
    rows.length > 0
      ? mergeApplianceSecrets(rows, secrets.kind === 'secrets' ? secrets.secrets : {})
      : undefined
  const parsed = homeConnectConfigSchema.safeParse({
    ...withoutAppliances,
    ...(appliances !== undefined ? { appliances: [...appliances] } : {}),
  })
  return parsed.success ? parsed.data : null
}

/** haIds of appliances on the account that have no usable credential (keychain locked, or never stored). */
export function appliancesWithoutCredential(settings: Record<string, unknown>): readonly string[] {
  const normalized = homeConnectSettingsForPersist(settings)
  const rows = legacyRowsOf(normalized['appliances'])
  const secrets = readApplianceSecrets(normalized[APPLIANCE_SECRETS_KEY])
  const have = new Set(
    mergeApplianceSecrets(rows, secrets.kind === 'secrets' ? secrets.secrets : {}).map(
      (a) => a.haId,
    ),
  )
  return rows.filter((r) => !have.has(r.haId)).map((r) => r.haId)
}

export type HomeConnectSettingsGapReason =
  | 'token-missing'
  | 'token-unresolved-marker'
  | 'appliance-secrets-unresolved'
  | 'schema-invalid'

function hasNonEmptyString(settings: Record<string, unknown>, key: string): boolean {
  const value = settings[key]
  return typeof value === 'string' && value.trim().length > 0
}

/** Why reconcile cannot build a connection; null when `connectionFromSettings` would succeed. */
export function homeConnectSettingsGap(
  settings: Record<string, unknown>,
): HomeConnectSettingsGapReason | null {
  if (connectionFromSettings(settings) !== null) return null

  const token = settings['token']
  if (isSecretMarker(token) || isSecretMarkerLike(token)) return 'token-unresolved-marker'
  if (!hasNonEmptyString(settings, 'token')) return 'token-missing'

  return 'schema-invalid'
}

/** Reconcile path: warn once per incomplete integration (never logs secret values). */
export function logHomeConnectSettingsGap(
  logger: Pick<IScopedLogger, 'warn'>,
  integrationId: string,
  settings: Record<string, unknown>,
): void {
  const gap = homeConnectSettingsGap(settings)
  if (gap === null) return

  const token = settings['token']
  logger.warn('Home Connect integration has incomplete account settings — skipping', {
    meta: {
      integrationId,
      gap,
      tokenIsSecretMarker: isSecretMarker(token),
      tokenType: typeof token,
      hasToken: hasNonEmptyString(settings, 'token'),
      hasRefresh: hasNonEmptyString(settings, 'refresh'),
    },
  })
}

export function sameHomeConnectConnection(
  a: HomeConnectConfig | null,
  b: HomeConnectConfig | null,
): boolean {
  if (a === null || b === null) return false
  return (
    a.token === b.token &&
    (a.refresh ?? '') === (b.refresh ?? '') &&
    JSON.stringify(a.appliances ?? []) === JSON.stringify(b.appliances ?? [])
  )
}

/** Sentinel so the gateway fields stay filled by sign-in and stay off the form. */
export const HOME_CONNECT_PAIRED_ONLY = '__paired_only__'

export function buildHomeConnectFormSchema(): ConfigUISchema {
  const pairedOnly = {
    field: '__hidden__',
    equals: HOME_CONNECT_PAIRED_ONLY,
  } as const
  return {
    sections: [
      {
        id: 'gateway',
        title: 'Home Connect',
        titleKey: 'provider-bosch:home-connect.s_gateway.title',
        description:
          'Sign in with your Home Connect account. Paste the address the browser stops on (hcauth://auth/prod?code=…).',
        descriptionKey: 'provider-bosch:home-connect.s_gateway.description',
        columns: 1,
        fields: [
          {
            type: 'account-sign-in',
            addonId: 'bosch-home-connect',
            key: '__home-connect-sign-in',
            label: 'Home Connect',
            labelKey: 'provider-bosch:home-connect.s_gateway.__home-connect-sign-in.label',
            providerLabel: 'Home Connect',
            beginAction: 'beginSignIn',
            completeAction: 'finishSignIn',
            signOutAction: 'signOut',
            accountKey: 'accountLabel',
            countFromKey: 'appliances',
            countNoun: 'appliance',
            pastePlaceholder: 'hcauth://auth/prod?code=…&state=…',
            secretKeys: ['token', 'refresh', APPLIANCE_SECRETS_KEY],
            assignResult: {
              token: 'token',
              refresh: 'refresh',
              accountLabel: 'accountLabel',
              appliances: 'appliances',
              [APPLIANCE_SECRETS_KEY]: APPLIANCE_SECRETS_KEY,
            },
          },
          {
            type: 'text',
            key: 'accountLabel',
            label: 'Account',
            labelKey: 'provider-bosch:home-connect.s_gateway.accountLabel.label',
            required: false,
            showWhen: pairedOnly,
          },
          {
            type: 'textarea',
            key: 'appliances',
            label: 'Appliances',
            labelKey: 'provider-bosch:home-connect.s_gateway.appliances.label',
            required: false,
            showWhen: pairedOnly,
          },
          {
            type: 'password',
            key: APPLIANCE_SECRETS_KEY,
            label: 'Appliance keys',
            required: false,
            showWhen: pairedOnly,
          },
          {
            type: 'group',
            key: '__home-connect-advanced',
            label: 'Advanced',
            labelKey: 'provider-bosch:home-connect.s_gateway.__home-connect-advanced.label',
            style: 'accordion',
            defaultCollapsed: true,
            fields: [
              {
                type: 'password',
                key: 'token',
                label: 'Access token',
                labelKey: 'provider-bosch:home-connect.s_gateway.token.label',
                required: false,
                showToggle: false,
              },
              {
                type: 'password',
                key: 'refresh',
                label: 'Refresh token',
                labelKey: 'provider-bosch:home-connect.s_gateway.refresh.label',
                required: false,
                showToggle: false,
              },
            ],
          },
        ],
      },
    ],
  }
}

/** WebSocket URL for local Home Connect (plain WS on port 80 path /homeconnect). */
export function homeConnectWsUrl(config: HomeConnectGatewayConfig): string {
  const scheme = config.mode === 'TLS' ? 'wss' : 'ws'
  const host = config.host.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `${scheme}://${host}/homeconnect`
}

/**
 * The `appliances` rows to write back after the connection learned something (an IDDF): every
 * stored row stays — a row with no credential is still a paired appliance — and a row the
 * connection knows is replaced by its fresher version.
 */
export function mergeAppliancesForPersist(
  storedAppliances: unknown,
  fromConnection: readonly HomeConnectStoredAppliance[],
): readonly Record<string, unknown>[] {
  const stored = legacyRowsOf(storedAppliances)
  const known = new Map(fromConnection.map((a) => [a.haId, a]))
  const out: Record<string, unknown>[] = stored.map((row) => ({
    ...(known.get(row.haId) ?? row),
  }))
  for (const fresh of fromConnection) {
    if (!stored.some((r) => r.haId === fresh.haId)) out.push({ ...fresh })
  }
  return out
}
