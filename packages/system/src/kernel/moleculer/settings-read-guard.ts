/**
 * Read-modify-write guard for the addon settings stores.
 *
 * ## The data loss this prevents
 *
 * Every settings mutation is `read current → merge patch → write back`. The
 * read used to answer `{}` for BOTH "this addon has no settings yet" and "the
 * read failed", so a failed read merged the patch onto nothing and the write
 * persisted a blob containing ONLY the patch. Everything else in it was gone.
 *
 * It happened on 2026-07-31. The UDS transport stalled, `settings write failed
 * (addon-settings/root) — transport error ... UDS request timed out after
 * 60000ms` appeared in the log, and the recording configuration for all three
 * recording cameras came back as `{"enabled": false, "bands": []}`. Two and a
 * half hours of footage were never written, and nothing looked broken: an
 * emptied config is indistinguishable from an operator switching recording off.
 *
 * The rule this module enforces: **a read that FAILED is not an empty value.**
 * A miss still merges onto `{}` — that is a real empty. A failure refuses the
 * write and says so, leaving the stored blob untouched so the next successful
 * write starts from the truth.
 */

/**
 * Outcome of a settings read. `missing` and `failed` are deliberately distinct
 * — collapsing them is the bug.
 */
export type SettingsRead =
  | { readonly kind: 'value'; readonly value: Record<string, unknown> }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly error: string }

export interface ReadModifyWriteInput {
  readonly read: () => Promise<SettingsRead>
  readonly write: (next: Record<string, unknown>) => Promise<void>
  readonly patch: Record<string, unknown>
  /** Called instead of writing when the read failed — always log this. */
  readonly onRefused: (error: string) => void
}

/**
 * Merge `patch` over the current value and write it — unless the read failed,
 * in which case write NOTHING.
 *
 * Returns whether the write was attempted, so a caller can surface the refusal.
 */
export async function readModifyWrite(input: ReadModifyWriteInput): Promise<boolean> {
  const current = await input.read()
  if (current.kind === 'failed') {
    // Refusing loses the PATCH, which is recoverable — the caller still holds
    // it and the next write re-applies it. Writing would lose everything the
    // patch does not mention, which is not.
    input.onRefused(current.error)
    return false
  }
  const base = current.kind === 'value' ? current.value : {}
  await input.write({ ...base, ...input.patch })
  return true
}
