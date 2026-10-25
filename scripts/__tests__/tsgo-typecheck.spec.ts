/**
 * The TS7 (`tsgo`) typecheck runs each project's OWN `typecheck` script with
 * the compiler swapped, then grades the result against the same pinned-debt
 * baseline `npm run typecheck` uses. A rewrite that missed a `tsc`, or a
 * comparison that let a production error ride on spec debt, would make the
 * fast check say green where the real one says red.
 */
import { describe, expect, it } from 'vitest'

import {
  diffErrorSets,
  gradeAgainstBaseline,
  normalizeErrorSet,
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

describe('normalizeErrorSet / diffErrorSets', () => {
  it('normalizes flat and pretty diagnostics to file(line,col): TSxxxx', () => {
    const flat =
      'src/a.ts(10,2): error TS2345: Argument of type \'"high" | "low"\' is not assignable.\n'
    const pretty =
      'src/a.ts:10:2 - error TS2345: Argument of type \'"high" | "mid" | "low"\' is not assignable.\n'
    expect([...normalizeErrorSet(flat)]).toEqual(['src/a.ts(10,2): TS2345'])
    expect([...normalizeErrorSet(pretty)]).toEqual(['src/a.ts(10,2): TS2345'])
    expect(diffErrorSets(normalizeErrorSet(flat), normalizeErrorSet(pretty))).toEqual({
      onlyInLeft: [],
      onlyInRight: [],
    })
  })

  it('reports a symmetric difference when codes or positions diverge', () => {
    const left = normalizeErrorSet('a.ts(1,1): error TS1005: ;\n')
    const right = normalizeErrorSet('a.ts(1,1): error TS2304: x\nb.ts(2,2): error TS2304: y\n')
    expect(diffErrorSets(left, right)).toEqual({
      onlyInLeft: ['a.ts(1,1): TS1005'],
      onlyInRight: ['a.ts(1,1): TS2304', 'b.ts(2,2): TS2304'],
    })
  })
})
