// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Integration } from '../integration-columns'
import { IntegrationGrid } from '../integration-grid'

const reolink: Integration = {
  id: 'int_reolink',
  addonId: 'provider-reolink',
  name: 'Reolink',
  enabled: true,
  status: 'running',
  deviceCount: 2,
}

const onvif: Integration = {
  id: 'int_onvif',
  addonId: 'provider-onvif',
  name: 'ONVIF',
  enabled: false,
  status: 'disabled',
  deviceCount: 0,
}

function renderGrid(expandedId: string | null = null) {
  const onOpen = vi.fn<(integration: Integration) => void>()
  const onToggleExpand = vi.fn<(addonId: string) => void>()
  render(
    <IntegrationGrid
      rows={[reolink, onvif]}
      isExpanded={(integration) => integration.addonId === expandedId}
      onToggleExpand={onToggleExpand}
      onOpen={onOpen}
      renderExpanded={() => <p>Front Door</p>}
      searchPlaceholder="Search integrations…"
      emptyLabel="No integrations found."
    />,
  )
  return { onOpen, onToggleExpand }
}

describe('IntegrationGrid', () => {
  it('shows the table facts, opens from one card control, and keeps expand separate', () => {
    const { onOpen, onToggleExpand } = renderGrid()
    const card = screen.getByTestId('integration-card-int_reolink')
    expect(within(card).getByText('Reolink')).toBeTruthy()
    expect(card.textContent?.includes('provider-reolink')).toBe(true)
    expect(within(card).getByText('2 devices')).toBeTruthy()
    expect(within(card).getByText('Running')).toBeTruthy()

    const openers = within(card).getAllByRole('button', { name: /^Open / })
    expect(openers).toHaveLength(1)
    expect(within(card).queryByRole('button', { name: /^Open$/ })).toBeNull()
    fireEvent.click(openers[0] ?? card)
    expect(onOpen).toHaveBeenCalledWith(reolink)
    expect(onToggleExpand).not.toHaveBeenCalled()

    fireEvent.click(within(card).getByRole('button', { name: 'Expand' }))
    expect(onToggleExpand).toHaveBeenCalledWith('provider-reolink')
    expect(onOpen).toHaveBeenCalledTimes(1)

    const stopped = screen.getByTestId('integration-card-int_onvif')
    expect(within(stopped).getByText('Disabled')).toBeTruthy()
    expect(within(stopped).getAllByRole('button', { name: /^Open / })).toHaveLength(1)
    expect(within(stopped).getByRole('button', { name: 'Expand' })).toBeTruthy()
    expect(within(stopped).queryByRole('button', { name: /^Open$/ })).toBeNull()
  })

  it('renders the nested list when the card is expanded', () => {
    renderGrid('provider-reolink')
    const card = screen.getByTestId('integration-card-int_reolink')
    expect(within(card).getByRole('button', { name: 'Collapse' })).toBeTruthy()
    expect(within(card).getByText('Front Door')).toBeTruthy()
  })

  it('filters by name and provider and uses the table empty label', () => {
    renderGrid()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search integrations…' }), {
      target: { value: 'onvif' },
    })
    expect(screen.queryByTestId('integration-card-int_reolink')).toBeNull()
    expect(screen.getByTestId('integration-card-int_onvif')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search integrations…' }), {
      target: { value: 'missing' },
    })
    expect(screen.getByText('No integrations found.')).toBeTruthy()
  })
})
