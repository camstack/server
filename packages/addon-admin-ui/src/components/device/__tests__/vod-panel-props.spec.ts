/**
 * The VOD request → `StreamPanel` prop mapping, and the one field that was
 * being dropped.
 *
 * `VodPlaybackRequest` gained `format` and `StreamPanel` gained
 * `playbackFormat` when the `mp4` branch landed in `HlsVideo` (D549 decision
 * 22). `PanelContent` — the ONE consumer of the request in the admin UI — did
 * not forward it, so a native clip's MP4 URL reached hls.js, which parses it
 * as a manifest and fails. Nothing failed at build time: both ends had the
 * field, the wire between them did not.
 *
 * That is exactly the shape a rendering test would have missed (the panel
 * mounts, the hero appears, the video never plays), so the mapping is a pure
 * function and this pins it field by field.
 */
import type { VodPlaybackRequest } from '@camstack/ui-library'
import { describe, expect, it } from 'vitest'
import { vodPanelProps } from '../vod-panel-props'

describe('vodPanelProps', () => {
  it('is null with no request — the hero stays LIVE', () => {
    expect(vodPanelProps(null, 'tok')).toBeNull()
  })

  it('forwards the format an MP4 clip needs', () => {
    const request: VodPlaybackRequest = {
      url: '/addon/provider-reolink/clip/592/abc.mp4',
      format: 'mp4',
      label: 'Sun 20 Sep 10:00',
    }
    expect(vodPanelProps(request, 'tok')).toEqual({
      playbackUrl: '/addon/provider-reolink/clip/592/abc.mp4',
      playbackFormat: 'mp4',
      playbackAuthToken: 'tok',
      playbackLabel: 'Sun 20 Sep 10:00',
    })
  })

  it('omits the format for a recorder manifest — absent means hls, and every existing controller is unchanged', () => {
    const props = vodPanelProps({ url: '/addon/recorder/5/master.m3u8' }, null)
    expect(props).toEqual({
      playbackUrl: '/addon/recorder/5/master.m3u8',
      playbackAuthToken: null,
    })
    expect(props === null ? true : 'playbackFormat' in props).toBe(false)
  })
})
