/**
 * Pratt (precedence-climbing) parser for the safe expression mini-language.
 *
 * Precedence (low → high): ternary `?:` (right-assoc) → `||` → `&&` → equality
 * → relational → additive → multiplicative → unary `! -` → call / primary.
 * Calls are ONLY `IDENT '(' args? ')'` at primary position — the callee is a
 * string validated against the builtin table at parse time, so an unknown
 * function is rejected immediately (author feedback) and a persisted expression
 * that references a since-removed builtin degrades at read.
 *
 * A node counter caps total AST size (`MAX_EXPRESSION_AST_NODES`) and call
 * arity is capped (`MAX_EXPRESSION_CALL_ARGS`) — both raise `ExpressionParseError`.
 */
import { ExpressionParseError } from './errors.js'
import { EXPRESSION_BUILTIN_NAMES } from './builtins.js'
import { MAX_EXPRESSION_AST_NODES, MAX_EXPRESSION_CALL_ARGS } from './limits.js'
import { tokenize, type Punctuator, type Token } from './tokenizer.js'
import type {
  ExpressionBinaryOperator,
  ExpressionLogicalOperator,
  ExpressionNode,
  ExpressionUnaryOperator,
} from './ast.js'

export interface ParsedExpression {
  readonly ast: ExpressionNode
  /** Free identifiers referenced by the expression (NOT callees). */
  readonly identifiers: ReadonlySet<string>
  /** Builtin function names called by the expression. */
  readonly callees: ReadonlySet<string>
  readonly nodeCount: number
}

/** Binary/logical operator precedence (higher binds tighter). */
const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
}

function isLogicalOp(op: Punctuator): op is ExpressionLogicalOperator {
  return op === '&&' || op === '||'
}

function isBinaryOp(op: Punctuator): op is ExpressionBinaryOperator {
  return (
    op === '+' ||
    op === '-' ||
    op === '*' ||
    op === '/' ||
    op === '%' ||
    op === '==' ||
    op === '!=' ||
    op === '<' ||
    op === '<=' ||
    op === '>' ||
    op === '>='
  )
}

class Parser {
  private pos = 0
  private nodeCount = 0
  private readonly identifiers = new Set<string>()
  private readonly callees = new Set<string>()

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): ParsedExpression {
    const ast = this.parseTernary()
    const tok = this.peek()
    if (tok.type !== 'eof') {
      throw new ExpressionParseError('unexpected trailing input', tok.pos)
    }
    return {
      ast,
      identifiers: this.identifiers,
      callees: this.callees,
      nodeCount: this.nodeCount,
    }
  }

  private peek(): Token {
    return this.tokens[this.pos]!
  }

  private next(): Token {
    return this.tokens[this.pos++]!
  }

  /** Consume a punctuator token, erroring if the next token isn't it. */
  private expectPunct(punct: Punctuator): void {
    const tok = this.peek()
    if (tok.type !== 'punct' || tok.punct !== punct) {
      throw new ExpressionParseError(`expected '${punct}'`, tok.pos)
    }
    this.pos += 1
  }

  private matchPunct(punct: Punctuator): boolean {
    const tok = this.peek()
    if (tok.type === 'punct' && tok.punct === punct) {
      this.pos += 1
      return true
    }
    return false
  }

  private countNode(): void {
    this.nodeCount += 1
    if (this.nodeCount > MAX_EXPRESSION_AST_NODES) {
      throw new ExpressionParseError('expression too complex', this.peek().pos)
    }
  }

  // ── ternary (lowest) ─────────────────────────────────────────────────────
  private parseTernary(): ExpressionNode {
    const test = this.parseBinary(1)
    if (this.matchPunct('?')) {
      const consequent = this.parseTernary()
      this.expectPunct(':')
      const alternate = this.parseTernary()
      this.countNode()
      return { kind: 'conditional', test, consequent, alternate }
    }
    return test
  }

  // ── binary / logical (precedence climbing) ───────────────────────────────
  private parseBinary(minPrec: number): ExpressionNode {
    let left = this.parseUnary()
    for (;;) {
      const tok = this.peek()
      if (tok.type !== 'punct') break
      const prec = BINARY_PRECEDENCE[tok.punct]
      if (prec === undefined || prec < minPrec) break
      const op = tok.punct
      this.pos += 1
      const right = this.parseBinary(prec + 1)
      this.countNode()
      if (isLogicalOp(op)) {
        left = { kind: 'logical', op, left, right }
      } else if (isBinaryOp(op)) {
        left = { kind: 'binary', op, left, right }
      } else {
        // Unreachable: only operators present in BINARY_PRECEDENCE reach here,
        // and each is either logical or binary. Kept as a total-function guard.
        throw new ExpressionParseError(`unexpected operator '${op}'`, tok.pos)
      }
    }
    return left
  }

  // ── unary ────────────────────────────────────────────────────────────────
  private parseUnary(): ExpressionNode {
    const tok = this.peek()
    if (tok.type === 'punct' && (tok.punct === '!' || tok.punct === '-')) {
      const op: ExpressionUnaryOperator = tok.punct
      this.pos += 1
      const operand = this.parseUnary()
      this.countNode()
      return { kind: 'unary', op, operand }
    }
    return this.parsePrimary()
  }

  // ── primary / call ───────────────────────────────────────────────────────
  private parsePrimary(): ExpressionNode {
    const tok = this.next()
    switch (tok.type) {
      case 'number':
        this.countNode()
        return { kind: 'literal', value: tok.value }
      case 'string':
        this.countNode()
        return { kind: 'literal', value: tok.value }
      case 'keyword':
        this.countNode()
        return { kind: 'literal', value: tok.keyword === 'null' ? null : tok.keyword === 'true' }
      case 'identifier': {
        const nextTok = this.peek()
        if (nextTok.type === 'punct' && nextTok.punct === '(') {
          return this.parseCall(tok.name, tok.pos)
        }
        this.identifiers.add(tok.name)
        this.countNode()
        return { kind: 'identifier', name: tok.name }
      }
      case 'punct':
        if (tok.punct === '(') {
          const inner = this.parseTernary()
          this.expectPunct(')')
          return inner
        }
        throw new ExpressionParseError(`unexpected token '${tok.punct}'`, tok.pos)
      case 'eof':
        throw new ExpressionParseError('unexpected end of expression', tok.pos)
    }
  }

  private parseCall(callee: string, pos: number): ExpressionNode {
    if (!EXPRESSION_BUILTIN_NAMES.has(callee)) {
      throw new ExpressionParseError(`unknown function '${callee}'`, pos)
    }
    this.expectPunct('(')
    const args: ExpressionNode[] = []
    if (!this.matchPunct(')')) {
      for (;;) {
        args.push(this.parseTernary())
        if (args.length > MAX_EXPRESSION_CALL_ARGS) {
          throw new ExpressionParseError(`too many arguments to '${callee}'`, pos)
        }
        if (this.matchPunct(',')) continue
        this.expectPunct(')')
        break
      }
    }
    this.callees.add(callee)
    this.countNode()
    return { kind: 'call', callee, args }
  }
}

/** Tokenize + parse `source` into a validated `ParsedExpression`. Throws
 *  `ExpressionParseError` on any lexical or grammatical failure. */
export function parseExpression(source: string): ParsedExpression {
  const tokens = tokenize(source)
  return new Parser(tokens).parse()
}
