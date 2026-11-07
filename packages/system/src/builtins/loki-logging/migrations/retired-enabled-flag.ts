/**
 * Loki's private `enabled` setting is gone (D777, D986, D987).
 *
 * The per-destination toggle is the only enable, and the legacy flag has not gated shipping since
 * D777. A stored `enabled: false` therefore describes NOTHING in effect: carrying it over would
 * switch off a destination that has been shipping for months, so this migration disables nothing.
 * It deletes the dead key, and the marker the earlier boot-time carry-over left beside it, in ONE
 * plan the engine applies under a precondition. Absence of the keys is the marker; a rerun finds
 * nothing and writes nothing. A read that fails throws and nothing is written.
 */
import { type MigrationPlan, preconditionOf } from '@camstack/types'
import { ADDON_SETTINGS_TABLE, LOKI_ADDON_ID } from './connection-to-records.js'

/** The retired settings key. */
export const RETIRED_ENABLED_KEY = 'enabled'
/** The marker the boot-time carry-over set. Not a schema field. Pre-D777 name kept. */
export const RETIREMENT_MARKER_KEY = 'migratedEnabled'

const RETIRED_KEYS: readonly string[] = [RETIRED_ENABLED_KEY, RETIREMENT_MARKER_KEY]

export interface RetiredEnabledFlagPorts {
  /** The addon's stored settings as written (markers unresolved), unparsed. Throws when unreadable. */
  readRawStored(): Promise<Readonly<Record<string, unknown>>>
  /** Said once, at the moment the key goes: the operator learns nothing was switched. */
  info(message: string): void
}

export async function planDropRetiredEnabledFlag(
  ports: RetiredEnabledFlagPorts,
): Promise<MigrationPlan> {
  const stored = await ports.readRawStored()
  const present = RETIRED_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  const flag = stored[RETIRED_ENABLED_KEY]
  if (typeof flag === 'boolean') {
    ports.info(
      `Loki logging: the retired \`enabled: ${String(flag)}\` setting was removed; ` +
        'it has not gated shipping since D777, so nothing was switched. The per-destination toggle is the only enable.',
    )
  }
  const rowId = (key: string): string => `${LOKI_ADDON_ID}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [rowId(key), { addonId: LOKI_ADDON_ID, key, value: stored[key] }]),
          ),
        ),
      },
    ],
  }
}
