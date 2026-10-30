/**
 * `check-no-hand-rolled-modal` — a modal is `Dialog`, never a `fixed inset-0`
 * div; a comment may still name the class.
 */
import { describe, expect, it } from 'vitest'
import { ALLOWLIST, findHandRolledOverlays } from '../check-no-hand-rolled-modal.js'

describe('hand-rolled overlays', () => {
  it('refuses the overlay as the wizards shipped it', () => {
    const src =
      '  return (\n    <div className="fixed inset-0 z-50 flex items-center justify-center">\n'
    expect(findHandRolledOverlays(src).map((f) => f.line)).toEqual([2])
  })

  it('allows a comment that names the class and the library Dialog', () => {
    expect(
      findHandRolledOverlays('// a plain `fixed inset-0` overlay is inert\n<Dialog open />'),
    ).toEqual([])
  })

  it('gives every allowlist entry a reason', () => {
    for (const entry of ALLOWLIST) expect(entry.reason.length).toBeGreaterThan(10)
  })
})
