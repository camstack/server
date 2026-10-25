/**
 * Secret handling for stored targets.
 *
 * A target's `config` blob holds secrets (API tokens, passwords, topics).
 * Secrets must NEVER round-trip to the admin UI, so `listTargets` replaces
 * every field declared `type:'password'` in the kind's `configSchema` with a
 * presence marker. On write, `mergeSecrets` restores the stored secret for any
 * password field the operator left as the marker (i.e. didn't re-type),
 * mirroring the settings-form secret-merge pattern (`config-ui.ts` §"Secret
 * masking").
 *
 * Passwords can also live NESTED inside an `editable-array` field's rows — e.g.
 * the webhook custom-header `value`. Those are redacted/merged per-row: on
 * write, a row whose secret came back as the marker is matched to a prior row
 * by its non-secret (identity) fields and the stored secret is restored.
 */
import type { ConfigField, Target, TargetKind } from '@camstack/types'
import { changedDestinations, type DestinationSpec } from './destinations.js'

/** Presence marker returned in place of a stored secret. */
export const REDACTED_MARKER = '__redacted__'

/** Password sub-fields nested inside one `editable-array` field's rows. */
interface ArraySecretSpec {
  /** The array field's `key` in the config blob. */
  readonly arrayKey: string
  /** Per-row keys declared `type:'password'`. */
  readonly passwordKeys: ReadonlySet<string>
  /** Per-row non-secret keys — used to match an incoming row to a stored one. */
  readonly identityKeys: readonly string[]
}

/** Where a kind's secrets live: top-level password keys + nested array specs. */
interface SecretSpec {
  readonly topLevel: ReadonlySet<string>
  readonly arrays: readonly ArraySecretSpec[]
}

function isPasswordField(field: ConfigField): boolean {
  return 'type' in field && field.type === 'password' && 'key' in field
}

/** Build the full secret spec (top-level + nested editable-array) for a kind. */
function secretSpec(descriptor: TargetKind): SecretSpec {
  const topLevel = new Set<string>()
  const arrays: ArraySecretSpec[] = []
  for (const section of descriptor.configSchema.sections) {
    for (const field of section.fields) {
      if (isPasswordField(field)) {
        topLevel.add(field.key)
        continue
      }
      if ('type' in field && field.type === 'editable-array' && 'key' in field) {
        const passwordKeys = new Set<string>()
        const identityKeys: string[] = []
        for (const item of field.itemFields) {
          if (!('key' in item)) continue
          if (isPasswordField(item)) passwordKeys.add(item.key)
          else identityKeys.push(item.key)
        }
        if (passwordKeys.size > 0) {
          arrays.push({ arrayKey: field.key, passwordKeys, identityKeys })
        }
      }
    }
  }
  return { topLevel, arrays }
}

/**
 * Collect the `key`s of every top-level `type:'password'` field in a kind's
 * config schema. (Nested editable-array passwords are handled separately — see
 * `redactForRead` / `mergeSecrets`.)
 */
export function passwordFieldKeys(descriptor: TargetKind): ReadonlySet<string> {
  return secretSpec(descriptor).topLevel
}

