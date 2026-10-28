// @vitest-environment jsdom
/**
 * Add Integration picker: search + 2-column grid (NotificationTargets KindPicker).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function setPointer(coarse: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query.includes('pointer: coarse'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}

const providers = vi.hoisted(() => ({
  list: [
    {
      addonId: 'provider-reolink',
      name: 'Reolink',
      description: 'Cameras',
      color: '#f60',
      iconUrl: null as string | null,
      instanceMode: 'multiple',
      existingInstances: [] as { id: string }[],
      discoveryMode: 'scan',
      kind: 'device-provider' as const,
      brokerKind: null as string | null,
      mode: 'standalone' as const,
      canTest: true,
    },
    {
      addonId: 'provider-tuya',
      name: 'Tuya',
      description: 'Smart home',
      color: '#06f',
      iconUrl: null as string | null,
      instanceMode: 'multiple',
      existingInstances: [] as { id: string }[],
      discoveryMode: 'cloud',
      kind: 'device-provider' as const,
      brokerKind: null as string | null,
      mode: 'account' as const,
      canTest: false,
    },
  ],
}))

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useIntegrationsGetAvailableTypes: () => ({ data: providers.list, isLoading: false }),
  useAddonsList: () => ({
    data: [
      { manifest: { id: 'provider-reolink' } },
      { manifest: { id: 'provider-tuya', integrationSection: 'system' } },
    ],
  }),
}))

import { ProviderPicker } from '../ProviderPicker'

describe('ProviderPicker', () => {
  beforeEach(() => {
    providers.list = providers.list.slice()
    setPointer(false)
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('renders the providers in Providers and System sections and filters by search', () => {
    const onSelect = vi.fn()
    render(
      <MemoryRouter>
        <ProviderPicker onSelect={onSelect} onClose={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('provider-picker')).toBeTruthy()
    expect(screen.getByTestId('provider-pick-provider-reolink')).toBeTruthy()
    expect(screen.getByTestId('provider-pick-provider-tuya')).toBeTruthy()
    expect(
      screen
        .getByTestId('integrations-section-providers')
        .contains(screen.getByTestId('provider-card-provider-reolink')),
    ).toBe(true)
    expect(
      screen
        .getByTestId('integrations-section-system')
        .contains(screen.getByTestId('provider-card-provider-tuya')),
    ).toBe(true)

    fireEvent.change(screen.getByTestId('provider-picker-search'), {
      target: { value: 'reolink' },
    })
    expect(screen.getByTestId('provider-pick-provider-reolink')).toBeTruthy()
    expect(screen.queryByTestId('provider-pick-provider-tuya')).toBeNull()
    expect(screen.queryByTestId('integrations-section-system')).toBeNull()
  })

  it('selects a provider when its card is clicked', () => {
    const onSelect = vi.fn()
    render(
      <MemoryRouter>
        <ProviderPicker onSelect={onSelect} onClose={vi.fn()} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByTestId('provider-pick-provider-reolink'))
    expect(onSelect).toHaveBeenCalledWith(
      'provider-reolink',
      'multiple',
      'scan',
      'Reolink',
      'device-provider',
      null,
      'standalone',
      true,
    )
  })

  it('does not show a trailing arrow on a provider card', () => {
    render(
      <MemoryRouter>
        <ProviderPicker onSelect={vi.fn()} onClose={vi.fn()} />
      </MemoryRouter>,
    )
    const card = screen.getByTestId('provider-card-provider-reolink')
    expect(card.textContent).not.toContain('>')
  })

  it('focuses the search when the picker opens on a fine pointer', () => {
    render(
      <MemoryRouter>
        <ProviderPicker onSelect={vi.fn()} onClose={vi.fn()} />
      </MemoryRouter>,
    )
    expect(document.activeElement).toBe(screen.getByTestId('provider-picker-search'))
  })

  it('does not focus the search on a coarse pointer', () => {
    setPointer(true)
    render(
      <MemoryRouter>
        <ProviderPicker onSelect={vi.fn()} onClose={vi.fn()} />
      </MemoryRouter>,
    )
    expect(document.activeElement).not.toBe(screen.getByTestId('provider-picker-search'))
  })
})
