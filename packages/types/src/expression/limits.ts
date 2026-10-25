/**
 * Resource-bound constants for the safe expression engine.
 *
 * Every bound is defense-in-depth: the grammar is non-Turing-complete (no
 * loops, recursion, lambdas or member access — see `ast.ts`), so evaluation is
 * O(nodeCount) by construction. These caps merely put a hard ceiling on the
 * work a single author-supplied expression can request, so a hostile or
 * accidental pathological string can never spend unbounded CPU/memory.
 */

/** Max source length (chars) — checked BEFORE tokenizing so a huge string is
 *  rejected without allocation. */
export const MAX_EXPRESSION_SOURCE_LENGTH = 2048

/** Max AST nodes — checked during parse; a deeply nested grouping that exceeds
 *  this is rejected as "expression too complex". */
export const MAX_EXPRESSION_AST_NODES = 256

/** Defense-in-depth walker step budget — one increment per node visit during
 *  evaluation. The grammar guarantees O(nodeCount) walks, so this can only trip
 *  on a crafted maximum-size AST. */
export const MAX_EXPRESSION_EVAL_STEPS = 4096

/** Max named bindings on one {@link ExpressionSource}. */
export const MAX_EXPRESSION_BINDINGS = 32

/** Max positional arguments to any builtin call. */
export const MAX_EXPRESSION_CALL_ARGS = 16

/** LRU compile-cache capacity (parsed ASTs keyed by raw source string). */
export const EXPRESSION_COMPILE_CACHE_CAPACITY = 256

/** A legal binding / identifier name. */
export const EXPRESSION_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Binding names an author may NOT use: `now` is auto-injected; the literal
 *  keywords lex as values, not identifiers, so binding to them is meaningless. */
export const RESERVED_BINDING_NAMES: ReadonlySet<string> = new Set(['now', 'true', 'false', 'null'])
