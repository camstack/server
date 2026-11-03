import { type MigrationPlan, preconditionOf, type StoredKeyRead } from '@camstack/types'

/** The canonical settings table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

export interface DropKeysPorts {
  /**
   * The addon's rows as stored (markers kept, nothing resolved), for each of `keys` that has a
   * row; a key without one is left out. Throws when the store cannot be read.
   */
  readStored(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
}

/** Delete each of `keys` that has a row; the precondition is the row as the writer stores it. */
export async function planDropKeys(
  addonId: string,
  keys: readonly string[],
  ports: DropKeysPorts,
): Promise<MigrationPlan> {
  const stored = await ports.readStored(keys)
  const present = keys.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  const rowId = (key: string): string => `${addonId}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [rowId(key), { addonId, key, value: stored[key] }]),
          ),
        ),
      },
    ],
  }
}

/**
 * The port's read over an addon's three-way key read: each of `keys` that has a row, raw. A key
 * the store could not answer for throws, so the migration fails instead of treating a failed read
 * as "nothing to delete".
 */
export async function readRawKeys(
  read: (key: string) => Promise<StoredKeyRead>,
  addonId: string,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  const found: Record<string, unknown> = {}
  for (const key of keys) {
    const answer = await read(key)
    if (answer.kind === 'unreadable') {
      throw new Error(`${addonId}: the setting ${key} cannot be read (${answer.reason})`)
    }
    if (answer.kind === 'present') found[key] = answer.value
  }
  return found
}
