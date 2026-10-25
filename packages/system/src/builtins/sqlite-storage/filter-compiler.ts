/**
 * One filter compiler for both the read and the bulk-mutation paths.
 *
 * It exists because those two paths must NOT behave the same way, and until
 * now the only compiler lived inline in `query` — where being forgiving is
 * correct. Reusing it verbatim for `deleteWhere` would have shipped two
 * data-loss shapes:
 *
 *  - **A dropped predicate.** A field that is not a column of a structured
 *    table is skipped, so `{ deviceId: 101, kind: 'motion' }` can compile to
 *    `WHERE "deviceId" = ?` — on a SELECT that returns extra rows, on a DELETE
 *    it removes rows the caller meant to keep.
 *  - **No predicate at all.** An empty filter compiles to an empty WHERE,
 *    which on a DELETE is the entire collection.
 *
 * `select` mode keeps the historical behaviour, because every existing caller
 * was written against it. `mutate` mode refuses both, before any SQL exists.
 * Emptying a collection is a legitimate thing to want, and it should be a
 * differently-named operation rather than a filter that happens to be empty.
 * `measure` mode sits between them — see {@link FilterMode}.
 *
 * ── NULL is a value the language can name ────────────────────────────────
 *
 * A `null` on the right-hand side of `where` / `whereNot` compiles to `IS NULL`
 * / `IS NOT NULL`, and binds no parameter. It used to compile to `= ?` / `!= ?`
 * with a NULL parameter, and SQL three-valued logic makes both of those NULL
 * for every row: the filter matched NOTHING and the caller got a `0` that
 * looked like an answer. `pipelineAnalytics.countUnstampedEventMedia` — the
 * gate that decides whether 152 GB of event media may be repointed onto
 * another disk — asks exactly "how many rows have no `locationId`", and `0` is
 * the one value that opens it. `whereNot: { field: null }` was the same defect
 * mirrored: `(expr IS NULL OR expr != NULL)` is TRUE for a NULL row and NULL
 * for every other, so it selected precisely the rows it was asked to exclude.
 *
 * Nothing could ever have MEANT `= NULL`; there is no caller to preserve.
 */

/** The part of a declared collection this compiler needs. */
export interface CollectionShape {
  readonly primaryKey: string
  readonly columns: ReadonlySet<string>
  /**
   * The single JSON blob column for a KV-shaped collection (fields inside it
   * are reachable via `json_extract`), or `null` for a structured table whose
   * fields are real columns.
   */
  readonly kvBlobColumn: string | null
}

/**
 * How forgiving this compilation is allowed to be.
 *
 * - `select` — a predicate naming a field the collection cannot express is
 *   SKIPPED. The caller receives the rows and can see for itself that the
 *   filter did not bite; the cost is extra rows, not a wrong belief.
 * - `measure` — the same predicate is REFUSED. A count, an aggregate or a
 *   histogram hands back a NUMBER: the whole collection and the intended
 *   subset are the same shape, and the caller has no way to tell which one it
 *   was given. An empty filter is still fine — `COUNT(*)` over everything is a
 *   legitimate question, unlike `DELETE` over everything. This closes the
 *   asymmetry `aggregate` already applied to its FIELDS ("a dropped aggregate
 *   returns a number that is wrong and looks exactly like a real one") but not
 *   to its predicate.
 * - `mutate` — refuses that AND an empty filter, which on a bulk write is the
 *   entire collection.
 */
export type FilterMode = 'select' | 'measure' | 'mutate'

/** Marshals a JS value to what the driver should bind. */
export type SerializeValue = (value: unknown) => unknown

export interface QueryFilterInput {
  /** Equality. A `null` value means `IS NULL` — see the file docblock. */
  readonly where?: Readonly<Record<string, unknown>>
  readonly whereIn?: Readonly<Record<string, readonly unknown[]>>
  readonly whereBetween?: Readonly<Record<string, readonly [unknown, unknown]>>
  /**
   * NULL-safe exclusion, compiled as `(expr IS NULL OR expr != ?)`. SQL `!=`
   * alone drops NULL rows, and on a nullable column those are precisely the
   * rows a "not this kind" filter must keep (they predate the column).
   *
   * A `null` VALUE means `IS NOT NULL` instead: "everything except the rows
   * that carry no value" is the only reading of `whereNot: { f: null }` that
   * is not a contradiction.
   */
  readonly whereNot?: Readonly<Record<string, unknown>>
  /**
   * NULL-safe exclusion of a SET, compiled as
   * `(expr IS NULL OR expr NOT IN (…))` — `whereNot` for more than one value.
   * See `QueryFilter.whereNotIn` for why it is a separate operator and not a
   * `whereNot` that happens to take an array.
   *
   * An EMPTY list is no predicate at all, not "matches nothing" — the same
   * reading `whereJsonArrayAny` gives it.
   */
  readonly whereNotIn?: Readonly<Record<string, readonly unknown[]>>
  /**
   * JSON-array membership, compiled as
   * `(expr IS NULL OR NOT json_valid(expr) OR EXISTS (SELECT 1 FROM
   * json_each(expr) WHERE value IN (…)))`.
   *
   * A SUPERSET prefilter on purpose — see `QueryFilter.whereJsonArrayAny`. An
   * unreadable column keeps its row rather than losing it, so this can narrow
   * a read without ever changing an answer.
   */
  readonly whereJsonArrayAny?: Readonly<Record<string, readonly unknown[]>>
}

/**
 * The predicate-only filter a bulk mutation accepts — no ordering, no limit.
 * Structurally the mutation half of {@link QueryFilterInput}.
 */
