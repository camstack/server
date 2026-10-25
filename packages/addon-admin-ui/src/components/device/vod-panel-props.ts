/**
 * The VOD request, as `StreamPanel` props.
 *
 * `VodPlaybackProvider` is how a widget (the Recording timeline, the Clips
 * browser) drives the hero player without owning it. `PanelContent` is the one
 * consumer in the admin UI, and this is the whole mapping — extracted so the
 * field-by-field handoff is pinned by a unit test instead of by a rendering
 * test that would pass while the video never plays.
 *
 * **`format` is load-bearing.** Absent means `hls` — the recorder's manifest,
 * unchanged for every existing controller. `mp4` is a native clip the vendor
 * addon fetched and muxed: handing that URL to hls.js parses an MP4 as a
 * manifest and fails (D549 decision 22). It was dropped here for exactly as
 * long as it took to write this file.
 */
import type { VodPlaybackRequest } from '@camstack/ui-library'

/** The playback half of `StreamPanel`'s props. */
export interface VodPanelProps {
  readonly playbackUrl: string
  readonly playbackFormat?: 'hls' | 'mp4'
  readonly playbackAuthToken: string | null
  readonly playbackLabel?: string
}

export function vodPanelProps(
  request: VodPlaybackRequest | null,
  playbackAuthToken: string | null,
): VodPanelProps | null {
  if (request === null) return null
  return {
    playbackUrl: request.url,
    ...(request.format === undefined ? {} : { playbackFormat: request.format }),
    playbackAuthToken,
    ...(request.label === undefined ? {} : { playbackLabel: request.label }),
  }
}
