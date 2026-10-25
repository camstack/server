// @vitest-environment jsdom
/**
 * `<ClipTile>` — what one row shows, starting from the state a real FIRST
 * PAINT is in.
 *
 * Every assertion below that is about a cold state is made BEFORE anything is
 * awaited. That is deliberate and it is the lesson of the previous pass on
 * this surface: every honest-state spec passed while the wire lied, because
 * each one warmed the state before asserting it. A tile whose mint has not
 * answered yet is the single most common thing on this screen — on camera 107,
 * 349 of 400 rows carry a mint URL and 43 of the 60 on one page answer
 * `queue-full` — so "what does it look like before the answer" is the whole
 * question, not a corner case.
 */
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Clip } from '@camstack/types'
import { ClipTile } from '../ClipTile.js'
import { STILL_RETRY_ATTEMPTS } from '../clip-still-retry.js'

const BASE: Clip = {
  id: 'native:reolink:onboard:0:abc',
  source: 'native:reolink:onboard',
  kind: 'native',
  // 19:29:27 → 19:32:07 on 592: 2 m 40 s, inside the real 2 s–220 s range.
  timeRange: { startMs: 1_789_925_367_000, endMs: 1_789_925_527_000 },
}

function refusal(code: string, disposition: string, retryAfter?: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'x-camstack-reason': `${code}: the provider's own words`,
      'x-camstack-reason-code': code,
      'x-camstack-disposition': disposition,
      ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
    },
  })
}

function jpeg(): Response {
  return new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 })
}

let fetchMock = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:still', revokeObjectURL: () => {} }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function draw(clip: Clip) {
  return render(<ClipTile clip={clip} selected={false} onSelect={() => {}} />)
}

/** Let every pending microtask settle without moving the clock. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// ── the duration ──────────────────────────────────────────────────────────

describe('what a row says about itself', () => {
  it('draws the duration it was carrying all along', () => {
    fetchMock.mockResolvedValue(jpeg())
    draw({ ...BASE, thumbnail: '/still.jpg' })
    expect(screen.getByText('2m 40s')).toBeTruthy()
  })

  it('says RECORDING, and no duration, for a clip still being written', () => {
    fetchMock.mockResolvedValue(jpeg())
    draw({ ...BASE, thumbnail: '/still.jpg', inProgress: true })
    // The camera's index entry froze at start + 29 s while the file went on
    // growing for a quarter of an hour (592, 2026-09-20). A duration that does
    // not match what plays is worse than no duration.
    expect(screen.queryByText('2m 40s')).toBeNull()
    expect(screen.getByText(/recording/i)).toBeTruthy()
  })
})

// ── the cold paint ────────────────────────────────────────────────────────

describe('the first paint, before anything has answered', () => {
  it('shows LOADING for an offered mint — not a reason, and not a blank box', () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    draw({ ...BASE, thumbnailMint: '/mint' })
    // Asserted with nothing awaited: this is the state 349 of 400 rows are in
    // the instant the page paints.
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-label')).toMatch(/loading|waiting/i)
  })

  it('a provider that already said no draws the REASON on the first paint, and asks nothing', () => {
    draw({ ...BASE, thumbnailUnavailable: { reason: 'sleeping' } })
    expect(screen.getByText(/asleep/i)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a row carrying no still at all SAYS so rather than falling through to grey', () => {
    draw(BASE)
    expect(screen.getByText(/no still/i)).toBeTruthy()
  })
})

// ── deferred vs final ─────────────────────────────────────────────────────

describe('a queued still is loading, not a refusal', () => {
  it('keeps showing loading after a DEFERRED 204, and comes back for it', async () => {
    fetchMock.mockResolvedValueOnce(refusal('queue-full', 'deferred', '5'))
    fetchMock.mockResolvedValueOnce(jpeg())
    const { container } = draw({ ...BASE, thumbnailMint: '/mint' })
    await settle()

    // Still loading — the operator is never told "busy" for something that is
    // seconds away.
    expect(screen.getByRole('status').getAttribute('aria-label')).toMatch(/waiting|loading/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The still arrived: the loading name is gone and the picture is there.
    // The `<img>` is `alt=""` on purpose — the clock and the duration beside
    // it already name the row, and 60 tiles of "clip still" is noise.
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:still')
  })

  it('STOPS after its budget and then SAYS why — never blank, never for ever', async () => {
    fetchMock.mockResolvedValue(refusal('queue-full', 'deferred', '5'))
    draw({ ...BASE, thumbnailMint: '/mint' })
    await settle()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    // One initial ask plus the bounded retries, and not one more.
    expect(fetchMock).toHaveBeenCalledTimes(STILL_RETRY_ATTEMPTS + 1)
    expect(screen.getByText(/waiting for the camera/i)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(STILL_RETRY_ATTEMPTS + 1)
  })

  it('latches a FINAL 204 at once — a sleeping camera is not asked five times', async () => {
    fetchMock.mockResolvedValue(refusal('sleeping', 'final'))
    draw({ ...BASE, thumbnailMint: '/mint' })
    await settle()

    expect(screen.getByText(/asleep/i)).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats an addon that predates the split exactly as before — one ask, then the reason', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { 'x-camstack-reason': 'queue-full: 16 mints already waiting' },
      }),
    )
    draw({ ...BASE, thumbnailMint: '/mint' })
    await settle()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
