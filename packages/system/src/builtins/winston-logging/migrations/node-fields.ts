/**
 * The log level and the retention of the rotated files are facts of ONE node: each node writes
 * its own files (D986). They were stored once, as bare rows `<addonId>.<key>`; a node's row is
 * `<addonId>.<key>@<nodeId>` carrying `nodeId`, and a node never falls back to a bare row. The
 * engine's ledger holds one row per migration id for the whole cluster, so the ONE plan writes
 * the rows of every node in `ports.nodeIds()`; a node that joins later starts from the schema
 * default (the rule for any node setting).
 *
 * A bare row is COPIED (the bare row stays for a release) and a value already on a node row is
 * never overwritten (a seed never overwrites). Idempotent: with every node row copied the plan
 * is empty.
 */
import { type MigrationPlan, preconditionOf, type StoredKeyRead } from '@camstack/types'

/** The canonical settings table: one row per key, id `<addonId>.<key>`. */
export const ADDON_SETTINGS_TABLE = 'addon-settings'

export interface NodeFieldsPorts {
  /**
   * The addon's rows as stored (markers kept, nothing resolved), for each of `keys` that has a
   * row; a key without one is left out. Throws when the store cannot be read.
   */
  readStored(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
  /** Every node the field is copied to. Throws when the cluster's nodes cannot be listed. */
  nodeIds(): Promise<readonly string[]>
}

export const nodeKeyOf = (key: string, nodeId: string): string => `${key}@${nodeId}`

export async function planNodeFields(
  addonId: string,
  keys: readonly string[],
  ports: NodeFieldsPorts,
): Promise<MigrationPlan> {
  const nodes = await ports.nodeIds()
  const stored = await ports.readStored([
    ...keys,
    ...nodes.flatMap((nodeId) => keys.map((key) => nodeKeyOf(key, nodeId))),
  ])
  const sets: Record<string, Record<string, unknown>> = {}
  for (const nodeId of nodes) {
    for (const key of keys) {
      const target = nodeKeyOf(key, nodeId)
      if (!(key in stored) || target in stored) continue
      sets[`${addonId}.${target}`] = { addonId, key: target, value: stored[key], nodeId }
    }
  }
  const ids = Object.keys(sets)
  if (ids.length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'setKeys',
        scope: ADDON_SETTINGS_TABLE,
        values: sets,
        // Every target row was absent when the plan read; a row that appeared since refuses it.
        precondition: preconditionOf(Object.fromEntries(ids.map((id) => [id, null]))),
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

/**
 * Every node the hub knows (online or not) plus this one. A node the directory does not list
 * yet is this one while it boots. Throws when the directory cannot be read or is `complete: false`: a copy that missed
 * a node must fail, not report done.
 */
export async function clusterNodeIds(
  directory: () => Promise<{
    readonly nodes: readonly { readonly id: string }[]
    readonly complete: boolean
  }>,
  localNodeId: string | undefined,
): Promise<readonly string[]> {
  const answer = await directory()
  if (!answer.complete) {
    throw new Error('the node directory is incomplete (no history read answered): not copying')
  }
  const listed = answer.nodes.map((node) => node.id)
  const self = (localNodeId ?? 'hub').split('/')[0] ?? 'hub'
  return [...new Set([self === '' ? 'hub' : self, ...listed])]
}
