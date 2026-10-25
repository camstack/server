/**
 * The Events detail panel's account of the best shot (D276).
 *
 * The operator's report was *"facce senza la persona… bisogna capire MOLTO
 * attentamente dove perdiamo le immagini"*. `previewMissReason` is the
 * [The operator's words: "faces without the person… we need to understand
 * VERY carefully where we lose the images".]
 * pipeline's answer, and it lives on `TrackSchema` — NOT on `KeyEventSchema` —
 * so the events GRID cannot show it and this panel, which already fetches the
 * whole track for the trajectory, can. That is the whole reason the block is
 * here rather than on the card.
 *
 * Three things are pinned, and the middle one is the point:
 *
 *  1. the sentence renders, and the RAW token line is kept beside it (that
 *     string is what an operator greps the hub log for — paraphrasing it away
 *     makes the two impossible to correlate);
 *  2. a track that closed with a native tile shows NOTHING. Absent means
 *     "nothing to say", never "it went fine", and a permanent "Best shot: —"
 *     reads as "checked, nothing wrong";
 *  3. the panel opens on a bare `TrackSubject`, not on the events feed's row —
 *     which is what lets the Debug tab open this same surface.
 *
 * The absence assertion in (2) is made only AFTER a positive assertion that the
 * panel rendered: an "it is not there" check passes against an empty DOM.
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackSubject } from '../track-subject.js'

const track = vi.fn<() => { readonly data: Record<string, unknown> | undefined }>(() => ({
  data: undefined,
}))

/** Every `videoclips.listClips` argument the panel built, in order. */
const listClipsCalls: { readonly input: unknown; readonly enabled: boolean }[] = []
/** What `listSources` answers — the only place a provider id may come from. */
let clipSources: readonly unknown[] = [
  {
    source: 'analytics',
    label: 'CamStack recordings',
    addonId: 'recorder',
    availability: { state: 'ok' },
  },
]

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const empty = () => ({ data: undefined, isLoading: false })
  return {
    ...actual,
    useSystem: () => ({ trpcClient: {} }),
    usePipelineAnalyticsGetTrack: () => track(),
    usePipelineAnalyticsListTrackMedia: empty,
    // Both halves of the filmstrip are MANIFESTS now; the panel no longer
    // calls the byte-bearing `getEventMedia`, so mocking it would leave a
    // stub for a hook nobody uses and let a real one reach the tRPC context.
    usePipelineAnalyticsListEventMedia: empty,
    useVideoclipsListSources: () => ({ data: clipSources, isLoading: false }),
    useVideoclipsListClips: (input: unknown, options?: { enabled?: boolean }) => {
      listClipsCalls.push({ input, enabled: options?.enabled ?? true })
      return empty()
    },
    usePipelineAnalyticsSetTrackFlags: () => ({ mutateAsync: vi.fn(), isPending: false }),
    usePipelineAnalyticsDeleteTracks: () => ({ mutateAsync: vi.fn(), isPending: false }),
    // `PublicMediaOrigin` probes the network cap to build the copyable URLs;
    // irrelevant here and it needs a tRPC context of its own.
    useAddonsListCapabilityProviders: empty,
  }
})

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { EventDetailPanel } from '../EventDetailPanel'

/** jsdom implements neither `<dialog>.showModal()` nor `.close()`; the Dialog
 *  primitive's open effect calls both. */
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false
    }
  }
})

const SUBJECT: TrackSubject = {
  deviceId: 101,
  trackId: 'trk-1',
  className: 'person',
  importance: 0.7,
  bestEventId: 'evt-1',
  timestamp: 1_700_000_000_000,
  windowMs: 30_000,
}

function renderPanel() {
  return render(
    // The panel's delete-confirm and its two failure notices go through the
    // shared dialog provider, which the admin shell mounts app-wide.
    <ConfirmDialogProvider>
      <EventDetailPanel
        row={SUBJECT}
        cameraName="Front Gate"
        deleteAvailable={false}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />
    </ConfirmDialogProvider>,
  )
}

/** The minimum a `getTrack` answer needs for the panel to render. */
function trackRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    trackId: 'trk-1',
    deviceId: 101,
    className: 'person',
    firstSeen: SUBJECT.timestamp,
    lastSeen: SUBJECT.timestamp + 30_000,
    positions: [],
    snapshots: [],
    zonesVisited: [],
    totalDistance: 0,
    state: 'idle',
    active: false,
    ...over,
  }
}

/**
 * The clip link asks `videoclips.listClips`, and that call must NAME its
 * provider (D554 amended).
 *
 * It used to send none, on the cap's documented default — *"absent means the
 * device's bound provider, which is CamStack on every camera"*. Nothing
 * implemented that: measured on the live hub 2026-09-20, device 107 (bound to
 * `recorder` AND `provider-reolink`) answered a bare call with both sources'
 * rows merged newest-first, and this panel takes `clips[0]`. So the "View
 * clip" button under an ANALYTICS event could open a 28-second file off the
 * camera's SD card, with nothing on screen saying which store it came from.
 */
describe('the clip link names the provider it is asking', () => {
  beforeEach(() => {
    listClipsCalls.length = 0
    clipSources = [
      {
        source: 'analytics',
        label: 'CamStack recordings',
        addonId: 'recorder',
        availability: { state: 'ok' },
      },
    ]
  })

  it('sends a provider from the camera’s own source list', () => {
    track.mockReturnValue({ data: trackRow({}) })
    renderPanel()
    const call = listClipsCalls.at(-1)
    expect(call).toBeDefined()
    expect(Reflect.get(Object(call?.input), 'provider')).toBe('recorder')
  })

  it('asks NOTHING when the camera lists no source — there is nobody to name', () => {
    clipSources = []
    track.mockReturnValue({ data: trackRow({}) })
    renderPanel()
    expect(listClipsCalls.every((call) => !call.enabled)).toBe(true)
  })
})

describe('the best-shot block', () => {
  it('says why the close produced no native tile, and keeps the raw tokens', () => {
    track.mockReturnValue({
      data: trackRow({ previewMissReason: 'no-key-frame capture=keyframe:native-missx4' }),
    })
    renderPanel()

    expect(screen.getByText('Best shot')).toBeInTheDocument()
    expect(screen.getByText(/No key frame existed at close/)).toBeInTheDocument()
    expect(screen.getByText('no-key-frame capture=keyframe:native-missx4')).toBeInTheDocument()
  })

  it('falls back to the RAW token for a reason this build has never heard of', () => {
    // The addon deploys separately from this bundle and can ship a new reason.
    // A defect that silently does not render is the worst way to learn that.
    track.mockReturnValue({ data: trackRow({ previewMissReason: 'lease-died-mid-close' }) })
    renderPanel()

    expect(screen.getByText('Best shot')).toBeInTheDocument()
    expect(screen.getAllByText(/lease-died-mid-close/).length).toBeGreaterThan(0)
  })

  it('says NOTHING for a track that closed with a native tile', () => {
    track.mockReturnValue({ data: trackRow({}) })
    renderPanel()

    // Positive first — the panel and its metadata rendered.
    expect(screen.getByText('Camera')).toBeInTheDocument()
    expect(screen.getAllByText('Front Gate').length).toBeGreaterThan(0)
    expect(screen.queryByText('Best shot')).not.toBeInTheDocument()
  })
})
