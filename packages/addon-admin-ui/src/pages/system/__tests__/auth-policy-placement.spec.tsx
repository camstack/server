// @vitest-environment jsdom
/**
 * The system-config auth section (token lifetimes, trusted proxies, trusted
 * networks, allowed browser origins) renders in exactly one place: Identity ->
 * Authentication. System -> Settings omits it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface PanelProps {
  readonly addonIds: readonly string[]
  readonly sectionIds?: readonly string[]
  readonly omitSectionIds?: readonly string[]
}

vi.mock('../../../components/settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: (props: PanelProps) => (
    <div
      data-testid="panel"
      data-addons={props.addonIds.join(',')}
      data-sections={(props.sectionIds ?? []).join(',')}
      data-omit={(props.omitSectionIds ?? []).join(',')}
    />
  ),
}))

vi.mock('../../../components/settings/SiteLocationCard', () => ({
  SiteLocationCard: () => null,
}))

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useClusterNodes: () => ({
      isLoading: false,
      nodes: [{ id: 'hub', isHub: true, isOnline: true, addons: [{ addonId: 'system-config' }] }],
    }),
  }
})

vi.mock('../../../components/settings/UnitsSection', () => ({
  UnitsSection: () => <div data-testid="units" />,
}))
vi.mock('../../../components/settings/HotkeysCard', () => ({
  HotkeysCard: () => <div data-testid="hotkeys" />,
}))

import { AuthenticationPolicyCard, PasskeyRelyingPartyCard } from '../Authentication'
import { SettingsPage } from '../Settings'

afterEach(cleanup)

describe('system-config auth section placement', () => {
  it('Identity -> Authentication draws the system-config-auth section', () => {
    render(
      <MemoryRouter>
        <AuthenticationPolicyCard />
      </MemoryRouter>,
    )
    const panel = screen.getByTestId('panel')
    expect(panel.dataset.addons).toBe('system-config')
    expect(panel.dataset.sections).toBe('system-config-auth')
  })

  it('System -> Settings omits the section', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )
    const panel = screen.getByTestId('panel')
    expect(panel.dataset.omit?.split(',')).toContain('system-config-auth')
  })

  it('Identity -> Authentication draws the webauthn section of auth-webauthn', () => {
    render(
      <MemoryRouter>
        <PasskeyRelyingPartyCard />
      </MemoryRouter>,
    )
    const panel = screen.getByTestId('panel')
    expect(panel.dataset.addons).toBe('auth-webauthn')
    expect(panel.dataset.sections).toBe('webauthn')
  })

  it('System -> Settings omits webauthn and shows Units and Hotkeys', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )
    const panel = screen.getByTestId('panel')
    expect(panel.dataset.omit?.split(',')).toContain('webauthn')
    expect(screen.getByTestId('units')).toBeTruthy()
    expect(screen.getByTestId('hotkeys')).toBeTruthy()
  })
})
