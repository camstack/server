/**
 * DeviceExportPanel — loading is not "this addon exports nothing".
 *
 * The second copy of the defect reported on 2026-08-31 (Recordings →
 * Management claiming a capability was "not installed" while its query was in
 * flight). Here the body read:
 *
 *     {hasSupportedKinds && candidateDevices.length > 0 ? <DeviceList/> :
 *       <EmptyState description={`"${addonId}" reports no exportable device
 *                                 kinds yet.`} />}
 *
 * `hasSupportedKinds` is derived from `deviceExport.listSupportedDeviceKinds`,
 * so before it answers it is false — for exactly the same reason it is false
 * for an exporter that genuinely supports nothing. The panel therefore stated,
 * about a named addon, that it reports no exportable kinds, before asking it.
 * The header spinner does not undo a sentence in the body.
 *
 * This pins the ONE thing the header spinner cannot: that the negative claim
 * is not on screen while the reads are unsettled.
 */
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

const NO_EXPORTABLE_KINDS = /reports no exportable device kinds/i

/** Every read this panel makes, held at "not answered yet". */
const PENDING = { data: undefined, isLoading: true, isPending: true }
/** A settled read that genuinely carries nothing. */
const EMPTY = { data: [], isLoading: false, isPending: false }

let kinds: unknown = PENDING
let devices: unknown = PENDING

vi.mock('../../generated/system-hooks', () => ({
  useDeviceExportGetStatus: () => ({ data: undefined, isLoading: false }),
  useDeviceExportListExposedDevices: () => ({ data: [], isLoading: false }),
  useDeviceExportListSupportedDeviceKinds: () => kinds,
  useDeviceManagerListAll: () => devices,
  useDeviceExportExposeDevice: () => ({ mutate: vi.fn(), isPending: false }),
  useDeviceExportUnexposeDevice: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { DeviceExportPanel } = await import('../device-export-panel')

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DeviceExportPanel addonId="export-hap" />
    </QueryClientProvider>,
  )
}

describe('DeviceExportPanel — an unanswered read is not an empty answer', () => {
  it('does not claim the addon exports nothing while the reads are in flight', () => {
    kinds = PENDING
    devices = PENDING
    renderPanel()
    expect(screen.queryByText(NO_EXPORTABLE_KINDS)).toBeNull()
    expect(screen.getByText(/loading exportable devices/i)).not.toBeNull()
  })

  it('claims it only once the kinds read has ANSWERED with nothing', () => {
    kinds = EMPTY
    devices = EMPTY
    renderPanel()
    expect(screen.getByText(NO_EXPORTABLE_KINDS)).not.toBeNull()
  })
})
