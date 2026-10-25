/**
 * `/automation` → `/build` must not lose the tab.
 *
 * The rename kept the tab ids deliberately, precisely so existing links keep
 * working. A redirect that drops `?tab=scripts` still renders a page and still
 * looks like it worked — it just opens the wrong section, which is the class of
 * failure nobody reports as a bug.
 */

import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { RedirectKeepingQuery } from '../RedirectKeepingQuery'

function Landed() {
  const { pathname, search } = useLocation()
  return <div data-testid="landed">{`${pathname}${search}`}</div>
}

function renderAt(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/automation" element={<RedirectKeepingQuery to="/build" />} />
        <Route path="/build" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RedirectKeepingQuery', () => {
  it('carries the query string to the new path', () => {
    renderAt('/automation?tab=scripts')
    expect(screen.getByTestId('landed').textContent).toBe('/build?tab=scripts')
  })

  it('redirects a bare path without inventing a query', () => {
    renderAt('/automation')
    expect(screen.getByTestId('landed').textContent).toBe('/build')
  })

  it('preserves every parameter, not only the first', () => {
    renderAt('/automation?tab=scripts&open=b7f2')
    expect(screen.getByTestId('landed').textContent).toBe('/build?tab=scripts&open=b7f2')
  })
})
