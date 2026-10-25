/**
 * Google broker registry — N Google accounts under kind `google`.
 * No live WS; "connected" means a refresh token exists for the broker id.
 */
import type { BrokerInfo } from '@camstack/types'
import { z } from 'zod'
import {
  GOOGLE_BROKER_KIND,
  GoogleBrokerEntrySchema,
  LegacyGoogleFlatConfigSchema,
  type GoogleBrokerEntry,
  type GoogleOauthAccount,
  type GoogleOauthAccountInput,
  GoogleOauthAccountSchema,
  type GoogleOauthState,
  type GoogleServicesConfig,
} from './google-types.js'

interface LegacyFlatSlice {
  readonly clientId?: string
  readonly clientSecret?: string
  readonly calendarFilter?: string
  readonly fromAddress?: string
  readonly fromName?: string
  readonly brokers?: readonly GoogleBrokerEntry[]
}

const GoogleAddSettingsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).meta({ secret: true }),
  /** Selected Google calendar ids; empty = import all. */
  calendarIds: z.array(z.string()).optional(),
  /** @deprecated Prefer calendarIds — still accepted on save. */
  calendarFilter: z.string().optional(),
  fromAddress: z.string().optional(),
  fromName: z.string().optional(),
})

export type GoogleAddSettings = z.infer<typeof GoogleAddSettingsSchema>

/** Persist UI calendarIds (or legacy filter string) as comma-separated filter. */
export function calendarIdsToFilter(settings: {
  readonly calendarIds?: readonly string[]
  readonly calendarFilter?: string
}): string {
  if (settings.calendarIds !== undefined) {
    return settings.calendarIds
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(',')
  }
  return settings.calendarFilter ?? ''
}

export function settingsToBrokerFields(settings: unknown): Omit<GoogleBrokerEntry, 'id' | 'name'> {
  const parsed = GoogleAddSettingsSchema.parse(settings)
  return {
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
    calendarFilter: calendarIdsToFilter(parsed),
    fromAddress: parsed.fromAddress ?? '',
    fromName: parsed.fromName ?? '',
  }
}

export function brokerEntryToSettings(entry: GoogleBrokerEntry): Record<string, unknown> {
  return {
    clientId: entry.clientId,
    clientSecret: entry.clientSecret,
    calendarIds: [...parseCalendarFilter(entry.calendarFilter)],
    fromAddress: entry.fromAddress,
    fromName: entry.fromName,
  }
}

export interface MigrateLegacyResult {
  readonly brokers: readonly GoogleBrokerEntry[]
  readonly oauthAccounts: readonly GoogleOauthAccount[]
  readonly didMigrate: boolean
}

/**
 * One-shot: flat singleton config + legacy `oauth` state → `google_001`.
 * Idempotent when `brokers` already present.
 */
export function migrateLegacyToBrokers(
  rawConfig: unknown,
  legacyOauth: GoogleOauthState | null,
): MigrateLegacyResult {
  const loose = LegacyGoogleFlatConfigSchema.safeParse(rawConfig)
  const flat: LegacyFlatSlice = loose.success ? loose.data : {}
  const existingBrokers = flat.brokers ?? []
  if (existingBrokers.length > 0) {
    return {
      brokers: existingBrokers.map((b) => GoogleBrokerEntrySchema.parse(b)),
      oauthAccounts: [],
      didMigrate: false,
    }
  }

  const hasClient = (flat.clientId ?? '').length > 0 || (flat.clientSecret ?? '').length > 0
  const hasOauth = legacyOauth !== null && legacyOauth.refreshToken.length > 0
  if (!hasClient && !hasOauth) {
    return { brokers: [], oauthAccounts: [], didMigrate: false }
  }

  const id = 'google_001'
  const email = legacyOauth?.accountEmail?.trim() ?? ''
  const name = email.length > 0 ? email : 'Google account'
  const entry: GoogleBrokerEntry = GoogleBrokerEntrySchema.parse({
    id,
    name,
    clientId: flat.clientId ?? '',
    clientSecret: flat.clientSecret ?? '',
    calendarFilter: flat.calendarFilter ?? '',
    fromAddress: flat.fromAddress ?? '',
    fromName: flat.fromName ?? '',
  })

  const oauthAccounts: GoogleOauthAccount[] =
    legacyOauth !== null &&
    (legacyOauth.refreshToken.length > 0 || legacyOauth.accessToken.length > 0)
      ? [
          {
            id,
            refreshToken: legacyOauth.refreshToken,
            accessToken: legacyOauth.accessToken,
            accessExpiresAt: legacyOauth.accessExpiresAt,
            accountEmail: legacyOauth.accountEmail,
            needsReauth: false,
          },
        ]
      : []

  return { brokers: [entry], oauthAccounts, didMigrate: true }
}

