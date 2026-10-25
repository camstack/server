/**
 * The named failures of `ctx.records` (D881).
 *
 * A records call crosses a worker thread, a UDS channel and a tRPC router, and
 * an error class does not survive any of them - only its message does. So
 * every message STARTS with a stable code, `records/<code>: <detail>`, and
 * {@link recordsErrorFromMessage} rebuilds the typed class on the caller's side.
 * A failed read is never `[]` or `undefined`: it throws one of these.
 */

/** Every code a records failure carries. */
export const RECORDS_ERROR_CODES = [
  'rev-conflict',
  'too-large',
  'unindexed-filter',
  'filter-required',
  'unknown-kind',
  'not-found',
  'unique-violation',
  'plaintext-secret',
  'foreign-marker',
  'secret-unavailable',
  'invalid-record',
  'declaration-refused',
  'no-caller',
  'batch-too-large',
  'transact-refused',
] as const
export type RecordsErrorCode = (typeof RECORDS_ERROR_CODES)[number]

const PREFIX = 'records/'

/** The base of every records failure. `detail` is the human part of the message. */
export class RecordsError extends Error {
  readonly code: RecordsErrorCode
  readonly detail: string

  constructor(code: RecordsErrorCode, detail: string) {
    super(`${PREFIX}${code}: ${detail}`)
    this.name = 'RecordsError'
    this.code = code
    this.detail = detail
  }
}

/** A write guarded by `ifRev` found another revision (or an existing row for `ifRev: 0`). */
export class RevConflictError extends RecordsError {
  constructor(detail: string) {
    super('rev-conflict', detail)
    this.name = 'RevConflictError'
  }
}

/** `data` exceeds the kind's `maxDataBytes`. Bytes are never record fields (D613). */
export class RecordTooLargeError extends RecordsError {
  constructor(detail: string) {
    super('too-large', detail)
    this.name = 'RecordTooLargeError'
  }
}

/** A filter, order or aggregate names a field no declared index serves. */
export class UnindexedFilterError extends RecordsError {
  constructor(detail: string) {
    super('unindexed-filter', detail)
    this.name = 'UnindexedFilterError'
  }
}

/** A bulk delete with no predicate at all. */
export class FilterRequiredError extends RecordsError {
  constructor(detail: string) {
    super('filter-required', detail)
    this.name = 'FilterRequiredError'
  }
}

/** The caller declared no such kind (another addon's kind is indistinguishable from none). */
export class UnknownRecordKindError extends RecordsError {
  constructor(detail: string) {
    super('unknown-kind', detail)
    this.name = 'UnknownRecordKindError'
  }
}

export class RecordNotFoundError extends RecordsError {
  constructor(detail: string) {
    super('not-found', detail)
    this.name = 'RecordNotFoundError'
  }
}

/** A unique index refused the write. */
export class RecordUniqueViolationError extends RecordsError {
  constructor(detail: string) {
    super('unique-violation', detail)
    this.name = 'RecordUniqueViolationError'
  }
}

/** A secret field held a plain string where only a keychain marker may be stored. */
export class PlaintextSecretError extends RecordsError {
  constructor(detail: string) {
    super('plaintext-secret', detail)
    this.name = 'PlaintextSecretError'
  }
}

/** A marker whose ref is not the row's own (the D878 rule). */
export class ForeignSecretMarkerError extends RecordsError {
  constructor(detail: string) {
    super('foreign-marker', detail)
    this.name = 'ForeignSecretMarkerError'
  }
}

/** The keychain could not store or serve a value: explicit, never an empty string. */
export class RecordSecretUnavailableError extends RecordsError {
  constructor(detail: string) {
    super('secret-unavailable', detail)
    this.name = 'RecordSecretUnavailableError'
  }
}

export class InvalidRecordError extends RecordsError {
  constructor(detail: string) {
    super('invalid-record', detail)
    this.name = 'InvalidRecordError'
  }
}

/** A kind declaration the engine refuses (non-additive change, bad shape, wrong file). */
export class DeclarationRefusedError extends RecordsError {
  constructor(detail: string) {
    super('declaration-refused', detail)
    this.name = 'DeclarationRefusedError'
  }
}

export class NoCallerError extends RecordsError {
  constructor(detail: string) {
    super('no-caller', detail)
    this.name = 'NoCallerError'
  }
}

export class BatchTooLargeError extends RecordsError {
  constructor(detail: string) {
    super('batch-too-large', detail)
    this.name = 'BatchTooLargeError'
  }
}

/**
 * A `transact` the engine refuses before touching a row: an op on a kind the
 * caller did not declare in ONE file and ONE `transactFamily`. The detail names
 * which rule (`cross-file`, `cross-family`, `no-family`); it is never a silent split.
 */
export class TransactRefusedError extends RecordsError {
  constructor(detail: string) {
    super('transact-refused', detail)
    this.name = 'TransactRefusedError'
  }
}

type ErrorFactory = (detail: string) => RecordsError

const FACTORIES: Readonly<Record<RecordsErrorCode, ErrorFactory>> = {
  'rev-conflict': (d) => new RevConflictError(d),
  'too-large': (d) => new RecordTooLargeError(d),
  'unindexed-filter': (d) => new UnindexedFilterError(d),
  'filter-required': (d) => new FilterRequiredError(d),
  'unknown-kind': (d) => new UnknownRecordKindError(d),
  'not-found': (d) => new RecordNotFoundError(d),
  'unique-violation': (d) => new RecordUniqueViolationError(d),
  'plaintext-secret': (d) => new PlaintextSecretError(d),
  'foreign-marker': (d) => new ForeignSecretMarkerError(d),
  'secret-unavailable': (d) => new RecordSecretUnavailableError(d),
  'invalid-record': (d) => new InvalidRecordError(d),
  'declaration-refused': (d) => new DeclarationRefusedError(d),
  'no-caller': (d) => new NoCallerError(d),
  'batch-too-large': (d) => new BatchTooLargeError(d),
  'transact-refused': (d) => new TransactRefusedError(d),
}

function isCode(value: string): value is RecordsErrorCode {
  return RECORDS_ERROR_CODES.some((code) => code === value)
}

/**
 * Rebuild the typed error from a message that crossed a wire; `null` when the
 * message is not a records failure.
 */
export function recordsErrorFromMessage(message: string): RecordsError | null {
  if (!message.startsWith(PREFIX)) return null
  const colon = message.indexOf(': ')
  if (colon < 0) return null
  const code = message.slice(PREFIX.length, colon)
  if (!isCode(code)) return null
  return FACTORIES[code](message.slice(colon + 2))
}

/** The records failure inside any thrown value (a wrapped tRPC error included), or the value. */
export function asRecordsError(err: unknown): unknown {
  if (err instanceof RecordsError) return err
  if (err instanceof Error) {
    const typed = recordsErrorFromMessage(err.message)
    if (typed !== null) return typed
  }
  return err
}
