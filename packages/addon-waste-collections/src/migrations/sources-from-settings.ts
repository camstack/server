/**
 * The sources a pre-record install kept in the addon settings (`sources`) become `waste-source`
 * records (planning#440 step 6). Two legacy shapes feed it, the ones the boot code used to read:
 *
 * - the seeding of an empty record store from `config.sources`;
 * - the D880 rewrite of a row whose arguments were a free JSON object string (`argsJson`, which
 *   could carry a password raw) into typed `args`.
 *
 * Reads come RESOLVED (a stored credential reads as its value); one the keychain could not serve
 * is still a marker and REFUSES the step, so nothing is written from a guess. A credential is
 * stored through the records door (a keychain marker bound to the row) and every record is read
 * back before the step reports it done. A record that already exists is never overwritten, a
 * disabled source stays disabled, and a row that cannot be converted (malformed JSON, a nested
 * value) is counted and left in the settings, never guessed at. The legacy key stays where it is.
 */
import { isSecretMarker, type MigrationProcedureResult, type StoredKeyRead } from '@camstack/types'
import { isSecretArg } from '../waste-secrets.js'
import type { WasteArgValue, WasteSourceConfig } from '../waste-types.js'

export const LEGACY_SOURCES_KEY = 'sources'

export interface WasteSourcePorts {
  /** The addon's three-way read of one settings key, credentials resolved. */
  readStored(key: string): Promise<StoredKeyRead>
  /** The ids that already have a record. */
  listSourceIds(): Promise<readonly string[]>
  /** Create the record (its credentials go to the keychain through the records door). */
  putSource(source: WasteSourceConfig): Promise<void>
  /** The record as stored, credentials resolved; `null` when there is none. */
  readSource(id: string): Promise<WasteSourceConfig | null>
}

type PlainArgs = Record<string, string | number | boolean>

/** A row that cannot become a record; the reason names the row, never a value. */
class UnconvertibleRow extends Error {}

function textOf(row: object, key: string): string | undefined {
  const value: unknown = Reflect.get(row, key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function plainArgs(raw: unknown): PlainArgs {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UnconvertibleRow('the arguments are not an object')
  }
  const out: PlainArgs = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    if (isSecretMarker(value)) {
      throw new Error(
        'waste-collections: a stored credential is unavailable (is the keychain locked?)',
      )
    }
    if (typeof value === 'object') throw new UnconvertibleRow('an argument is not a plain value')
    if (isSecretArg(key)) {
      // The credential schema is text; an empty one is no credential.
      const text = String(value)
      if (text.length > 0) out[key] = text
    } else {
      out[key] = value
    }
  }
  return out
}

/** The arguments a row means: a legacy `argsJson` wins when set, like the old fetch did. */
function argsOf(row: object): PlainArgs {
  const legacy = textOf(row, 'argsJson')?.trim() ?? ''
  if (legacy.length === 0) return plainArgs(Reflect.get(row, 'args') ?? {})
  let parsed: unknown
  try {
    parsed = JSON.parse(legacy)
  } catch {
    // A SyntaxError quotes the text, which holds the credential: say nothing of it.
    throw new UnconvertibleRow('argsJson is not valid JSON')
  }
  return plainArgs(parsed)
}

interface SourceDraft {
  readonly source: WasteSourceConfig
  readonly expected: PlainArgs
}

function draftOf(raw: unknown): SourceDraft {
  if (raw === null || typeof raw !== 'object')
    throw new UnconvertibleRow('the row is not an object')
  const id = textOf(raw, 'id')
  const module = textOf(raw, 'module')
  if (id === undefined || module === undefined)
    throw new UnconvertibleRow('the row has no id or module')
  const expected = argsOf(raw)
  const enabled: unknown = Reflect.get(raw, 'enabled')
  const args: Record<string, WasteArgValue> = { ...expected }
  return {
    expected,
    source: {
      id,
      label: textOf(raw, 'label') ?? id,
      module,
      args,
      enabled: enabled !== false,
    },
  }
}

function sameArgs(back: Readonly<Record<string, unknown>>, expected: PlainArgs): boolean {
  const entries = (value: Readonly<Record<string, unknown>>): string =>
    JSON.stringify(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1)))
  return entries(back) === entries(expected)
}

async function legacyRows(ports: WasteSourcePorts): Promise<readonly unknown[]> {
  const answer = await ports.readStored(LEGACY_SOURCES_KEY)
  if (answer.kind === 'unreadable') {
    throw new Error(`waste-collections: the stored 'sources' cannot be read (${answer.reason})`)
  }
  if (answer.kind === 'absent' || !Array.isArray(answer.value)) return []
  return answer.value
}

export async function copySourcesToRecords(
  ports: WasteSourcePorts,
): Promise<MigrationProcedureResult> {
  const rows = await legacyRows(ports)
  if (rows.length === 0) return { outcome: 'already-done', summary: { reason: 'no-legacy-data' } }

  // Convert every row BEFORE writing any: a refusal (a locked keychain) leaves nothing half-copied.
  const drafts: SourceDraft[] = []
  let unconverted = 0
  for (const raw of rows) {
    try {
      drafts.push(draftOf(raw))
    } catch (err: unknown) {
      if (!(err instanceof UnconvertibleRow)) throw err
      unconverted += 1
    }
  }

  const have = new Set(await ports.listSourceIds())
  let created = 0
  let kept = 0
  for (const { source, expected } of drafts) {
    if (have.has(source.id)) {
      kept += 1
      continue
    }
    await ports.putSource(source)
    const back = await ports.readSource(source.id)
    if (
      back === null ||
      back.module !== source.module ||
      back.label !== source.label ||
      back.enabled !== source.enabled ||
      !sameArgs(back.args, expected)
    ) {
      throw new Error(`waste-collections: source '${source.id}' did not read back as written`)
    }
    have.add(source.id)
    created += 1
  }
  return {
    outcome: created === 0 ? 'already-done' : 'done',
    summary: { created, kept, unconverted },
  }
}
