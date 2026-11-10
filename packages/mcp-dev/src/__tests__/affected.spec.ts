import { describe, expect, it } from 'vitest'

import { affectedChecks } from '../ci/affected.js'

/**
 * `affected_checks` is what an agent runs: it must name the scoped gate (the
 * related specs through the test slot, tsgo per package), never a package's
 * full suite or its TS 6 `typecheck` script.
 */
describe('affectedChecks', () => {
  const paths = [
    'packages/addon-pipeline/src/runner.ts',
    'packages/addon-pipeline/src/__tests__/runner.spec.ts',
    'packages/types/src/index.ts',
    'docs/architecture/overview.md',
  ]

  it('runs the related specs of the changed code through test:related', () => {
    const { checks } = affectedChecks('/nonexistent', { paths })
    const related = checks.find((c) => c.id === 'test:related')
    expect(related?.command).toBe(
      'npm run test:related -- packages/addon-pipeline/src/runner.ts packages/addon-pipeline/src/__tests__/runner.spec.ts packages/types/src/index.ts',
    )
  })

  it('typechecks the changed packages with tsgo', () => {
    const { checks } = affectedChecks('/nonexistent', { paths })
    expect(checks.find((c) => c.id === 'typecheck:pkg')?.command).toBe(
      'npm run typecheck:pkg -- addon-pipeline types',
    )
  })

  it('never proposes a full package suite or a package typecheck script', () => {
    const { checks } = affectedChecks('/nonexistent', { paths })
    for (const c of checks) {
      expect(c.command).not.toMatch(/npm (?:run )?test -w|typecheck -w/)
    }
  })
})
