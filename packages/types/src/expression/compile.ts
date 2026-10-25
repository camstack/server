/**
 * LRU compile cache for parsed expressions (spec §2.4 "parse once … LRU keyed
 * by expr"). The cache stores BOTH successes and failures (negative caching),
 * so a corrupt persisted string costs exactly one tokenize+parse total — not
 * one per read on a hot resolve path.
 *
 * The cache is a module-level singleton: entries are pure, content-addressed
 * ASTs keyed by the raw source string, so sharing one instance across all
 * callers is safe and maximises hit rate.
 */
import { ExpressionParseError } from './errors.js'
import { parseExpression, type ParsedExpression } from './parser.js'
import { EXPRESSION_COMPILE_CACHE_CAPACITY } from './limits.js'

export type CompileResult =
  | { readonly ok: true; readonly parsed: ParsedExpression }
  | { readonly ok: false; readonly error: string }

const cache = new Map<string, CompileResult>()

function getCached(source: string): CompileResult {
  const hit = cache.get(source)
  if (hit !== undefined) {
    // LRU touch: delete + re-insert moves the key to the most-recent position.
    cache.delete(source)
    cache.set(source, hit)
    return hit
  }
  let result: CompileResult
  try {
    result = { ok: true, parsed: parseExpression(source) }
  } catch (err: unknown) {
    result = {
      ok: false,
      error: err instanceof ExpressionParseError ? err.message : String(err),
    }
  }
  cache.set(source, result)
  if (cache.size > EXPRESSION_COMPILE_CACHE_CAPACITY) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return result
}

/** Compile `source` to a `ParsedExpression`, throwing `ExpressionParseError`
 *  on failure. LRU/negative-cached. */
export function compileExpression(source: string): ParsedExpression {
  const result = getCached(source)
  if (result.ok) return result.parsed
  throw new ExpressionParseError(result.error)
}

/** Compile `source`, returning a discriminated result instead of throwing.
 *  Used by read paths that must degrade rather than raise. LRU/negative-cached. */
export function compileExpressionSafe(source: string): CompileResult {
  return getCached(source)
}

/** Test-only: clear the module-level cache. Not part of the public engine
 *  surface — used to make cache-behaviour assertions deterministic. */
export function __clearExpressionCompileCache(): void {
  cache.clear()
}
