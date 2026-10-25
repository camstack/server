/**
 * Horizontal padding COMPOUNDS, so it has to scale.
 *
 * 2026-09-10, operator on a phone: "il padding tra i vari componenti è
 * estremamente alto e non scala bene su schermi piccoli", about the shared
 * panel Connectivity → Export renders.
 *
 * No single value was large. The nesting was: `AdminPage`'s `p-4`, the export
 * panel's own `p-4`, and its rows' `px-4` — three layers of 16 px a side, so
 * **96 px of a 320 px viewport, 30% of the screen, spent on margins** before
 * any content. On a desktop the same three layers are invisible.
 *
 * The rule this pins: a container that nests inside other padded containers
 * states its horizontal padding responsively. `px-4` alone is a desktop
 * measurement wearing no qualifier.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = path.join(__dirname, '..', 'device-export-panel.tsx')

/** Every `px-N` / `p-N` that is NOT already qualified by a breakpoint. */
function unqualifiedHorizontalPadding(src: string): readonly string[] {
  const out: string[] = []
  for (const m of src.matchAll(/className="([^"]*)"/g)) {
    const classes = (m[1] ?? '').split(/\s+/)
    for (const c of classes) {
      // `sm:px-4` is the qualified half of a pair and is fine.
      if (c.includes(':')) continue
      const size = /^p(x)?-(\d+)$/.exec(c)
      if (size === null) continue
      if (Number(size[2]) < 3) continue
      // Only a violation when the same list has no responsive counterpart.
      if (classes.some((other) => other.endsWith(`:${c}`) || /^sm:p(x)?-\d+$/.test(other))) continue
      out.push(c)
    }
  }
  return out
}

describe('the export panel scales its horizontal padding', () => {
  const src = fs.readFileSync(SOURCE, 'utf-8')

  it('states no bare p-4/px-4 — those are desktop measurements', () => {
    expect(
      unqualifiedHorizontalPadding(src),
      'a padding this size compounds with the page wrapper and the row inside it',
    ).toEqual([])
  })

  it('and does carry the responsive pairs, so desktop is unchanged', () => {
    expect(src).toContain('sm:px-4')
    expect(src).toContain('sm:p-4')
  })
})
