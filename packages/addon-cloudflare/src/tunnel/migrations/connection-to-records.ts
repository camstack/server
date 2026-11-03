/**
 * The Cloudflare tunnel settings move from the addon's settings into the `tunnels` record
 * (D985, D996), and where the tunnel forwards to becomes a fact of the node (D986). Three
 * migrations of the catalogue, each idempotent, in this order:
 *
 *  1. `moveConnectionToRecord` (procedure): the record is created, the old secrets are read BACK
 *     from it, and only then cleared. Nothing is written before the old settings are read in
 *     full (a secret that cannot be resolved aborts the pass); an existing record is never
 *     overwritten.
 *  2. `planDropMovedSettings` (plan): the moved keys are deleted from the canonical
 *     `addon-settings` rows, and only once the record is confirmed to hold what they carried.
 *  3. `planLocalOriginToNode` (plan): `localHost`, `localPortMode` and `localPort` are COPIED to
 *     the hub's node rows. The bare rows stay: a node row never overwrites another.
 *
 * All three are `tolerate`: the addon is the tunnel, and a blocked owner is a dead tunnel. While
 * the record does not exist the addon keeps reading the legacy keys.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import {
  CLOUDFLARE_TUNNEL_DEFAULT_BODY,
  type CloudflareTunnelBody,
  MOVED_TUNNEL_KEYS,
  NODE_ORIGIN_KEYS,
} from '../tunnel-record-kinds.js'

/** The addon id, the prefix of its rows in the canonical settings table. */
export const CLOUDFLARE_TUNNEL_ADDON_ID = 'cloudflare-tunnel'

/** The canonical `addon-settings` table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

/** The node the hub-only addon runs on: its node rows are `<key>@hub`. */
export const HUB_NODE_ID = 'hub'

const ACCOUNT_NAME = 'Cloudflare tunnel'

export type TunnelSecretKey = 'customApiToken' | 'customTunnelToken'
const SECRET_KEYS: readonly TunnelSecretKey[] = ['customApiToken', 'customTunnelToken']

/** What the migrations say about a decision they took; never carries a value. */
export interface CloudflareTunnelMigrationLog {
  warn(message: string): void
}

/** What the tunnel record holds, as far as the migrations care; the secrets resolved. */
export interface CloudflareTunnelRecordState {
  readonly hostname: string
  readonly apiToken: string
  readonly tunnelToken: string
}

export interface CloudflareTunnelMigrationPorts extends CloudflareTunnelMigrationLog {
  /** The stored settings, secrets resolved. Throws when a secret cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Put the record with `ifRev: 0`; `exists` when a record is already there. */
  putRecord(body: CloudflareTunnelBody): Promise<'created' | 'exists'>
  /** The record, secrets resolved; null when absent. Throws when it cannot be read. */
  readRecord(): Promise<CloudflareTunnelRecordState | null>
  /** Remove these old secrets (their keychain values and markers) from the addon settings. */
  clearOldSecrets(keys: readonly TunnelSecretKey[]): Promise<void>
}

function text(stored: Readonly<Record<string, unknown>>, key: string): string {
  const value = stored[key]
  return typeof value === 'string' ? value.trim() : ''
}

function flag(stored: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
  const value = stored[key]
  return typeof value === 'boolean' ? value : fallback
}

/** The record body the legacy settings describe; a missing or mistyped key takes the default. */
export function bodyFrom(stored: Readonly<Record<string, unknown>>): CloudflareTunnelBody {
  const d = CLOUDFLARE_TUNNEL_DEFAULT_BODY
  const mode = stored['mode'] === 'custom' ? 'custom' : 'quick'
  const protocol =
    stored['protocol'] === 'http2' || stored['protocol'] === 'quic' ? stored['protocol'] : 'auto'
  const apiToken = text(stored, 'customApiToken')
  const tunnelToken = text(stored, 'customTunnelToken')
  return {
    name: ACCOUNT_NAME,
    mode,
    ...(apiToken.length > 0 ? { customApiToken: apiToken } : {}),
    ...(tunnelToken.length > 0 ? { customTunnelToken: tunnelToken } : {}),
    customAccountId: text(stored, 'customAccountId'),
    customTunnelId: text(stored, 'customTunnelId'),
    customZoneId: text(stored, 'customZoneId'),
    customZoneName: text(stored, 'customZoneName'),
    customDnsRecordId: text(stored, 'customDnsRecordId'),
    customHostname: text(stored, 'customHostname') || d.customHostname,
    noTLSVerify: flag(stored, 'noTLSVerify', d.noTLSVerify),
    originServerName: text(stored, 'originServerName'),
    httpHostHeader: text(stored, 'httpHostHeader'),
    debugLogging: flag(stored, 'debugLogging', d.debugLogging),
    protocol,
  }
}

