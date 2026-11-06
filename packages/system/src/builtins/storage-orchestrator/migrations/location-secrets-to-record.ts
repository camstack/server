/**
 * The credentials of a storage location move from `row/storage_locations/<id>` to the location's
 * OWN record (planning#440 step 6, D879, D987). A location row kept its provider's credentials as
 * keychain markers inside `config`, filed under a per-row collection of a table that no longer
 * exists; they become the record's `secrets` map, which the records door keeps in the keychain
 * bound to the row (a delete releases them, one row's value is never another's).
 *
 * Fails closed. Every legacy credential is RESOLVED before anything is written: a keychain that
 * is locked, or a value that is gone, refuses the whole step and leaves every row as it was.
 * A row is moved with ONE patch that sets `secrets` and removes the marker keys from `config`;
 * nothing else of the row (its id, its mode, `minFreePercent`, `maxUsedGb`) is part of the patch.
 * The moved credential is read back RESOLVED and must equal what was resolved; only then are the
 * legacy keychain values released. A row with no legacy marker is not touched, so a second run
 * finds nothing and the step reports `already-done`.
 */
import type { MigrationProcedureResult, SecretMarker } from '@camstack/types'

/** One location row's legacy credentials: config key to the marker that names the old ref. */
export interface LegacyLocationRow {
  readonly id: string
  readonly legacy: Readonly<Record<string, SecretMarker>>
}

/** What the keychain said about one ref. */
export type LegacySecretRead =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'unavailable' | 'missing' }

/** A row after the move, as the runtime reads it. */
export interface MovedLocationRow {
  /** The credentials of the record, resolved. */
  readonly secrets: Readonly<Record<string, string>>
  /** The keys left in `config`. */
  readonly configKeys: readonly string[]
}

export interface LocationSecretPorts {
  /** Every location row with the legacy markers of its config. A read that fails throws. */
  readLegacy(): Promise<readonly LegacyLocationRow[]>
  /** The keychain's answer for each ref. */
  resolveLegacy(refs: readonly string[]): Promise<ReadonlyMap<string, LegacySecretRead>>
  /** One patch: set `secrets` on the record and drop `keys` from its `config`. */
  moveToRecord(id: string, secrets: Readonly<Record<string, string>>): Promise<void>
  /** The record after the move, credentials resolved; `null` when the row is gone. */
  readMoved(id: string): Promise<MovedLocationRow | null>
  /** Remove legacy keychain values, after the move was read back. */
  releaseLegacy(refs: readonly string[]): Promise<void>
  /** The running service re-reads the markers its locations carry. */
  refreshLocations(): Promise<void>
}

function sameSecrets(
  back: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const entries = (value: Readonly<Record<string, string>>): string =>
    JSON.stringify(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1)))
  return entries(back) === entries(expected)
}

export async function moveLocationSecretsToRecords(
  ports: LocationSecretPorts,
): Promise<MigrationProcedureResult> {
  const rows = (await ports.readLegacy()).filter((row) => Object.keys(row.legacy).length > 0)
  if (rows.length === 0)
    return {
      outcome: 'already-done',
      summary: { reason: 'no-legacy-secrets' },
    }

  const refs = [...new Set(rows.flatMap((row) => Object.values(row.legacy).map((m) => m.$secret)))]
  const answers = await ports.resolveLegacy(refs)
  const lost: string[] = []
  for (const row of rows) {
    for (const [key, marker] of Object.entries(row.legacy)) {
      if (answers.get(marker.$secret)?.kind !== 'value') lost.push(`${row.id}.${key}`)
    }
  }
  if (lost.length > 0) {
    // Names, never values; nothing has been written.
    throw new Error(
      `storage-orchestrator: ${lost.length} location credential(s) cannot be read from the keychain (${lost.join(', ')}); nothing was moved`,
    )
  }

  let moved = 0
  let credentials = 0
  try {
    for (const row of rows) {
      const expected: Record<string, string> = {}
      for (const [key, marker] of Object.entries(row.legacy)) {
        const answer = answers.get(marker.$secret)
        if (answer?.kind === 'value') expected[key] = answer.value
      }
      await ports.moveToRecord(row.id, expected)
      const back = await ports.readMoved(row.id)
      const staleKeys = back === null ? [] : back.configKeys.filter((key) => key in expected)
      if (back === null || !sameSecrets(back.secrets, expected) || staleKeys.length > 0) {
        throw new Error(
          `storage-orchestrator: location '${row.id}' did not read back as moved; its legacy credentials were kept`,
        )
      }
      await ports.releaseLegacy(Object.values(row.legacy).map((marker) => marker.$secret))
      moved += 1
      credentials += Object.keys(expected).length
    }
  } finally {
    // Rows moved before a refusal have released their legacy values: the running service must not
    // keep pointing at them.
    if (moved > 0) await ports.refreshLocations()
  }
  return { outcome: 'done', summary: { locations: moved, credentials } }
}
