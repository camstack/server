/**
 * Tokenizer for the safe expression mini-language. Hand-rolled, single-pass,
 * zero-dependency. The grammar is deliberately boring: decimal numbers,
 * single/double-quoted strings with a tiny escape set, identifiers, the three
 * value keywords (`true`/`false`/`null`) and a fixed punctuator set. Anything
 * outside that — a bare `.`, `=`, `[`, `]`, `{`, `}`, `;`, backtick, `&`, `|` —
 * is a parse error with a source position, so member access / assignment /
 * template literals are lexically impossible.
 */
import { ExpressionParseError } from './errors.js'
import { MAX_EXPRESSION_SOURCE_LENGTH } from './limits.js'

/** The fixed punctuator set of the language. */
export type Punctuator =
  | '('
  | ')'
  | ','
  | '?'
  | ':'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '!'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||'

/** The three value keywords. */
export type Keyword = 'true' | 'false' | 'null'

export interface NumberToken {
  readonly type: 'number'
  readonly value: number
  readonly pos: number
}
export interface StringToken {
  readonly type: 'string'
  readonly value: string
  readonly pos: number
}
export interface IdentifierToken {
  readonly type: 'identifier'
  readonly name: string
  readonly pos: number
}
export interface KeywordToken {
  readonly type: 'keyword'
  readonly keyword: Keyword
  readonly pos: number
}
export interface PunctToken {
  readonly type: 'punct'
  readonly punct: Punctuator
  readonly pos: number
}
export interface EofToken {
  readonly type: 'eof'
  readonly pos: number
}

export type Token =
  | NumberToken
  | StringToken
  | IdentifierToken
  | KeywordToken
  | PunctToken
  | EofToken

const KEYWORDS: ReadonlySet<string> = new Set(['true', 'false', 'null'])

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}
function isIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_'
}
function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch)
}
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
}

/** Tokenize `source` into a flat token list ending with a single `eof` token.
 *  Throws `ExpressionParseError` on any illegal character or unterminated
 *  string. */
export function tokenize(source: string): readonly Token[] {
  if (source.length > MAX_EXPRESSION_SOURCE_LENGTH) {
    throw new ExpressionParseError(
      `expression too long (${source.length} > ${MAX_EXPRESSION_SOURCE_LENGTH} chars)`,
      0,
    )
  }
  const tokens: Token[] = []
  let i = 0
  const n = source.length

  while (i < n) {
    const ch = source[i]!
    if (isWhitespace(ch)) {
      i += 1
      continue
    }

    // Numbers: decimal only, `[0-9]+(\.[0-9]+)?`.
    if (isDigit(ch)) {
      const start = i
      while (i < n && isDigit(source[i]!)) i += 1
      if (i < n && source[i] === '.') {
        // A decimal point MUST be followed by at least one digit.
        if (i + 1 >= n || !isDigit(source[i + 1]!)) {
          throw new ExpressionParseError('malformed number: decimal point needs a digit', i)
        }
        i += 1
        while (i < n && isDigit(source[i]!)) i += 1
      }
      const text = source.slice(start, i)
      const value = Number(text)
      if (!Number.isFinite(value)) {
        throw new ExpressionParseError(`malformed number: '${text}'`, start)
      }
      tokens.push({ type: 'number', value, pos: start })
      continue
    }

    // Strings: single- or double-quoted; escapes limited to \\ \' \".
    if (ch === "'" || ch === '"') {
      const quote = ch
      const start = i
      i += 1
      let out = ''
      let closed = false
      while (i < n) {
        const c = source[i]!
        if (c === '\\') {
          const next = i + 1 < n ? source[i + 1]! : ''
          if (next === '\\' || next === "'" || next === '"') {
            out += next
            i += 2
            continue
          }
          throw new ExpressionParseError(`invalid string escape: '\\${next}'`, i)
        }
        if (c === quote) {
          closed = true
          i += 1
          break
        }
        out += c
        i += 1
      }
      if (!closed) {
        throw new ExpressionParseError('unterminated string literal', start)
      }
      tokens.push({ type: 'string', value: out, pos: start })
      continue
    }

    // Identifiers / keywords.
    if (isIdentStart(ch)) {
      const start = i
      while (i < n && isIdentPart(source[i]!)) i += 1
      const text = source.slice(start, i)
      if (KEYWORDS.has(text)) {
        tokens.push({ type: 'keyword', keyword: keywordOf(text), pos: start })
      } else {
        tokens.push({ type: 'identifier', name: text, pos: start })
      }
      continue
    }

    // Two-char punctuators.
    const two = i + 1 < n ? source.slice(i, i + 2) : ''
    if (
      two === '<=' ||
      two === '>=' ||
      two === '==' ||
      two === '!=' ||
      two === '&&' ||
      two === '||'
    ) {
      tokens.push({ type: 'punct', punct: two, pos: i })
      i += 2
      continue
    }

    // Single-char punctuators.
    if (isSinglePunct(ch)) {
      tokens.push({ type: 'punct', punct: ch, pos: i })
      i += 1
      continue
    }

    // Anything else (`.`, `=`, `[`, `]`, `{`, `}`, `;`, backtick, `&`, `|`, `@`, …)
    // is not part of the language. A dangling `=`/`&`/`|` reaches here because
    // the two-char forms above already consumed the valid combinations.
    throw new ExpressionParseError(`unexpected character '${ch}'`, i)
  }

  tokens.push({ type: 'eof', pos: n })
  return tokens
}

function keywordOf(text: string): Keyword {
  if (text === 'true') return 'true'
  if (text === 'false') return 'false'
  return 'null'
}

function isSinglePunct(ch: string): ch is Punctuator {
  return (
    ch === '(' ||
    ch === ')' ||
    ch === ',' ||
    ch === '?' ||
    ch === ':' ||
    ch === '+' ||
    ch === '-' ||
    ch === '*' ||
    ch === '/' ||
    ch === '%' ||
    ch === '!' ||
    ch === '<' ||
    ch === '>'
  )
}
