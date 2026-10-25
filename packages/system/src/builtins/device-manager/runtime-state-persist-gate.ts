/**
 * The two pure predicates that decide whether a runtime-state change is worth a
 * SQLite commit. Separated from `DeviceStateMirror` so they can be tested
 * without a mirror, a settings store or a timer.
 *
 * ── Why a gate at all ──────────────────────────────────────────────────────
 * The cost model for `camstack.db` is not bytes and not rows — it is how many
 * commits you offer to the WAL-checkpoint lottery on a FUSE share (D96: p50
 * 0.14 ms for the statement, up to 25 s for the unlucky commit that enters a
 * checkpoint). Runtime state at full fleet activity offers 12–19 commits/s,
 * measured, to maintain 161 KB of state.
 *
 * Two of those commits in three come from caps whose restored value is worth
 * nothing, and about half of what is left comes from a device rewriting its
 * blob to record that it re-read a value that had not moved.
 *
 * ── Why not the mirror's existing `shallowEqual` ───────────────────────────
 * `shallowEqual` is reference equality (`a[k] !== b[k]`). The stored value is
 * the output of `schema.parse` — fresh nested allocations — and the incoming
 * value is a fresh deserialisation, so any slice with an object or array field
 * never dedupes. That is 25+ of the 62 runtime-state caps, including `zones`,
 * `zone-rules`, `camera-streams`, `feature-probe` and `privacy-mask`.
 *
 * The mirror keeps `shallowEqual`: it decides whether to EMIT, and an emit is
 * cheap and must stay eager (`createRuntimeStateBridge.ensureFresh` detects a
 * successful refresh by a clock field advancing — suppress that and a refresh
 * looks like a failure). These predicates decide only whether to WRITE.
 */
import type { RuntimeStatePolicy } from '@camstack/types'
import { OWNED_FIELDS_KEY } from './field-ownership.js'

/** Resolves the declared policy for a cap name. */
export type RuntimeStatePolicyLookup = (capName: string) => RuntimeStatePolicy

/** A device's cap-keyed slice map, as mirrored and as persisted. */
export type RuntimeStateBlob = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/**
 * The subset of `blob` that is allowed on disk: slices whose capability
 * declared `durability: 'restored'`.
 *
 * A cap the lookup does not know resolves to `'session'` and is dropped. That
 * direction is deliberate: the cost of losing a session value is a cold window
 * until the provider republishes; the cost of persisting an unasked-for one is
 * a commit per second on the fleet's busiest write path.
 *
 * `$owned` is not a cap: it is the device's claims record (D663) and is kept
 * whatever the lookup says — a restart that forgot who owns a field would hand
 * it back to the native provider.
 */
export function persistableBlob(
  blob: RuntimeStateBlob,
  policyFor: RuntimeStatePolicyLookup,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [capName, slice] of Object.entries(blob)) {
    if (capName !== OWNED_FIELDS_KEY && policyFor(capName).durability !== 'restored') continue
    out[capName] = { ...slice }
  }
  return out
}

/**
 * Are two slices the same, ignoring the fields the cap declared volatile?
 *
 * A volatile field is still WRITTEN — it simply does not, on its own, justify
 * the write. A field the cap did NOT declare volatile is content, even when its
 * name looks like a clock: the capability is the only authority on which of its
 * fields carry meaning (D4), and the guard makes an undeclared clock visible in
 * the diff rather than assuming it.
 */
export function sliceEffectivelyEqual(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
  volatileFields: readonly string[],
): boolean {
  const skip = new Set(volatileFields)
  const keys = new Set<string>()
  for (const k of Object.keys(a)) if (!skip.has(k)) keys.add(k)
  for (const k of Object.keys(b)) if (!skip.has(k)) keys.add(k)
  for (const k of keys) {
    if (!deepEqual(a[k], b[k])) return false
    // A key present with `undefined` is not the same as an absent key: the
    // schema may distinguish them, and `JSON.stringify` would not.
    if (Object.hasOwn(a, k) !== Object.hasOwn(b, k)) return false
  }
  return true
}

/**
 * Is the whole persistable blob unchanged in every way that matters?
 *
 * A cap slice APPEARING or DISAPPEARING is always a change — the write is a
 * whole-blob replace, so a dropped slice only leaves disk if the write happens.
 */
export function effectivelyEqual(
  before: RuntimeStateBlob,
  after: RuntimeStateBlob,
  policyFor: RuntimeStatePolicyLookup,
): boolean {
  const caps = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const capName of caps) {
    const a = before[capName]
    const b = after[capName]
    if (a === undefined || b === undefined) return false
    if (!sliceEffectivelyEqual(a, b, policyFor(capName).volatileFields)) return false
  }
  return true
}

/**
 * Structural equality over the JSON values a runtime-state slice can hold.
 * `NaN` compares equal to itself so a sensor that reports it does not rewrite
 * the blob forever.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b)
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false
  if (aIsArray) {
    const bArr = b as readonly unknown[]
    if (a.length !== bArr.length) return false
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], bArr[i])) return false
    return true
  }
  const aRec = a as Record<string, unknown>
  const bRec = b as Record<string, unknown>
  const aKeys = Object.keys(aRec)
  if (aKeys.length !== Object.keys(bRec).length) return false
  for (const k of aKeys) {
    if (!Object.hasOwn(bRec, k)) return false
    if (!deepEqual(aRec[k], bRec[k])) return false
  }
  return true
}
