/**
 * Error types for the safe expression engine. Two distinct classes so callers
 * can tell a compile-time (grammar) failure from a runtime (evaluation)
 * failure — both are non-fatal to the host: read paths degrade to "skip link".
 */

/** Thrown by the tokenizer / parser. Carries a 0-based source `position` when
 *  the failure is anchored to a character (author-facing inline feedback). */
export class ExpressionParseError extends Error {
  readonly position?: number
  constructor(message: string, position?: number) {
    super(message)
    this.name = 'ExpressionParseError'
    this.position = position
  }
}

/** Thrown by the evaluator (unknown identifier, type mismatch, non-finite
 *  result, unknown builtin, step-budget exceeded). */
export class ExpressionEvalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpressionEvalError'
  }
}
