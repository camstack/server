import { describe, expect, it } from 'vitest'

import { groupByOwner, ownerDir, resolvePackageDir } from '../ci/test-run.mjs'

/**
 * `npm run test:related` hands each changed file to the vitest config that
 * owns it — a spec run from the wrong directory collects nothing and reads as
 * green.
 */
const ROOT = '/repo'
const FILES = new Set([
  '/repo/packages/a/package.json',
  '/repo/packages/a/vitest.config.ts',
  '/repo/packages/a/src/x.ts',
  '/repo/packages/a/src/__tests__/x.spec.ts',
  '/repo/packages/addon-pipeline/package.json',
  '/repo/packages/addon-pipeline/src/stream-broker/vitest.config.ts',
  '/repo/packages/addon-pipeline/src/stream-broker/ring.ts',
  '/repo/scripts/check-x.ts',
  '/repo/server/backend/package.json',
  '/repo/docs/a.md',
])
const exists = (p: string): boolean => FILES.has(p)

describe('test-run', () => {
  it('finds the nearest owning config, the root for repo scripts', () => {
    expect(ownerDir(ROOT, '/repo/packages/a/src/x.ts', exists)).toBe('/repo/packages/a')
    expect(ownerDir(ROOT, '/repo/packages/addon-pipeline/src/stream-broker/ring.ts', exists)).toBe(
      '/repo/packages/addon-pipeline/src/stream-broker',
    )
    expect(ownerDir(ROOT, '/repo/scripts/check-x.ts', exists)).toBe('/repo')
  })

  it('groups code files by owner and drops docs and deleted files', () => {
    const groups = groupByOwner(
      ROOT,
      [
        '/repo/packages/a/src/x.ts',
        '/repo/packages/a/src/__tests__/x.spec.ts',
        '/repo/scripts/check-x.ts',
        '/repo/docs/a.md',
        '/repo/packages/a/src/deleted.ts',
      ],
      exists,
    )
    expect([...groups.entries()]).toEqual([
      ['/repo/packages/a', ['/repo/packages/a/src/x.ts', '/repo/packages/a/src/__tests__/x.spec.ts']],
      ['/repo', ['/repo/scripts/check-x.ts']],
    ])
  })

  it('resolves a package by path, basename or backend', () => {
    expect(resolvePackageDir(ROOT, 'packages/a/', exists)).toBe('packages/a')
    expect(resolvePackageDir(ROOT, 'a', exists)).toBe('packages/a')
    expect(resolvePackageDir(ROOT, 'backend', exists)).toBe('server/backend')
    expect(resolvePackageDir(ROOT, 'nope', exists)).toBeNull()
  })
})