export type MutationFilterInput = QueryFilterInput

export interface CompiledFilter {
  /** Either `''` or a leading-space ` WHERE …` clause, ready to concatenate. */
  readonly whereSql: string
  readonly params: readonly unknown[]
}

/** Thrown by `measure` and `mutate` mode. Distinct type so a caller can map it
 *  to a 400. */
export class UnsafeFilterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeFilterError'
  }
}

/**
 * SQL expression for `field` on this collection, or `null` when it cannot be
 * expressed: a real column → `"field"`; a KV blob field → `json_extract`;
 * anything else on a structured table → unresolvable. Exported because
 * `histogram` needs the same resolution for its bucketed column.
 */
export function fieldExprFor(field: string, shape: CollectionShape): string | null {
  if (field === shape.primaryKey || shape.columns.has(field)) return `"${field}"`
  if (shape.kvBlobColumn !== null) return `json_extract("${shape.kvBlobColumn}", '$.${field}')`
  return null
}

export function compileFilter(
  filter: QueryFilterInput | undefined,
  shape: CollectionShape,
  mode: FilterMode,
  serialize: SerializeValue,
): CompiledFilter {
  const clauses: string[] = []
  const params: unknown[] = []

  const resolve = (field: string): string | null => {
    const expr = fieldExprFor(field, shape)
    if (expr === null && mode === 'mutate') {
      throw new UnsafeFilterError(
        `filter refers to "${field}", which this collection cannot express — refusing to run a bulk mutation with a dropped predicate`,
      )
    }
    if (expr === null && mode === 'measure') {
      throw new UnsafeFilterError(
        `filter refers to "${field}", which this collection cannot express — refusing to answer with a number counted over a different question`,
      )
    }
    return expr
  }

  for (const [field, value] of Object.entries(filter?.where ?? {})) {
    const expr = resolve(field)
    if (expr === null) continue
    // `= NULL` is NULL for every row: the predicate would match nothing and
    // report it as an answer. NULL is named, not compared.
    if (value === null) {
      clauses.push(`${expr} IS NULL`)
      continue
    }
    clauses.push(`${expr} = ?`)
    params.push(serialize(value))
  }

  for (const [field, values] of Object.entries(filter?.whereIn ?? {})) {
    const expr = resolve(field)
    if (expr === null) continue
    if (values.length === 0) {
      if (mode === 'mutate') {
        throw new UnsafeFilterError(
          `filter has an empty whereIn list for "${field}" — it matches nothing, which is more likely a caller bug than an intent`,
        )
      }
      continue
    }
    clauses.push(`${expr} IN (${values.map(() => '?').join(', ')})`)
    for (const v of values) params.push(serialize(v))
  }

  for (const [field, values] of Object.entries(filter?.whereJsonArrayAny ?? {})) {
    const expr = resolve(field)
    if (expr === null) continue
    // An empty list is "no selection", i.e. no filter — NOT "matches nothing".
    // Every caller of this operator is a chip row, and a chip row with nothing
    // selected is an operator who has not narrowed anything.
    if (values.length === 0) continue
    const placeholders = values.map(() => '?').join(', ')
    clauses.push(
      `(${expr} IS NULL OR NOT json_valid(${expr}) OR EXISTS (SELECT 1 FROM json_each(${expr}) WHERE value IN (${placeholders})))`,
    )
    for (const v of values) params.push(serialize(v))
  }

  for (const [field, [low, high]] of Object.entries(filter?.whereBetween ?? {})) {
    const expr = resolve(field)
    if (expr === null) continue
    clauses.push(`${expr} BETWEEN ? AND ?`)
    params.push(serialize(low), serialize(high))
  }

  for (const [field, value] of Object.entries(filter?.whereNot ?? {})) {
    const expr = resolve(field)
    if (expr === null) continue
    // The NULL-safe form below is TRUE for a NULL row and NULL for every other
    // when the bound value is itself NULL — the exact inverse of "not null".
    if (value === null) {
      clauses.push(`${expr} IS NOT NULL`)
      continue
    }
    clauses.push(`(${expr} IS NULL OR ${expr} != ?)`)
    params.push(serialize(value))
  }

  for (const [field, values] of Object.entries(filter?.whereNotIn ?? {})) {
    const expr = resolve(field)
    if (expr === null) continue
    // Empty is "nothing excluded" — a chip row with nothing selected, not a
    // predicate that matches no row.
    if (values.length === 0) continue
    // `NOT IN (…, NULL)` is NULL for EVERY row, so a listed `null` is named
    // rather than bound — it means "also exclude the rows carrying no value",
    // which is the only reading that is not a contradiction. Same treatment
    // `whereNot: { f: null }` gets above.
    const hasNull = values.some((v) => v === null)
    const rest = values.filter((v) => v !== null)
    if (rest.length === 0) {
      clauses.push(`${expr} IS NOT NULL`)
      continue
    }
    const placeholders = rest.map(() => '?').join(', ')
    clauses.push(
      hasNull
        ? `(${expr} IS NOT NULL AND ${expr} NOT IN (${placeholders}))`
        : `(${expr} IS NULL OR ${expr} NOT IN (${placeholders}))`,
    )
    for (const v of rest) params.push(serialize(v))
  }

  if (clauses.length === 0 && mode === 'mutate') {
    throw new UnsafeFilterError(
      'filter compiled to no predicate — that would affect every row in the collection; use the explicit clear operation if that is the intent',
    )
  }

  return {
    whereSql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}
