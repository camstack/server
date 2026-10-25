import { describe, it, expect } from 'vitest'
import { checkViewerBuild, compareVersions, parseMarker } from '../check-viewer-web-build.js'

/**
 * The case this guard exists for, with its real numbers: on 2026-07-31 the hub
 * served viewer 1.0.186 (built 24 July) while the repository pinned 1.0.204.
 * Eighteen versions of app changes were live on mobile and absent in every
 * browser, because an OTA ships the native app and never touches the web
 * bundle embedded in this repository.
 */
describe('checkViewerBuild', () => {
  it('FAILS on the real 18-version gap, and says how to fix it', () => {
    const v = checkViewerBuild({ markerRaw: '1.0.186+d73f583', pinnedVersion: '1.0.204' })
    expect(v.ok).toBe(false)
    expect(v.message).toContain('1.0.186')
    expect(v.message).toContain('1.0.204')
    expect(v.message).toContain('build:orchestrator')
  })

  it('passes when the bundle matches the pin', () => {
    const v = checkViewerBuild({ markerRaw: '1.0.205+fdba289', pinnedVersion: '1.0.205' })
    expect(v.ok).toBe(true)
  })

  it('fails on a bundle AHEAD of the pin — that is a disagreement too', () => {
    const v = checkViewerBuild({ markerRaw: '1.0.206+abc1234', pinnedVersion: '1.0.205' })
    expect(v.ok).toBe(false)
    expect(v.message).toContain('AHEAD')
  })

  it('ignores the commit hash — a viewer commit that changes only iOS project files does not change the web bundle', () => {
    const v = checkViewerBuild({ markerRaw: '1.0.205+deadbee', pinnedVersion: '1.0.205' })
    expect(v.ok).toBe(true)
  })

  it('SKIPS when the submodule is not checked out — CI clones without it', () => {
    const v = checkViewerBuild({ markerRaw: '1.0.186+d73f583', pinnedVersion: null })
    expect(v.ok).toBe(true)
    expect(v.message).toContain('not checked out')
  })

  it('fails when the marker is missing entirely', () => {
    const v = checkViewerBuild({ markerRaw: null, pinnedVersion: '1.0.205' })
    expect(v.ok).toBe(false)
    expect(v.message).toContain('no .viewer-version marker')
  })

  it('fails loudly on an unreadable marker rather than passing it', () => {
    for (const junk of ['', '   ', 'not-a-version', '+abc']) {
      expect(checkViewerBuild({ markerRaw: junk, pinnedVersion: '1.0.205' }).ok).toBe(false)
    }
  })
})

describe('parseMarker', () => {
  it('splits version and commit', () => {
    expect(parseMarker('1.0.205+fdba289')).toEqual({ version: '1.0.205', commit: 'fdba289' })
  })

  it('accepts a bare version with no commit', () => {
    expect(parseMarker('1.0.205')).toEqual({ version: '1.0.205' })
  })

  it('tolerates trailing whitespace from the file write', () => {
    expect(parseMarker('1.0.205+abc\n')).toEqual({ version: '1.0.205', commit: 'abc' })
  })

  it('rejects nonsense', () => {
    expect(parseMarker('')).toBeNull()
    expect(parseMarker('latest')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by numeric component, not lexically', () => {
    // The bug a string compare would produce: '1.0.9' > '1.0.10'.
    expect(compareVersions('1.0.9', '1.0.10')).toBeLessThan(0)
    expect(compareVersions('1.0.186', '1.0.204')).toBeLessThan(0)
    expect(compareVersions('1.0.205', '1.0.205')).toBe(0)
    expect(compareVersions('1.1.0', '1.0.999')).toBeGreaterThan(0)
  })

  it('treats a missing component as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })
})
