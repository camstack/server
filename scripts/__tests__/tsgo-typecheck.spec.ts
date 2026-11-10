/**
 * The TS7 (`tsgo`) typecheck runs each project's OWN `typecheck` script with
 * the compiler swapped, then grades the result against the same pinned-debt
 * baseline `npm run typecheck` uses. A rewrite that missed a `tsc`, or a
 * comparison that let a production error ride on spec debt, would make the
 * fast check say green where the real one says red.
 */
import { describe, expect, it } from 'vitest'

import {
  gradeAgainstBaseline,
  toTsgoCommand,
} from '../lib/tsgo-typecheck.js'

describe('toTsgoCommand', () => {
  it('swaps every tsc invocation, keeping its arguments', () => {
    expect(
      toTsgoCommand(
        'tsc --noEmit -p tsconfig.spec.json && tsc --noEmit -p tsconfig.server.json',
        '/bin/tsgo --checkers 1',
      ),
    ).toBe(
      '/bin/tsgo --checkers 1 --noEmit -p tsconfig.spec.json && /bin/tsgo --checkers 1 --noEmit -p tsconfig.server.json',
    )
  })

  it('leaves words that merely contain "tsc" alone', () => {
    expect(toTsgoCommand('tscx --noEmit && node tsc-helper.js', 'TSGO')).toBeNull()
    expect(toTsgoCommand('tsc -p a.json && tscx', 'TSGO')).toBe('TSGO -p a.json && tscx')
  })

  it('returns null for a script that never calls tsc', () => {
    expect(toTsgoCommand('vue-tsc --noEmit', 'TSGO')).toBeNull()
    expect(toTsgoCommand('echo skip', 'TSGO')).toBeNull()
  })
})

describe('gradeAgainstBaseline', () => {
  const baseline = {
    typecheck: {},
    'typecheck-specs': { 'p » src/a.spec.ts': 3 },
  }

  it('is clean when every count is within its pin', () => {
    const r = gradeAgainstBaseline(
      'p',
      { production: 0, specs: new Map([['src/a.spec.ts', 3]]) },
      baseline,
    )
    expect(r).toEqual([])
  })

  it('fails a production error even when the package carries spec debt', () => {
    const r = gradeAgainstBaseline('p', { production: 1, specs: new Map() }, baseline)
    expect(r).toEqual(['p: 1 production error(s), pinned 0'])
  })

  it('fails a spec file that got worse or was never pinned', () => {
    const r = gradeAgainstBaseline(
      'p',
      {
        production: 0,
        specs: new Map([
          ['src/a.spec.ts', 4],
          ['src/b.spec.ts', 1],
        ]),
      },
      baseline,
    )
    expect(r).toEqual([
      'p » src/a.spec.ts: 4 error(s), pinned 3',
      'p » src/b.spec.ts: 1 error(s), pinned 0',
    ])
  })
})
