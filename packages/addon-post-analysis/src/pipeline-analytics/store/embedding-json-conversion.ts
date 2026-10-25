/**
 * Move the vectors that are still JSON text into the vector index — in place,
 * once, and then never again.
 *
 * ## Why this is not a migration framework
 *
 * Because it is not a migration. There is no schema version to advance and no
 * step to replay: a row is converted when its `embedding` column holds `[]` and
 * its vector is in the index, and that state is reached by doing the work or by
 * having been written after the conversion shipped. Running this on a converted
 * collection reads one page, finds nothing to do, and logs a zero — which is
 * the whole of its idempotence argument.
 *
 * The operator's instruction was exactly this: *"nessuna migrazione lato codice
 * necessaria, trasforma se necessario le entry correnti"*.
 *
 * ## The one rule
 *
 * **The JSON is not blanked until the vector has been READ BACK out of the
 * index.** A conversion that emptied the column on "the call returned" would
 * destroy the only copy of an enrolled person's face vector the first time the
 * index refused a write — and `EmbeddingVectorIndex.put` returns `false` for a
 * rejected upsert, not an exception, so "it returned" was never the same
 * statement as "it landed" (D58). Verifying by READING is stronger again, and
 * it is what makes the deploy order stop mattering: this addon and the
 * `vector-store` provider ship in different artefacts, so an addon can land on
 * a hub whose provider has no `fetchByIds` — there, every row refuses and keeps
 * its array instead of being drained into an index nothing can read from. A row
 * whose write did not land is retried on the next pass.
 *
 * ## Cost
 *
 * `better-sqlite3` runs on hub-main's only thread. So this pages, yields
 * between pages, and stops at a row ceiling — the same discipline as the orphan
 * audit, for the same reason. The two collections it converts hold 1,558 and
 * 128 rows on the live hub, so one pass finishes; the bounds are there because
 * a table nothing bounds is how every one of these loops got expensive.
 */

import type { IScopedLogger } from '@camstack/types'
import type { EmbeddingVectorIndex, EmbeddingVectorWrite } from './embedding-vector-index.js'

/** Rows read per page. Wide enough to finish in one pass, small enough to yield. */
const CONVERSION_PAGE = 200

/** Rows one pass will touch. A ceiling, not a target. */
const CONVERSION_MAX_ROWS = 20_000

/** Ids named in the "could not convert" line before it stops. */
const REFUSED_IDS_LOGGED = 10

export interface EmbeddingConversionRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

export interface EmbeddingConversionSpec {
  readonly collection: string
  readonly vectors: EmbeddingVectorIndex
  /**
   * Build the index write for one row. `null` refuses the row — a row that
   * cannot say which model produced its vector is not convertible, and guessing
   * a modelId puts an incomparable vector in the gallery.
   */
  readonly write: (
    id: string,
    embedding: readonly number[],
    data: Record<string, unknown>,
  ) => EmbeddingVectorWrite | null
  /** One page of the collection's rows, through its records-kind ledger. */
  readonly pageRows: (limit: number, offset: number) => Promise<readonly EmbeddingConversionRow[]>
  /** Blank the row's JSON `embedding` column through the same ledger. */
  readonly drainEmbedding: (id: string) => Promise<void>
}

export interface EmbeddingConversionDeps {
  readonly logger: IScopedLogger
  readonly breathe?: () => Promise<void>
}

export interface EmbeddingConversionReport {
  readonly collection: string
  readonly examined: number
  /** Rows that already held `[]` — nothing to do. */
  readonly alreadyConverted: number
  readonly converted: number
  /** Rows whose index write did not land. They keep their JSON and are retried. */
  readonly refused: number
  /** Rows whose column was neither `[]` nor a usable float array. */
  readonly unusable: number
  readonly stoppedBy: 'exhausted' | 'row-ceiling' | 'page-failed'
}

/** A stored `embedding` column, narrowed. */
function floatsOf(raw: unknown): readonly number[] | null {
  if (!Array.isArray(raw)) return null
  const out: number[] = []
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    out.push(v)
  }
  return out
}

/**
 * Convert one collection. Never throws — a failed page ends the pass with what
 * it has, and the next boot picks the rest up.
 */
