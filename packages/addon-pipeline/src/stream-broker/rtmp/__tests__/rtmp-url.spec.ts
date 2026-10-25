import { describe, expect, it } from 'vitest'
import { parseRtmpUrl } from '../rtmp-url.js'

/**
 * An RTMP url is `rtmp://host[:port]/<app>/<playpath>`, and the split is the
 * LAST slash — the rule ffmpeg and every relay client follow. `new URL()` is
 * not that rule: a query string starts at the first `?`, so a LinkVisual relay
 * (`…/live?token=…&session=…/<stream>`) parsed through it had `app = live`
 * (without its token) and `playPath = ?token=…/<stream>`, and the relay
 * closed the stream after `play` with zero bytes ("stream ended: readLength
 * end", the Dreame robot camera, 2026-09-06).
 */
describe('parseRtmpUrl — the last slash splits app from playpath', () => {
  it('keeps a query BEFORE the playpath inside the app, as the relay expects', () => {
    const p = parseRtmpUrl(
      'rtmp://relay.example:8000/live?token=abc&session=s1&cacheDuration=3000/StreamKey',
    )
    expect(p.host).toBe('relay.example')
    expect(p.port).toBe(8000)
    expect(p.app).toBe('live?token=abc&session=s1&cacheDuration=3000')
    expect(p.playPath).toBe('StreamKey')
    expect(p.tcUrl).toBe('rtmp://relay.example:8000/live?token=abc&session=s1&cacheDuration=3000')
  })

  it('splits a plain url the ordinary way and defaults the port', () => {
    const p = parseRtmpUrl('rtmp://cam.lan/app/stream')
    expect(p).toMatchObject({ host: 'cam.lan', port: 1935, app: 'app', playPath: 'stream' })
    expect(p.tcUrl).toBe('rtmp://cam.lan:1935/app')
  })

  it('leaves a query AFTER the playpath on the playpath, unchanged from before', () => {
    const p = parseRtmpUrl('rtmp://cam.lan/app/stream?auth=1')
    expect(p.app).toBe('app')
    expect(p.playPath).toBe('stream?auth=1')
  })

  it('refuses a url with no playpath', () => {
    expect(() => parseRtmpUrl('rtmp://cam.lan/onlyapp')).toThrow(/playpath/)
    expect(() => parseRtmpUrl('http://cam.lan/a/b')).toThrow(/rtmp/)
  })
})
