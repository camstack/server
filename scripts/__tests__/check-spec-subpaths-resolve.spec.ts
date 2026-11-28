/**
 * The guard for specs that fail to LOAD on an unresolvable package subpath.
 * The root vitest alias for `@dominevo/types` swallowed `/node`, so 13 specs
 * of addon-export-hap never ran and nothing reported it.
 */
import { describe, expect, it } from 'vitest'

import { applyAlias, isExported, subpathSpecifiers } from '../check-spec-subpaths-resolve.js'

describe('applyAlias', () => {
  it('reproduces the bug: a string alias rewrites a subpath into a path under index.mjs', () => {
    const legacy = [{ find: '@dominevo/types', replacement: '/t/dist/index.mjs' }]
    expect(applyAlias(legacy, '@dominevo/types/node')).toBe('/t/dist/index.mjs/node')
  })

  it('exact-match regexes keep a subpath on its own file', () => {
    const fixed = [
      { find: /^@dominevo\/types$/, replacement: '/t/dist/index.mjs' },
      { find: /^@dominevo\/types\/node$/, replacement: '/t/dist/node.mjs' },
    ]
    expect(applyAlias(fixed, '@dominevo/types/node')).toBe('/t/dist/node.mjs')
    expect(applyAlias(fixed, '@dominevo/types')).toBe('/t/dist/index.mjs')
  })
})

describe('isExported', () => {
  it('matches literal and star keys, and refuses an unknown subpath', () => {
    const facts = { keys: ['.', './node', './features/*'] }
    expect(isExported(facts, 'node')).toBe(true)
    expect(isExported(facts, 'features/x')).toBe(true)
    expect(isExported(facts, 'nope')).toBe(false)
  })
})

describe('subpathSpecifiers', () => {
  it('finds scoped subpath imports and ignores bare package imports', () => {
    const src = `import a from '@dominevo/types/node'\nimport b from '@dominevo/types'`
    expect(subpathSpecifiers(src)).toEqual([{ pkg: '@dominevo/types', sub: 'node' }])
  })

  it('ignores a specifier that is only test data, not a module position', () => {
    expect(subpathSpecifiers(`expect(f('@dominevo/server/systemx')).toBe(false)`)).toEqual([])
  })
})
