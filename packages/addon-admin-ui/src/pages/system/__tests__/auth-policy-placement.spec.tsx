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

interface FormProps {
  readonly sectionIds?: readonly string[]
  readonly omitSectionIds?: readonly string[]
}

vi.mock('../../../components/system/BootstrapSettingsForm', () => ({
  BootstrapSettingsForm: (props: FormProps) => (
    <div
      data-testid="bootstrap-form"
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
      nodes: [
        {
          id: 'hub',
          isHub: true,
          isOnline: true,
          addons: [{ addonId: 'system-config' }, { addonId: 'auth-webauthn' }],
        },
      ],
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
  it('Identity -> Authentication draws the system-config-auth section from the bootstrap form', () => {
    render(
      <MemoryRouter>
        <AuthenticationPolicyCard />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('bootstrap-form').dataset.sections).toBe('system-config-auth')
    // system-config has no addon-level settings pane any more
    expect(screen.queryByTestId('panel')).toBeNull()
  })

  it('System -> Settings draws the bootstrap form without the auth section, and no system-config pane', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('bootstrap-form').dataset.omit?.split(',')).toContain(
      'system-config-auth',
    )
    expect(screen.getByTestId('panel').dataset.addons).not.toContain('system-config')
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
