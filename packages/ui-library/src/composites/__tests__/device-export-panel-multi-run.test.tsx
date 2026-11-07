/**
 * A multi export lands EVERY selected device.
 *
 * The exporters' `exposeDevice` is a read-modify-write of one persisted list
 * with an await between the read and the write. Fired in parallel, each call
 * reads the list before any other has written, so the last writer replaces the
 * others and a three-device export persisted one device. The panel therefore
 * runs the devices one after another.
 *
 * The fake below models that exporter faithfully (stale read, awaited work,
 * write); a fake that merely records calls cannot see the loss.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface MutationInput {
  readonly deviceId: string
  readonly instanceId?: string
}

let persisted: readonly string[] = []

function makeDevice(id: number, name: string) {
  return {
    id,
    stableId: `reolink:${String(id)}`,
    addonId: 'provider-reolink',
    type: 'camera',
    name,
    online: true,
    disabled: false,
    parentDeviceId: null,
  }
}
const DEVICES = [makeDevice(1, 'Garden cam'), makeDevice(2, 'Gate cam'), makeDevice(3, 'Porch cam')]

async function exposeLikeAnExporter(deviceId: string): Promise<null> {
  const snapshot = persisted
  await new Promise((resolve) => setTimeout(resolve, 5))
  persisted = [...snapshot.filter((id) => id !== deviceId), deviceId]
  return null
}

vi.mock('../../generated/system-hooks', () => ({
  useDeviceExportGetStatus: () => ({
    data: { linkState: 'linked', exposedDeviceCount: 0 },
    isLoading: false,
  }),
  useDeviceExportListExposedDevices: () => ({ data: [], isLoading: false }),
  useDeviceExportListInstances: () => ({
    data: [{ instanceId: 'export-x', name: 'X', enabled: true }],
    isLoading: false,
  }),
  useDeviceExportListSupportedDeviceKinds: () => ({ data: ['camera'], isLoading: false }),
  useDeviceExportListSupportedEntityKinds: () => ({ data: undefined, isLoading: false }),
  useDeviceExportListExposedEntities: () => ({ data: undefined, isLoading: false }),
  useDeviceExportExposeEntity: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeviceExportUnexposeEntity: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useActionsList: () => ({ data: undefined, isLoading: false }),
  useDeviceManagerListAll: () => ({ data: DEVICES, isLoading: false }),
  useIntegrationsList: () => ({ data: undefined, isLoading: false }),
  useDeviceExportExposeDevice: () => ({
    mutateAsync: (input: MutationInput) =>
      input.instanceId === 'export-x'
        ? exposeLikeAnExporter(input.deviceId)
        : Promise.reject(new Error('a write must name its instance')),
    isPending: false,
  }),
  useDeviceExportUnexposeDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('../../hooks/use-instances-of-cap', () => ({
  useInstancesOfCap: () => ({ data: undefined, isLoading: false }),
}))

const { DeviceExportPanel } = await import('../device-export-panel')

beforeEach(() => {
  persisted = []
})

describe('multi export', () => {
  it('persists every selected device, not just one', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DeviceExportPanel addonId="export-hap" />
      </QueryClientProvider>,
    )
    for (const name of ['Garden cam', 'Gate cam', 'Porch cam']) {
      fireEvent.click(screen.getByLabelText(`Select ${name}`))
    }
    fireEvent.click(screen.getByRole('button', { name: 'Expose 3' }))

    await waitFor(() => expect(screen.queryByTestId('export-selection-count')).toBeNull())
    expect(persisted.toSorted()).toEqual(['1', '2', '3'])
  })
})
