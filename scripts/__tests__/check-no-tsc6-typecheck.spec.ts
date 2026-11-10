import { describe, expect, it } from 'vitest'

import { scanPackageScripts, scanText } from '../check-no-tsc6-typecheck.ts'

describe('check-no-tsc6-typecheck', () => {
  it('refuses a TS 6 `tsc --noEmit` in an instruction or a script', () => {
    expect(scanText('a.md', 'run `npx tsc --noEmit -p tsconfig.spec.json`')).toHaveLength(1)
    expect(scanText('a.sh', 'tsc -p tsconfig.json --noEmit')).toHaveLength(1)
  })

  it('accepts the TS 7 wrapper and an emitting tsc build', () => {
    expect(scanText('a.sh', '../../scripts/tsc7 --noEmit -p tsconfig.spec.json')).toEqual([])
    expect(scanText('a.sh', 'tsc -p tsconfig.build.json')).toEqual([])
    expect(scanText('a.sh', 'vue-tsc --noEmit')).toEqual([])
  })

  it('refuses the removed engine flag and script', () => {
    expect(scanText('a.md', 'tsx scripts/check-ci-baselines.ts --engine=tsc')).toHaveLength(1)
    expect(scanText('a.md', 'npm run typecheck:tsc6')).toHaveLength(1)
  })

  it('refuses a TS 6 check in any package script but the open `typecheck` contract', () => {
    const pkg = JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit -p tsconfig.spec.json',
        build: 'tsc --noEmit && vite build',
        emit: 'tsc -p tsconfig.build.json',
      },
    })
    expect(scanPackageScripts('packages/a/package.json', pkg).map((f) => f.where)).toEqual([
      'packages/a/package.json scripts.build',
    ])
  })

  it('refuses the root typecheck:tsc6 script and a root TS 6 typecheck', () => {
    const root = JSON.stringify({
      scripts: {
        'typecheck:tsc6': 'tsx scripts/check-ci-baselines.ts --engine=tsc typecheck',
        typecheck: 'tsc --noEmit',
      },
    })
    expect(scanPackageScripts('package.json', root)).toHaveLength(2)
  })
})
