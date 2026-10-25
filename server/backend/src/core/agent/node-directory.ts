import type { NodeDirectory, NodeDirectoryEntry, NodeLiveness } from '@camstack/types'
import type { PersistedClusterNode } from './cluster-node-history-store'

/**
 * The cheap node list (D637): live liveness plus the durable history, merged.
 *
 * - A node Moleculer still lists keeps Moleculer's liveness verdict, named
 *   from the history when the history knows it.
 * - A node known ONLY from the history (Moleculer already purged it) is
 *   listed OFFLINE — never dropped.
 * - `history === null` = unreadable, so the answer is INCOMPLETE and a picker
 *   must not call a missing id removed (D315).
 */
export function toNodeDirectory(
  live: readonly NodeLiveness[],
  history: readonly PersistedClusterNode[] | null,
): NodeDirectory {
  const rows = history ?? []
  const names = new Map(rows.map((row) => [row.id, row.name]))
  const hubs = new Set(rows.filter((row) => row.isHub).map((row) => row.id))
  const entries = new Map<string, NodeDirectoryEntry>()
  for (const node of live) {
    entries.set(node.id, {
      id: node.id,
      name: displayName(node.id, names.get(node.id)),
      isHub: node.isHub || hubs.has(node.id),
      isOnline: node.isOnline,
    })
  }
  for (const row of rows) {
    if (entries.has(row.id)) continue
    entries.set(row.id, {
      id: row.id,
      name: displayName(row.id, row.name),
      isHub: row.isHub,
      isOnline: false,
    })
  }
  const nodes = [...entries.values()].sort(compareDirectoryEntries)
  return { nodes, complete: history !== null }
}

function displayName(id: string, name: string | undefined): string {
  return name !== undefined && name.length > 0 ? name : id
}

/** Hub first, then online before offline, then by name. */
function compareDirectoryEntries(a: NodeDirectoryEntry, b: NodeDirectoryEntry): number {
  return (
    Number(b.isHub) - Number(a.isHub) ||
    Number(b.isOnline) - Number(a.isOnline) ||
    a.name.localeCompare(b.name)
  )
}
