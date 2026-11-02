/**
 * The hub's public URL is no longer a setting of this addon (D986 §5): Google reads the
 * `publicEndpoint` role of the local-network palette on every use. The two keys older
 * versions persisted are deleted. Every other key is left exactly as stored.
 *
 * Idempotent: a store without either key yields an empty plan, which writes nothing.
 */
import { type MigrationPlan, preconditionOf } from '@camstack/types'

/** The addon id, the prefix of its rows in the canonical settings table. */
export const GOOGLE_ADDON_ID = 'export-google'

/**
 * Where the addon's global settings live: the canonical `addon-settings` table, one row per
 * key, id `<addonId>.<key>`, data `{ addonId, key, value }` (never a per-addon scoped table,
 * which exists only when something lazily declared it).
 */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

export const RETIRED_PUBLIC_URL_KEYS: readonly string[] = ['publicHubUrl', 'detectedPublicHubUrl']

export interface DropPublicHubUrlPorts {
  /** The addon's stored settings as written, unparsed. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropPublicHubUrl(ports: DropPublicHubUrlPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored()
  const present = RETIRED_PUBLIC_URL_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  const rowId = (key: string): string => `${GOOGLE_ADDON_ID}.${key}`
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
              { addonId: GOOGLE_ADDON_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
