/**
 * DeviceExportPanel is per export INSTANCE: the instances are asked of the
 * provider, every read and write names one, a disabled instance reads as
 * disabled, and an unanswered instance list is neither "nothing exported"
 * nor "no instance".
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Instance {
  readonly instanceId: string
  readonly name: string
  readonly enabled: boolean
}
interface QueryInput {
  readonly instanceId?: string
}
interface MutationInput {
  readonly instanceId: string
  readonly deviceId: string
}

let instancesResult: unknown = {
  data: undefined,
  isLoading: true,
  isError: false,
}
const readInputs: QueryInput[] = []
const exposeCalls: MutationInput[] = []

vi.mock('../../generated/system-hooks', () => ({
  useDeviceExportListInstances: () => instancesResult,
  useDeviceExportGetStatus: (input: QueryInput) => {
    readInputs.push(input)
    return { data: undefined, isLoading: false }
  },
  useDeviceExportListExposedDevices: (input: QueryInput) => {
    readInputs.push(input)
    return { data: [], isLoading: false }
  },
  useDeviceExportListSupportedDeviceKinds: (input: QueryInput) => {
    readInputs.push(input)
    return { data: ['camera'], isLoading: false }
  },
  useDeviceExportListSupportedEntityKinds: () => ({
    data: undefined,
    isLoading: false,
  }),
  useDeviceExportListExposedEntities: () => ({
    data: undefined,
    isLoading: false,
  }),
  useDeviceExportExposeEntity: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeviceExportUnexposeEntity: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useActionsList: () => ({ data: undefined, isLoading: false }),
  useDeviceManagerListAll: () => ({
    data: [
      {
        id: 1,
        stableId: 'reolink:cam1',
        addonId: 'provider-reolink',
        type: 'camera',
        name: 'Garden cam',
        online: true,
        disabled: false,
        parentDeviceId: null,
      },
    ],
    isLoading: false,
  }),
  useIntegrationsList: () => ({ data: undefined, isLoading: false }),
  useDeviceExportExposeDevice: () => ({
    mutateAsync: (input: MutationInput) => {
      exposeCalls.push(input)
      return Promise.resolve(null)
    },
    isPending: false,
  }),
  useDeviceExportUnexposeDevice: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))

vi.mock('../../hooks/use-instances-of-cap', () => ({
  useInstancesOfCap: () => ({ data: undefined, isLoading: false }),
}))

const { DeviceExportPanel } = await import('../device-export-panel')

function answered(instances: readonly Instance[]): void {
  instancesResult = { data: instances, isLoading: false, isError: false }
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <DeviceExportPanel addonId="homeassistant-export" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  readInputs.length = 0
  exposeCalls.length = 0
})

describe('DeviceExportPanel per instance', () => {
  it('one instance: no instance name, reads pinned to it, a write names it', async () => {
    answered([{ instanceId: 'export-hap', name: 'Bridge', enabled: true }])
    renderPanel()
    expect(screen.queryByText('Bridge')).toBeNull()
    expect(readInputs.length).toBeGreaterThan(0)
    expect(readInputs.every((i) => i.instanceId === 'export-hap')).toBe(true)
    fireEvent.click(screen.getByLabelText('Select Garden cam'))
    fireEvent.click(screen.getByRole('button', { name: 'Expose 1' }))
    await vi.waitFor(() => {
      expect(exposeCalls).toEqual([
        expect.objectContaining({ instanceId: 'export-hap', deviceId: '1' }),
      ])
    })
  })

  it('several instances: one named section each; only the one acted on is written', async () => {
    answered([
      { instanceId: 'ha_001', name: 'Home', enabled: true },
      { instanceId: 'ha_002', name: 'Cabin', enabled: true },
    ])
    renderPanel()
    expect(screen.getByText('Home')).not.toBeNull()
    expect(screen.getByText('Cabin')).not.toBeNull()
    expect(new Set(readInputs.map((i) => i.instanceId))).toEqual(new Set(['ha_001', 'ha_002']))
    const boxes = screen.getAllByLabelText('Select Garden cam')
    expect(boxes).toHaveLength(2)
    const second = boxes[1]
    if (second === undefined) throw new Error('second section missing')
    fireEvent.click(second)
    fireEvent.click(screen.getByRole('button', { name: 'Expose 1' }))
    await vi.waitFor(() => {
      expect(exposeCalls).toEqual([
        expect.objectContaining({ instanceId: 'ha_002', deviceId: '1' }),
      ])
    })
  })

  it('a disabled instance reads as disabled and is asked nothing', () => {
    answered([
      { instanceId: 'ha_001', name: 'Home', enabled: true },
      { instanceId: 'ha_002', name: 'Cabin', enabled: false },
    ])
    renderPanel()
    expect(screen.getByText('Cabin')).not.toBeNull()
    expect(screen.getByText('Disabled')).not.toBeNull()
    expect(readInputs.some((i) => i.instanceId === 'ha_002')).toBe(false)
  })

  it('an unanswered instance list is loading, not "no instance" or "nothing exposed"', () => {
    instancesResult = { data: undefined, isLoading: true, isError: false }
    renderPanel()
    expect(screen.getByText(/loading export instances/i)).not.toBeNull()
    expect(screen.queryByText(/no export instance/i)).toBeNull()
    expect(screen.queryByText(/No exportable devices/i)).toBeNull()
  })

  it('a failed instance list is unknown, not an empty exporter', () => {
    instancesResult = { data: undefined, isLoading: false, isError: true }
    renderPanel()
    expect(screen.getByText(/could not be read/i)).not.toBeNull()
    expect(screen.queryByText(/No exportable devices/i)).toBeNull()
  })

  it('an answered empty list says the addon has no instance', () => {
    answered([])
    renderPanel()
    expect(screen.getByText(/has no export instance/i)).not.toBeNull()
  })
})
