import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pagePackages } from '../check-addon-page-css.js'
import { pageRemoteConfigProblems } from '../check-page-remote-no-ui-library-alias.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

const GOOD = `
  federation({ shared: { '@camstack/ui-library': { singleton: true, requiredVersion: \`>=\${v}\`, import: false } } })
  export default { resolve: { alias: { other: 'x' } } }
`

describe('page remote shared-library guard', () => {
  it('accepts a remote that shares ui-library and states its minimum', () => {
    expect(pageRemoteConfigProblems(GOOD)).toEqual([])
  })

  it('refuses an alias of ui-library to source', () => {
    const bad = `${GOOD}\n resolve: { alias: { '@camstack/ui-library': path.resolve(__dirname, '../ui-library/src') } }`
    expect(pageRemoteConfigProblems(bad).join()).toContain('@camstack/ui-library')
  })

  it('refuses an alias of ui to source, and of types', () => {
    const ui = `${GOOD}\n alias: { '@camstack/ui': path.resolve(a, 'b') }`
    expect(pageRemoteConfigProblems(ui).join()).toContain('@camstack/ui')
    const types = `${GOOD}\n alias: { '@camstack/types': './types/src' }`
    expect(pageRemoteConfigProblems(types).join()).toContain('@camstack/types')
  })

  it('refuses a ui-library share with no stated minimum', () => {
    const bad = GOOD.replace('requiredVersion: `>=${v}`', 'requiredVersion: false')
    expect(pageRemoteConfigProblems(bad).join()).toContain('requiredVersion')
  })

  it('ignores a config that is not a federation remote', () => {
    expect(pageRemoteConfigProblems("alias: { '@camstack/ui-library': 'x' }")).toEqual([])
  })

  it('holds for every page package in the tree', () => {
    for (const name of pagePackages()) {
      for (const config of ['vite.config.ts', 'vite.page.config.ts']) {
        const file = path.join(ROOT, 'packages', name, config)
        if (!fs.existsSync(file)) continue
        expect(pageRemoteConfigProblems(fs.readFileSync(file, 'utf8')), file).toEqual([])
      }
    }
  })
})
