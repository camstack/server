// @vitest-environment jsdom
/**
 * System → Settings is the installation's own settings: the bootstrap form shows whenever the
 * hub is online, and no addon's settings are drawn here (#578 — they live on the page about
 * their subject, or in the addon's dialog).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  addons: [] as Array<{ addonId: string }>,
  online: true,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const real = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...real,
    useClusterNodes: () => ({
      isLoading: false,
      nodes: [{ id: 'hub', isHub: true, isOnline: state.online, addons: state.addons }],
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

describe('SettingsPage', () => {
  it('shows the bootstrap form and no addon settings, however many addons the hub runs', () => {
    state.online = true
    state.addons = [{ addonId: 'system-config' }, { addonId: 'stream-broker' }]
    render(<SettingsPage />)
    expect(screen.getByTestId('bootstrap-form')).toBeTruthy()
    expect(screen.queryByTestId('addon-panel')).toBeNull()
    expect(screen.queryByText(/not available/i)).toBeNull()
  })

  it('says the hub is not reachable instead of drawing the bootstrap form', () => {
    state.online = false
    render(<SettingsPage />)
    expect(screen.queryByTestId('bootstrap-form')).toBeNull()
    expect(screen.getByText(/No online hub node found/i)).toBeTruthy()
  })
})
