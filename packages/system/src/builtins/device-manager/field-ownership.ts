/**
 * Per-field ownership of a runtime-state slice (D663) — the pure half.
 *
 * A composition may claim fields of a cap on an existing device. The native
 * provider keeps writing its slice (it never learns of the claim — D62: one
 * authority per field, and the authority for a claimed field is the owner),
 * the hub keeps that slice as a SHADOW, and what consumers read and receive is
 * the MERGE: the native slice with the owned fields replaced. The shadow is
 * readable only by the owner-side mechanism (D224), never served as a second
 * truth.
 *
 * Both halves live in the device's own runtime-state row: the native slices
 * under their cap names, the claims under `$owned`. One row, one write, so a
 * claim and the slice it governs can never disagree on disk.
 *
 * This module has no mirror, no settings store and no logger: it merges and
 * it (de)serialises. `DeviceStateMirror` owns the state and the log lines.
 */
import { z } from 'zod'
import { type FieldClaimMode, FieldClaimModeSchema } from '@camstack/types'
import type { RuntimeStatePolicyLookup } from './runtime-state-persist-gate.js'

/** The row key under which claims travel. Not a cap name: `$` is not legal in one. */
export const OWNED_FIELDS_KEY = '$owned'

/**
 * One claimed cap. `fields` is the claimed set, `values` what has been written
 * so far — a claimed field with no value is HELD (ruling S5), never answered
 * from the native slice.
 */
export interface OwnedCap {
  readonly owner: string
  readonly mode: FieldClaimMode
  readonly fields: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
}

export type OwnedCaps = ReadonlyMap<string, OwnedCap>

export interface SplitBlob {
  readonly native: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly owned: OwnedCaps
  /** `$owned` entries that failed `OwnedCapSchema`, by cap name — logged once per device, never applied. */
  readonly dropped: readonly string[]
}

export type MergedSlice =
  | { readonly kind: 'slice'; readonly slice: Readonly<Record<string, unknown>> }
  | { readonly kind: 'held'; readonly reason: string }

const OwnedCapSchema = z.object({
  owner: z.string().min(1),
  mode: FieldClaimModeSchema,
  fields: z.array(z.string().min(1)).min(1),
  values: z.record(z.string(), z.unknown()),
})

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Split a runtime-state row into its native slices and its claims. A row with
 * no `$owned` splits to its slices and an empty map — the shape every device
 * without a claim has always had. Non-object entries are dropped, as the
 * mirror seed and `DeviceRuntimeState.fromInitial` have always dropped them.
 */
export function splitRuntimeBlob(blob: Readonly<Record<string, unknown>>): SplitBlob {
  const native: Record<string, Readonly<Record<string, unknown>>> = {}
  const owned = new Map<string, OwnedCap>()
  const dropped: string[] = []
  for (const [key, raw] of Object.entries(blob)) {
    if (key === OWNED_FIELDS_KEY) continue
    if (!isPlainRecord(raw)) continue
    native[key] = { ...raw }
  }
  const rawOwned = blob[OWNED_FIELDS_KEY]
  if (isPlainRecord(rawOwned)) {
    for (const [capName, entry] of Object.entries(rawOwned)) {
      const parsed = OwnedCapSchema.safeParse(entry)
      if (parsed.success) owned.set(capName, parsed.data)
      else dropped.push(capName)
    }
  }
  return { native, owned, dropped }
}

/**
 * Join native slices and claims into one row. `values` are kept only for caps
 * whose policy is `durability: 'restored'`; a session-only cap keeps its CLAIM
 * (so a restart still knows who owns what) but not its values, and the claimed
 * fields are held after boot until the owner writes again. A device with no
 * claims gets no `$owned` key at all — its row is byte-identical to before.
 */
export function joinRuntimeBlob(
  native: SplitBlob['native'],
  owned: OwnedCaps,
  policyFor: RuntimeStatePolicyLookup,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [capName, slice] of Object.entries(native)) out[capName] = { ...slice }
  if (owned.size === 0) return out
  const claims: Record<string, unknown> = {}
  for (const [capName, cap] of owned) {
    const restored = policyFor(capName).durability === 'restored'
    claims[capName] = {
      owner: cap.owner,
      mode: cap.mode,
      fields: [...cap.fields],
      values: restored ? { ...cap.values } : {},
    }
  }
  out[OWNED_FIELDS_KEY] = claims
  return out
}

/**
 * The one merge. Held when a claimed field has no value yet (S5: never
 * answered from the native), when a `replace` has no native slice to overlay
 * (a partial slice is never emitted), or when the merged slice fails the cap's
 * `runtimeState` schema (the native value never leaks through a bad overlay).
 */
export function mergeOwned(
  native: Readonly<Record<string, unknown>> | null,
  owned: OwnedCap,
  schema: z.ZodType | null,
): MergedSlice {
  const missing = owned.fields.filter((f) => !Object.hasOwn(owned.values, f))
  if (missing.length > 0) {
    return { kind: 'held', reason: `claimed fields with no value yet: ${missing.join(', ')}` }
  }
  if (owned.mode === 'replace' && native === null) {
    return { kind: 'held', reason: 'no native slice yet' }
  }
  const merged: Record<string, unknown> = { ...native, ...owned.values }
  if (schema === null) return { kind: 'slice', slice: merged }
  const parsed = schema.safeParse(merged)
  if (parsed.success) {
    // Documented type boundary: the cap's `runtimeState` is a ZodObject by
    // construction (`CapabilityDefinition.runtimeState`), so its output is a
    // record — the same boundary `DeviceRuntimeState.installCapSchema` crosses.
    return { kind: 'slice', slice: parsed.data as Record<string, unknown> }
  }
  const at = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
  return { kind: 'held', reason: `merged slice fails the schema at ${at}` }
}
