/**
 * The camera webhook is a plane of the addon's HTTP data plane, not a private listener
 * (D999): its enable switch, port and bind host are gone. The three keys older versions
 * persisted are deleted; every other key is left exactly as stored.
 *
 * Idempotent: a store without the keys yields an empty plan, which writes nothing.
 */
import { type MigrationPlan, preconditionOf } from '@camstack/types'

/** The addon id, the prefix of its rows in the canonical settings table. */
export const REOLINK_ADDON_ID = 'provider-reolink'

/** The canonical `addon-settings` table: one row per key, id `<addonId>.<key>`, data `{ addonId, key, value }`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

export const RETIRED_WEBHOOK_INTAKE_KEYS: readonly string[] = [
  'baichuanWebhookEnabled',
  'baichuanWebhookPort',
  'baichuanWebhookBindHost',
]

export interface DropWebhookIntakePorts {
  /** The addon's stored settings as written, unparsed. */
  readStoredRaw(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropWebhookIntakeSettings(
  ports: DropWebhookIntakePorts,
): Promise<MigrationPlan> {
  const stored = await ports.readStoredRaw()
  const present = RETIRED_WEBHOOK_INTAKE_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  const rowId = (key: string): string => `${REOLINK_ADDON_ID}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              rowId(key),
              { addonId: REOLINK_ADDON_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
