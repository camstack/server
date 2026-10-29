/**
 * The exporter's Setup block (pairing QR, copyable fields) and its error can
 * stand on their own, apart from the devices table.
 *
 * The integration page puts the devices table LAST (after settings and
 * activity), but a HomeKit pairing code buried under the logs is no use: the
 * page renders `<DeviceExportSetup>` near the top and the table with
 * `showSetup={false}`. Elsewhere (the addon card) the panel stays whole.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let status: Record<string, unknown> = {}

vi.mock('../../generated/system-hooks', () => ({
  useDeviceExportGetStatus: () => ({ data: status, isLoading: false }),
  useDeviceExportListExposedDevices: () => ({ data: [], isLoading: false }),
  useDeviceExportListSupportedDeviceKinds: () => ({ data: ['camera'], isLoading: false }),
  // An exporter that does not answer what else it can expose: devices only.
  useDeviceExportListSupportedEntityKinds: () => ({ data: undefined, isLoading: false }),
  useDeviceExportListExposedEntities: () => ({ data: undefined, isLoading: false }),
  useDeviceExportExposeEntity: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeviceExportUnexposeEntity: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useActionsList: () => ({ data: undefined, isLoading: false }),
  useNotificationOutputListTargets: () => ({ data: undefined, isLoading: false }),
  useDeviceManagerListAll: () => ({ data: [], isLoading: false }),
  useDeviceExportExposeDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeviceExportUnexposeDevice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

const { DeviceExportPanel, DeviceExportSetup } = await import('../device-export-panel')

function withClient(node: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

const PAIRING = {
  linkState: 'unlinked',
  exposedDeviceCount: 0,
  setup: { note: 'Scan with the Home app', fields: [{ label: 'Setup code', value: '123-45-678' }] },
}

beforeEach(() => {
  status = PAIRING
})

describe('<DeviceExportSetup>', () => {
  it('shows the setup block on its own', () => {
    render(withClient(<DeviceExportSetup addonId="export-hap" />))
    expect(screen.getByText('Scan with the Home app')).toBeTruthy()
    expect(screen.getByText('Setup code')).toBeTruthy()
  })

  it('shows the exporter error', () => {
    status = { linkState: 'error', exposedDeviceCount: 0, error: 'token expired' }
    render(withClient(<DeviceExportSetup addonId="export-alexa" />))
    expect(screen.getByText('token expired')).toBeTruthy()
  })

  it('renders nothing when there is neither setup nor error', () => {
    status = { linkState: 'linked', exposedDeviceCount: 3 }
    const { container } = render(withClient(<DeviceExportSetup addonId="export-alexa" />))
    expect(container.textContent).toBe('')
  })
})

describe('<DeviceExportPanel showSetup>', () => {
  it('carries the setup block by default', () => {
    render(withClient(<DeviceExportPanel addonId="export-hap" />))
    expect(screen.getByText('Scan with the Home app')).toBeTruthy()
  })

  it('leaves it out when the page shows it elsewhere', () => {
    status = { ...PAIRING, error: 'token expired' }
    render(withClient(<DeviceExportPanel addonId="export-hap" showSetup={false} />))
    expect(screen.queryByText('Scan with the Home app')).toBeNull()
    expect(screen.queryByText('token expired')).toBeNull()
    expect(screen.getByText('Exported devices')).toBeTruthy()
  })
})
