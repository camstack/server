/**
 * Events → Debug, driven through the REAL page.
 *
 * Only the transport is stubbed: `addons.custom` answers the two `debug.*`
 * actions, `setTrackFlags` answers the writes, and `fetch` answers the
 * data-plane download and the tile bytes. Everything between — the narrowing,
 * the badge vocabulary, the shared card, the selection, the export URL — is the
 * shipping code.
 *
 * The assertions that earn their place:
 *
 *  1. the tab exists on the Events strip and `?section=debug` deep-links to it;
 *  2. the actions are called with the MANIFEST addon id (`pipeline-analytics`).
 *     Getting that wrong is a 404 that looks like a missing deploy, and it has
 *     already cost this repo an afternoon;
 *  3. a track's anomalies render as badges, and a clean track says so;
 *  4. a STAND-IN tile is visibly a stand-in (D276), and a native one is badged
 *     nothing at all — "we cannot tell" must not render as an accusation;
 *  5. the close's own `previewMissReason` reaches the screen as a sentence;
 *  6. multi-select selects, and the bulk action applies to the SELECTION —
 *     not to the whole list, and not to the wrong camera's `track-N`;
 *  7. "Analyzed" un-marks, and the un-marked row leaves the list;
 *  8. "Export all" hits the admin-gated data plane, with the camera filter.
 *
 * The trap that has bitten this file's neighbours twice: an ABSENCE assertion
 * passes against a DOM that never rendered. Every `not.toBeInTheDocument()`
 * below is preceded by a positive assertion that the panel it is about is on
 * screen.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const T0 = 1_700_000_000_000

const BROKEN_TRACK = {
  trackId: 'trk-broken',
  deviceId: 101,
  className: 'person',
  label: 'postman',
  firstSeen: T0,
  lastSeen: T0 + 30_000,
  durationMs: 30_000,
  active: false,
  importance: 0.8,
  bestEventId: 'evt-broken',
  previewMissReason: 'no-key-frame capture=keyframe:native-missx4',
}

const CLEAN_TRACK = {
  trackId: 'trk-clean',
  deviceId: 102,
  className: 'cat',
  label: 'cat',
  firstSeen: T0,
  lastSeen: T0 + 30_000,
  durationMs: 30_000,
  active: false,
  importance: 0.4,
  bestEventId: 'evt-clean',
}

const BROKEN_REPORT = {
  ...BROKEN_TRACK,
  positionCount: 12,
  mediaCount: 2,
  mediaKinds: ['firstFrame', 'keyFrame'],
  eventCount: 0,
  thumbnailProvenance: 'standin',
  findings: [
    {
      code: 'ZERO_EVENTS',
      severity: 'error',
      detail: 'No object events — the track recorded nothing.',
    },
    { code: 'MISSING_THUMBNAIL', severity: 'warn', detail: 'No thumbnail.' },
  ],
}

const CLEAN_REPORT = {
  ...CLEAN_TRACK,
  positionCount: 40,
  mediaCount: 6,
  mediaKinds: ['keyFrame', 'lastFrame'],
  eventCount: 24,
  thumbnailProvenance: 'native',
  findings: [],
}

/** Track ids the list should still report. Mutated by an un-mark. */
let listedTracks: readonly unknown[] = [BROKEN_TRACK, CLEAN_TRACK]

const custom = vi.fn(async (input: { action: string; addonId: string; input: unknown }) => {
  if (input.action === 'debug.listTracks') {
    return { tracks: listedTracks, truncated: false }
  }
  if (input.action === 'debug.analyze') {
    const ids = new Set(listedTracks.map((t) => (t as { trackId: string }).trackId))
    return {
      reports: [BROKEN_REPORT, CLEAN_REPORT].filter((r) => ids.has(r.trackId)),
      vanished: ['trk-evicted'],
    }
  }
  throw new Error(`unexpected action ${input.action}`)
})

interface SetFlagsVars {
  readonly deviceId: number
  readonly trackId: string
  readonly flags: Record<string, boolean>
}

