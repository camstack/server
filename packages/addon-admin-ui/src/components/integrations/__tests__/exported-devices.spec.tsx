/**
 * The Devices column of an exporters table: a count button per row that opens the exported
 * devices in a dialog. An unanswered status draws nothing (never "0 exported"), and a fixed row
 * (a provider that keeps no records yet) still gets the button for the whole addon.
 */
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelRow } from '../../instances/instances-model'

const h = vi.hoisted(() => ({
  status: undefined as unknown,
  statusInputs: [] as unknown[],
  panelProps: [] as Array<Record<string, unknown>>,
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useDeviceExportGetStatus: (input: unknown) => {
      h.statusInputs.push(input)
      return { data: h.status }
    },
    DeviceExportInstancePanel: (props: { instance: { instanceId: string } }) => {
      h.panelProps.push(props)
      return <div data-testid="instance-panel">{props.instance.instanceId}</div>
    },
    DeviceExportPanel: (props: { addonId: string }) => {
      h.panelProps.push(props)
      return <div data-testid="addon-panel">{props.addonId}</div>
    },
  }
})

import { exportedDevicesColumn } from '../exported-devices'

const t = ((_key: string, fallback: string, opts?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(opts?.[k] ?? ''))) as never

const INSTANCE_ROW: PanelRow = {
  kind: 'instance',
  key: 'export-hap:main',
  addonId: 'export-hap',
  providerName: 'HomeKit',
  id: 'main',
  name: 'Main bridge',
  configured: true,
  enabled: true,
} as PanelRow

const FIXED_ROW: PanelRow = {
  kind: 'fixed',
  key: 'fixed:export-alexa',
  addonId: 'export-alexa',
  providerName: 'Alexa',
  name: 'Alexa',
  description: '',
  isActive: true,
}

function cleanupPanelAndOpenFixed(): void {
  cleanup()
  cell(FIXED_ROW)
  fireEvent.click(screen.getByRole('button', { name: '16 devices exported' }))
}

function cell(row: PanelRow) {
  const column = exportedDevicesColumn(t)
  return render(<MemoryRouter>{column.render(row, 0)}</MemoryRouter>)
}

beforeEach(() => {
  h.status = { linkState: 'linked', exposedDeviceCount: 16 }
  h.statusInputs = []
  h.panelProps = []
})

describe('exportedDevicesColumn', () => {
  it('is a Devices column that says why it cannot be sorted', () => {
    const column = exportedDevicesColumn(t)
    expect(column.header).toBe('Devices')
    expect(column.notSortableReason).toBeTruthy()
  })

  it('asks the status of the row instance and opens that instance in a dialog', () => {
    cell(INSTANCE_ROW)
    expect(h.statusInputs[0]).toEqual({
      addonId: 'export-hap',
      instanceId: 'main',
    })
    fireEvent.click(screen.getByRole('button', { name: '16 devices exported' }))
    expect(screen.getByTestId('instance-panel').textContent).toBe('main')
  })

  it('a fixed row asks the addon and opens the whole addon', () => {
    cell(FIXED_ROW)
    expect(h.statusInputs[0]).toEqual({ addonId: 'export-alexa' })
    fireEvent.click(screen.getByRole('button', { name: '16 devices exported' }))
    expect(screen.getByTestId('addon-panel').textContent).toBe('export-alexa')
  })

  it('opens the list without a way to leave for a device page: a row click navigates nowhere', () => {
    cell(INSTANCE_ROW)
    fireEvent.click(screen.getByRole('button', { name: '16 devices exported' }))
    cleanupPanelAndOpenFixed()
    for (const props of h.panelProps) expect(props.onOpenDevice).toBeUndefined()
    expect(h.panelProps.length).toBeGreaterThan(0)
  })

  it('draws nothing while the status has not answered', () => {
    h.status = undefined
    const { container } = cell(INSTANCE_ROW)
    expect(container.textContent).toBe('')
  })
})
