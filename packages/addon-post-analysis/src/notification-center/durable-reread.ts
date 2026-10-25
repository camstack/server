/**
 * Re-read ONE row of a ledger-backed store from the durable store, and put
 * the answer in the mirror.
 *
 * For a writer that must not act on a mirror that can be a reload tick stale:
 * the deleted-device prune writes WHOLE rows, and CRUD is served on whichever
 * node is asked, so a row planned from this node's mirror could revert an edit
 * saved elsewhere a moment ago (`device-prune-runner.ts`, D633).
 *
 * A failed read THROWS — the caller must not write on it (D49). A row that no
 * longer exists is `gone` and is evicted from the mirror (it was deleted on
 * another node; writing it back would resurrect it). A row that does not
 * validate is `unreadable` and the mirror is left as it was.
 */
import type { RecordKindHandle, SettingsStoreClient } from '@camstack/types'
import type { DurableLedger, DurableLedgerSpec } from '../durable/durable-ledger.js'

export type NcRereadResult<TRow> =
  | { readonly kind: 'row'; readonly row: TRow }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Re-read a row from a `DurableLedger`-backed store (legacy SettingsStoreClient). */
export async function rereadLedgerRow<TRow>(
  store: SettingsStoreClient,
  spec: DurableLedgerSpec<TRow>,
  ledger: DurableLedger<TRow>,
  key: string,
): Promise<NcRereadResult<TRow>> {
  // `get` answers the stored column map (structured collection), or nothing.
  const raw: unknown = await store.get.query({ collection: spec.collection, key })
  if (raw === null || raw === undefined) {
    ledger.evict(key)
    return { kind: 'gone' }
  }
  if (!isRecord(raw)) return { kind: 'unreadable' }
  const row = spec.fromRecord(key, raw)
  if (row === null) return { kind: 'unreadable' }
  ledger.stage(row)
  return { kind: 'row', row }
}

/**
 * Re-read ONE row from a `RecordKindHandle`-backed store into the in-memory mirror.
 *
 * Used by stores migrated to the records API (phase 2, steps 18-24).
 * A failed read THROWS; `gone` evicts from the mirror; `unreadable` leaves it.
 */
export async function rereadRecordRow<TBody, TRow>(
  kind: RecordKindHandle<TBody>,
  mirror: Map<string, TRow>,
  key: string,
  decode: (id: string, data: TBody) => TRow | null,
): Promise<NcRereadResult<TRow>> {
  const row = await kind.get(key)
  if (row === null) {
    mirror.delete(key)
    return { kind: 'gone' }
  }
  const decoded = decode(row.id, row.data)
  if (decoded === null) return { kind: 'unreadable' }
  mirror.set(key, decoded)
  return { kind: 'row', row: decoded }
}
