import { describe, expect, it } from 'vitest'
import { findSystemPackageReferences } from '../check-no-system-package'

const f = (rel: string, content: string) => [{ rel, content }]

describe('check-no-system-package', () => {
  it('flags an import of the retired package', () => {
    expect(
      findSystemPackageReferences(
        f('packages/addon-x/src/a.ts', `import { x } from '@camstack/system'\n`),
      ),
    ).toEqual([{ file: 'packages/addon-x/src/a.ts', line: 1 }])
  })

  it('flags a deep import and a config entry', () => {
    expect(
      findSystemPackageReferences(
        f('vite.config.ts', `\nexternal: ['@camstack/system/addon-utils']\n`),
      ),
    ).toEqual([{ file: 'vite.config.ts', line: 2 }])
  })

  it('flags the name spelled as path segments', () => {
    const src = `fs.existsSync(path.join(root, 'node_modules', '@camstack', 'system'))\n`
    expect(findSystemPackageReferences(f('server/backend/src/launcher.ts', src))).toEqual([
      { file: 'server/backend/src/launcher.ts', line: 1 },
    ])
  })

  it('accepts the folded path and neighbouring names', () => {
    const src = `import a from '@camstack/server/system'\nimport b from '@camstack/system-utils'\njoin(r, '@camstack', 'server', 'system')\n`
    expect(findSystemPackageReferences(f('a.ts', src))).toEqual([])
  })

  it('leaves history alone', () => {
    const src = `@camstack/system was published\n`
    expect(findSystemPackageReferences(f('docs/decisions/D15.md', src))).toEqual([])
    expect(findSystemPackageReferences(f('packages/x/CHANGELOG.md', src))).toEqual([])
  })
})
