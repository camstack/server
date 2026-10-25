/**
 * The typed errors of the owned-file layer (D851).
 *
 * They cross a thread boundary by NAME: a worker serialises `{ name, message,
 * code? }` and the main thread rebuilds the class with {@link rehydrateError},
 * so a caller's `instanceof CollectionPlacementError` survives the hop.
 */
import type { DataStoreDatabase } from '@camstack/types'

/**
 * A collection was declared for one file while its table already lives in
 * another. The engine never moves a table: moving is the offline split
 * script's job (D853). This is the safety net that turns an accidental deploy
 * to an unconverted hub into a loud failure of ONE addon instead of a silent
 * empty file beside the real rows.
 */
export class CollectionPlacementError extends Error {
  constructor(
    readonly table: string,
    readonly livesIn: DataStoreDatabase,
    readonly declaredFor: DataStoreDatabase,
  ) {
    super(
      `table "${table}" is in "${livesIn}", declared for "${declaredFor}"; the engine never moves data (D853) — the table must be moved offline, with the hub stopped`,
    )
    this.name = 'CollectionPlacementError'
  }
}

/** A collection declared in two files at boot: the layout is corrupt and is not served. */
export class DuplicatePlacementError extends Error {
  constructor(
    readonly table: string,
    readonly first: DataStoreDatabase,
    readonly second: DataStoreDatabase,
  ) {
    super(
      `table "${table}" is declared in both "${first}" and "${second}"; the layout is corrupt and is not served`,
    )
    this.name = 'DuplicatePlacementError'
  }
}

/** A `transact` whose ops resolve to more than one database file. */
export class CrossDatabaseTransactError extends Error {
  constructor(readonly databases: readonly DataStoreDatabase[]) {
    super(
      `transact spans more than one database file (${databases.join(', ')}); a transaction is one file`,
    )
    this.name = 'CrossDatabaseTransactError'
  }
}

/** A worker already has its in-flight bound of calls queued; the call is refused, never queued. */
export class DatabaseBusyError extends Error {
  constructor(
    readonly databaseId: DataStoreDatabase,
    readonly inFlight: number,
  ) {
    super(`database "${databaseId}" is busy: ${inFlight} calls in flight`)
    this.name = 'DatabaseBusyError'
  }
}

/** An id-addressed call (get/set/update/delete/insert/upsert/guard) on a composite-keyed collection. */
export class CompositeKeyError extends Error {
  constructor(
    readonly table: string,
    readonly op: string,
    readonly keyColumns: readonly string[],
  ) {
    super(
      `${op} on "${table}": the collection has a composite key (${keyColumns.join(', ')}) and no id — write it with insertMany/upsertMany/transact, read it with query/count/aggregate, delete with deleteWhere`,
    )
    this.name = 'CompositeKeyError'
  }
}

/** The wire form of an error that crossed the worker boundary. */
export interface SerializedError {
  readonly name: string
  readonly message: string
  readonly code?: string
}

/** Error classes the engine raises that a caller may test with `instanceof`. */
const REHYDRATED: ReadonlyMap<string, object> = new Map<string, object>([
  ['CollectionPlacementError', CollectionPlacementError.prototype],
  ['CrossDatabaseTransactError', CrossDatabaseTransactError.prototype],
  ['DuplicatePlacementError', DuplicatePlacementError.prototype],
  ['DatabaseBusyError', DatabaseBusyError.prototype],
  ['CompositeKeyError', CompositeKeyError.prototype],
])

/**
 * An Error on `proto` carrying `name` and `message`. Built with
 * `Object.create` because the constructors take structured fields the wire
 * does not carry — the revived instance answers `instanceof` and `name` /
 * `message`; its structured fields are `undefined`.
 */
function revive(proto: object, name: string, message: string): Error {
  const err: Error = Object.create(proto)
  Object.defineProperties(err, {
    name: { value: name, writable: true, configurable: true },
    message: { value: message, writable: true, configurable: true },
    stack: { value: `${name}: ${message}`, writable: true, configurable: true },
  })
  return err
}

/** Flatten any thrown value for `postMessage`. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const code = 'code' in err && typeof err.code === 'string' ? err.code : undefined
    return { name: err.name, message: err.message, ...(code !== undefined ? { code } : {}) }
  }
  return { name: 'Error', message: String(err) }
}

/**
 * Rebuild an error on the main thread. A name this module knows comes back as
 * an instance of its class (`instanceof` works); anything else comes back as a
 * plain Error with the name and code preserved.
 */
export function rehydrateError(serialized: SerializedError): Error {
  const err = revive(
    REHYDRATED.get(serialized.name) ?? Error.prototype,
    serialized.name,
    serialized.message,
  )
  if (serialized.code !== undefined) Object.assign(err, { code: serialized.code })
  return err
}