export async function convertJsonEmbeddings(
  spec: EmbeddingConversionSpec,
  deps: EmbeddingConversionDeps,
): Promise<EmbeddingConversionReport> {
  let examined = 0
  let alreadyConverted = 0
  let converted = 0
  let refused = 0
  let unusable = 0
  let offset = 0
  let stoppedBy: EmbeddingConversionReport['stoppedBy'] = 'exhausted'
  const refusedIds: string[] = []

  while (examined < CONVERSION_MAX_ROWS) {
    let rows: readonly EmbeddingConversionRow[]
    try {
      rows = await spec.pageRows(CONVERSION_PAGE, offset)
    } catch (err) {
      deps.logger.warn('embedding conversion: page failed — pass abandoned', {
        meta: { collection: spec.collection, offset, error: String(err) },
      })
      stoppedBy = 'page-failed'
      break
    }
    if (rows.length === 0) break

    for (const row of rows) {
      examined += 1
      const data = row.data as Record<string, unknown>
      const raw = data['embedding']
      if (Array.isArray(raw) && raw.length === 0) {
        alreadyConverted += 1
        continue
      }
      const embedding = floatsOf(raw)
      if (embedding === null || embedding.length === 0) {
        // Neither a drained column nor a vector. Counted, never touched: a row
        // whose column is unreadable is exactly the row a blanking write would
        // destroy for good.
        unusable += 1
        continue
      }
      const write = spec.write(row.id, embedding, data)
      if (write === null || !(await spec.vectors.put(write))) {
        refused += 1
        if (refusedIds.length < REFUSED_IDS_LOGGED) refusedIds.push(row.id)
        continue
      }
      // WRITTEN is not READABLE, and only the second one licenses the blank.
      //
      // This is a version-skew guard as much as a D58 one. The addon and the
      // `vector-store` provider ship in DIFFERENT artefacts — the provider is a
      // builtin inside `@camstack/server`, the addon is deployed on its own — so
      // an addon can land on a hub whose provider predates `fetchByIds`. Upserts
      // would succeed, read-backs would fail, and a conversion that blanked on
      // the upsert alone would drain the gallery into an index it cannot read
      // from. Verifying makes the deploy ORDER stop mattering: on an old
      // provider every row simply refuses and keeps its JSON.
      const readBack = await spec.vectors.load([row.id])
      if ((readBack.get(row.id)?.length ?? 0) !== embedding.length) {
        refused += 1
        if (refusedIds.length < REFUSED_IDS_LOGGED) refusedIds.push(row.id)
        continue
      }
      try {
        // ONLY now. The array is the only copy until this line, and the line
        // above is the confirmation that it no longer is.
        await spec.drainEmbedding(row.id)
        converted += 1
      } catch (err) {
        // The vector is in the index and the array is still on the row. That is
        // a safe state — `loadGallery` prefers the index — and the next pass
        // will simply re-write the same vector and try the blank again.
        refused += 1
        deps.logger.warn('embedding conversion: row kept its JSON after a successful index write', {
          meta: { collection: spec.collection, id: row.id, error: String(err) },
        })
      }
    }

    if (deps.breathe) await deps.breathe()
    offset += rows.length
    if (rows.length < CONVERSION_PAGE) break
  }
  if (examined >= CONVERSION_MAX_ROWS) stoppedBy = 'row-ceiling'

  if (refused > 0) {
    // A branch that drops work says so, and names enough rows to find them.
    deps.logger.warn('embedding conversion: rows could not be moved into the index', {
      meta: {
        collection: spec.collection,
        index: spec.vectors.name,
        refused,
        ids: refusedIds,
        why: 'the index refused the write or the row named no model — these rows KEEP their JSON vector and are retried on the next pass',
      },
    })
  }
  deps.logger.info('embedding conversion', {
    meta: {
      collection: spec.collection,
      index: spec.vectors.name,
      examined,
      alreadyConverted,
      converted,
      refused,
      unusable,
      stoppedBy,
    },
  })

  return {
    collection: spec.collection,
    examined,
    alreadyConverted,
    converted,
    refused,
    unusable,
    stoppedBy,
  }
}
