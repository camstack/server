import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Navigation must survive a navigation.
 *
 * Every page is a lazy chunk. The app's only Suspense boundary sat above
 * `<Routes>`, which is also above `AppLayout` — so opening a page for the first
 * time suspended the entire tree and the operator got a blank screen with a
 * spinner in the middle: no sidebar, no header, nothing to click but the
 * browser's back button. It resolved in a moment on a warm LAN, which is
 * exactly why it survived: the failure is proportional to how slow the chunk
 * is, and the developer's chunk is always warm.
 *
 * This is asserted on the SOURCE rather than by rendering. `AppLayout` pulls
 * the auth context, the router and several tRPC queries, so a render harness
 * here would be mostly mocks — and a mock that supplies a chunk which never
 * suspends would make the assertion vacuous. The structural fact is what
 * matters: the boundary is INSIDE the chrome, not around it.
 */
const layoutSrc = readFileSync(join(__dirname, '..', 'AppLayout.tsx'), 'utf-8')

describe('the chrome outlives a page chunk that is still loading', () => {
  it('suspends INSIDE the layout, around the keep-alive outlet', () => {
    const suspenseAt = layoutSrc.indexOf('<Suspense')
    const outletAt = layoutSrc.indexOf('<KeepAliveOutlet')
    expect(suspenseAt).toBeGreaterThanOrEqual(0)
    expect(outletAt).toBeGreaterThan(suspenseAt)
    expect(layoutSrc.slice(suspenseAt, outletAt)).not.toContain('</Suspense>')
  })

  it('uses a fallback sized to the CONTENT, never the viewport', () => {
    // `min-h-screen` here would blank the page just as thoroughly as the outer
    // boundary did — the sidebar would still be mounted, and pushed off screen.
    const fallback = layoutSrc.slice(
      layoutSrc.indexOf('function PageContentFallback'),
      layoutSrc.indexOf('export function AppLayout'),
    )
    expect(fallback.length).toBeGreaterThan(0)
    expect(fallback).not.toContain('min-h-screen')
  })
})
