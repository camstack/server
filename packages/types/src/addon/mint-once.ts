/**
 * Mint-on-empty, with the read-back that makes it safe.
 *
 * ## The shape, and why it is a trap
 *
 * ```ts
 * let secret = await state.get()
 * if (secret === '') {
 *   secret = randomUUID()
 *   await state.set(secret)
 * }
 * ```
 *
 * `state.get()` cannot distinguish "never minted" from "the store could not be
 * read": `readAddonStoreWithRetry` gives up and answers `{}`, so a store that
 * is merely unreachable reads as EMPTY and this mints a SECOND secret over a
 * perfectly good first one. For a signing secret that invalidates every link
 * already handed out. For the HomeKit bridge identity it is irreversible —
 * every paired iPhone loses the bridge, and no later write of the store brings
 * it back.
 *
 * The read-back is the only evidence available at this layer that the store is
 * actually answering. `snapshot.addon.ts` (`ensureLinkSecret`) has done this
 * since 2026-08-14 and was the only site that did.
 *
 * ## What it does NOT fix
 *
 * If the write genuinely lands, the read-back confirms it and the old value is
 * already gone — a read-back cannot undo a write. It is a gate on USING the
 * minted value, and it is load-bearing only because the settings view refuses
 * to write at all when the last read of the addon store failed
 * (`writeAddonStore`'s refusal). The two together are what close the window;
 * the durable fix is a discriminated read result carried all the way up —
 * `docs/design/plans/2026-08-27-lettura-fallita-non-diventa-un-default.md`.
 */

/** Why a mint was refused. Both mean: the store is not answering. */
export type MintRefusalReason = 'read-back-empty' | 'read-back-mismatch'

export interface MintRefusalDetail {
  readonly reason: MintRefusalReason
  /** True when the read-back answered the fallback — the usual store-down shape. */
  readonly readBackEmpty: boolean
}

export type MintOnceOutcome<TValue> =
  | { readonly kind: 'existing'; readonly value: TValue }
  | { readonly kind: 'minted'; readonly value: TValue }
  | { readonly kind: 'refused' }

export interface MintOnceReadBackInput<TValue> {
  /** Read the persisted value. MUST answer the fallback (not throw) when absent. */
  readonly read: () => Promise<TValue>
  /** Is this the fallback — i.e. "nothing persisted, or nothing readable"? */
  readonly isEmpty: (value: TValue) => boolean
  /** Produce a fresh value. Called at most once, and only when `isEmpty` holds. */
  readonly mint: () => TValue
  /** Persist the freshly minted value. */
  readonly write: (value: TValue) => Promise<void>
  /** Value equality for the read-back. Defaults to `Object.is`. */
  readonly equals?: (a: TValue, b: TValue) => boolean
  /** Always log this: a refusal means a feature is deliberately not starting. */
  readonly onRefused: (detail: MintRefusalDetail) => void
}

/**
 * Resolve a mint-once secret/identity: reuse what is stored, or mint, persist
 * and READ BACK — refusing the minted value when the read-back disagrees.
 *
 * A `refused` outcome is never cached by this function; the caller may retry on
 * the next tick, when the store may be answering again.
 */
export async function mintOnceWithReadBack<TValue>(
  input: MintOnceReadBackInput<TValue>,
): Promise<MintOnceOutcome<TValue>> {
  const existing = await input.read()
  if (!input.isEmpty(existing)) return { kind: 'existing', value: existing }

  const minted = input.mint()
  await input.write(minted)

  const confirmed = await input.read()
  if (input.isEmpty(confirmed)) {
    input.onRefused({ reason: 'read-back-empty', readBackEmpty: true })
    return { kind: 'refused' }
  }
  const same =
    input.equals !== undefined ? input.equals(confirmed, minted) : Object.is(confirmed, minted)
  if (!same) {
    input.onRefused({ reason: 'read-back-mismatch', readBackEmpty: false })
    return { kind: 'refused' }
  }
  return { kind: 'minted', value: minted }
}