const setFlags = vi.fn(async (vars: SetFlagsVars) => ({
  trackId: vars.trackId,
  markForTrain: false,
  debug: vars.flags['debug'] ?? false,
  favourited: vars.flags['favourited'] ?? false,
  retrainStatus: 'none' as const,
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useSystem: () => ({ trpcClient: { addons: { custom: { mutate: custom } } } }),
    useDeviceManagerListAll: () => ({
      data: [
        { id: 101, name: 'Front Gate' },
        { id: 102, name: 'Driveway' },
      ],
      isLoading: false,
      refetch: vi.fn(),
    }),
    // The page's bulk actions go through `use-track-flags.ts`, which resolves
    // this hook ONCE at module load — so it has to exist on the mock.
    usePipelineAnalyticsSetTrackFlags: () => ({ mutateAsync: setFlags, isPending: false }),
  }
})

// The Feed tab owns its own tests; this file is about Debug.
vi.mock('../../components/detection-intelligence/EventsSection', () => ({
  EventsSection: () => <div>events-feed-section</div>,
}))
vi.mock('../../components/detection-intelligence/SemanticEventSearch', () => ({
  SemanticEventSearch: () => <div>semantic-event-search</div>,
}))
vi.mock('../../components/detection-intelligence/StationarySection', () => ({
  StationarySection: () => <div>stationary-section</div>,
}))
vi.mock('../Retrain', () => ({ RetrainPage: () => <div>retrain-page</div> }))

// The detail modal is the Events feed's own surface and has its own spec. Here
// it is a probe: what matters is that Debug opens THE SHARED PANEL, with the
// track the operator clicked — not that it renders a second view of its own.
vi.mock('../../components/detection-intelligence/EventDetailPanel', () => ({
  EventDetailPanel: ({ row }: { readonly row: { readonly trackId: string } | null }) =>
    row === null ? null : <div>detail-panel:{row.trackId}</div>,
}))

import { EventsPage } from '../Events'

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <EventsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listedTracks = [BROKEN_TRACK, CLEAN_TRACK]
  localStorage.setItem('camstack_admin_token', 'tok')
})