function recordSecret(state: CloudflareTunnelRecordState, key: TunnelSecretKey): string {
  return key === 'customApiToken' ? state.apiToken : state.tunnelToken
}

export async function moveConnectionToRecord(
  ports: CloudflareTunnelMigrationPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  if (!MOVED_TUNNEL_KEYS.some((key) => key in stored)) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  const put = await ports.putRecord(bodyFrom(stored))
  const legacy = SECRET_KEYS.filter((key) => text(stored, key).length > 0)
  if (legacy.length > 0) {
    // The old secret is the only copy until the record verifiably holds one: it is read back
    // first. A record this pass created must hold the SAME value; an existing record only has to
    // hold one. Anything else (and a read that throws) leaves the old copy where it is.
    const held = await ports.readRecord()
    const clearable = legacy.filter((key) => {
      const value = held === null ? '' : recordSecret(held, key)
      return put === 'created' ? value === text(stored, key) : value.length > 0
    })
    if (clearable.length > 0) await ports.clearOldSecrets(clearable)
    if (clearable.length < legacy.length) {
      ports.warn(
        'Cloudflare tunnel migration: the record does not hold every old secret; the legacy ones are kept, not cleared',
      )
    }
  }
  return put === 'created'
    ? { outcome: 'done', summary: { moved: true } }
    : { outcome: 'already-done', summary: { moved: false } }
}

export interface DropMovedSettingsPorts extends CloudflareTunnelMigrationLog {
  /** The record, secrets resolved; null when absent. Throws when it cannot be read. */
  readRecord(): Promise<CloudflareTunnelRecordState | null>
  /** The addon's stored settings as written, unparsed. */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
}

const rowId = (key: string): string => `${CLOUDFLARE_TUNNEL_ADDON_ID}.${key}`

/** Whether a stored value carries something: text, or a keychain marker (an object). */
function carries(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  return typeof value === 'object' && value !== null
}

export async function planDropMovedSettings(ports: DropMovedSettingsPorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const present = MOVED_TUNNEL_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  await confirmRecordHoldsLegacy(ports, stored)
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        // The precondition is the rows as the settings writer stores them: `{ addonId, key, value }`.
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              rowId(key),
              { addonId: CLOUDFLARE_TUNNEL_ADDON_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}

/**
 * The keys are deleted only when the record is confirmed to hold what they carried: the hostname,
 * and each token the legacy settings still have. Otherwise the migration fails, the keys stay (the
 * addon keeps reading them), and the next boot retries.
 */
async function confirmRecordHoldsLegacy(
  ports: DropMovedSettingsPorts,
  stored: Readonly<Record<string, unknown>>,
): Promise<void> {
  const refuse = (reason: string): never => {
    ports.warn(`Cloudflare tunnel migration: the legacy keys are kept: ${reason}`)
    throw new Error(`the legacy Cloudflare tunnel keys are not deleted: ${reason}`)
  }
  const record = await ports.readRecord()
  if (record === null) return refuse('no Cloudflare tunnel record exists')
  if (carries(stored['customHostname']) && record.hostname.trim().length === 0) {
    return refuse('the record holds no hostname')
  }
  if (carries(stored['customTunnelToken']) && record.tunnelToken.length === 0) {
    return refuse('the record holds no tunnel token')
  }
  if (carries(stored['customApiToken']) && record.apiToken.length === 0) {
    return refuse('the record holds no API token')
  }
}

export interface LocalOriginToNodePorts extends CloudflareTunnelMigrationLog {
  /** The addon's stored settings as written, node rows included (`<key>@<nodeId>`). */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
}

/**
 * Copy the bare origin keys to the hub's node rows. A node row that already exists is the
 * operator's (or a previous pass's) and is never touched; the bare rows are kept.
 */
export async function planLocalOriginToNode(ports: LocalOriginToNodePorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const values: Record<string, unknown> = {}
  const before: Record<string, unknown> = {}
  for (const key of NODE_ORIGIN_KEYS) {
    const scoped = `${key}@${HUB_NODE_ID}`
    if (!(key in stored) || scoped in stored) continue
    values[rowId(scoped)] = {
      addonId: CLOUDFLARE_TUNNEL_ADDON_ID,
      key: scoped,
      value: stored[key],
      nodeId: HUB_NODE_ID,
    }
    // Absent rows read as `null`: a row that appeared since the plan was read refuses the edit.
    before[rowId(scoped)] = null
  }
  if (Object.keys(values).length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'setKeys',
        scope: ADDON_SETTINGS_TABLE,
        values,
        precondition: preconditionOf(before),
      },
    ],
  }
}
