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

/**
 * Cross-realm brand. An addon bundles its own copy of this module (D15) while
 * `ctx.records` is the HOST's door, so an error thrown by the host is an
 * instance of the host's classes, not of the addon's. The brand plus the code
 * make `instanceof` answer by identity of the failure, not of the copy.
 */
const RECORDS_ERROR_BRAND = Symbol.for('camstack.records-error')

function carriesBrand(value: unknown): value is { readonly code?: unknown } {
  return typeof value === 'object' && value !== null && Reflect.get(value, RECORDS_ERROR_BRAND) === true
}

/** The base of every records failure. `detail` is the human part of the message. */
export class RecordsError extends Error {
  /** The code a subclass stands for; the base stands for every code. */
  static readonly code: RecordsErrorCode | undefined = undefined

  /**
   * `instanceof` across copies of this module: any branded error is a
   * `RecordsError`, and is an instance of a subclass only when its code is the
   * subclass's code. Same-copy answers are unchanged.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true
    if (!carriesBrand(value)) return false
    return this.code === undefined || value.code === this.code
  }

  readonly code: RecordsErrorCode
  readonly detail: string
  readonly [RECORDS_ERROR_BRAND] = true

  constructor(code: RecordsErrorCode, detail: string) {
    super(`${PREFIX}${code}: ${detail}`)
    this.name = 'RecordsError'
    this.code = code
    this.detail = detail
  }
}

/** A write guarded by `ifRev` found another revision (or an existing row for `ifRev: 0`). */
export class RevConflictError extends RecordsError {
  static readonly code = 'rev-conflict' as const
  constructor(detail: string) {
    super(RevConflictError.code, detail)
    this.name = 'RevConflictError'
  }
}

/** `data` exceeds the kind's `maxDataBytes`. Bytes are never record fields (D613). */
export class RecordTooLargeError extends RecordsError {
  static readonly code = 'too-large' as const
  constructor(detail: string) {
    super(RecordTooLargeError.code, detail)
    this.name = 'RecordTooLargeError'
  }
}

/** A filter, order or aggregate names a field no declared index serves. */
export class UnindexedFilterError extends RecordsError {
  static readonly code = 'unindexed-filter' as const
  constructor(detail: string) {
    super(UnindexedFilterError.code, detail)
    this.name = 'UnindexedFilterError'
  }
}

/** A bulk delete with no predicate at all. */
export class FilterRequiredError extends RecordsError {
  static readonly code = 'filter-required' as const
  constructor(detail: string) {
    super(FilterRequiredError.code, detail)
    this.name = 'FilterRequiredError'
  }
}

/** The caller declared no such kind (another addon's kind is indistinguishable from none). */
export class UnknownRecordKindError extends RecordsError {
  static readonly code = 'unknown-kind' as const
  constructor(detail: string) {
    super(UnknownRecordKindError.code, detail)
    this.name = 'UnknownRecordKindError'
  }
}

export class RecordNotFoundError extends RecordsError {
  static readonly code = 'not-found' as const
  constructor(detail: string) {
    super(RecordNotFoundError.code, detail)
    this.name = 'RecordNotFoundError'
  }
}

/** A unique index refused the write. */
export class RecordUniqueViolationError extends RecordsError {
  static readonly code = 'unique-violation' as const
  constructor(detail: string) {
    super(RecordUniqueViolationError.code, detail)
    this.name = 'RecordUniqueViolationError'
  }
}

/** A secret field held a plain string where only a keychain marker may be stored. */
export class PlaintextSecretError extends RecordsError {
  static readonly code = 'plaintext-secret' as const
  constructor(detail: string) {
    super(PlaintextSecretError.code, detail)
    this.name = 'PlaintextSecretError'
  }
}

/** A marker whose ref is not the row's own (the D878 rule). */
export class ForeignSecretMarkerError extends RecordsError {
  static readonly code = 'foreign-marker' as const
  constructor(detail: string) {
    super(ForeignSecretMarkerError.code, detail)
    this.name = 'ForeignSecretMarkerError'
  }
}

/** The keychain could not store or serve a value: explicit, never an empty string. */
export class RecordSecretUnavailableError extends RecordsError {
  static readonly code = 'secret-unavailable' as const
  constructor(detail: string) {
    super(RecordSecretUnavailableError.code, detail)
    this.name = 'RecordSecretUnavailableError'
  }
}

export class InvalidRecordError extends RecordsError {
  static readonly code = 'invalid-record' as const
  constructor(detail: string) {
    super(InvalidRecordError.code, detail)
    this.name = 'InvalidRecordError'
  }
}

/** A kind declaration the engine refuses (non-additive change, bad shape, wrong file). */
export class DeclarationRefusedError extends RecordsError {
  static readonly code = 'declaration-refused' as const
  constructor(detail: string) {
    super(DeclarationRefusedError.code, detail)
    this.name = 'DeclarationRefusedError'
  }
}

export class NoCallerError extends RecordsError {
  static readonly code = 'no-caller' as const
  constructor(detail: string) {
    super(NoCallerError.code, detail)
    this.name = 'NoCallerError'
  }
}

export class BatchTooLargeError extends RecordsError {
  static readonly code = 'batch-too-large' as const
  constructor(detail: string) {
    super(BatchTooLargeError.code, detail)
    this.name = 'BatchTooLargeError'
  }
}

/**
 * A `transact` the engine refuses before touching a row: an op on a kind the
 * caller did not declare in ONE file and ONE `transactFamily`. The detail names
 * which rule (`cross-file`, `cross-family`, `no-family`); it is never a silent split.
 */
export class TransactRefusedError extends RecordsError {
  static readonly code = 'transact-refused' as const
  constructor(detail: string) {
    super(TransactRefusedError.code, detail)
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
