import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { TemplatesRedirect, templatesRedirectTarget } from '../TemplatesRedirect'

function Where() {
  const { pathname, search } = useLocation()
  return <span data-testid="where">{`${pathname}${search}`}</span>
}

function renderAt(url: string): void {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/system/templates" element={<TemplatesRedirect />} />
        <Route path="/build" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('/system/templates redirect', () => {
  it('lands on the Build templates tab', () => {
    renderAt('/system/templates')
    expect(screen.getByTestId('where').textContent).toBe('/build?tab=templates')
  })

  it('keeps ?edit= so the editor still opens on that template', () => {
    renderAt('/system/templates?edit=tpl%201')
    expect(screen.getByTestId('where').textContent).toBe('/build?tab=templates&edit=tpl+1')
  })

  it('carries nothing else over', () => {
    expect(templatesRedirectTarget('?foo=1&edit=a')).toBe('/build?tab=templates&edit=a')
  })
})
