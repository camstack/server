/**
 * AdoptDevicesModal — the generic, cap-driven adopt surface bound by the
 * `device-adoption` cap (NOT HA-specific). It previews candidate devices
 * (commit-on-Add) via the `device-manager` adoption PROXY methods and
 * adopts the selected ones. These tests partial-mock `@camstack/ui-library`
 * so only the adoption hooks are stubbed; the rest of the library keeps its
 * real implementation.
 */

import type { AdoptionJob } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AdoptDevicesModal } from '../AdoptDevicesModal'

const adopt = vi.fn().mockResolvedValue({ jobId: 'job-1' })
const refresh = vi.fn()

// The list-candidates hook result is swappable per-test so we can exercise
// the error path without disturbing the happy-path default. Tests reset it in
// `beforeEach`.
interface ListResult {
  data:
    | {
        candidates: ReadonlyArray<{
          childNativeId: string
          name: string
          type: string
          status: string
          metadata: Record<string, unknown>
          alreadyAdopted: boolean
          adoptedDeviceId: number | null
          capabilities: string[]
          children: unknown[]
        }>
        totalCount: number
        page: number
        pageSize: number
      }
    | undefined
  isLoading: boolean
  isError: boolean
  error: Error | null
  refetch: () => void
}

function successList(): ListResult {
  return {
    data: {
      candidates: [
        {
          childNativeId: 'ha:dev:1',
          name: 'Kitchen Light',
          type: 'light',
          status: 'online',
          metadata: {},
          alreadyAdopted: false,
          adoptedDeviceId: null,
          capabilities: ['switch'],
          children: [],
        },
        {
          childNativeId: 'ha:dev:2',
          name: 'Old Sensor',
          type: 'sensor',
          status: 'online',
          metadata: {},
          alreadyAdopted: true,
          adoptedDeviceId: 42,
          capabilities: [],
          children: [],
        },
      ],
      totalCount: 2,
      page: 1,
      pageSize: 50,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }
}

function entitiesList(): ListResult {
  return {
    data: {
      candidates: [
        {
          childNativeId: 'sensor.kitchen_temp',
          name: 'Kitchen Temperature',
          type: 'sensor',
          status: 'online',
          metadata: {},
          alreadyAdopted: false,
          adoptedDeviceId: null,
          capabilities: ['temperature-sensor'],
          children: [],
        },
        {
          childNativeId: 'light.kitchen',
          name: 'Kitchen Light',
          type: 'light',
          status: 'online',
          metadata: {},
          alreadyAdopted: false,
          adoptedDeviceId: null,
          capabilities: ['switch'],
          children: [],
        },
      ],
      totalCount: 2,
      page: 1,
      pageSize: 50,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }
}

let listResult: ListResult = successList()

// `listCandidates` is called by the modal with the active filter threaded in;
// per-test we swap which candidate set comes back based on the `filter` arg so
// switching the selector exercises a real re-query.
interface ListCandidatesArgs {
  filter?: string
}
const listCandidatesSpy = vi.fn()
const cancelJob = vi.fn()

// Jobs the modal's progress strip reads. Swappable per-test.
interface JobsResult {
  data: readonly AdoptionJob[] | undefined
}
let jobsResult: JobsResult = { data: [] }

interface RefreshResult {
  mutate: typeof refresh
  mutateAsync: typeof refresh
  isPending: boolean
  isError: boolean
  error: Error | null
  data: { lastError: string | null } | undefined
}
let refreshResult: RefreshResult = {
  mutate: refresh,
  mutateAsync: refresh,
  isPending: false,
  isError: false,
  error: null,
  data: undefined,
}

// The provider-declared discovery-granularity filters. Swappable per-test:
// the back-compat default is a single implicit `devices` filter (no selector).
interface FiltersResult {
  data: { filters: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }> } | undefined
  isLoading: boolean
}
let filtersResult: FiltersResult = { data: undefined, isLoading: false }

// The available-types entries drive the "import locations" checkbox: the modal
// reads `supportsLocationImport` from the entry matching its `addonId`.
// Swappable per-test so we can toggle whether the source system supports it.
interface AvailableTypesResult {
  data: ReadonlyArray<{ addonId: string; supportsLocationImport: boolean }> | undefined
}
let availableTypesResult: AvailableTypesResult = {
  data: [{ addonId: 'ha', supportsLocationImport: true }],
}

vi.mock('@camstack/ui-library', async (orig) => ({
  ...(await orig<typeof import('@camstack/ui-library')>()),
  useDeviceManagerAdoptionListCandidateFilters: () => filtersResult,
  useDeviceManagerAdoptionListCandidates: (args: ListCandidatesArgs) => {
    listCandidatesSpy(args)
    return args.filter === 'entities' ? entitiesList() : listResult
  },
  // Adoption is now a JOB: `adoptionStartJob` returns a jobId immediately and
  // the modal follows it through `adoptionListJobs`.
  useDeviceManagerAdoptionStartJob: () => ({ mutateAsync: adopt, isPending: false }),
  useDeviceManagerAdoptionListJobs: () => jobsResult,
  useDeviceManagerAdoptionCancelJob: () => ({ mutate: cancelJob, isPending: false }),
  useDeviceManagerAdoptionRefresh: () => refreshResult,
  useIntegrationsGetAvailableTypes: () => availableTypesResult,
}))

/**
 * The modal reads the query client to refresh the PAGE BEHIND when a job
 * finishes, so it needs a provider — exactly as it does in the app, where one
 * has always been above it. Rendering it without one would be a fixture that
 * disagrees with production.
 */
function renderModal(ui: React.ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('AdoptDevicesModal', () => {
  beforeEach(() => {
    adopt.mockClear()
    refresh.mockClear()
    listCandidatesSpy.mockClear()
    cancelJob.mockClear()
    jobsResult = { data: [] }
    refreshResult = {
      mutate: refresh,
      mutateAsync: refresh,
      isPending: false,
      isError: false,
      error: null,
      data: undefined,
    }
    listResult = successList()
    filtersResult = { data: undefined, isLoading: false }
    availableTypesResult = { data: [{ addonId: 'ha', supportsLocationImport: true }] }
  })

  it('warms a COLD candidate cache on open via adoptionRefresh', () => {
    // The modal warms the cache only when the first read comes back EMPTY
    // (a cache already warmed on broker-connect is not re-queried). Use an
    // empty candidate list so the one-shot cold-cache warm fires.
    listResult = {
      data: { candidates: [], totalCount: 0, page: 1, pageSize: 50 },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    expect(refresh).toHaveBeenCalled()
    expect(refresh.mock.calls[0][0]).toEqual({ addonId: 'ha', integrationId: 'ha_001' })
  })

  it('shows lastError from a successful refresh instead of a genuine empty list', () => {
    listResult = {
      data: { candidates: [], totalCount: 0, page: 1, pageSize: 50 },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }
    refreshResult = {
      ...refreshResult,
      data: { lastError: 'unable to get local issuer certificate' },
    }
    renderModal(
      <AdoptDevicesModal addonId="provider-wyze" integrationId="int_0026" onClose={() => {}} />,
    )
    expect(screen.getByText(/could not discover devices/i)).toBeTruthy()
    expect(screen.getByText(/issuer certificate/i)).toBeTruthy()
  })

  it('does NOT warm a non-empty (already-warm) cache on open', () => {
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('lists preview candidates and adopts the selected ones', async () => {
    const onClose = vi.fn()
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={onClose} />)
    // Selection is via the row's Select button (Kitchen Light is the first,
    // non-adopted candidate); clicking the name text no longer selects.
    fireEvent.click(screen.getAllByRole('button', { name: /^select$/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /add selected/i }))
    await waitFor(() => {
      expect(adopt).toHaveBeenCalledWith(
        expect.objectContaining({
          addonId: 'ha',
          integrationId: 'ha_001',
          childNativeIds: ['ha:dev:1'],
        }),
      )
    })
    // The modal must STAY OPEN and follow the job. Closing on submit is the
    // defect this replaced: adoption outlives the request that started it (a
    // 25-candidate batch measured 130s against a 60s deadline), so a modal that
    // closed left the operator with no way to see which candidates landed.
    await waitFor(() => expect(adopt).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })

  /**
   * The operator, 2026-09-16: "quando adotto un device, il pulsante adopt
   * dovrebbe diventare close se non vengono selezionati altri devices".
   * [In English: "when I adopt a device, the adopt button should become
   * close if no other devices are selected".]
   *
   * The dialog stays open after a job starts — deliberately, so the operator
   * can see which candidates landed. But `handleAdopt` clears the selection,
   * so the primary button sat there DISABLED, still saying "Add selected",
   * and the only way out was the secondary "Cancel" — which reads like undoing
   * the adoption that just succeeded.
   */
  it('turns the primary button into Close once the adopting is done', async () => {
    const onClose = vi.fn()
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={onClose} />)
    fireEvent.click(screen.getAllByRole('button', { name: /^select$/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /add selected/i }))
    await waitFor(() => expect(adopt).toHaveBeenCalled())

    // The selection is empty again and a job is running: the primary action is
    // to leave, and it must WORK — a disabled button is the defect.
    // BY TEXT, not by accessible name: the dialog's header X is also labelled
    // "Close", and a query that matched both would pass while the footer
    // button stayed disabled saying "Add selected" — the actual defect.
    const close = await screen.findByText('Close')
    expect(close.closest('button')).not.toBeDisabled()
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalled()
  })

  /**
   * …but only AFTER an adoption. With nothing adopted yet there is nothing to
   * close over, "Cancel" is the honest word for leaving, and a primary button
   * saying "Close" would just duplicate it.
   */
  it('still says Add selected before anything has been adopted', () => {
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: /add selected/i })).toBeInTheDocument()
    // The header X is labelled "Close" too, so this asks for the VISIBLE word.
    expect(screen.queryByText('Close')).toBeNull()
  })

  it('renders live job progress, and names every failed candidate', async () => {
    jobsResult = {
      data: [
        {
          jobId: 'job-1',
          addonId: 'ha',
          integrationId: 'ha_001',
          state: 'running',
          total: 25,
          processed: 9,
          adopted: 7,
          alreadyAdopted: 1,
          failed: 1,
          accessoriesCreated: 40,
          currentChildNativeId: 'ha:dev:9',
          results: [
            {
              childNativeId: 'ha:dev:8',
              outcome: 'failed',
              parentDeviceId: null,
              accessoryCount: 0,
              error: 'broker offline',
            },
          ],
          startedAt: 1,
          finishedAt: null,
          error: null,
        } satisfies AdoptionJob,
      ],
    }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    fireEvent.click(screen.getAllByRole('button', { name: /^select$/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /add selected/i }))

    // "which of my 25 landed?" must be answerable WHILE the job runs.
    await waitFor(() =>
      expect(
        screen.getByText(/9\/25 processed · 7 added · 1 already there · 1 failed/i),
      ).toBeTruthy(),
    )
    // A failure is named, never folded into one opaque error.
    expect(screen.getByText(/ha:dev:8: broker offline/i)).toBeTruthy()
    // And a running job can be stopped.
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(cancelJob).toHaveBeenCalledWith({ jobId: 'job-1' })
  })

  it('does not select already-adopted candidates', () => {
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    // Clicking an already-adopted row must not arm the Add button.
    fireEvent.click(screen.getByText('Old Sensor'))
    const addButton = screen.getByRole('button', { name: /add selected/i })
    if (!(addButton instanceof HTMLButtonElement)) throw new Error('expected a button')
    expect(addButton.disabled).toBe(true)
  })

  it('surfaces a list-fetch error instead of the empty state', () => {
    listResult = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('candidate fetch boom'),
      refetch: vi.fn(),
    }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    // The error message renders (getByText throws if absent); the genuine
    // empty state must NOT (queryByText returns null when absent).
    expect(screen.getByText('candidate fetch boom')).not.toBeNull()
    expect(screen.queryByText(/No candidate devices found/i)).toBeNull()
  })

  it('renders no filter selector when the provider declares one filter (back-compat)', () => {
    filtersResult = {
      data: { filters: [{ id: 'devices', label: 'Devices', isDefault: true }] },
      isLoading: false,
    }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    // A single filter keeps the current look — no segmented selector.
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('renders no filter selector when the provider declares none (implicit devices)', () => {
    filtersResult = { data: undefined, isLoading: false }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('renders a filter selector defaulting to the isDefault filter when >1 filter', () => {
    filtersResult = {
      data: {
        filters: [
          { id: 'devices', label: 'Devices', isDefault: true },
          { id: 'entities', label: 'Entities' },
        ],
      },
      isLoading: false,
    }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    expect(screen.getByRole('tablist')).not.toBeNull()
    const devicesTab = screen.getByRole('tab', { name: 'Devices' })
    if (!(devicesTab instanceof HTMLElement)) throw new Error('expected the Devices tab')
    expect(devicesTab.getAttribute('aria-selected')).toBe('true')
    // The default filter threads into the candidate query.
    expect(listCandidatesSpy).toHaveBeenCalledWith(expect.objectContaining({ filter: 'devices' }))
  })

  it('switching to entities re-queries listCandidates with filter:entities and lists flat entities', async () => {
    filtersResult = {
      data: {
        filters: [
          { id: 'devices', label: 'Devices', isDefault: true },
          { id: 'entities', label: 'Entities' },
        ],
      },
      isLoading: false,
    }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Entities' }))
    await waitFor(() => {
      expect(listCandidatesSpy).toHaveBeenCalledWith(
        expect.objectContaining({ filter: 'entities' }),
      )
    })
    // The flat entity candidates render.
    expect(screen.getByText('Kitchen Temperature')).not.toBeNull()
  })

  it('adopts selected entities with filter:entities and the entity ids', async () => {
    filtersResult = {
      data: {
        filters: [
          { id: 'devices', label: 'Devices', isDefault: true },
          { id: 'entities', label: 'Entities' },
        ],
      },
      isLoading: false,
    }
    const onClose = vi.fn()
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={onClose} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Entities' }))
    await waitFor(() => expect(screen.getByText('Kitchen Temperature')).not.toBeNull())
    // Kitchen Temperature is the first entity row; its selection checkbox is
    // the first "Select" button.
    fireEvent.click(screen.getAllByRole('button', { name: /^select$/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /add selected/i }))
    await waitFor(() => {
      expect(adopt).toHaveBeenCalledWith(
        expect.objectContaining({
          addonId: 'ha',
          integrationId: 'ha_001',
          filter: 'entities',
          childNativeIds: ['sensor.kitchen_temp'],
        }),
      )
    })
  })

  it('renders the import-locations checkbox when the source system supports it', () => {
    availableTypesResult = { data: [{ addonId: 'ha', supportsLocationImport: true }] }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    expect(screen.getByText(/import locations/i)).not.toBeNull()
  })

  it('does NOT render the import-locations checkbox when unsupported', () => {
    availableTypesResult = { data: [{ addonId: 'ha', supportsLocationImport: false }] }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    expect(screen.queryByText(/import locations/i)).toBeNull()
  })

  it('does NOT render the checkbox when the addon is absent from available-types', () => {
    availableTypesResult = { data: [{ addonId: 'other', supportsLocationImport: true }] }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    expect(screen.queryByText(/import locations/i)).toBeNull()
  })

  it('defaults the import-locations checkbox to checked', () => {
    availableTypesResult = { data: [{ addonId: 'ha', supportsLocationImport: true }] }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    const checkbox = screen.getByRole('checkbox')
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('expected a checkbox')
    expect(checkbox.checked).toBe(true)
  })

  it('adopts with importLocations:true when supported and checkbox left checked', async () => {
    availableTypesResult = { data: [{ addonId: 'ha', supportsLocationImport: true }] }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    // The first selectable candidate (Kitchen Light) — its row Select button.
    fireEvent.click(screen.getAllByRole('button', { name: /^select$/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /add selected/i }))
    await waitFor(() => {
      expect(adopt).toHaveBeenCalledWith(expect.objectContaining({ importLocations: true }))
    })
  })

  it('adopts with importLocations:false after the operator unchecks it', async () => {
    availableTypesResult = { data: [{ addonId: 'ha', supportsLocationImport: true }] }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('checkbox')) // uncheck the import-locations box
    fireEvent.click(screen.getAllByRole('button', { name: /^select$/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /add selected/i }))
    await waitFor(() => {
      expect(adopt).toHaveBeenCalledWith(expect.objectContaining({ importLocations: false }))
    })
  })

  it('omits importLocations entirely when the source system does not support it', async () => {
    availableTypesResult = { data: [{ addonId: 'ha', supportsLocationImport: false }] }
    renderModal(<AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={() => {}} />)
    fireEvent.click(screen.getAllByRole('button', { name: /^select$/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /add selected/i }))
    await waitFor(() => expect(adopt).toHaveBeenCalled())
    const payload = adopt.mock.calls[0][0]
    expect('importLocations' in payload).toBe(false)
  })

  it('is a native modal <dialog> that closes through the dialog close path (Escape), not a fixed overlay', () => {
    const proto = HTMLDialogElement.prototype
    if (!proto.showModal) {
      proto.showModal = function showModal(this: HTMLDialogElement) {
        this.setAttribute('open', '')
      }
    }
    if (!proto.close) {
      proto.close = function close(this: HTMLDialogElement) {
        this.removeAttribute('open')
      }
    }
    const onClose = vi.fn()
    const { container } = renderModal(
      <AdoptDevicesModal addonId="ha" integrationId="ha_001" onClose={onClose} />,
    )
    const dialog = document.querySelector('dialog')
    expect(dialog).not.toBeNull()
    expect(container.querySelector('.fixed.inset-0')).toBeNull()
    // The browser fires `close` after Escape; the primitive maps it to onOpenChange(false).
    fireEvent(dialog as HTMLDialogElement, new Event('close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
