// @vitest-environment jsdom
/**
 * Identity → Tokens & sessions (D819): one page, one pills strip per credential
 * kind (same pattern as Notification Center → Rules), the kind in the URL —
 * and the two tabs it replaced (`?tab=api-keys`, `?tab=linked-sessions`) land
 * on it, on the matching kind.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => () => <div data-testid="kind-body">{name}</div>,
}))

vi.mock('../../../components/access/LoginSessionsSection', () => ({
  LoginSessionsSection: stub('login sessions body'),
}))
vi.mock('../../../components/access/LinkedAppsSection', () => ({
  LinkedAppsSection: stub('linked apps body'),
}))
vi.mock('../../../components/access/TokensSection', () => ({
  TokensSection: stub('tokens body'),
}))
vi.mock('../../../components/access/ExternalIdentitiesSection', () => ({
  ExternalIdentitiesSection: stub('sign-in links body'),
}))
vi.mock('../../../components/auth/AuthAuditSection', () => ({
  AuthAuditSection: stub('audit body'),
}))
vi.mock('../Users', () => ({ UsersPage: stub('users body') }))
vi.mock('../Authentication', () => ({
  AuthenticationPage: stub('authentication body'),
}))

import { IdentityPage } from '../Identity'

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <IdentityPage />
      <Where />
    </MemoryRouter>,
  )
}

describe('Identity → Tokens & sessions', () => {
  it('offers one pills strip of credential kinds (Rules-style sub-header)', () => {
    renderAt('/system/identity?tab=access')
    const strip = screen.getByRole('tablist', { name: /credential kinds/i })
    for (const name of ['Login sessions', 'Linked apps', 'Tokens', 'Sign-in links', 'Audit']) {
      expect(within(strip).getByRole('tab', { name: new RegExp(`^${name}$`) })).toBeTruthy()
    }
    // Flat strip — not IntegrationHub's Sessions / Tokens / Identity rows.
    expect(screen.queryByRole('group', { name: 'Sessions' })).toBeNull()
    // Legacy API keys are gone: no pill.
    expect(within(strip).queryByRole('tab', { name: /legacy/i })).toBeNull()
    // Separate scoped / admin pills are gone.
    expect(within(strip).queryByRole('tab', { name: /scoped tokens/i })).toBeNull()
    expect(within(strip).queryByRole('tab', { name: /admin tokens/i })).toBeNull()
    // A share link is a token (D895): no pill of its own.
    expect(within(strip).queryByRole('tab', { name: /share links/i })).toBeNull()
    // The first kind is on screen by default.
    expect(screen.getByTestId('kind-body').textContent).toBe('login sessions body')
  })

  it('opens the kind the URL names', () => {
    renderAt('/system/identity?tab=access&integration=auth-audit')
    expect(screen.getByTestId('kind-body').textContent).toBe('audit body')
  })

  it('an old share-links link lands on tokens, where share links now live', () => {
    renderAt('/system/identity?tab=access&integration=share-links')
    expect(screen.getByTestId('where').textContent).toContain('integration=tokens')
    expect(screen.getByTestId('kind-body').textContent).toBe('tokens body')
  })

  it('switching a kind writes ?integration= (history walk)', () => {
    renderAt('/system/identity?tab=access')
    fireEvent.click(screen.getByRole('tab', { name: /^Tokens$/ }))
    expect(screen.getByTestId('where').textContent).toContain('integration=tokens')
    expect(screen.getByTestId('kind-body').textContent).toBe('tokens body')
  })

  it('shows New token on the Identity header when Tokens is selected', () => {
    renderAt('/system/identity?tab=access&integration=tokens')
    expect(screen.getByTestId('access-new-token')).toBeTruthy()
    expect(screen.getByTestId('kind-body').textContent).toBe('tokens body')
  })

  it('the old Tokens tab redirects to the merged tokens kind', () => {
    renderAt('/system/identity?tab=api-keys')
    expect(screen.getByTestId('where').textContent).toBe(
      '/system/identity?tab=access&integration=tokens',
    )
    expect(screen.getByTestId('kind-body').textContent).toBe('tokens body')
  })

  it('retired scoped-tokens / admin-tokens integrations redirect to tokens', () => {
    renderAt('/system/identity?tab=access&integration=scoped-tokens')
    expect(screen.getByTestId('where').textContent).toContain('integration=tokens')
    expect(screen.getByTestId('kind-body').textContent).toBe('tokens body')
  })

  it('the old Linked Sessions tab redirects to linked apps', () => {
    renderAt('/system/identity?tab=linked-sessions')
    expect(screen.getByTestId('where').textContent).toBe(
      '/system/identity?tab=access&integration=linked-apps',
    )
    expect(screen.getByTestId('kind-body').textContent).toBe('linked apps body')
  })

  it('the Identity strip names the merged tab once', () => {
    renderAt('/system/identity?tab=users')
    expect(screen.getByRole('tablist', { name: /Identity & Access sections/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Tokens & sessions' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Linked Sessions' })).toBeNull()
  })
})
