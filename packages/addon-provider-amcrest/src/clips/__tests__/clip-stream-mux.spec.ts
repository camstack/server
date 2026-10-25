/**
 * What ffmpeg is told for a clip STREAM, and how a clip becomes a
 * `/cam/playback` URL.
 *
 * Both are read back as argument lists because both encode measurements that
 * a reviewer cannot see by looking at the prose: the probe flags are most of
 * the operator's wait (D616), and the URL form is the only one this camera
 * answers (`?filename=` and the bare path both 404).
 */
import { describe, expect, it } from 'vitest'

import type { AmcrestCameraClock } from '../clip-clock.js'
import { buildReplayUrl, describeReplayUrl, toReplayTimestamp } from '../clip-replay-url.js'
import {
  buildClipStreamMuxArgs,
  clipStreamContainerFor,
  clipStreamContentTypeFor,
  CLIP_MUX_PROBE_BYTES,
  CLIP_STREAM_AUDIO_RESYNC_FILTER,
  CLIP_STREAM_FRAG_DURATION_US,
  CLIP_STREAM_MAX_INTERLEAVE_DELTA_US,
} from '../clip-stream-mux.js'

/** +2 h, which is what 3836 really runs at in summer. */
const CLOCK: AmcrestCameraClock = { offsetMs: 7_200_000, readAtMs: 0 }

describe('the replay URL', () => {
  it('spells the window in the CAMERA’s wall clock, underscore-separated', () => {
    // 2026-09-23T12:58:07Z on the hub is 14:58:07 on this camera.
    expect(toReplayTimestamp(Date.UTC(2026, 8, 23, 12, 58, 7), CLOCK)).toBe('2026_09_23_14_58_07')
  })

  /**
   * The offset is the ONLY thing between the operator's window and the
   * camera's. A URL built on the host's own clock asks for footage two hours
   * away, and the camera answers 200 with the wrong recording rather than an
   * error — which is why this is asserted against a non-zero offset and not
   * against `new Date().toISOString()`.
   */
  it('is the channel+starttime+endtime form and nothing else', () => {
    const url = buildReplayUrl({
      host: '192.168.10.80',
      username: 'admin',
      password: 'p@ss word',
      channel: 1,
      startMs: Date.UTC(2026, 8, 23, 12, 58, 7),
      endMs: Date.UTC(2026, 8, 23, 13, 0, 35),
      clock: CLOCK,
    })
    expect(url).toBe(
      'rtsp://admin:p%40ss%20word@192.168.10.80:554/cam/playback' +
        '?channel=1&starttime=2026_09_23_14_58_07&endtime=2026_09_23_15_00_35',
    )
  })

  it('has a description with no credential in it, and that is what a log gets', () => {
    const url = buildReplayUrl({
      host: '192.168.10.80',
      username: 'admin',
      password: 'hunter2',
      channel: 1,
      startMs: 0,
      endMs: 1000,
      clock: CLOCK,
    })
    expect(describeReplayUrl(url)).not.toContain('hunter2')
    expect(describeReplayUrl(url)).not.toContain('admin')
    expect(describeReplayUrl(url)).toContain('192.168.10.80')
  })
})

