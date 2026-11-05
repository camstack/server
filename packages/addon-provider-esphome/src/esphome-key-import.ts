/**
 * Import the API encryption keys of the boards CamStack already runs from a
 * `board-key-source` (the ESPHome builder beside Home Assistant).
 *
 * Every board gets exactly one outcome, with a reason when it was not imported:
 * a board whose key could not be read is reported, never skipped in silence,
 * and a failed read never reaches {@link KeyImportBoards.setBoardKey}, so a key
 * the board already has is never cleared by an import that could not read one.
 * The key itself is never logged.
 */
import type {
  BoardKeyBoard,
  BoardKeyFailureReason,
  BoardKeyListResult,
  BoardKeyResult,
  BoardKeySource,
  IScopedLogger,
} from '@camstack/types'
import type { EspBrokerEntry } from './config.js'

export type KeyImportReason =
  | BoardKeyFailureReason
  | 'no-source'
  | 'no-match'
  | 'ambiguous'
  | 'store-failed'

export interface BoardKeyImportResult {
  readonly boardId: string
  readonly name: string
  readonly outcome: 'imported' | 'unchanged' | 'not-imported'
  readonly reason?: KeyImportReason
  readonly sourceId?: string
}

/** The slice of the generated `boardKeySource` client the import uses. */
export interface KeySourceClient {
  listSources(): Promise<readonly BoardKeySource[]>
  listBoards(input: { readonly sourceId: string }): Promise<BoardKeyListResult>
  getBoardKey(input: {
    readonly sourceId: string
    readonly configuration: string
  }): Promise<BoardKeyResult>
}

export interface KeyImportBoards {
  boards(): readonly EspBrokerEntry[]
  setBoardKey(
    integrationId: string,
    boardId: string,
    key: string,
  ): Promise<'set' | 'unchanged' | 'missing'>
}

export interface KeyImportDeps {
  readonly boards: KeyImportBoards
  readonly keySources: KeySourceClient
  readonly logger: IScopedLogger
  /** Limit the import to one integration's boards. */
  readonly integrationId?: string
}

interface SourceListing {
  readonly source: BoardKeySource
  readonly result: BoardKeyListResult
}

function hostLabel(host: string): string {
  const first = host.split('.')[0]
  return (first ?? host).toLowerCase()
}

function matches(entry: EspBrokerEntry, candidate: BoardKeyBoard): boolean {
  const name = candidate.name.toLowerCase()
  const host = entry.connection.host.toLowerCase()
  if (entry.name.toLowerCase() === name) return true
  if (hostLabel(host) === name) return true
  return candidate.address !== null && candidate.address.toLowerCase() === host
}

export async function importBoardKeys(
  deps: KeyImportDeps,
): Promise<readonly BoardKeyImportResult[]> {
  const entries = deps.boards
    .boards()
    .filter((b) => deps.integrationId === undefined || b.integrationId === deps.integrationId)
  if (entries.length === 0) return []

  const listings: SourceListing[] = []
  let sources: readonly BoardKeySource[] = []
  try {
    sources = await deps.keySources.listSources()
  } catch (err: unknown) {
    deps.logger.warn('key import: listing key sources failed', {
      meta: { error: err instanceof Error ? err.message : 'unknown' },
    })
  }
  for (const source of sources) {
    listings.push({
      source,
      result: await deps.keySources.listBoards({ sourceId: source.sourceId }),
    })
  }

  const results: BoardKeyImportResult[] = []
  for (const entry of entries) {
    results.push(await importOne(deps, entry, listings))
  }
  return results
}

