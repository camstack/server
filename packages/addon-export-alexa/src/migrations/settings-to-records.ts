/**
 * The Alexa export's settings move into records (D985, D996). Three migrations of the catalogue
 * after the retired-URL one, each idempotent, in this order:
 *
 *  2. `moveSettingsToSkill` (procedure): the seven skill settings become the `skills` record.
 *     An existing record is never overwritten.
 *  3. `moveLedgersToLinks` (procedure): `linkedAccounts` and `tokens` become the `skill-links`
 *     record. The record is read BACK (credentials resolved) and must equal what the old
 *     settings carried, byte for byte, BEFORE the old token credentials are cleared; any
 *     difference throws and clears nothing. An existing record is never overwritten.
 *  4. `planDropMovedSettings` (plan): the moved keys are deleted from the canonical
 *     `addon-settings` rows, and only while the records are confirmed to hold what they carried.
 *
 * All three are `tolerate`: the addon keeps reading the legacy keys until a record exists.
 */
import {
  isSecretClear,
  type MigrationPlan,
  type MigrationProcedureResult,
  preconditionOf,
} from '@camstack/types'
import {
  ALEXA_INSTANCE_ID,
  ALEXA_SKILL_DEFAULT_BODY,
  type AlexaSkillBody,
  MOVED_LEDGER_KEYS,
  MOVED_SKILL_KEYS,
  type SkillLinksBody,
} from '../skill-records.js'
import type { LinkedAccount, LwaTokenEntry } from '../types.js'

/** The canonical `addon-settings` table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

const SKILL_NAME = 'Alexa skill'
const LINKS_NAME = 'Alexa account links'

export interface AlexaMigrationLog {
  warn(message: string): void
}

export interface MoveSettingsPorts extends AlexaMigrationLog {
  /** The stored settings, secrets resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Put the `skills` record with `ifRev: 0`; `exists` when one is already there. */
  putSkill(body: AlexaSkillBody): Promise<'created' | 'exists'>
}

export interface MoveLedgersPorts extends AlexaMigrationLog {
  /** The stored settings, secrets resolved. Throws when a credential cannot be resolved. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Put the `skill-links` record with `ifRev: 0`; `exists` when one is already there. */
  putLinks(body: SkillLinksBody): Promise<'created' | 'exists'>
  /** Overwrite the existing `skill-links` record with `body`. */
  replaceLinks(body: SkillLinksBody): Promise<void>
  /** The `skill-links` record, credentials resolved; null when absent. Throws when unreadable. */
  readLinks(): Promise<SkillLinksBody | null>
  /** Remove the old token credentials (their keychain values and markers) from the settings. */
  clearOldTokenSecrets(): Promise<void>
}

export interface DropMovedSettingsPorts extends AlexaMigrationLog {
  /** The addon's stored settings as written, unparsed (markers unresolved). */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
  /** The `skills` record's presence. */
  hasSkill(): Promise<boolean>
  /** The `skill-links` record, credentials resolved; null when absent. */
  readLinks(): Promise<SkillLinksBody | null>
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
export function skillBodyFrom(stored: Readonly<Record<string, unknown>>): AlexaSkillBody {
  const d = ALEXA_SKILL_DEFAULT_BODY
  const region = stored['region']
  return {
    name: SKILL_NAME,
    skillMode: stored['skillMode'] === 'custom' ? 'custom' : 'public',
    region: region === 'EU' || region === 'FE' ? region : 'NA',
    expectedAudience: text(stored, 'expectedAudience'),
    detectionSensors: flag(stored, 'detectionSensors', d.detectionSensors),
    objectDetection: flag(stored, 'objectDetection', d.objectDetection),
    snapshots: flag(stored, 'snapshots', d.snapshots),
    enforceIngressToken: flag(stored, 'enforceIngressToken', d.enforceIngressToken),
  }
}

export async function moveSettingsToSkill(
  ports: MoveSettingsPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  if (!MOVED_SKILL_KEYS.some((key) => key in stored)) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  const put = await ports.putSkill(skillBodyFrom(stored))
  return put === 'created'
    ? { outcome: 'done', summary: { moved: true } }
    : { outcome: 'already-done', summary: { moved: false } }
}

function accountsOf(value: unknown): readonly LinkedAccount[] {
  return Array.isArray(value) ? value.filter(isLinkedAccount) : []
}

function tokensOf(value: unknown): readonly LwaTokenEntry[] {
  return Array.isArray(value) ? value.filter(isTokenEntry) : []
}

function isLinkedAccount(value: unknown): value is LinkedAccount {
  return (
    typeof value === 'object' &&
    value !== null &&
    'userId' in value &&
    typeof value.userId === 'string' &&
    'username' in value &&
    typeof value.username === 'string' &&
    'linkedAt' in value &&
    typeof value.linkedAt === 'number'
  )
}

function isTokenEntry(value: unknown): value is LwaTokenEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'userId' in value &&
    typeof value.userId === 'string' &&
    'accessToken' in value &&
    typeof value.accessToken === 'string' &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'number' &&
    'receivedAt' in value &&
    typeof value.receivedAt === 'number'
  )
}

