import { describe, expect, it } from 'vitest'
import {
  desktopDowngradeNote,
  deriveProductVersion,
  productReleaseName,
} from '../ci/product-release.mjs'

/**
 * The product release (image tag, desktop app, GitHub release) is its own
 * line, starting at 0.1.0 beta. It is not `@camstack/server`'s version.
 */
describe('deriveProductVersion', () => {
  const aligned = { fileVersion: '0.1.0', desktopVersion: '0.1.0' }

  it('a tag vX.Y.Z is the product version when it matches the committed file', () => {
    const result = deriveProductVersion({
      ref: 'refs/tags/v0.1.0',
      refName: 'v0.1.0',
      eventName: 'push',
      versionType: '',
      ...aligned,
    })
    expect(result.problems).toEqual([])
    expect(result.version).toBe('0.1.0')
    expect(result.releaseName).toBe('CamStack 0.1.0 beta')
  })

  it('labels beta only while the major is 0', () => {
    expect(productReleaseName('0.2.1')).toBe('CamStack 0.2.1 beta')
    expect(productReleaseName('1.0.0')).toBe('CamStack 1.0.0')
    expect(productReleaseName('1.2.621')).toBe('CamStack 1.2.621')
  })

  it('a workflow_dispatch bumps the committed product version and does not touch npm', () => {
    const result = deriveProductVersion({
      ref: 'refs/heads/main',
      refName: 'main',
      eventName: 'workflow_dispatch',
      versionType: 'patch',
      ...aligned,
    })
    expect(result.problems).toEqual([])
    expect(result.version).toBe('0.1.1')
    expect(result.releaseName).toBe('CamStack 0.1.1 beta')
  })

  it('FAILS when the tag and product-version.json disagree', () => {
    const result = deriveProductVersion({
      ref: 'refs/tags/v0.1.1',
      refName: 'v0.1.1',
      eventName: 'push',
      versionType: '',
      ...aligned,
    })
    expect(result.problems.join('\n')).toContain('0.1.1')
    expect(result.problems.join('\n')).toContain('0.1.0')
  })

  it('FAILS when the desktop app version drifts from the product file', () => {
    const result = deriveProductVersion({
      ref: 'refs/heads/main',
      refName: 'main',
      eventName: 'workflow_dispatch',
      versionType: 'patch',
      fileVersion: '0.1.0',
      desktopVersion: '0.0.0',
    })
    expect(result.problems.join('\n')).toContain('packages/desktop/package.json')
  })
})

describe('desktopDowngradeNote', () => {
  it('tells a 1.2.x install that 0.x will not auto-update', () => {
    const note = desktopDowngradeNote('0.1.0')
    expect(note).toContain('1.2.x')
    expect(note).toContain('Reinstall')
    expect(note).toContain('1.0.x')
  })

  it('is absent once the product leaves 0.x', () => {
    expect(desktopDowngradeNote('1.0.0')).toBeNull()
  })
})