async function importOne(
  deps: KeyImportDeps,
  entry: EspBrokerEntry,
  listings: readonly SourceListing[],
): Promise<BoardKeyImportResult> {
  const base = { boardId: entry.id, name: entry.name }
  const refuse = (reason: KeyImportReason, sourceId?: string): BoardKeyImportResult => {
    deps.logger.warn('key import: board not imported', {
      meta: { boardId: entry.id, reason, ...(sourceId !== undefined ? { sourceId } : {}) },
    })
    return {
      ...base,
      outcome: 'not-imported',
      reason,
      ...(sourceId !== undefined ? { sourceId } : {}),
    }
  }
  if (listings.length === 0) return refuse('no-source')

  let firstFailure: { reason: BoardKeyFailureReason; sourceId: string } | null = null
  for (const { source, result } of listings) {
    if (!result.ok) {
      firstFailure ??= { reason: result.reason, sourceId: source.sourceId }
      continue
    }
    const found = result.boards.filter((c) => matches(entry, c))
    if (found.length > 1) return refuse('ambiguous', source.sourceId)
    const [candidate] = found
    if (candidate === undefined) continue
    const read = await deps.keySources.getBoardKey({
      sourceId: source.sourceId,
      configuration: candidate.configuration,
    })
    if (!read.ok) return refuse(read.reason, source.sourceId)
    let stored: 'set' | 'unchanged' | 'missing'
    try {
      stored = await deps.boards.setBoardKey(entry.integrationId ?? '', entry.id, read.key)
    } catch (err: unknown) {
      deps.logger.warn('key import: storing the key failed', {
        meta: { boardId: entry.id, error: err instanceof Error ? err.message : 'unknown' },
      })
      return refuse('store-failed', source.sourceId)
    }
    if (stored === 'missing') return refuse('no-match', source.sourceId)
    deps.logger.info('key import: board key stored', {
      meta: { boardId: entry.id, sourceId: source.sourceId, changed: stored === 'set' },
    })
    return {
      ...base,
      outcome: stored === 'set' ? 'imported' : 'unchanged',
      sourceId: source.sourceId,
    }
  }
  return firstFailure !== null
    ? refuse(firstFailure.reason, firstFailure.sourceId)
    : refuse('no-match')
}

/** One line per run for the admin form: counts, then each board with its outcome and reason. */
export function summarizeImport(results: readonly BoardKeyImportResult[]): string {
  if (results.length === 0) return 'No boards to import.'
  const count = (outcome: BoardKeyImportResult['outcome']): number =>
    results.filter((r) => r.outcome === outcome).length
  const head = `${count('imported')} imported, ${count('unchanged')} unchanged, ${count('not-imported')} not imported`
  const rows = results.map((r) => {
    const label = r.name.length > 0 ? r.name : r.boardId
    const verdict = r.outcome === 'not-imported' ? 'not imported' : r.outcome
    return r.reason === undefined ? `${label}: ${verdict}` : `${label}: ${verdict} (${r.reason})`
  })
  return `${head}. ${rows.join('; ')}`
}

/** What the lookup of one board's key answers; a key is only ever present on `found`. */
export type BoardKeyLookup =
  | { readonly outcome: 'found'; readonly key: string }
  | { readonly outcome: 'not-found'; readonly reason: KeyImportReason }

/**
 * Read the key of a board that is NOT saved yet (a board found on the network)
 * from the key sources, matching it by name or by host. Nothing is stored here:
 * the caller saves the key with the board, in one write. A failed read is
 * `not-found` with its reason, never an empty key.
 */
export async function lookupBoardKey(
  keySources: KeySourceClient,
  board: { readonly name: string; readonly host: string },
): Promise<BoardKeyLookup> {
  let sources: readonly BoardKeySource[] = []
  try {
    sources = await keySources.listSources()
  } catch {
    return { outcome: 'not-found', reason: 'no-source' }
  }
  if (sources.length === 0) return { outcome: 'not-found', reason: 'no-source' }
  const entry: EspBrokerEntry = {
    id: '',
    name: board.name,
    connection: { host: board.host, port: 0, noisePsk: '', password: '' },
  }
  let firstFailure: BoardKeyFailureReason | null = null
  for (const source of sources) {
    const result = await keySources.listBoards({ sourceId: source.sourceId })
    if (!result.ok) {
      firstFailure ??= result.reason
      continue
    }
    const found = result.boards.filter((c) => matches(entry, c))
    if (found.length > 1) return { outcome: 'not-found', reason: 'ambiguous' }
    const [candidate] = found
    if (candidate === undefined) continue
    const read = await keySources.getBoardKey({
      sourceId: source.sourceId,
      configuration: candidate.configuration,
    })
    return read.ok
      ? { outcome: 'found', key: read.key }
      : { outcome: 'not-found', reason: read.reason }
  }
  return { outcome: 'not-found', reason: firstFailure ?? 'no-match' }
}
