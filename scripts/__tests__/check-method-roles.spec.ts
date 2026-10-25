/**
 * D921 guards: every method's viewer role is legal and pinned, and the viewer
 * app's calls are reachable by a viewer in the section that makes them.
 */
import { describe, expect, it } from 'vitest'
import { roleViolations } from '../check-method-roles.ts'
import { extractCalls, refusedCalls } from '../check-viewer-calls-allowed.ts'

describe('check-method-roles', () => {
  it('the current labels have no violation', () => {
    expect(roleViolations()).toEqual([])
  })
})

describe('check-viewer-calls-allowed', () => {
  it('extracts helper calls (multi-line, generic first arg), typed-client calls and addons.custom', () => {
    const src = [
      'await capQuery(',
      '  system.trpcClient as unknown as Record<string, unknown>,',
      "  'deviceManager',",
      "  'listAll',",
      '  {},',
      ')',
      'await client.turnProvider.getTurnServers.query()',
      'const fn = (client.addons as Record<string, unknown> | null)?.custom',
      "await capQuery(c, 'notACap', 'nope')",
    ].join('\n')
    expect(extractCalls(src, 'data/x.ts').map((c) => c.path)).toEqual([
      'deviceManager.listAll',
      'turnProvider.getTurnServers',
      'addons.custom',
    ])
  })

  it('a baseline file may call viewer methods only', () => {
    const refused = refusedCalls([
      { path: 'deviceManager.listAll', file: 'data/use-cameras.ts' },
      { path: 'userManagement.listUsers', file: 'data/use-cameras.ts' },
      { path: 'faceGallery.listRecentFaces', file: 'data/use-cameras.ts' },
    ])
    expect(refused.map((r) => r.call.path)).toEqual([
      'userManagement.listUsers',
      'faceGallery.listRecentFaces',
    ])
  })

  it("a feature section may call its own feature, not another's", () => {
    const refused = refusedCalls([
      { path: 'faceGallery.listRecentFaces', file: 'screens/faces/FaceReviewScreen.tsx' },
      { path: 'plateGallery.listPlates', file: 'screens/faces/FaceReviewScreen.tsx' },
    ])
    expect(refused.map((r) => `${r.call.path} ${r.section}`)).toEqual([
      'plateGallery.listPlates feature:face-assignment',
    ])
  })

  it('a gated feature call in a baseline file passes for its own feature only', () => {
    const file = 'components/camera/theater/detail/use-face-info.ts'
    expect(refusedCalls([{ path: 'faceGallery.assignFace', file }])).toEqual([])
    expect(
      refusedCalls([{ path: 'plateGallery.deletePlate', file }]).map((r) => r.call.path),
    ).toEqual(['plateGallery.deletePlate'])
  })

  it('an admin section is not checked', () => {
    expect(refusedCalls([{ path: 'userManagement.listUsers', file: 'data/use-users.ts' }])).toEqual(
      [],
    )
  })
})
