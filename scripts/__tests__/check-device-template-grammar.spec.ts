import { describe, expect, it } from 'vitest'
import { barrelViolations, nunjucksViolations } from '../check-device-template-grammar.js'

const ALLOWED = 'packages/system/src/builtins/device-manager/device-template/nunjucks-internals.ts'

describe('check-device-template-grammar', () => {
  it('lets only the internals module import nunjucks', () => {
    const src = "import nunjucks from 'nunjucks'\n"
    expect(nunjucksViolations(ALLOWED, src)).toEqual([])
    expect(nunjucksViolations('packages/system/src/other.ts', src)).toHaveLength(1)
    expect(nunjucksViolations('a.ts', "const n = require('nunjucks')")).toHaveLength(1)
    expect(nunjucksViolations('a.ts', "const n = await import('nunjucks')")).toHaveLength(1)
    expect(nunjucksViolations('a.ts', "import { x } from 'nunjucks/src/y'")).toHaveLength(1)
    expect(nunjucksViolations('a.ts', "import x from 'nunjucks-like'")).toEqual([])
  })

  it('keeps the types barrel out of the worker as a value', () => {
    expect(barrelViolations('w.ts', "import { A } from '@camstack/types'")).toHaveLength(1)
    expect(barrelViolations('w.ts', "import type { A } from '@camstack/types'")).toEqual([])
    expect(
      barrelViolations('w.ts', "import { tryConvertUnit } from '@camstack/types/units-lean'"),
    ).toEqual([])
  })
})
