// @vitest-environment jsdom
/**
 * System → one page with tabs (Settings, Secrets, Capabilities; Terminal stays standalone),
 * `?tab=` deep links, legacy standalone routes redirecting to their tab, and a
 * sidebar that lists System once instead of four entries.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../Settings', () => ({ SettingsPage: () => <p>settings-content</p> }))
vi.mock('../Secrets', () => ({ SecretsPage: () => <p>secrets-content</p> }))
vi.mock('../Capabilities', () => ({ CapabilitiesPage: () => <p>capabilities-content</p> }))

import { SecretsTabRedirect, SystemTabRedirect } from '../../../components/system/SystemTabRedirect'
import { buildNavSections } from '../../../lib/nav-items'
import {
  SECRETS_LEGACY_PATH,
  SYSTEM_LEGACY_ROUTES,
  SYSTEM_PAGE_PATH,
} from '../../../lib/system-page-url'
import { SystemPage } from '../System'

function Where() {
  const loc = useLocation()
  return <output data-testid="where">{loc.pathname + loc.search}</output>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={SYSTEM_PAGE_PATH} element={<SystemPage />} />
        <Route path="/system/data" element={<div>data-page</div>} />
        <Route path={SECRETS_LEGACY_PATH} element={<SecretsTabRedirect />} />
        {SYSTEM_LEGACY_ROUTES.map((r) => (
          <Route key={r.path} path={r.path} element={<SystemTabRedirect tab={r.tab} />} />
        ))}
      </Routes>
      <Where />
    </MemoryRouter>,
  )
}

describe('SystemPage', () => {
  it('opens on Settings by default', () => {
    renderAt('/system/settings')
    expect(screen.getByText('settings-content')).toBeTruthy()
    expect(screen.getByRole('tablist', { name: 'System sections' })).toBeTruthy()
    for (const label of ['Settings', 'Capabilities']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy()
    }
  })

  it.each([
    ['capabilities', 'capabilities-content'],
  ])('?tab=%s deep-links to its tab', (tab, content) => {
    renderAt(`/system/settings?tab=${tab}`)
    expect(screen.getByText(content)).toBeTruthy()
  })
})

describe('legacy standalone routes', () => {
  it.each([
    ['/system/capabilities', '/system/settings?tab=capabilities', 'capabilities-content'],
  ])('%s redirects to its tab', (from, to, content) => {
    renderAt(from)
    expect(screen.getByTestId('where').textContent).toBe(to)
    expect(screen.getByText(content)).toBeTruthy()
  })

  it('/system/secrets lands on the Data Secrets tab', () => {
    renderAt('/system/secrets')
    expect(screen.getByTestId('where').textContent).toBe('/system/data?tab=secrets')
  })

  it('maps the old ?view=audit to secretsView, which Records does not own', () => {
    renderAt('/system/secrets?view=audit')
    expect(screen.getByTestId('where').textContent).toBe(
      '/system/data?tab=secrets&secretsView=audit',
    )
  })

  it('the old /system/settings?tab=secrets deep link follows to Data', () => {
    renderAt('/system/settings?view=audit&tab=secrets')
    expect(screen.getByTestId('where').textContent).toBe(
      '/system/data?tab=secrets&secretsView=audit',
    )
  })
})

describe('sidebar', () => {
  const t = ((key: string, fallback?: string) => fallback ?? key) as never
  const paths = buildNavSections({ t, isAdmin: true }).flatMap((s) => s.items.map((i) => i.path))

  it('lists System once, and none of the pages it now hosts', () => {
    expect(paths.filter((p) => p === SYSTEM_PAGE_PATH)).toHaveLength(1)
    for (const r of SYSTEM_LEGACY_ROUTES) expect(paths).not.toContain(r.path)
  })
})