function isPresentSecret(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Redact the password sub-fields of every row in one editable-array value. */
function redactArray(value: unknown, spec: ArraySecretSpec): { rows: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { rows: value, changed: false }
  let changed = false
  const rows = value.map((row) => {
    if (!isRecord(row)) return row
    let rowChanged = false
    const next: Record<string, unknown> = { ...row }
    for (const key of spec.passwordKeys) {
      if (isPresentSecret(next[key])) {
        next[key] = REDACTED_MARKER
        rowChanged = true
      }
    }
    if (rowChanged) changed = true
    return rowChanged ? next : row
  })
  return { rows: changed ? rows : value, changed }
}

/**
 * Return a copy of `target` with every present secret replaced by
 * `REDACTED_MARKER`. Empty / unset secret fields are left untouched so the UI
 * can tell "no secret set" apart from "secret set but hidden". Nested
 * editable-array password sub-fields are redacted per row.
 */
export function redactForRead(target: Target, descriptor: TargetKind): Target {
  const spec = secretSpec(descriptor)
  if (spec.topLevel.size === 0 && spec.arrays.length === 0) return target
  const config: Record<string, unknown> = { ...target.config }
  let changed = false
  for (const key of spec.topLevel) {
    if (isPresentSecret(config[key])) {
      config[key] = REDACTED_MARKER
      changed = true
    }
  }
  for (const arraySpec of spec.arrays) {
    const { rows, changed: arrChanged } = redactArray(config[arraySpec.arrayKey], arraySpec)
    if (arrChanged) {
      config[arraySpec.arrayKey] = rows
      changed = true
    }
  }
  return changed ? { ...target, config } : target
}

/** True when two rows agree on every identity (non-secret) field. */
function rowsMatch(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((k) => a[k] === b[k])
}

/** One editable-array merged, and whether any stored row-secret was put back. */
interface ArrayMerge {
  readonly rows: unknown
  readonly restored: boolean
}

/**
 * Merge an incoming editable-array over the stored one, restoring each stored
 * row-secret the operator did not re-type. An incoming row whose password came
 * back as the marker (or absent) is matched to a prior row by its identity
 * fields; if no prior secret is found the marker is dropped rather than saved.
 */
function mergeArray(existing: unknown, incoming: unknown, spec: ArraySecretSpec): ArrayMerge {
  if (!Array.isArray(incoming)) return { rows: incoming, restored: false }
  const priorRows = Array.isArray(existing) ? existing.filter(isRecord) : []
  let restored = false
  const rows = incoming.map((row) => {
    if (!isRecord(row)) return row
    const next: Record<string, unknown> = { ...row }
    for (const key of spec.passwordKeys) {
      const value = next[key]
      if (value !== REDACTED_MARKER && value !== undefined) continue
      const prior = priorRows.find(
        (p) => rowsMatch(next, p, spec.identityKeys) && isPresentSecret(p[key]),
      )
      if (prior) {
        next[key] = prior[key]
        restored = true
      } else {
        delete next[key]
      }
    }
    return next
  })
  return { rows, restored }
}

/** The row a save would replace, as far as the secret merge needs it. */
export interface StoredSecretSource {
  readonly kind: string
  readonly config: Readonly<Record<string, unknown>>
}

/** The edited row a save proposes. `config` carries markers for untouched secrets. */
export interface IncomingTargetConfig {
  readonly id: string
  readonly kind: string
  readonly config: Readonly<Record<string, unknown>>
}

/** Everything {@link mergeSecrets} needs to decide whether a restore is safe. */
export interface SecretMergeRequest {
  readonly existing: StoredSecretSource | undefined
  readonly incoming: IncomingTargetConfig
  /**
   * The INCOMING kind's adapter: its schema says which fields are secret, its
   * `destinationKeys` say which fields decide where they go.
   */
  readonly adapter: DestinationSpec
}

/** Why a restore was refused — the kind moved, or these destinations did. */
export type SecretRestoreRefusal =
  | { readonly reason: 'kind-changed'; readonly from: string; readonly to: string }
  | { readonly reason: 'destination-changed'; readonly keys: readonly string[] }

/**
 * A save asked for a stored secret to be kept while changing where it is sent.
 *
 * The message names the target, the secret FIELDS and what changed — never a
 * value: it travels back to the editor and into logs.
 */
export class SecretRestoreRefusedError extends Error {
  readonly targetId: string
  readonly secretKeys: readonly string[]
  readonly refusal: SecretRestoreRefusal

  constructor(targetId: string, secretKeys: readonly string[], refusal: SecretRestoreRefusal) {
    const what =
      refusal.reason === 'kind-changed'
        ? `its kind changed from '${refusal.from}' to '${refusal.to}'`
        : `its destination changed (${refusal.keys.join(', ')})`
    super(
      `Refusing to reuse the stored secret (${secretKeys.join(', ')}) of target '${targetId}': ${what}. ` +
        'Re-enter the secret when changing where this target sends — a stored credential only ' +
        'ever goes where it was typed for.',
    )
    this.name = 'SecretRestoreRefusedError'
    this.targetId = targetId
    this.secretKeys = secretKeys
    this.refusal = refusal
  }
}

/**
 * Merge an incoming (UI-supplied) config over the stored one, preserving each
 * stored secret the operator did not re-type. A password field whose incoming
 * value is the marker (or absent) falls back to the existing secret; if there
 * is no existing secret the marker is dropped rather than persisted. Nested
 * editable-array password sub-fields are merged per row.
 *
 * **A restore is only granted to the destination the secret already had.** If
 * any stored secret would be put back while the kind changed, or while any of
 * the adapter's `destinationKeys` changed (judged on the destination the
 * adapter would USE — `destinations.ts`), the save is refused with
 * {@link SecretRestoreRefusedError} — otherwise an edit of `serverUrl` with the
 * token left redacted hands the token to the new host on the next send, and
 * the editor never saw the token it just redirected.
 */
export function mergeSecrets(request: SecretMergeRequest): Record<string, unknown> {
  const { existing, incoming, adapter } = request
  const spec = secretSpec(adapter.descriptor)
  const prior = existing?.config
  const merged: Record<string, unknown> = { ...incoming.config }
  const restoredKeys: string[] = []
  for (const key of spec.topLevel) {
    const value = merged[key]
    if (value === REDACTED_MARKER || value === undefined) {
      const stored = prior?.[key]
      if (stored !== undefined) {
        merged[key] = stored
        restoredKeys.push(key)
      } else {
        delete merged[key]
      }
    }
  }
  for (const arraySpec of spec.arrays) {
    if (arraySpec.arrayKey in merged) {
      const { rows, restored } = mergeArray(
        prior?.[arraySpec.arrayKey],
        merged[arraySpec.arrayKey],
        arraySpec,
      )
      merged[arraySpec.arrayKey] = rows
      if (restored) restoredKeys.push(`${arraySpec.arrayKey}[]`)
    }
  }

  if (restoredKeys.length === 0 || existing === undefined) return merged
  if (existing.kind !== incoming.kind) {
    throw new SecretRestoreRefusedError(incoming.id, restoredKeys, {
      reason: 'kind-changed',
      from: existing.kind,
      to: incoming.kind,
    })
  }
  // Compared on the MERGED row: a destination that is itself a secret and came
  // back redacted has just been restored, so it reads as unchanged.
  const changed = changedDestinations(adapter, existing.config, merged)
  if (changed.length > 0) {
    throw new SecretRestoreRefusedError(incoming.id, restoredKeys, {
      reason: 'destination-changed',
      keys: changed,
    })
  }
  return merged
}
