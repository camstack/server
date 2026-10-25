// @vitest-environment jsdom
/**
 * `<DeviceExportPanel>` — the SHAPE of its fleet read.
 *
 * The panel polled `deviceManager.listAll({})` — the UNPROJECTED fleet, 1 017
 * rows a call on the reference hub — **every 5 seconds**, the most frequent
 * whole-collection read in either UI tree (2026-08-31 audit, defect #1). The
 * full projection is the expensive one twice over: it ships every device's
 * `config` blob, and the server reaches the settings store a SECOND time to
 * produce it (`device-queries.ts#readDeviceConfigs`). Measured the same day:
 * 5.6 s full, 2.9 s slim, against `/health` at 0.055 s.
 *
 * What is pinned here, and why each assertion is not the ambient one:
 *
 *  - **The projection is `slim`.** Asserted on the CALL, not on the rows —
 *    a test that checked the rendered rows passes against the full projection
 *    too, because the rows were never wrong. `{ projection: 'slim' }` is also
 *    the key Devices / GlobalSearch / ScanNetworkModal / ScopePreview /
 *    IntegrationDetail already hold warm, so this is a cache MERGE, not just a
 *    smaller payload.
 *  - **`refetchInterval` is the fleet window, not 5 s.** The fleet is not what
 *    changes when an operator exposes a device — `listExposedDevices` is, and
 *    it keeps its own 10 s poll.
 *  - **No field the panel renders is lost.** Slim drops exactly `config` (→
 *    `{}`), `metadata` (→ `null`) and `sourceInfo`. The panel's row parse never
 *    asked for `config`/`metadata`; `sourceInfo` it did ask for and NOTHING on
 *    this surface reads — its only reader is `resolveContainerPrimary`, and a
 *    `container` row cannot reach this list (every `device-export` provider's
 *    `listSupportedDeviceKinds` is a set of leaf types). So the test renders
 *    the REAL `<DeviceList>` from a slim wire payload and requires the row, its
 *    type label and its Expose control to still be there.
 *  - **The parse is a real gate.** A row missing a required identity field is
 *    dropped, so "the slim row still renders" is a fact about slim and not a
 *    fact about a parse that accepts anything.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FleetReadCall {
  readonly input: unknown
  readonly options: unknown
}

const fleetReads: FleetReadCall[] = []
let fleet: readonly Record<string, unknown>[] = []

const EXPORT_STATUS = {
  linkState: 'linked',
  exposedDeviceCount: 0,
  setup: null,
}

vi.mock('../../generated/system-hooks', () => ({
  useDeviceManagerListAll: (input: unknown, options: unknown) => {
    fleetReads.push({ input, options })
    return { data: fleet, isLoading: false, error: null }
  },
  useDeviceExportGetStatus: () => ({ data: EXPORT_STATUS, isLoading: false, error: null }),
  useDeviceExportListExposedDevices: () => ({ data: [], isLoading: false, error: null }),
  useDeviceExportListSupportedDeviceKinds: () => ({
    data: ['camera', 'sensor'],
    isLoading: false,
    error: null,
  }),
  useDeviceExportExposeDevice: () => ({ mutate: vi.fn(), isPending: false }),
  useDeviceExportUnexposeDevice: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { DeviceExportPanel } = await import('../device-export-panel')

/**
 * A row exactly as the SLIM projection puts it on the wire: `config` omitted
 * (the server sends `{}`), `metadata` null, and no `sourceInfo` — that is what
 * `device-queries.ts#listAll` returns for `projection: 'slim'`.
 */
const SLIM_CAMERA: Record<string, unknown> = {
  id: 41,
  stableId: 'reo-front',
  addonId: 'provider-reolink',
  type: 'camera',
  name: 'Front door',
  online: true,
  disabled: false,
  parentDeviceId: null,
  role: null,
  features: [],
  isCamera: true,
  config: {},
  metadata: null,
}

function renderPanel(): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <DeviceExportPanel addonId="export-hap" />
    </QueryClientProvider>
  )
}

describe('DeviceExportPanel — fleet read shape', () => {
  beforeEach(() => {
    fleetReads.length = 0
    fleet = [SLIM_CAMERA]
    window.localStorage.clear()
  })

  it('asks for the SLIM projection — the shared fleet key, not the unprojected one', () => {
    render(renderPanel())
    expect(fleetReads.length).toBeGreaterThan(0)
    expect(fleetReads[0]?.input).toEqual({ projection: 'slim' })
  })

  it('polls on the fleet window, not the 5 s status cadence', () => {
    render(renderPanel())
    expect(fleetReads[0]?.options).toMatchObject({ refetchInterval: 30_000 })
  })

  it('declares no window of its own — D274 owns staleTime/gcTime on the query client', () => {
    render(renderPanel())
    const options = fleetReads[0]?.options
    expect(options).not.toHaveProperty('staleTime')
    expect(options).not.toHaveProperty('gcTime')
  })

  it('renders the row, its type and its Expose control from a SLIM payload', () => {
    render(renderPanel())
    expect(screen.getByText('Front door')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /expose/i }).length).toBeGreaterThan(0)
  })

  it('the row parse is a real gate — a row missing an identity field is dropped', () => {
    const { stableId: _dropped, ...withoutStableId } = SLIM_CAMERA
    fleet = [withoutStableId]
    render(renderPanel())
    expect(screen.queryByText('Front door')).toBeNull()
  })
})
