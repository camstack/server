import { describe, expect, it } from 'vitest'
import { stripBundleVersionSegment } from '../addon-widgets.service'

/**
 * Content-version namespace strip — the generic MF cache-bust. The aggregator
 * emits `/api/addon-widgets/<addon>/v<dirHash>/<file>`; the route must serve
 * the file at `distDir/<file>` and treat the request as content-addressed
 * (immutable), while relative MF imports (`v<hash>/_stub.js`) resolve to the
 * bare `_stub.js`. Legacy unversioned paths are untouched.
 */
describe('stripBundleVersionSegment', () => {
  it('strips a leading v<hash> segment and flags versioned', () => {
    expect(stripBundleVersionSegment('v0a1b2c3d4e5f/remoteEntry.js')).toEqual({
      filePath: 'remoteEntry.js',
      versioned: true,
    })
    // relative sibling import inherits the version prefix → must resolve bare
    expect(stripBundleVersionSegment('v0a1b2c3d4e5f/_stub.js')).toEqual({
      filePath: '_stub.js',
      versioned: true,
    })
    // nested bundle subpath survives after the version segment
    expect(stripBundleVersionSegment('vdeadbeef1234/pipeline-analytics/remoteEntry.js')).toEqual({
      filePath: 'pipeline-analytics/remoteEntry.js',
      versioned: true,
    })
    // Date.now() fallback tag (digits) is still a valid v-segment
    expect(stripBundleVersionSegment('v1783974042942/remoteEntry.js').versioned).toBe(true)
  })

  it('leaves an unversioned path untouched (legacy)', () => {
    expect(stripBundleVersionSegment('remoteEntry.js')).toEqual({
      filePath: 'remoteEntry.js',
      versioned: false,
    })
    expect(stripBundleVersionSegment('pipeline-analytics/remoteEntry.js')).toEqual({
      filePath: 'pipeline-analytics/remoteEntry.js',
      versioned: false,
    })
  })

  it('does not mistake a real filename/dir for a version segment', () => {
    // 'v' + non-hex, or too short, or a normal word → not a version segment
    expect(stripBundleVersionSegment('version/remoteEntry.js').versioned).toBe(false)
    expect(stripBundleVersionSegment('v1/remoteEntry.js').versioned).toBe(false) // too short
    expect(stripBundleVersionSegment('vendor/index.js').versioned).toBe(false) // 'endor' not hex
    expect(stripBundleVersionSegment('widgets/v123/x.js').versioned).toBe(false) // not leading
  })

  it('never strips more than the first segment (traversal-safe shape)', () => {
    const out = stripBundleVersionSegment('vabcdef123456/a/b/c.js')
    expect(out.filePath).toBe('a/b/c.js')
  })
})