export function parseCalendarFilter(raw: string): Set<string> {
  const trimmed = raw.trim()
  if (!trimmed) return new Set()
  return new Set(
    trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
}

/** Local calendar id stamped as `brokerId:googleCalendarId`. */
export function stampCalendarId(brokerId: string, googleCalendarId: string): string {
  return `${brokerId}:${googleCalendarId}`
}

export function parseStampedCalendarId(
  stamped: string,
): { brokerId: string; googleCalendarId: string } | null {
  const idx = stamped.indexOf(':')
  if (idx <= 0 || idx === stamped.length - 1) return null
  return {
    brokerId: stamped.slice(0, idx),
    googleCalendarId: stamped.slice(idx + 1),
  }
}

/**
 * In-memory index over broker entries + oauth accounts. The addon owns
 * persistence; this class only allocates ids and builds BrokerInfo rows.
 */
export class GoogleBrokerRegistry {
  private nextIdCounter = 1
  private entries: GoogleBrokerEntry[] = []
  private oauthById = new Map<string, GoogleOauthAccount>()

  seedFrom(
    entries: readonly GoogleBrokerEntry[],
    accounts: readonly GoogleOauthAccountInput[],
  ): void {
    this.entries = entries.map((e) => GoogleBrokerEntrySchema.parse(e))
    this.oauthById = new Map(
      accounts.map((a) => {
        const account = GoogleOauthAccountSchema.parse(a)
        return [account.id, account]
      }),
    )
    this.seedCounterFromEntries(this.entries)
  }

  listEntries(): readonly GoogleBrokerEntry[] {
    return this.entries
  }

  getEntry(id: string): GoogleBrokerEntry | null {
    return this.entries.find((e) => e.id === id) ?? null
  }

  getOauth(id: string): GoogleOauthAccount | null {
    return this.oauthById.get(id) ?? null
  }

  listOauthAccounts(): readonly GoogleOauthAccount[] {
    return [...this.oauthById.values()]
  }

  setOauth(account: GoogleOauthAccountInput): void {
    const parsed: GoogleOauthAccount = GoogleOauthAccountSchema.parse(account)
    this.oauthById.set(parsed.id, parsed)
  }

  removeOauth(id: string): void {
    this.oauthById.delete(id)
  }

  isConnected(id: string): boolean {
    const o = this.oauthById.get(id)
    return o !== undefined && o.refreshToken.length > 0 && !o.needsReauth
  }

  /** A refresh token Google refused: kept (a sign-in replaces it) but not usable. */
  needsReauth(id: string): boolean {
    return this.oauthById.get(id)?.needsReauth === true
  }

  markNeedsReauth(id: string): boolean {
    const o = this.oauthById.get(id)
    if (o === undefined || o.needsReauth) return false
    this.oauthById.set(id, { ...o, needsReauth: true })
    return true
  }

  allocateId(): string {
    const id = `google_${String(this.nextIdCounter).padStart(3, '0')}`
    this.nextIdCounter += 1
    return id
  }

  adoptId(id: string): string {
    if (this.entries.some((e) => e.id === id)) {
      throw new Error(
        `broker id "${id}" is already in use — adopt an id only to restore a broker that is gone`,
      )
    }
    const match = id.match(/^google_(\d+)$/)
    if (match?.[1] !== undefined) {
      this.nextIdCounter = Math.max(this.nextIdCounter, Number.parseInt(match[1], 10) + 1)
    }
    return id
  }

  createEntry(
    name: string,
    settings: unknown,
    opts: { readonly id?: string } = {},
  ): GoogleBrokerEntry {
    const fields = settingsToBrokerFields(settings)
    const id = opts.id !== undefined ? this.adoptId(opts.id) : this.allocateId()
    const entry = GoogleBrokerEntrySchema.parse({ id, name, ...fields })
    this.entries = [...this.entries, entry]
    return entry
  }

  updateEntry(id: string, settings: unknown): GoogleBrokerEntry | null {
    const idx = this.entries.findIndex((e) => e.id === id)
    if (idx < 0) return null
    const prev = this.entries[idx]!
    const fields = settingsToBrokerFields(settings)
    const next = GoogleBrokerEntrySchema.parse({
      id: prev.id,
      name: prev.name,
      ...fields,
    })
    this.entries = this.entries.map((e, i) => (i === idx ? next : e))
    return next
  }

  removeEntry(id: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    this.oauthById.delete(id)
    return this.entries.length < before
  }

  replaceEntries(entries: readonly GoogleBrokerEntry[]): void {
    this.entries = entries.map((e) => GoogleBrokerEntrySchema.parse(e))
    this.seedCounterFromEntries(this.entries)
  }

  toBrokerInfo(entry: GoogleBrokerEntry, addonId: string): BrokerInfo {
    const oauth = this.oauthById.get(entry.id)
    const connected = this.isConnected(entry.id)
    const reauth = this.needsReauth(entry.id)
    return {
      id: entry.id,
      addonId,
      name: entry.name,
      kind: GOOGLE_BROKER_KIND,
      status: connected ? 'connected' : reauth ? 'auth-failed' : 'disconnected',
      info: {
        accountEmail: oauth?.accountEmail ?? '',
        hasClient: entry.clientId.length > 0,
      },
      lastCheckedAt: connected ? Date.now() : null,
      error: connected
        ? null
        : reauth
          ? 'Google session expired — sign in again'
          : entry.clientId.length === 0
            ? 'Configure Client ID / secret, then Connect Google'
            : 'Not connected — open Connect Google on this broker',
    }
  }

  listBrokerInfos(addonId: string, kind?: string): BrokerInfo[] {
    if (kind !== undefined && kind !== GOOGLE_BROKER_KIND) return []
    return this.entries.map((e) => this.toBrokerInfo(e, addonId))
  }

  size(): number {
    return this.entries.length
  }

  connectedSize(): number {
    return this.entries.filter((e) => this.isConnected(e.id)).length
  }

  toConfig(calendarIds: readonly string[] = []): GoogleServicesConfig {
    return { brokers: [...this.entries], calendarIds: [...calendarIds] }
  }

  private seedCounterFromEntries(entries: readonly GoogleBrokerEntry[]): void {
    let maxSeen = 0
    for (const e of entries) {
      const match = e.id.match(/^google_(\d+)$/)
      if (match?.[1] !== undefined) {
        maxSeen = Math.max(maxSeen, Number.parseInt(match[1], 10))
      }
    }
    this.nextIdCounter = maxSeen + 1
  }
}
