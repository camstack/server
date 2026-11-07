/**
 * StorageLocationsPanel — the storage locations of a fixed set of location KINDS, the same table
 * as the Storage page. Used by the Pipeline → Cluster Events/Recording tabs to manage their
 * folders inline.
 */
import { StorageLocationsTable } from '../../storage/StorageLocationsTable'

export interface StorageLocationsPanelProps {
  /** Location kinds to render, e.g. ['eventMedia'] or ['recordings','recordingsLow']. */
  readonly types: readonly string[]
}

export function StorageLocationsPanel({ types }: StorageLocationsPanelProps) {
  return <StorageLocationsTable kinds={types} />
}
