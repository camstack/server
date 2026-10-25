/**
 * ONE-SHOT retirement of Loki's private `enabled` setting (2026-07-30, D777).
 *
 * The per-destination `log-destination` capability toggle is the only enable.
 * A stored `enabled: false` is carried over to it ONCE, so an operator who had
 * Loki off does not silently start shipping logs to a host they may no longer
 * control:
 *
 *  - flag stored `false`            → the provider is disabled at the capability;
 *  - flag stored `true`, or never
 *    written                        → the capability is left as it is.
 *
 * Then the dead key is stripped and the marker is written in the SAME store
 * write, so the carry-over never repeats — an operator who re-enables Loki
 * afterwards is never switched off again.
 *
 * Anything that cannot be confirmed (unreadable store, refused toggle — the
 * provider is not registered yet while the addon initializes — or a write that
 * silently did not land) returns `deferred` and writes nothing; the caller
 * retries in the background.
 *
 * Same shape as the (since removed) magic-link addon's carry-over in
 * addon-auth; the one difference is the default the flag had (OFF there, ON
 * here).
 */
import type { StoredKeyRead } from '@camstack/types'

/** The retired settings key. */
export const RETIRED_ENABLED_KEY = 'enabled'
/** Store key marking the retirement as done. Not a schema field. Pre-D777 name kept. */
export const RETIREMENT_MARKER_KEY = 'migratedEnabled'

export type RetirementOutcome =
  | { readonly kind: 'already-retired' }
  | { readonly kind: 'retired'; readonly capDisabled: boolean }
  | { readonly kind: 'deferred'; readonly reason: string }

export interface RetireEnabledFlagDeps {
  /** Three-way read of one key of the addon's own store. */
  readStoredKey(key: string): Promise<StoredKeyRead>
  /** Disable this addon at the `log-destination` toggle. Throws when refused. */
  disableAtCapability(): Promise<void>
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
  const wasOff = flag.kind === 'present' && flag.value === false

  if (wasOff) {
    try {
      await deps.disableAtCapability()
    } catch (err: unknown) {
      return deferred(
        `capability toggle refused: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  await deps.commit()
  // A forked settings view refuses a read-modify-write SILENTLY when its read
  // fails — only a read-back proves the marker landed.
  const written = await deps.readStoredKey(RETIREMENT_MARKER_KEY)
  if (!isMarked(written)) return deferred('retirement write did not land')
  return { kind: 'retired', capDisabled: wasOff }
}
