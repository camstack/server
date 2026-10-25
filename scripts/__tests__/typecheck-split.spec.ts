/**
 * One tsc pass over `tsconfig.spec.json`, two verdicts. The split must never
 * let a production error hide in the spec bucket, which carries pinned debt.
 */
import { describe, expect, it } from 'vitest'

import { isSpecPath, splitTypecheckSection } from '../lib/typecheck-split.js'

describe('isSpecPath', () => {
  it('knows every spec shape this repo uses', () => {
    for (const p of [
      'src/a.spec.ts',
      'src/a.test.tsx',
      'src/x/__tests__/helpers.ts',
      '__tests__/pipeline-runner.test.ts',
      'src/__mocks__/fs.ts',
    ]) {
      expect(isSpecPath(p), p).toBe(true)
    }
  })

  it('is false for production code, including names that merely contain "test"', () => {
    for (const p of ['src/a.ts', 'src/testing/fake-clock.ts', 'src/latest.ts', 'src/tests.ts']) {
      expect(isSpecPath(p), p).toBe(false)
    }
  })
})

describe('splitTypecheckSection', () => {
  it('splits the flat (CI) form by file', () => {
    const out = splitTypecheckSection(
      [
        "src/a.ts(1,2): error TS2322: Type 'x' is not assignable.",
        'src/__tests__/b.spec.ts(3,4): error TS2345: Argument …',
        '  continuation line that is not a diagnostic',
        'src/__tests__/b.spec.ts(9,1): error TS2741: Property …',
      ].join('\n'),
    )
    expect(out?.production).toBe(1)
    expect(Object.fromEntries(out?.specs ?? [])).toEqual({ 'src/__tests__/b.spec.ts': 2 })
  })

  it('splits the pretty (terminal) form too', () => {
    const out = splitTypecheckSection(
      [
        'src/c.test.ts:12:3 - error TS2345: Argument …',
        '',
        '12   foo(bar)',
        '',
        'Found 1 error in src/c.test.ts:12',
      ].join('\n'),
    )
    expect(out?.production).toBe(0)
    expect(Object.fromEntries(out?.specs ?? [])).toEqual({ 'src/c.test.ts': 1 })
  })

  // An error nobody can attribute must fail the strict bucket, never be
  // absorbed by the one that carries pinned debt.
  it('counts a summary with no readable diagnostic as production', () => {
    expect(splitTypecheckSection('Found 3 errors in 2 files.')).toEqual({
      production: 3,
      specs: new Map(),
    })
  })

  it('returns null for a section with nothing to read', () => {
    expect(splitTypecheckSection('> tsc --noEmit -p tsconfig.spec.json\n')).toBeNull()
  })
})
