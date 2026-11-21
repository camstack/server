/**
 * `<DeviceExportPanel>` link badge — tells the truth about the link (D315).
 *
 *  - linked + push ok     -> "Linked"
 *  - linked + push paused -> says proactive updates are paused and what to do
 *  - unlinked             -> "Unlinked"
 *  - a status that did not answer, or came back malformed -> "Unknown", never
 *    "Unlinked": not-yet-known must not read as not-linked.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

let statusData: unknown

vi.mock('../../generated/system-hooks', () => ({
  useDeviceExportGetStatus: () => ({ data: statusData, isLoading: false }),
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
  useDeviceManagerListAll: () => ({ data: [], isLoading: false }),
  useIntegrationsList: () => ({ data: [], isLoading: false }),
  useDeviceExportExposeDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeviceExportUnexposeDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('../../hooks/use-instances-of-cap', () => ({
  useInstancesOfCap: () => ({ data: undefined, isLoading: false }),
}))

const { DeviceExportPanel } = await import('../device-export-panel')

function renderWith(status: unknown) {
  statusData = status
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DeviceExportPanel addonId="export-alexa" />
    </QueryClientProvider>,
  )
}

describe('the link badge', () => {
  it('reads Linked when linked and pushing', () => {
    renderWith({ linkState: 'linked', push: 'ok', exposedDeviceCount: 0 })
    expect(screen.getByText('Linked')).toBeTruthy()
  })

  it('reads Linked even when the addon reports no push notion', () => {
    renderWith({ linkState: 'linked', exposedDeviceCount: 0 })
    expect(screen.getByText('Linked')).toBeTruthy()
  })

  it('says proactive updates are paused and to re-link, while staying linked', () => {
    renderWith({ linkState: 'linked', push: 'paused', exposedDeviceCount: 0 })
    expect(
      screen.getByText('Linked — proactive updates paused, re-link the skill in the Alexa app'),
    ).toBeTruthy()
    expect(screen.queryByText('Unlinked')).toBeNull()
  })

  it('reads Unlinked only when the addon says so', () => {
    renderWith({ linkState: 'unlinked', exposedDeviceCount: 0 })
    expect(screen.getByText('Unlinked')).toBeTruthy()
  })

  it('reads Unknown, not Unlinked, when there is no status', () => {
    renderWith(undefined)
    expect(screen.getByText('Unknown')).toBeTruthy()
    expect(screen.queryByText('Unlinked')).toBeNull()
  })

  it('reads Unknown, not Unlinked, when the status is malformed', () => {
    renderWith({ linkState: 'garbage' })
    expect(screen.getByText('Unknown')).toBeTruthy()
    expect(screen.queryByText('Unlinked')).toBeNull()
  })
})
