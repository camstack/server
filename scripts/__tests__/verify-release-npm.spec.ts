import { describe, expect, it } from 'vitest'
import { assessReleaseNpm } from '../ci/verify-release-npm.mjs'

/**
 * The product tag and the npm closure are different lines (D943).
 *
 * The image and the desktop app both install `@camstack/server@latest`.
 * The gate's job is to name that closure before the build starts. It must
 * not demand that `latest` equal the product version — that equality was
 * the old, coupled contract, and it is exactly what this release gives up.
 */
describe('assessReleaseNpm', () => {
  it('passes when latest resolves, even though it is not the product version', () => {
    const result = assessReleaseNpm({
      productVersion: '0.1.0',
      latestVersion: '1.2.621',
    })
    expect(result.problems).toEqual([])
    expect(result.serverVersion).toBe('1.2.621')
  })

  it('FAILS closed when the dist-tag could not be resolved', () => {
    const result = assessReleaseNpm({
      productVersion: '0.1.0',
      latestVersion: null,
    })
    expect(result.problems.length).toBeGreaterThan(0)
    expect(result.problems.join('\n')).toContain('dist-tag')
    expect(result.problems.join('\n')).toContain('@latest')
    expect(result.serverVersion).toBeNull()
  })

  it('FAILS when the product version is not X.Y.Z', () => {
    const result = assessReleaseNpm({
      productVersion: '0.1.0-beta',
      latestVersion: '1.2.621',
    })
    expect(result.problems.join('\n')).toContain('0.1.0-beta')
  })
})
