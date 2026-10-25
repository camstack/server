/**
 * integration-columns — the generic `DeviceListColumn<Integration>[]` that
 * drives the `/integrations` list via the unified `<DeviceList mode="generic">`.
 *
 * These render tests assert each column cell produces the integration-row
 * content: ProviderIcon + name + addonId, device count, and status badge —
 * plus the expand chevron wired to the toggle handler. There is no per-row
 * Settings button: the whole row is clickable (the page wires navigation via
 * the generic list's `onRowClick`), and the chevron `stopPropagation`s.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { buildIntegrationColumns, type Integration } from '../integration-columns'

const integration: Integration = {
  id: 'int_1',
  addonId: 'provider-reolink',
  name: 'Reolink',
  enabled: true,
  status: 'running',
  deviceCount: 3,
}

function findColumn(columns: ReturnType<typeof buildIntegrationColumns>, key: string) {
  const col = columns.find((c) => c.key === key)
  if (!col) throw new Error(`column "${key}" not found`)
  return col
}

describe('buildIntegrationColumns', () => {
  it('name cell renders the integration name + addonId and an expand toggle', () => {
    const onToggleExpand = vi.fn()
    const columns = buildIntegrationColumns({
      isExpanded: () => false,
      onToggleExpand,
    })
    render(<>{findColumn(columns, 'name').cell(integration)}</>)

    expect(screen.getByText('Reolink')).toBeTruthy()
    expect(screen.getByText('provider-reolink')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(onToggleExpand).toHaveBeenCalledWith('provider-reolink')
  })

  it('name cell shows a collapse affordance when expanded', () => {
    const columns = buildIntegrationColumns({
      isExpanded: () => true,
      onToggleExpand: vi.fn(),
    })
    render(<>{findColumn(columns, 'name').cell(integration)}</>)
    expect(screen.getByRole('button', { name: /collapse/i })).toBeTruthy()
  })

  it('devices cell renders the pluralized device count', () => {
    const columns = buildIntegrationColumns({
      isExpanded: () => false,
      onToggleExpand: vi.fn(),
    })
    render(<>{findColumn(columns, 'devices').cell(integration)}</>)
    expect(screen.getByText('3 devices')).toBeTruthy()

    render(<>{findColumn(columns, 'devices').cell({ ...integration, deviceCount: 1 })}</>)
    expect(screen.getByText('1 device')).toBeTruthy()
  })

  it('status cell renders the status badge', () => {
    const columns = buildIntegrationColumns({
      isExpanded: () => false,
      onToggleExpand: vi.fn(),
    })
    render(<>{findColumn(columns, 'status').cell(integration)}</>)
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('has no actions/settings column (row click navigates instead)', () => {
    const columns = buildIntegrationColumns({
      isExpanded: () => false,
      onToggleExpand: vi.fn(),
    })
    expect(columns.find((c) => c.key === 'actions')).toBeUndefined()
    expect(columns.map((c) => c.key)).toEqual(['name', 'devices', 'status'])
  })
})