describe('the stream mux', () => {
  const args = (audio: 'opus' | 'pcmu' | 'none'): readonly string[] =>
    buildClipStreamMuxArgs({ url: 'rtsp://x/y', audio })

  /**
   * D616's measurement, reached from the other vendor. `-analyzeduration` 5 s
   * and `-probesize` 5 MB are ffmpeg's defaults and a realtime source pays
   * them in wall clock; nothing is being discovered, because the SDP names
   * both codecs and carries the parameter sets inline.
   */
  it('tells ffmpeg not to probe an input that has already stated itself', () => {
    const a = args('none')
    expect(a).toContain('-analyzeduration')
    expect(a[a.indexOf('-analyzeduration') + 1]).toBe('0')
    expect(a[a.indexOf('-probesize') + 1]).toBe(String(CLIP_MUX_PROBE_BYTES))
    // An input option applies only to the input that FOLLOWS it.
    expect(a.indexOf('-probesize')).toBeLessThan(a.indexOf('-i'))
  })

  it('closes a fragment on a half second and flushes it, so the peer sees one', () => {
    const a = args('none')
    expect(a[a.indexOf('-frag_duration') + 1]).toBe(String(CLIP_STREAM_FRAG_DURATION_US))
    expect(a[a.indexOf('-flush_packets') + 1]).toBe('1')
  })

  it('copies the video and never re-encodes a recording it is only re-containerising', () => {
    expect(args('none')[args('none').indexOf('-c:v') + 1]).toBe('copy')
  })

  /** The archive is AAC 8 kHz. No WebRTC session speaks it, so both asks are
   *  an encode — where Hikvision's µ-law archive makes `pcmu` a copy. */
  it('transcodes the archive’s AAC for either ask, and says `-an` for none', () => {
    expect(args('opus')).toContain('libopus')
    expect(args('pcmu')).toContain('pcm_mulaw')
    expect(args('none')).toContain('-an')
    expect(args('none')).not.toContain('-c:a')
  })

  /** ffmpeg's MP4 muxer refuses `pcm_mulaw`; its MOV muxer takes it. */
  it('puts µ-law in a QuickTime container and says so on the wire', () => {
    expect(clipStreamContainerFor('pcmu')).toBe('mov')
    expect(clipStreamContainerFor('opus')).toBe('mp4')
    expect(clipStreamContainerFor(null)).toBe('mp4')
    expect(clipStreamContentTypeFor('pcmu')).toBe('video/quicktime')
    expect(clipStreamContentTypeFor(null)).toBe('video/mp4')
    expect(args('pcmu')[args('pcmu').indexOf('-f') + 1]).toBe('mov')
    expect(args('opus')[args('opus').indexOf('-f') + 1]).toBe('mp4')
  })

  /** TCP, never UDP: the camera interleaves both tracks on the control
   *  socket, which is what makes an abandoned session free its slot at once. */
  it('asks for interleaved TCP', () => {
    expect(args('none')[args('none').indexOf('-rtsp_transport') + 1]).toBe('tcp')
  })

  /**
   * MEASURED on 3836, 2026-09-23, through the real `/cam/playback` session.
   *
   * The camera stamps its AAC frames with timestamps that do not advance by a
   * frame: an 8 kHz AAC-LC frame is 1 024 samples, exactly 0.128 s, and the
   * observed deltas over one clip were 0.098, 0.108, 0.118, 0.128, 0.138,
   * 0.148, 0.158 and 0.168 s — a jitter of +/-30 % around the only value the
   * frame can have. ffmpeg carries that jitter into the libopus encoder's
   * OUTPUT timestamps, the mp4 muxer calls the result non-monotonic and drops
   * the packet, and the clip's sound is what survives.
   *
   * On one 30 s bound: **299 `Non-monotonic DTS` drops at the audio encoder,
   * and 4.24 s of opus where the same session decoded 45.95 s of intact AAC**
   * — the operator's "audio distorted". `aresample=async=1` rebuilds a
   * continuous timeline from the SAMPLES, which is where the truth is, rather
   * than from the camera's opinion of when it sent them.
   *
   * It goes on only where there IS an encoder. `-an` has no filter graph and
   * ffmpeg refuses `-af` with no audio output stream.
   */
  it('rebuilds the audio timeline from the samples, because this camera’s stamps jitter', () => {
    for (const ask of ['opus', 'pcmu'] as const) {
      const a = args(ask)
      expect(a).toContain('-af')
      expect(a[a.indexOf('-af') + 1]).toBe(CLIP_STREAM_AUDIO_RESYNC_FILTER)
      // A filter applies to the OUTPUT, so it must come after the input.
      expect(a.indexOf('-af')).toBeGreaterThan(a.indexOf('-i'))
    }
    expect(args('none')).not.toContain('-af')
    // …and the filter must actually RESYNC. Pinning the constant by identity
    // only proves a `-af` is emitted: swapping its value for `anull` — a real
    // ffmpeg filter that does nothing — left every assertion above green when
    // this was disarmed. `async=1` is the whole fix: it rebuilds the audio
    // timeline from the SAMPLE COUNT, which is where the truth is, and it is
    // what took the encoder from 299 `Non-monotonic DTS` drops to 0 against
    // camera 3836.
    expect(CLIP_STREAM_AUDIO_RESYNC_FILTER).toContain('aresample=')
    expect(CLIP_STREAM_AUDIO_RESYNC_FILTER).toContain('async=1')
  })

  /**
   * D618's sibling, and the same measurement Hikvision's mux carries: ffmpeg
   * holds one track's packets waiting for the other, and its default window
   * is TEN SECONDS. On a realtime-bound replay that window is paid in the
   * operator's wait and is seen as a picture that stops — measured on 3836
   * as byte-arrival plateaus of 1, 3 and 3 s inside a single 19 s stream,
   * ending in a 3.1 MB burst.
   *
   * `0` means UNLIMITED, not "no window", so the value must be small and
   * POSITIVE. 100 ms is longer than any gap between this camera's frames and
   * shorter than anything a consumer notices.
   */
  it('bounds how long the muxer may hold one track waiting for the other', () => {
    for (const ask of ['opus', 'pcmu', 'none'] as const) {
      const a = args(ask)
      expect(a[a.indexOf('-max_interleave_delta') + 1]).toBe(
        String(CLIP_STREAM_MAX_INTERLEAVE_DELTA_US),
      )
    }
    expect(CLIP_STREAM_MAX_INTERLEAVE_DELTA_US).toBeGreaterThan(0)
  })
})
