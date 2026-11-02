/**
 * ONE-SHOT retirement of Loki's private `enabled` setting (2026-07-30, D777).
 *
 * The per-destination toggle is the only enable, and the legacy flag has not gated
 * shipping since D777. A stored `enabled: false` therefore describes NOTHING in effect:
 * carrying it over would switch off a destination that has been shipping for months, so
 * the retirement disables nothing. It only strips the dead key and sets the marker in
 * ONE store write, so it never repeats.
 *
 * Anything that cannot be confirmed (unreadable store, or a write that silently did not
 * land) returns `deferred` and writes nothing; the caller retries in the background.
 */
import type { StoredKeyRead } from '@camstack/types'

/** The retired settings key. */
export const RETIRED_ENABLED_KEY = 'enabled'
/** Store key marking the retirement as done. Not a schema field. Pre-D777 name kept. */
export const RETIREMENT_MARKER_KEY = 'migratedEnabled'

export type RetirementOutcome =
  | { readonly kind: 'already-retired' }
  | { readonly kind: 'retired'; readonly strippedValue: boolean | null }
  | { readonly kind: 'deferred'; readonly reason: string }

export interface RetireEnabledFlagDeps {
  /** Three-way read of one key of the addon's own store. */
  readStoredKey(key: string): Promise<StoredKeyRead>
  /** ONE store write: strip {@link RETIRED_ENABLED_KEY} and set {@link RETIREMENT_MARKER_KEY}. */
  commit(): Promise<void>
}

function deferred(reason: string): RetirementOutcome {
  return { kind: 'deferred', reason }
}

function isMarked(read: StoredKeyRead): boolean {
  return read.kind === 'present' && read.value === true
}

export async function retireEnabledFlag(deps: RetireEnabledFlagDeps): Promise<RetirementOutcome> {
  const marker = await deps.readStoredKey(RETIREMENT_MARKER_KEY)
  if (marker.kind === 'unreadable') return deferred('settings store unreadable (marker)')
  if (isMarked(marker)) return { kind: 'already-retired' }

  const flag = await deps.readStoredKey(RETIRED_ENABLED_KEY)
  if (flag.kind === 'unreadable') return deferred('settings store unreadable (enabled)')
  const strippedValue =
    flag.kind === 'present' && typeof flag.value === 'boolean' ? flag.value : null

  await deps.commit()
  // A forked settings view refuses a read-modify-write SILENTLY when its read
  // fails — only a read-back proves the marker landed.
  const written = await deps.readStoredKey(RETIREMENT_MARKER_KEY)
  if (!isMarked(written)) return deferred('retirement write did not land')
  return { kind: 'retired', strippedValue }
}
