// @vitest-environment jsdom
/**
 * The bootstrap form is a hub fact, not an addon pane: it shows whenever the hub is online, even
 * with no addon to list below it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  addons: [] as Array<{ addonId: string }>,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const real = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...real,
    useClusterNodes: () => ({
      isLoading: false,
      nodes: [{ id: 'hub', isHub: true, isOnline: true, addons: state.addons }],
    }),
  }
})
vi.mock('../../../components/AdminPage', () => ({
  AdminPage: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}))
vi.mock('../../../components/settings/SiteLocationCard', () => ({ SiteLocationCard: () => null }))
vi.mock('../../../components/settings/UnitsSection', () => ({ UnitsSection: () => null }))
vi.mock('../../../components/settings/HotkeysCard', () => ({ HotkeysCard: () => null }))
vi.mock('../../../components/settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: () => <div data-testid="addon-panel" />,
}))
vi.mock('../../../components/system/BootstrapSettingsForm', () => ({
  BootstrapSettingsForm: () => <div data-testid="bootstrap-form" />,
}))
import { SettingsPage } from '../Settings'

afterEach(cleanup)

describe('SettingsPage bootstrap form', () => {
  it('shows the bootstrap form when the hub lists no addon besides system-config', () => {
    state.addons = [{ addonId: 'system-config' }]
    render(<SettingsPage />)
    expect(screen.getByTestId('bootstrap-form')).toBeTruthy()
    expect(screen.queryByTestId('addon-panel')).toBeNull()
    expect(screen.getByText(/No addons installed/i)).toBeTruthy()
  })

  it('shows the addon panel under it when addons exist', () => {
    state.addons = [{ addonId: 'system-config' }, { addonId: 'mqtt-broker' }]
    render(<SettingsPage />)
    expect(screen.getByTestId('bootstrap-form')).toBeTruthy()
    expect(screen.getByTestId('addon-panel')).toBeTruthy()
  })
})
