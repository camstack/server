/**
 * Two retired face settings leave the cluster row (D987, D986 §2).
 *
 * `suggestionMinCosine` (D222) and `minFaceConfidence` (D662) are declared by no scope any more, so
 * no typed handle can unset them: they are removed here, once, from the `addon-settings` table.
 * Each one found is announced first — the value in force changes, and silence would be the same
 * defect one layer up — through the `announce` port, with the value the operator had typed.
 * Absence of the keys is the marker; a rerun finds nothing and writes nothing. A read that fails
 * throws and nothing is written. The per-camera rows are still swept by the retention pass.
 */
import { type MigrationPlan, preconditionOf } from '@camstack/types'
import { PIPELINE_ANALYTICS_ID } from './split-enabled-key.js'

export const RETIRED_SUGGESTION_KEY = 'suggestionMinCosine'
export const RETIRED_FACE_CONFIDENCE_KEY = 'minFaceConfidence'
const RETIRED_KEYS: readonly string[] = [RETIRED_SUGGESTION_KEY, RETIRED_FACE_CONFIDENCE_KEY]

/** The canonical settings table: one row per key, id `<addonId>.<key>`. */
const SETTINGS_TABLE = 'addon-settings'

export interface RetiredFaceKeysPorts {
  /** The addon's cluster rows as stored, for each of `keys` that has one. Throws when unreadable. */
  readStored(keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
  /** Say which retired key was found and what it held; may read the settings in force. */
  announceRetired(key: string, was: unknown): Promise<void>
}

export async function planRetireFaceKeys(ports: RetiredFaceKeysPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored(RETIRED_KEYS)
  const present = RETIRED_KEYS.filter((key) => stored[key] !== undefined)
  if (present.length === 0) return { edits: [] }
  for (const key of present) await ports.announceRetired(key, stored[key])
  const rowId = (key: string): string => `${PIPELINE_ANALYTICS_ID}.${key}`
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: SETTINGS_TABLE,
        keys: present.map(rowId),
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              rowId(key),
              { addonId: PIPELINE_ANALYTICS_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
