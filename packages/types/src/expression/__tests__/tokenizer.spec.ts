import { describe, it, expect } from 'vitest'
import { tokenize } from '../tokenizer.js'
import { ExpressionParseError } from '../errors.js'
import { MAX_EXPRESSION_SOURCE_LENGTH } from '../limits.js'

describe('tokenizer', () => {
  it('tokenizes numbers (int + decimal) with positions', () => {
    const toks = tokenize('12 + 3.5')
    expect(toks.map((t) => t.type)).toEqual(['number', 'punct', 'number', 'eof'])
    expect(toks[0]).toMatchObject({ type: 'number', value: 12, pos: 0 })
    expect(toks[2]).toMatchObject({ type: 'number', value: 3.5, pos: 5 })
  })

  it('tokenizes single- and double-quoted strings with escapes', () => {
    const toks = tokenize(`'a\\'b' + "c\\"d" + 'e\\\\f'`)
    const strings = toks
      .filter((t) => t.type === 'string')
      .map((t) => (t.type === 'string' ? t.value : ''))
    expect(strings).toEqual(["a'b", 'c"d', 'e\\f'])
  })

  it('lexes true/false/null as keywords and other words as identifiers', () => {
    const toks = tokenize('true false null foo_bar')
    expect(toks.map((t) => t.type)).toEqual(['keyword', 'keyword', 'keyword', 'identifier', 'eof'])
    expect(toks[3]).toMatchObject({ type: 'identifier', name: 'foo_bar' })
  })

  it('tokenizes all two-char and single-char operators', () => {
    const toks = tokenize('<= >= == != && || ( ) , ? : + - * / % ! < >')
    const puncts = toks
      .filter((t) => t.type === 'punct')
      .map((t) => (t.type === 'punct' ? t.punct : ''))
    expect(puncts).toEqual([
      '<=',
      '>=',
      '==',
      '!=',
      '&&',
      '||',
      '(',
      ')',
      ',',
      '?',
      ':',
      '+',
      '-',
      '*',
      '/',
      '%',
      '!',
      '<',
      '>',
    ])
  })

  it('rejects a bare "." (member access is not in the language)', () => {
    expect(() => tokenize('a.b')).toThrow(ExpressionParseError)
  })

  it('rejects lone "=", "[", "]", "{", "}", ";", backtick, "&", "|"', () => {
    for (const bad of ['a = b', 'a[0]', 'a]', '{a}', 'a;', '`x`', 'a & b', 'a | b']) {
      expect(() => tokenize(bad), bad).toThrow(ExpressionParseError)
    }
  })

  it('rejects an unterminated string', () => {
    expect(() => tokenize(`'abc`)).toThrow(ExpressionParseError)
  })

  it('rejects an invalid escape', () => {
    expect(() => tokenize(`'a\\nb'`)).toThrow(ExpressionParseError)
  })

  it('rejects a malformed number (trailing dot)', () => {
    expect(() => tokenize('1.')).toThrow(ExpressionParseError)
  })

  it('rejects over-length source before scanning', () => {
    const long = '1'.repeat(MAX_EXPRESSION_SOURCE_LENGTH + 1)
    expect(() => tokenize(long)).toThrow(ExpressionParseError)
  })

  it('carries a source position on errors', () => {
    try {
      tokenize('1 + @')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ExpressionParseError)
      if (err instanceof ExpressionParseError) expect(err.position).toBe(4)
    }
  })
})