describe('the Debug tab on the Events strip', () => {
  it('is offered alongside Feed, and is not the default', () => {
    renderAt('/library?tab=events')
    expect(screen.getByRole('tab', { name: 'Debug' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Feed' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('events-feed-section')).toBeInTheDocument()
  })

  it('deep-links via ?section=debug', async () => {
    renderAt('/library?tab=events&section=debug')
    expect(await screen.findByText(/postman/)).toBeInTheDocument()
    expect(screen.queryByText('events-feed-section')).not.toBeInTheDocument()
  })
})

describe('Events → Debug', () => {
  it('calls both actions on the MANIFEST addon id, not the npm package name', async () => {
    renderAt('/library?tab=events&section=debug')
    await waitFor(() => {
      expect(custom).toHaveBeenCalledTimes(2)
    })
    for (const call of custom.mock.calls) {
      expect(call[0]?.addonId).toBe('pipeline-analytics')
    }
    expect(custom.mock.calls.map((c) => c[0]?.action).toSorted()).toEqual([
      'debug.analyze',
      'debug.listTracks',
    ])
  })

  it('asks to analyse exactly the tracks it listed', async () => {
    renderAt('/library?tab=events&section=debug')
    await waitFor(() => {
      expect(custom).toHaveBeenCalledTimes(2)
    })
    const analyze = custom.mock.calls.find((c) => c[0]?.action === 'debug.analyze')?.[0]
    expect(analyze?.input).toEqual({ trackIds: ['trk-broken', 'trk-clean'] })
  })

  it('renders each anomaly as a badge, with the addon’s own sentence as its title', async () => {
    renderAt('/library?tab=events&section=debug')
    const badge = await screen.findByText('no events')
    expect(badge).toBeInTheDocument()
    expect(badge.getAttribute('title')).toContain('No object events')
    expect(screen.getByText('no thumbnail')).toBeInTheDocument()
    // Worst first: the error precedes the warning.
    expect(badge.compareDocumentPosition(screen.getByText('no thumbnail'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('says a clean track is clean, rather than showing an empty row', async () => {
    renderAt('/library?tab=events&section=debug')
    expect(await screen.findByText('no anomaly found')).toBeInTheDocument()
  })

  it('names each track’s camera, and its media / event / position counts', async () => {
    renderAt('/library?tab=events&section=debug')
    expect(await screen.findByText('Front Gate')).toBeInTheDocument()
    expect(screen.getByText('Driveway')).toBeInTheDocument()
    // `find`, not `get`: the counts come from the SECOND request, so they appear
    // after the names do. And matched on the node's own textContent because the
    // JSX splits the line across several text nodes.
    expect(
      await screen.findByText(
        (_, el) =>
          (el?.textContent ?? '').replace(/\s+/g, ' ').trim() ===
          '2 media · 0 events · 12 positions',
      ),
    ).toBeInTheDocument()
  })

  it('reports the tracks that were evicted between the list and the analysis', async () => {
    renderAt('/library?tab=events&section=debug')
    expect(
      await screen.findByText(/1 marked track\(s\) were evicted between the list and the analysis/),
    ).toBeInTheDocument()
  })

  it('warns that a debug mark does not pin retention', async () => {
    renderAt('/library?tab=events&section=debug')
    expect(await screen.findByText(/does not pin retention/)).toBeInTheDocument()
  })

  it('opens the SHARED events detail panel for the clicked track', async () => {
    renderAt('/library?tab=events&section=debug')
    fireEvent.click(await screen.findByText(/postman/))
    expect(await screen.findByText('detail-panel:trk-broken')).toBeInTheDocument()
  })
})

/**
 * D276 on the tile.
 *
 * A stand-in is legitimate as a fallback and the operator accepted it — what is
 * not acceptable is showing one as if it were a best shot. Both directions are
 * asserted, because a badge that renders on everything is the same defect as
 * one that renders on nothing.
 */
describe('the best-shot provenance badge', () => {
  it('marks a stand-in tile as a stand-in, with the reason as its title', async () => {
    renderAt('/library?tab=events&section=debug')
    const badge = await screen.findByText('stand-in')
    expect(badge.getAttribute('title')).toContain('face or plate detail crop')
  })

  it('badges nothing on a native tile', async () => {
    renderAt('/library?tab=events&section=debug')
    // Assert the CLEAN card rendered FIRST — an absence assertion against a
    // DOM that never painted passes for the wrong reason.
    expect(await screen.findByTitle('Driveway')).toBeInTheDocument()
    expect(await screen.findByText('no anomaly found')).toBeInTheDocument()
    expect(screen.queryByText('native')).not.toBeInTheDocument()
    // Exactly one stand-in badge: the broken card's, not both cards'.
    expect(screen.getAllByText('stand-in')).toHaveLength(1)
  })

  it('prints the close’s own account of the miss, keeping the raw token line', async () => {
    renderAt('/library?tab=events&section=debug')
    const line = await screen.findByText(/No key frame existed at close/)
    expect(line.getAttribute('title')).toBe('no-key-frame capture=keyframe:native-missx4')
  })
})

/**
 * Multi-select and the bulk actions.
 *
 * `setTrackFlags` is per-track and has no batch form, so a bulk action is N
 * writes. What matters is that they go to the SELECTION — the composite
 * `${deviceId}:${trackId}` key exists because `track-N` is a per-camera counter
 * and a bare-id set un-marks the wrong camera's track.
 */
describe('multi-select', () => {
  async function selectBroken(): Promise<void> {
    await screen.findByText(/postman/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Select' })[0] as HTMLElement)
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
  }

  /**
   * Wait for the bulk to FINISH, not for a call count to pass through a value.
   *
   * `waitFor(() => expect(fn).toHaveBeenCalledTimes(1))` succeeds the instant
   * the first of N sequential writes lands, so it passes just as happily when
   * the action was applied to the whole list. This disarmed cleanly and the
   * count assertion did not — the bar clearing is the observable end of the
   * loop, and the count is only meaningful after it.
   */
  async function bulkSettled(): Promise<void> {
    await waitFor(() => {
      expect(screen.queryByText(/ selected$/)).not.toBeInTheDocument()
    })
  }

  it('selects a card and offers the bulk actions', async () => {
    renderAt('/library?tab=events&section=debug')
    await selectBroken()
    expect(screen.getByRole('button', { name: /Analyzed/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Keep/ })).toBeInTheDocument()
  })

  it('applies Analyzed to the SELECTION only, as debug:false', async () => {
    renderAt('/library?tab=events&section=debug')
    await selectBroken()
    fireEvent.click(screen.getByRole('button', { name: /Analyzed/ }))
    await bulkSettled()

    // The whole list is TWO tracks; only the selected one may be written.
    expect(setFlags).toHaveBeenCalledTimes(1)
    expect(setFlags).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 101,
        trackId: 'trk-broken',
        flags: { debug: false },
      }),
    )
  })

  it('removes the un-marked row from the list, and offers to undo it', async () => {
    renderAt('/library?tab=events&section=debug')
    await selectBroken()
    // The server is the authority on what is still marked: the un-marked track
    // stops being listed, exactly as the hub would answer on the refetch.
    listedTracks = [CLEAN_TRACK]
    fireEvent.click(screen.getByRole('button', { name: /Analyzed/ }))

    // Positive first: the list still rendered, and the OTHER card survived.
    // By TITLE — the camera picker holds an <option> with the same text.
    expect(await screen.findByTitle('Driveway')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText(/postman/)).not.toBeInTheDocument()
    })
    expect(
      screen.getByText(/1 track\(s\) marked analyzed and removed from this list/),
    ).toBeInTheDocument()
  })

  it('Keep pins the selection against retention, as favourited:true', async () => {
    renderAt('/library?tab=events&section=debug')
    await selectBroken()
    fireEvent.click(screen.getByRole('button', { name: /Keep/ }))
    await bulkSettled()

    expect(setFlags).toHaveBeenCalledTimes(1)
    expect(setFlags).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 'trk-broken', flags: { favourited: true } }),
    )
  })

  it('Select all selects every listed track, and both are written', async () => {
    renderAt('/library?tab=events&section=debug')
    await screen.findByText(/postman/)
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Analyzed/ }))
    await bulkSettled()

    expect(setFlags).toHaveBeenCalledTimes(2)
    expect(setFlags.mock.calls.map((c) => c[0]?.trackId).toSorted()).toEqual([
      'trk-broken',
      'trk-clean',
    ])
  })
})

