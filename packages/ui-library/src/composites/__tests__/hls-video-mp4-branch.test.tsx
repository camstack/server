/**
 * D549 22: clips play in the SAME player recordings use — and that player is
 * HLS-only today. A progressive MP4 does not drop in: hls.js would try to
 * parse it as a manifest and fail, and the Safari fallback keys on the HLS
 * MIME. The `mp4` branch is the one change a native clip needs.
 *
 * Two things this pins, both of which are the whole point:
 *  - `mp4` sets `video.src` and never touches hls.js;
 *  - NOTHING is appended to the URL. The hub's `/addon/<id>/<prefix>` proxy
 *    takes the session cookie, so a clip URL is never a credential and may
 *    sit in history, a `Referer` or a shared log and open nothing.
 */
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HlsVideo } from '../hls-video'

const CLIP_URL = '/addon/provider-reolink/clip/592/abc.mp4'
const MANIFEST_URL = '/addon/recorder/playback/592/master.m3u8'

describe('HlsVideo mp4 branch', () => {
  it('plays an mp4 by setting video.src, without loading hls.js', async () => {
    const { container } = render(
      <HlsVideo url={CLIP_URL} format="mp4" authToken="a-bearer" autoPlay={false} />,
    )
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    await waitFor(() => {
      expect(video?.getAttribute('src')).toBe(CLIP_URL)
    })
  })

  it('appends NOTHING to the URL — it is not a credential', async () => {
    const { container } = render(
      <HlsVideo url={CLIP_URL} format="mp4" authToken="a-bearer" autoPlay={false} />,
    )
    const video = container.querySelector('video')
    await waitFor(() => {
      expect(video?.getAttribute('src')).toBe(CLIP_URL)
    })
    expect(video?.getAttribute('src')).not.toContain('token')
    expect(video?.getAttribute('src')).not.toContain('a-bearer')
    expect(video?.getAttribute('src')).not.toContain('?')
  })

  it('leaves crossOrigin unset — the clip plane is same-origin', async () => {
    const { container } = render(<HlsVideo url={CLIP_URL} format="mp4" autoPlay={false} />)
    const video = container.querySelector('video')
    await waitFor(() => expect(video?.getAttribute('src')).toBe(CLIP_URL))
    expect(video?.getAttribute('crossorigin')).toBeNull()
  })

  it('does NOT take the mp4 branch for an HLS manifest', async () => {
    const { container } = render(<HlsVideo url={MANIFEST_URL} autoPlay={false} />)
    const video = container.querySelector('video')
    // hls.js attaches the media itself; nothing sets `src` on the HLS path.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(video?.getAttribute('src')).toBeNull()
  })

  it('treats an absent format as hls, so every existing caller is unchanged', async () => {
    const { container } = render(
      <HlsVideo url={MANIFEST_URL} format={undefined} autoPlay={false} />,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container.querySelector('video')?.getAttribute('src')).toBeNull()
  })
})