/** Key-order-independent JSON, so "byte-identical" does not depend on how a store orders keys. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export async function moveLedgersToLinks(
  ports: MoveLedgersPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  if (!MOVED_LEDGER_KEYS.some((key) => key in stored)) {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  const linkedAccounts = accountsOf(stored['linkedAccounts'])
  const tokens = tokensOf(stored['tokens'])
  const put = await ports.putLinks({ name: LINKS_NAME, linkedAccounts, tokens })
  // The old credentials are the only copy until the record verifiably holds the SAME ones.
  let held = await ports.readLinks()
  const matches = (record: SkillLinksBody | null): boolean =>
    record !== null &&
    canonical(record.linkedAccounts) === canonical(linkedAccounts) &&
    canonical(record.tokens) === canonical(tokens)
  // A record an earlier pass left behind (it carries this migration's name) that holds LESS than
  // the settings (a failed or partial write) is rewritten from the settings, which stay the
  // source of truth until a read-back matches. A record that holds anything the settings do not
  // carry is somebody's newer work.
  if (put === 'exists' && !matches(held) && isCoveredBy(held, linkedAccounts, tokens)) {
    await ports.replaceLinks({ name: LINKS_NAME, linkedAccounts, tokens })
    held = await ports.readLinks()
  }
  if (!matches(held)) {
    ports.warn(
      'Alexa migration: the skill-links record does not hold what the settings carried; the legacy ledgers are kept',
    )
    // A record this pass just wrote that reads back different is a fault; an older one is the
    // operator's (or a later writer's) and is left alone.
    if (put === 'created') {
      throw new Error(
        'the Alexa link record does not match the legacy settings; nothing was cleared',
      )
    }
    return { outcome: 'already-done', summary: { moved: false } }
  }
  if (tokens.length > 0) await ports.clearOldTokenSecrets()
  return put === 'created'
    ? { outcome: 'done', summary: { moved: true, accounts: linkedAccounts.length } }
    : { outcome: 'done', summary: { moved: true, repaired: true, accounts: linkedAccounts.length } }
}

/**
 * The record carries this migration's own name and every account and grant it holds is also in
 * the settings: rewriting it loses nothing and touches nothing an operator named.
 */
function isCoveredBy(
  held: SkillLinksBody | null,
  linkedAccounts: readonly LinkedAccount[],
  tokens: readonly LwaTokenEntry[],
): boolean {
  if (held === null || held.name !== LINKS_NAME) return false
  const accounts = new Set(linkedAccounts.map((a) => a.userId))
  const grants = new Set(tokens.map((t) => t.userId))
  return (
    held.linkedAccounts.every((a) => accounts.has(a.userId)) &&
    held.tokens.every((t) => grants.has(t.userId))
  )
}

/**
 * A ledger key the drop may judge: absent, a list, or the leftover of a credential clear
 * (`{ $secretClear: true }`, stored where a list belongs by an older build). Anything else is
 * not understood, so nothing is deleted on its account.
 */
function isLedgerShape(value: unknown): boolean {
  return value === undefined || Array.isArray(value) || isSecretClear(value)
}

/** Whether a stored token entry still carries a credential: text, or a keychain marker. */
function carriesCredential(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  return ['accessToken', 'refreshToken', 'brokerCredential'].some((key) => {
    const value = Reflect.get(entry, key)
    if (typeof value === 'string') return value.length > 0
    return typeof value === 'object' && value !== null
  })
}

const rowId = (key: string): string => `${ALEXA_INSTANCE_ID}.${key}`

export async function planDropMovedSettings(ports: DropMovedSettingsPorts): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const skillKeys = MOVED_SKILL_KEYS.filter((key) => key in stored)
  const ledgerKeys = MOVED_LEDGER_KEYS.filter((key) => key in stored)
  if (skillKeys.length === 0 && ledgerKeys.length === 0) return { edits: [] }
  const refuse = (reason: string): never => {
    ports.warn(`Alexa migration: the legacy keys are kept: ${reason}`)
    throw new Error(`the legacy Alexa keys are not deleted: ${reason}`)
  }
  if (skillKeys.length > 0 && !(await ports.hasSkill())) {
    return refuse('no Alexa skill record exists')
  }
  if (ledgerKeys.length > 0) {
    const links = await ports.readLinks()
    if (links === null) return refuse('no Alexa link record exists')
    // POSITIVE proof only: the ledgers are deleted when the settings carry nothing the record
    // lacks, never because a comparison could not be made.
    if (!isLedgerShape(stored['linkedAccounts'])) {
      return refuse('the old linkedAccounts setting is not a list the migration understands')
    }
    if (!isLedgerShape(stored['tokens'])) {
      return refuse('the old tokens setting is not a list the migration understands')
    }
    // A credential still in the old settings means the record was never verified to hold it
    // (the migration clears the old ones only after the read-back matched): keep the key.
    const legacyTokens = stored['tokens']
    if (Array.isArray(legacyTokens) && legacyTokens.some(carriesCredential)) {
      return refuse('the old settings still carry Amazon push credentials')
    }
    const heldAccounts = new Map(links.linkedAccounts.map((a) => [a.userId, a]))
    const heldTokens = new Set(links.tokens.map((t) => t.userId))
    for (const account of accountsOf(stored['linkedAccounts'])) {
      const held = heldAccounts.get(account.userId)
      if (held === undefined) return refuse(`the record lacks the account ${account.userId}`)
      if (canonical(held) !== canonical(account)) {
        return refuse(`the record holds the account ${account.userId} differently`)
      }
    }
    for (const token of tokensOf(stored['tokens'])) {
      if (!heldTokens.has(token.userId)) return refuse(`the record lacks the grant ${token.userId}`)
    }
  }
  const present = [...skillKeys, ...ledgerKeys]
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        // The rows as the settings writer stores them: `{ addonId, key, value }`.
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              rowId(key),
              { addonId: ALEXA_INSTANCE_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
