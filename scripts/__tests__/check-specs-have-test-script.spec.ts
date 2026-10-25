/**
 * The guard for specs CI never collects.
 *
 * `npm run test` is `nx run-many -t test`, and nx only runs a `test` target a
 * package DECLARES. Four packages carried specs and no `test` script on
 * 2026-10-01 — addon-provider-reolink alone had 83 spec files / 963 tests —
 * so CI never ran a line of them, and nothing said so.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  findSpecFiles,
  judgePackage,
  workspacePackageDirs,
} from '../check-specs-have-test-script.js'

describe('judgePackage', () => {
  it('refuses a package with specs and no test script — the exact gap', () => {
    expect(judgePackage({ name: '@x/reolink', specCount: 83, testScript: undefined })).toEqual([
      '@x/reolink: 83 spec file(s) and no `test` script — nx never runs them, so CI never does',
    ])
  })

  it('passes a package with specs and a runner', () => {
    expect(judgePackage({ name: '@x/a', specCount: 3, testScript: 'vitest run' })).toEqual([])
  })

  it('passes a package with no specs and no test script', () => {
    expect(judgePackage({ name: '@x/a', specCount: 0, testScript: undefined })).toEqual([])
  })

  // A script that cannot fail is the same gap with a script attached.
  it('refuses a test script that runs nothing', () => {
    for (const noop of ['echo "no tests"', 'true', 'exit 0', ':']) {
      expect(judgePackage({ name: '@x/a', specCount: 1, testScript: noop })).toHaveLength(1)
    }
  })

  // With specs on disk, "no test files found" means the config's include
  // stopped matching them — the one failure the flag exists to hide.
  it('refuses --passWithNoTests on a package that has specs', () => {
    expect(
      judgePackage({ name: '@x/a', specCount: 2, testScript: 'vitest run --passWithNoTests' }),
    ).toEqual([
      '@x/a: `--passWithNoTests` on a package with 2 spec file(s) — a config that stops collecting them would still pass',
    ])
  })

  it('allows --passWithNoTests where there is nothing to collect', () => {
    expect(
      judgePackage({ name: '@x/a', specCount: 0, testScript: 'vitest run --passWithNoTests' }),
    ).toEqual([])
  })
})

describe('the repository walk', () => {
  let repo: string
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'specs-have-test-'))
    const put = (rel: string, body: string): void => {
      const full = path.join(repo, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
    put('package.json', JSON.stringify({ workspaces: ['packages/*', 'server/*', 'e2e'] }))
    put('packages/a/package.json', '{"name":"a"}')
    put('packages/a/src/x.spec.ts', '')
    put('packages/a/src/__tests__/y.test.tsx', '')
    put('packages/a/src/z.ts', '')
    put('packages/a/node_modules/dep/q.spec.ts', '')
    put('packages/a/dist/x.spec.ts', '')
    put('packages/not-a-package/src/w.spec.ts', '')
    put('server/backend/package.json', '{"name":"backend"}')
    put('e2e/package.json', '{"name":"e2e"}')
    put('e2e/suites/boot.spec.ts', '')
  })
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('lists every workspace directory that has a package.json', () => {
    expect(workspacePackageDirs(repo).toSorted()).toEqual(
      ['e2e', 'packages/a', 'server/backend'].toSorted(),
    )
  })

  it('counts .spec/.test files and never node_modules or dist', () => {
    expect(findSpecFiles(path.join(repo, 'packages/a')).toSorted()).toEqual(
      ['src/__tests__/y.test.tsx', 'src/x.spec.ts'].toSorted(),
    )
  })
})
