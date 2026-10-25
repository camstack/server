// @vitest-environment jsdom
/**
 * Selecting a clip drives the SAME hero player recordings use — and the
 * `format` reaches it.
 *
 * `getClipPlayback` answers `{ playbackUrl, format:'mp4', served }` for a
 * native file. Handing that URL to hls.js parses an MP4 as a manifest and
 * fails, so `format` is not decoration: it is the one bit that makes "the same
 * player" true (D549 decision 22). This test watches the VOD request the panel
 * publishes, because that is the contract `StreamPanel`/`HlsVideo` consume —
 * asserting on a rendered `<video>` would pin the player, not the handoff.
 *
 * It also pins the two things that are silently wrong when they are missing:
 * nothing is appended to the URL (the session cookie authenticates it, D549
 * decision 22), and a clip served as a different twin than the one asked for
 * SAYS so rather than pretending it was the asked-for quality (D549 15).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const PLAYBACK = {
  playbackUrl: '/addon/provider-reolink/clip/107/abc.mp4',
  format: 'mp4',
  served: 'low',
}

const SOURCES = [
  {
    source: 'native:reolink:onboard',
    label: 'SD card',
    // Stamped by the dispatcher on every row, and what the section names on
    // every `listClips` call (D554 amended).
    addonId: 'provider-reolink',
    availability: { state: 'ok' },
  },
]
const CLIPS = [
  {
    id: 'native:reolink:onboard:592:abc',
    source: 'native:reolink:onboard',
    kind: 'native',
    timeRange: {
      startMs: Date.parse('2026-09-20T10:00:00Z'),
      endMs: Date.parse('2026-09-20T10:01:40Z'),
    },
    thumbnailUnavailable: { reason: 'unsupported' },
  },
]

const playbackInputs: unknown[] = []

vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'present',
}))

vi.mock('../../../generated/system-hooks', () => ({
  useVideoclipsListSources: () => ({ status: 'success', data: SOURCES }),
  useVideoclipsListClips: () => ({ status: 'success', data: CLIPS }),
  usePipelineAnalyticsGetEventDensity: () => ({ status: 'success', data: [] }),
  useVideoclipsGetClipPlayback: (input: unknown) => {
    playbackInputs.push(input)
    return { status: 'success', data: PLAYBACK }
  },
}))

const { ClipsSection } = await import('../ClipsSection.js')
const { VodPlaybackProvider, useVodPlayback } = await import('../../../contexts/vod-playback.js')

/** Renders whatever the panel published, so the handoff is observable. */
function VodProbe() {
  const vod = useVodPlayback()
  return (
    <div data-testid="vod">
      {vod.request === null ? 'idle' : `${vod.request.format ?? 'hls'} ${vod.request.url}`}
    </div>
  )
}

describe('ClipsSection — selecting a clip', () => {
  it("publishes the provider's format and URL to the hero player, unchanged", () => {
    render(
      <VodPlaybackProvider>
        <ClipsSection deviceId={107} />
        <VodProbe />
      </VodPlaybackProvider>,
    )
    fireEvent.click(screen.getAllByRole('button', { name: /native:reolink:onboard/ })[0]!)
    expect(screen.getByTestId('vod').textContent).toBe(
      'mp4 /addon/provider-reolink/clip/107/abc.mp4',
    )
  })

  it('asks for a twin on the ONE quality scale, and says which one was served', () => {
    render(
      <VodPlaybackProvider>
        <ClipsSection deviceId={107} />
      </VodPlaybackProvider>,
    )
    fireEvent.click(screen.getAllByRole('button', { name: /native:reolink:onboard/ })[0]!)
    expect(playbackInputs.at(-1)).toMatchObject({
      deviceId: 107,
      clipId: 'native:reolink:onboard:592:abc',
      profile: 'low',
    })
    // Asked `low`, served `low` — no mismatch line.
    expect(screen.queryByText(/this clip has no/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'high' }))
    expect(playbackInputs.at(-1)).toMatchObject({ profile: 'high' })
    // Asked `high`, served `low`: the surface SAYS so.
    expect(screen.getByText(/this clip has no high twin/i)).toBeTruthy()
  })
})
