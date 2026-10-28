// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { IntegrationAddonGroup } from '../../../lib/integration-addon-groups'
import type { Integration } from '../integration-columns'
import { IntegrationGrid } from '../integration-grid'

const inst = (id: string, addonId: string, name: string, deviceCount: number): Integration => ({
  id,
  addonId,
  name,
  enabled: true,
  status: 'running',
  deviceCount,
})

const wyze: IntegrationAddonGroup = {
  addonId: 'provider-wyze',
  name: 'Wyze',
  instances: [inst('a', 'provider-wyze', 'Casa', 2), inst('b', 'provider-wyze', 'Garage', 1)],
  instanceCount: 2,
  deviceCount: 3,
  status: 'running',
}
const shc: IntegrationAddonGroup = {
  addonId: 'bosch-shc',
  name: 'Bosch SHC',
  instances: [inst('c', 'bosch-shc', 'Casa', 0)],
  instanceCount: 1,
  deviceCount: 0,
  status: 'stopped',
}

const blocks: IntegrationAddonGroup = {
  addonId: 'core-blocks',
  name: 'Core Blocks',
  instances: [inst('d', 'core-blocks', 'Blocks', 4)],
  instanceCount: 1,
  deviceCount: 4,
  status: 'running',
}

function renderGrid(
  providers: readonly IntegrationAddonGroup[] = [wyze, shc],
  system: readonly IntegrationAddonGroup[] = [],
) {
  const onOpen = vi.fn<(group: IntegrationAddonGroup) => void>()
  render(
    <IntegrationGrid
      providers={providers}
      system={system}
      onOpen={onOpen}
      searchPlaceholder="Search integrations…"
      emptyLabel="No integrations found."
    />,
  )
  return { onOpen }
}

describe('IntegrationGrid', () => {
  it('shows one card per addon with its name, integration and device totals, and no id line or chevron', () => {
    const { onOpen } = renderGrid()
    const card = screen.getByTestId('integration-card-provider-wyze')
    expect(within(card).getByText('Wyze')).toBeTruthy()
    expect(within(card).getByText('2 integrations · 3 devices')).toBeTruthy()
    expect(within(card).getByText('Running')).toBeTruthy()
    expect(card.textContent?.includes('provider-wyze')).toBe(false)
    expect(within(card).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(within(card).getByRole('button', { name: 'Open Wyze' }))
    expect(onOpen).toHaveBeenCalledWith(wyze)
    expect(screen.queryByText('Casa')).toBeNull()
  })

  it('filters by addon name, id and instance name and uses the table empty label', () => {
    renderGrid()
    const search = screen.getByRole('searchbox', { name: 'Search integrations…' })
    fireEvent.change(search, { target: { value: 'garage' } })
    expect(screen.getByTestId('integration-card-provider-wyze')).toBeTruthy()
    expect(screen.queryByTestId('integration-card-bosch-shc')).toBeNull()
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByText('No integrations found.')).toBeTruthy()
  })

  it('splits the cards into a Providers and a System block, each with its heading', () => {
    renderGrid([wyze], [blocks])
    const providers = screen.getByTestId('integrations-section-providers')
    const system = screen.getByTestId('integrations-section-system')
    expect(within(providers).getByRole('heading', { name: 'Providers' })).toBeTruthy()
    expect(within(system).getByRole('heading', { name: 'System' })).toBeTruthy()
    expect(within(providers).getByTestId('integration-card-provider-wyze')).toBeTruthy()
    expect(within(system).getByTestId('integration-card-core-blocks')).toBeTruthy()
    expect(within(providers).queryByTestId('integration-card-core-blocks')).toBeNull()
  })

  it('hides an empty block', () => {
    renderGrid([wyze], [])
    expect(screen.queryByTestId('integrations-section-system')).toBeNull()
    expect(screen.getByTestId('integrations-section-providers')).toBeTruthy()
  })

  it('one search narrows both blocks and hides the block it empties', () => {
    renderGrid([wyze], [blocks])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search integrations…' }), {
      target: { value: 'blocks' },
    })
    expect(screen.queryByTestId('integrations-section-providers')).toBeNull()
    expect(screen.getByTestId('integrations-section-system')).toBeTruthy()
  })
})
