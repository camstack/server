/**
 * LLM profile rows are normalised once (D987): a row still in the FLAT pre-D893 shape moves its
 * provider fields into `providerConfig`, and a key a row still carries in plaintext moves into the
 * row's keychain slot. The records door writes the value to the keychain FIRST and the row keeps a
 * marker, so a plaintext key never survives the pass.
 *
 * The records door shows the slot as a redaction token or a marker and refuses a plain value on
 * write, so a plaintext key can only sit in the kind's field inside `providerConfig`, where a row
 * copied verbatim from the pre-keychain collection left it. It ends as the slot's marker. When the
 * slot already holds a marker it is authoritative: the stale `providerConfig` copy is dropped and
 * the marker is written back as the redaction token, which the door answers by keeping what is
 * stored - a key is never read, copied or re-written for a row that already has one.
 *
 * Idempotent: a second pass finds no flat field and no plaintext. Rows are independent; a row that
 * cannot be written is reported and the next boot retries it. A list that cannot be read writes
 * nothing.
 */
import {
  isSecretFieldView,
  isSecretMarker,
  type MigrationProcedureResult,
  REDACTED_SECRET,
} from '@camstack/types'
import { LlmProfileSchema } from '@camstack/types'
import { secretFieldOf } from '../kinds/provider-config.js'
import { hasFlatFields, migrateProfileBody } from '../profile-migration.js'

/** One stored row as the records door shows it: the slot holds a redaction token or a plain value. */
export interface ProfileRowState {
  readonly id: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface ProfileRowsPorts {
  /** Every `llm-profiles` row, UNRESOLVED. Throws when the list cannot be read. */
  listRows(): Promise<readonly ProfileRowState[]>
  /** Replace one row; a slot value other than the redaction token goes to the keychain first. */
  putRow(id: string, data: Record<string, unknown>): Promise<void>
  /** What the migration says about a decision it took; never carries a value. */
  warn(message: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A secret value that is neither absent, the redaction token, a marker nor a form view. */
function isPlaintext(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value !== REDACTED_SECRET &&
    !isSecretMarker(value) &&
    !isSecretFieldView(value)
  )
}

/** The slot value a row ends with: the keep token, a new plaintext to store, or none. */
function slotOf(slot: unknown, inConfig: unknown): string | undefined {
  if (slot === REDACTED_SECRET || isSecretMarker(slot)) return REDACTED_SECRET
  return isPlaintext(inConfig) ? inConfig : undefined
}

interface RowPlan {
  readonly data: Record<string, unknown>
  readonly rewrites: boolean
}

function planRow(row: ProfileRowState): RowPlan {
  const { body } = migrateProfileBody({ ...row.data })
  const kind = typeof body.kind === 'string' ? body.kind : ''
  const field = secretFieldOf(kind)
  const config = isRecord(body.providerConfig) ? { ...body.providerConfig } : {}
  const inConfig = field === null ? undefined : config[field]
  if (field !== null) delete config[field]
  const slot = slotOf(body.apiKey, inConfig)
  const { apiKey: _slot, ...rest } = body
  const data = {
    ...rest,
    providerConfig: config,
    ...(slot === undefined ? {} : { apiKey: slot }),
  }
  const moves = hasFlatFields(row.data) || inConfig !== undefined
  return { data, rewrites: moves }
}

export async function normaliseProfileRows(
  ports: ProfileRowsPorts,
): Promise<MigrationProcedureResult> {
  const rows = await ports.listRows()
  let rewritten = 0
  let failed = 0
  for (const row of rows) {
    const plan = planRow(row)
    if (!plan.rewrites) continue
    const { apiKey: _slot, ...common } = plan.data
    if (!LlmProfileSchema.omit({ id: true }).safeParse(common).success) {
      ports.warn(`LLM profile "${row.id}" does not parse; left as it was`)
      failed += 1
      continue
    }
    try {
      await ports.putRow(row.id, plan.data)
      rewritten += 1
    } catch (err: unknown) {
      ports.warn(
        `LLM profile "${row.id}" could not be rewritten: ${err instanceof Error ? err.message : String(err)}`,
      )
      failed += 1
    }
  }
  if (failed > 0) throw new Error(`${String(failed)} LLM profile row(s) could not be normalised`)
  return rewritten > 0
    ? { outcome: 'done', summary: { rewritten, rows: rows.length } }
    : { outcome: 'already-done', summary: { rows: rows.length } }
}
