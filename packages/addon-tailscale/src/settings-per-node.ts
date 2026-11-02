/**
 * The Tailscale addons keep their settings per node (D986): the client flags and the funnel
 * mode are facts of ONE host, never of the cluster. Rows used to be bare, `<addonId>.<key>`;
 * a node's row is `<addonId>.<key>@<nodeId>` carrying `nodeId`, and a node never falls back to
 * a bare row. Both addons are placed `hub-only`, so the one node that ever held a value is
 * the hub: each bare row is COPIED to `<key>@hub`. The bare row stays for a release (a copy,
 * not a move), and a value already on the node row is never overwritten (a seed never
 * overwrites).
 *
 * A keychain marker is copied verbatim. The marker carries the ref, and a ref names the owner
 * and the secret, not the row that points at it, so the secret needs no re-keying.
 *
 * Idempotent: with every bare row already copied the plan is empty.
 */
import { type MigrationPlan, preconditionOf, type StoredKeyRead } from '@camstack/types'

/** The canonical settings table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

/** Both addons are `hub-only`: the hub is the only node that ever held a value. */
export const SETTINGS_NODE_ID = 'hub'

export interface SettingsPerNodePorts {
  /**
   * The addon's rows as stored (markers kept, nothing resolved, nothing projected), for each of
   * `keys` that has a row; a key without one is left out. Throws when the store cannot be read.
   */
  readStored(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
}

export const nodeKeyOf = (key: string): string => `${key}@${SETTINGS_NODE_ID}`

export async function planSettingsPerNode(
  addonId: string,
  keys: readonly string[],
  ports: SettingsPerNodePorts,
): Promise<MigrationPlan> {
  const stored = await ports.readStored([...keys, ...keys.map(nodeKeyOf)])
  const pending = keys.filter((key) => key in stored && !(nodeKeyOf(key) in stored))
  if (pending.length === 0) return { edits: [] }
  const rowId = (key: string): string => `${addonId}.${nodeKeyOf(key)}`
  return {
    edits: [
      {
        op: 'setKeys',
        scope: ADDON_SETTINGS_TABLE,
        values: Object.fromEntries(
          pending.map((key) => [
            rowId(key),
            {
              addonId,
              key: nodeKeyOf(key),
              value: stored[key],
              nodeId: SETTINGS_NODE_ID,
            },
          ]),
        ),
        // Every target row was absent when the plan read; a row that appeared since refuses it.
        precondition: preconditionOf(Object.fromEntries(pending.map((key) => [rowId(key), null]))),
      },
    ],
  }
}

/**
 * The port's read over an addon's three-way key read: each of `keys` that has a row, raw. A key
 * the store could not answer for throws, so the migration fails instead of treating a failed read
 * as "nothing to copy".
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
