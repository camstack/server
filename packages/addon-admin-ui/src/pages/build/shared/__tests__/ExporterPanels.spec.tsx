/**
 * The Exporters panels of the quick modal: an action's rows (pending, none set
 * up, the name an exporter publishes it as) and a custom device's placeholder
 * before it has reported a device.
 */
import { DeviceType } from '@dominevo/types'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'
import type { CompositionRow } from '../../composition-rows'
import { ActionExporters } from '../quick-bodies/ActionExporters'
import { CustomDeviceExporters } from '../quick-bodies/CustomDeviceQuickBody'

interface Instances {
  readonly isLoading: boolean
  readonly data: readonly { id: string; name: string; addonId: string; usable: boolean }[]
}

let instances: Instances = { isLoading: true, data: [] }
let exposed: readonly { entity: { kind: string; actionId?: string }; exposedAs?: string }[] = []

vi.mock('@dominevo/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dominevo/ui-library')>()),
  useInstancesOfCap: () => instances,
  useDeviceExportListSupportedEntityKinds: () => ({ data: ['action'] }),
  useDeviceExportListExposedEntities: () => ({ data: exposed }),
  useDeviceExportExposeEntity: () => ({ mutate: vi.fn(), isPending: false }),
  useDeviceExportUnexposeEntity: () => ({ mutate: vi.fn(), isPending: false }),
  useDeviceManagerGetDevice: () => ({ data: undefined }),
}))

function wrap(node: React.ReactNode): React.ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  instances = { isLoading: true, data: [] }
  exposed = []
})

describe('ActionExporters', () => {
  it('shows a skeleton while the instances are unanswered, not "none set up"', () => {
    render(wrap(<ActionExporters actionId="internal:abc" />))
    expect(screen.queryByText('No exporter is set up.')).toBeNull()
    expect(document.querySelector('[class*="h-10"]')).not.toBeNull()
  })

  it('says no exporter is set up when the answer is empty', () => {
    instances = { isLoading: false, data: [] }
    render(wrap(<ActionExporters actionId="internal:abc" />))
    expect(screen.getByText('No exporter is set up.')).toBeTruthy()
  })

  it('shows the name an exporter publishes the action as', () => {
    instances = {
      isLoading: false,
      data: [{ id: 'i1', name: 'Home bridge', addonId: 'export-hap', usable: true }],
    }
    exposed = [{ entity: { kind: 'action', actionId: 'internal:abc' }, exposedAs: 'Feed the dog' }]
    render(wrap(<ActionExporters actionId="internal:abc" />))
    expect(screen.getByText('Home bridge')).toBeTruthy()
    expect(screen.getByTestId('exporter-exposed-as').textContent).toBe('Exported as Feed the dog')
  })

  it('shows no name line for an action that is not exposed', () => {
    instances = {
      isLoading: false,
      data: [{ id: 'i1', name: 'Home bridge', addonId: 'export-hap', usable: true }],
    }
    render(wrap(<ActionExporters actionId="internal:abc" />))
    expect(screen.queryByTestId('exporter-exposed-as')).toBeNull()
  })
})

describe('CustomDeviceExporters', () => {
  it('says exporters wait for the device while it has not reported one', () => {
    const row: CompositionRow = {
      blockId: 'porch',
      kind: 'composed',
      enabled: true,
      name: 'Porch sensor',
      namePresence: 'present',
      type: DeviceType.Sensor,
      origin: { section: 'advanced', kind: null },
      features: [],
      state: { tone: 'ok', label: 'Running', reason: null },
      sources: [],
      reportedDeviceId: null,
      tags: [],
      linkedTriggers: 0,
    }
    render(wrap(<CustomDeviceExporters row={row} />))
    expect(screen.getByText('Exporters are available once the device is reported.')).toBeTruthy()
  })
})
