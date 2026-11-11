// @vitest-environment jsdom
/**
 * The system-config auth section (token lifetimes, trusted proxies, trusted
 * networks, allowed browser origins) renders in exactly one place: Identity ->
 * Authentication, which asks the bootstrap form for that section. System ->
 * Settings asks for no section and names no omit list: the form leaves the
 * sign-in policy out, and the aggregate panel drops function-cap sections
 * (passkeys included) on its own.
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

import { AuthenticationPolicyCard } from '../Authentication'
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

  it('System -> Settings does not hand-pick sections, and draws no system-config pane', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )
    const form = screen.getByTestId('bootstrap-form')
    expect(form.dataset.sections).toBe('')
    expect(form.dataset.omit).toBe('')
    const panel = screen.getByTestId('panel')
    expect(panel.dataset.omit).toBe('')
    expect(panel.dataset.addons).not.toContain('system-config')
    expect(screen.getByTestId('units')).toBeTruthy()
    expect(screen.getByTestId('hotkeys')).toBeTruthy()
  })
})
