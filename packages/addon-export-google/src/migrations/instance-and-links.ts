/**
 * Google becomes a multi-instance exporter (planning#422 P2). Two migrations, both `block-owner`:
 * the addon must not serve a link ledger it cannot trust, and after them nothing reads the old key.
 *
 *  1. `moveInstanceAndLinks` (procedure): the first instance is the `google-homes` row under the
 *     id `export-google`, and the `linkedAccounts` setting becomes the `google-links` row under
 *     the same id. An existing row is never overwritten; a row this pass just wrote is read BACK
 *     and must equal what the settings carried, or the pass throws.
 *  2. `planDropMovedLinks` (plan): the key is deleted only while the record holds every user the
 *     settings carried; a record that cannot be read leaves the key in place.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import {
  GOOGLE_HOME_NAME,
  GOOGLE_INSTANCE_ID,
  GOOGLE_LINKS_NAME,
  type GoogleHomeBody,
  type GoogleLinksBody,
  LinkedAccountSchema,
  MOVED_LINKS_KEY,
} from '../export-records.js'
import type { LinkedAccount } from '../types.js'
import { ADDON_SETTINGS_TABLE } from './drop-public-hub-url.js'
import { canonical, type ExposureMigrationLog } from './exposure-to-record.js'

export interface MoveInstanceAndLinksPorts extends ExposureMigrationLog {
  /** The addon's stored settings as written. Throws when they cannot be read. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Put the `google-homes` row `export-google` with `ifRev: 0`; `exists` when one is there. */
  putHome(body: GoogleHomeBody): Promise<'created' | 'exists'>
  /** Put the `google-links` row `export-google` with `ifRev: 0`; `exists` when one is there. */
  putLinks(body: GoogleLinksBody): Promise<'created' | 'exists'>
  /** The `google-homes` row; null when absent. Throws when unreadable. */
  readHome(): Promise<GoogleHomeBody | null>
  /** The `google-links` row; null when absent. Throws when unreadable. */
  readLinks(): Promise<GoogleLinksBody | null>
}

export type DropMovedLinksPorts = Pick<
  MoveInstanceAndLinksPorts,
  'warn' | 'readStored' | 'readLinks'
>

function linksOf(value: unknown): readonly LinkedAccount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): LinkedAccount[] => {
    const parsed = LinkedAccountSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

export async function moveInstanceAndLinks(
  ports: MoveInstanceAndLinksPorts,
): Promise<MigrationProcedureResult> {
  const stored = await ports.readStored()
  const hasLinks = MOVED_LINKS_KEY in stored
  const linkedAccounts = linksOf(stored[MOVED_LINKS_KEY])
  const raw = stored[MOVED_LINKS_KEY]
  const understood = Array.isArray(raw) ? raw.length : 0
  if (understood > linkedAccounts.length) {
    ports.warn(
      `Google migration: ${understood - linkedAccounts.length} linked account(s) were not understood and are left out`,
    )
  }
  const home = await ports.putHome({ name: GOOGLE_HOME_NAME })
  const links = hasLinks
    ? await ports.putLinks({ name: GOOGLE_LINKS_NAME, linkedAccounts })
    : 'exists'
  if ((await ports.readHome()) === null) {
    throw new Error('the Google Home instance row is not there after it was written')
  }
  if (links === 'created') {
    const held = await ports.readLinks()
    if (held === null || canonical(held.linkedAccounts) !== canonical(linkedAccounts)) {
      throw new Error(
        'the Google links record does not match the legacy settings; nothing was cleared',
      )
    }
  }
  if (home === 'exists' && links === 'exists') {
    return { outcome: 'already-done', summary: { moved: false } }
  }
  return {
    outcome: 'done',
    summary: {
      instance: home === 'created',
      linked: links === 'created' ? linkedAccounts.length : 0,
    },
  }
}

export async function planDropMovedLinks(ports: DropMovedLinksPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored()
  if (!(MOVED_LINKS_KEY in stored)) return { edits: [] }
  const refuse = (reason: string): never => {
    ports.warn(`Google migration: the legacy linkedAccounts key is kept: ${reason}`)
    throw new Error(`the legacy Google linkedAccounts key is not deleted: ${reason}`)
  }
  const held = await ports.readLinks()
  if (held === null) return refuse('no links record exists')
  const heldUsers = new Set(held.linkedAccounts.map((a) => a.userId))
  for (const account of linksOf(stored[MOVED_LINKS_KEY])) {
    if (!heldUsers.has(account.userId)) return refuse(`the record lacks the user ${account.userId}`)
  }
  const id = `${GOOGLE_INSTANCE_ID}.${MOVED_LINKS_KEY}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: [id],
        precondition: preconditionOf({
          [id]: {
            addonId: GOOGLE_INSTANCE_ID,
            key: MOVED_LINKS_KEY,
            value: stored[MOVED_LINKS_KEY],
          },
        }),
      },
    ],
  }
}
