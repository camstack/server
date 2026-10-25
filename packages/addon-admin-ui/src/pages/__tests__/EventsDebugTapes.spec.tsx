/**
 * The Tapes section driven through the real component; only the transport is
 * stubbed.
 *
 *  1. collapsed, it asks the hub NOTHING (the Debug tab's own spec counts its
 *     two calls, and an unopened section must not cost the hub);
 *  2. opened, it asks status and list on the MANIFEST addon id, and a
 *     switched-off camera reads "Off", not an absent row;
 *  3. in the review view, "Same subject" on two selected lanes writes ONE
 *     relation, on the tape's camera;
 *  4. (fix round 1) a truncated ground-truth read says so on screen — a
 *     truncated read must never look like a whole one.
 *
 * Disarm: render `<TapesBody />` outside the `CollapsibleCard` (always
 * mounted) — test 1 must fail. Fix round 1 disarm: make the review never
 * render the truncated notice — test 4 must fail.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface CustomCall {
  readonly addonId: string
  readonly action: string
  readonly input: unknown
}

/** Set by an individual test before rendering; reset in `beforeEach`. */
let gtTruncated = false

const custom = vi.fn(async (call: CustomCall): Promise<unknown> => {
  switch (call.action) {
    case 'debug.tape.status':
      return {
        cameras: [
          {
            deviceId: 101,
            state: 'recording',
            framesPerMin: 420,
            gapsSinceArmed: 0,
            segmentsHeld: 12,
            bytesLastHour: 2_400_000,
            bytesHeld: 20_000_000,
          },
          {
            deviceId: 104,
            state: 'off',
            gapsSinceArmed: 0,
            segmentsHeld: 0,
            bytesLastHour: 0,
            bytesHeld: 0,
          },
        ],
      }
    case 'debug.tape.list':
      return {
        tapes: [
          {
            id: 'promo-0001',
            deviceId: 101,
            scenario: '101-door-groups',
            note: null,
            lighting: 'day',
            fromMs: 1_000_000,
            toMs: 1_300_000,
            state: 'complete',
            frames: 2_100,
            skips: 0,
            gaps: 0,
            bytes: 90_000,
            reviewed: false,
            released: false,
            tracks: ['trk-a', 'trk-b'],
            tracksStillStored: 1,
          },
        ],
      }
    case 'debug.tape.tracks':
      return {
        tapeId: 'promo-0001',
        deviceId: 101,
        fromMs: 1_000_000,
        toMs: 1_300_000,
        reviewed: false,
        lanes: [
          {
            trackId: 'trk-a',
            plane: 'pipeline',
            firstT: 0,
            lastT: 40_000,
            boundFrames: 280,
            cls: 'person',
            stillStored: true,
          },
          {
            trackId: 'trk-b',
            plane: 'pipeline',
            firstT: 42_000,
            lastT: 90_000,
            boundFrames: 300,
            cls: 'person',
            stillStored: false,
          },
        ],
      }
    case 'debug.gt.list':
      return { relations: [], purities: [], truncated: gtTruncated }
    case 'debug.gt.setRelation':
      return {}
    default:
      throw new Error(`unexpected action ${call.action}`)
  }
})

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useSystem: () => ({ trpcClient: { addons: { custom: { mutate: custom } } } }),
    useDeviceManagerListAll: () => ({
      data: [
        { id: 101, name: 'Front door' },
        { id: 104, name: 'Living room' },
      ],
      isLoading: false,
      refetch: vi.fn(),
    }),
  }
})

import { EventsDebugTapes } from '../EventsDebugTapes'

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <EventsDebugTapes />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  gtTruncated = false
  localStorage.setItem('camstack_admin_token', 'tok')
})

describe('Events → Debug → Tracking tapes', () => {
  it('asks nothing while collapsed', async () => {
    renderSection()
    expect(screen.getByText('Tracking tapes')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 20))
    expect(custom).not.toHaveBeenCalled()
  })

  it('opened, reads status and list on the manifest addon id, and says Off', async () => {
    renderSection()
    fireEvent.click(screen.getByText('Tracking tapes'))
    expect(await screen.findByText('Off')).toBeInTheDocument()
    expect(screen.getByText('Recording')).toBeInTheDocument()
    expect(screen.getByText('101-door-groups')).toBeInTheDocument()
    for (const call of custom.mock.calls) expect(call[0]?.addonId).toBe('pipeline-analytics')
    expect(custom.mock.calls.map((c) => c[0]?.action).toSorted()).toEqual([
      'debug.tape.list',
      'debug.tape.status',
    ])
  })

  it('writes one same-subject relation for two selected lanes', async () => {
    renderSection()
    fireEvent.click(screen.getByText('Tracking tapes'))
    fireEvent.click(await screen.findByRole('button', { name: 'Review 101-door-groups' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'select trk-a' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'select trk-b' }))
    fireEvent.click(screen.getByRole('button', { name: 'Same subject' }))
    await waitFor(() => {
      expect(custom.mock.calls.filter((c) => c[0]?.action === 'debug.gt.setRelation')).toHaveLength(
        1,
      )
    })
    const write = custom.mock.calls.find((c) => c[0]?.action === 'debug.gt.setRelation')?.[0]
    expect(write?.input).toEqual({
      deviceId: 101,
      trackId: 'trk-a',
      otherTrackId: 'trk-b',
      relation: 'same-subject',
    })
    expect(screen.getByText('not stored — marked through the tape')).toBeInTheDocument()
  })

  it('says so when the ground-truth read is truncated, never hides it silently', async () => {
    gtTruncated = true
    renderSection()
    fireEvent.click(screen.getByText('Tracking tapes'))
    fireEvent.click(await screen.findByRole('button', { name: 'Review 101-door-groups' }))
    expect(await screen.findByText(/more exist/i)).toBeInTheDocument()
  })
})
