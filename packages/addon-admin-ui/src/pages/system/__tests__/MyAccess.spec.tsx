// @vitest-environment jsdom
/**
 * My access is split into sections (Profile, Sign-in & security, Sessions &
 * devices, Tokens), the active one in `?tab=` — and a linked-account popup's
 * return (`?linked=` / `?linkError=`, no tab) opens Sign-in & security, where
 * `LinkedSignInsSection` shows the outcome.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => () => <div data-testid="section-body">{name}</div>,
}))

vi.mock('../../../contexts/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'u-admin-0001', username: 'admin', isAdmin: true, exp: 0, scopes: [] },
    logout: vi.fn(),
  }),
}))
vi.mock('../../../components/users/OwnSignInSections', () => ({
  ChangePasswordSection: stub('change password'),
  TotpSection: stub('two-factor'),
  PasskeySection: stub('passkeys'),
}))
vi.mock('../../../components/users/LinkedSignInsSection', () => ({
  LinkedSignInsSection: stub('linked sign-ins'),
}))
vi.mock('../../../components/users/ConnectPhoneCard', () => ({
  ConnectPhoneCard: stub('connect phone'),
}))
vi.mock('../../../components/access/TokensSection', () => ({
  TokensSection: stub('my tokens'),
}))
vi.mock('../../../components/auth/MySessionsSection', () => ({
  MySessionsSection: stub('my sessions'),
}))
vi.mock('../../../components/certificates/MyDevicesSection', () => ({
  MyDevicesSection: stub('my devices'),
}))

import { MyAccessPage } from '../MyAccess'

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <MyAccessPage />
      <Where />
    </MemoryRouter>,
  )
}

function bodies(): string[] {
  return screen.queryAllByTestId('section-body').map((n) => n.textContent ?? '')
}

describe('My access sections', () => {
  it('offers the four sections and opens on Profile', () => {
    renderAt('/system/my-access')
    const strip = screen.getByRole('tablist', { name: /my access sections/i })
    for (const name of ['Profile', 'Sign-in & security', 'Sessions & devices', 'Tokens']) {
      expect(within(strip).getByRole('tab', { name })).toBeTruthy()
    }
    expect(screen.getByText('Unrestricted access')).toBeTruthy()
    expect(bodies()).toEqual([])
  })

  it('deep-links each section through ?tab=', () => {
    renderAt('/system/my-access?tab=sign-in')
    expect(bodies()).toEqual(['change password', 'two-factor', 'passkeys', 'linked sign-ins'])
  })

  it('switching section writes ?tab=', () => {
    renderAt('/system/my-access')
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions & devices' }))
    expect(screen.getByTestId('where').textContent).toBe('/system/my-access?tab=sessions')
    expect(bodies()).toEqual(['my sessions', 'my devices', 'connect phone'])
    fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }))
    expect(bodies()).toEqual(['my tokens'])
  })

  it('a linked-account return opens Sign-in & security and keeps the outcome', () => {
    renderAt('/system/my-access?linkError=conflict')
    expect(screen.getByTestId('where').textContent).toBe(
      '/system/my-access?linkError=conflict&tab=sign-in',
    )
    expect(bodies()).toContain('linked sign-ins')
  })
})
