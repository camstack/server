/**
 * The package-boundary guard: a production file may not reach a sibling
 * package's source by a relative path (the probe the D695 review used).
 */
import { describe, expect, it } from 'vitest'

import { escapingImports } from '../check-src-imports-stay-in-package.js'

const PKG = '/repo/packages/addon-provider-gree'
const FILE = `${PKG}/src/x/y.ts`

describe('escapingImports', () => {
  it('refuses the review probe: one addon reaching another by relative path', () => {
    expect(
      escapingImports(FILE, "import { a } from '../../../addon-provider-dreo/src/a.js'\n", PKG),
    ).toEqual([{ file: FILE, line: 1, specifier: '../../../addon-provider-dreo/src/a.js' }])
  })

  it('sees export-from, dynamic import and require too', () => {
    const code = [
      "export * from '../../../system/src/b.js'",
      "const c = await import('../../../types/src/c.js')",
      "const d = require('../../../sdk/src/d.js')",
    ].join('\n')
    expect(escapingImports(FILE, code, PKG).map((e) => e.line)).toEqual([1, 2, 3])
  })

  it('allows relative imports that stay inside the package, including its root', () => {
    const code = [
      "import { a } from './a.js'",
      "import { b } from '../b.js'",
      "import pkg from '../../package.json'",
      "import { t } from '@camstack/types'",
    ].join('\n')
    expect(escapingImports(FILE, code, PKG)).toEqual([])
  })
})