/** Only the slice of `RequestInit` the download helper sets. */
interface FetchInit {
  readonly headers?: Record<string, string>
}

describe('Export all', () => {
  it('downloads from the admin-gated data plane, with the bearer token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-disposition': 'attachment; filename="camstack-debug-x.zip"',
      }),
      blob: async () => new Blob(['PK']),
    }))
    vi.stubGlobal('fetch', fetchMock)
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:stub')
    globalThis.URL.revokeObjectURL = vi.fn()

    renderAt('/library?tab=events&section=debug')
    fireEvent.click(await screen.findByRole('button', { name: /Export all \(2\)/ }))

    // The card tiles fetch off the same plane, so the export is identified by
    // its URL rather than by being the only call.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((c) => c[0] === '/addon/pipeline-analytics/debug-export'),
      ).toBe(true)
    })
    const call = fetchMock.mock.calls.find((c) => c[0] === '/addon/pipeline-analytics/debug-export')
    expect(call?.[1]?.headers?.['Authorization']).toBe('Bearer tok')
    vi.unstubAllGlobals()
  })

  it('carries the camera filter into the export URL', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: FetchInit) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: async () => new Blob(['PK']),
    }))
    vi.stubGlobal('fetch', fetchMock)
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:stub')
    globalThis.URL.revokeObjectURL = vi.fn()

    renderAt('/library?tab=events&section=debug')
    await screen.findByText(/postman/)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '102' } })
    // The filter change starts a new list query; until it lands the set is empty
    // and the button is (correctly) disabled, so clicking now would be a no-op.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Export all \(2\)/ })).toBeEnabled()
    })
    fireEvent.click(screen.getByRole('button', { name: /Export all/ }))

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (c) => c[0] === '/addon/pipeline-analytics/debug-export?deviceIds=102',
        ),
      ).toBe(true)
    })
    vi.unstubAllGlobals()
  })
})
