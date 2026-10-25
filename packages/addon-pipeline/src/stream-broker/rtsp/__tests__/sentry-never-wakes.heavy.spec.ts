/**
 * A SENTRY dial must not wake the camera. Ever.
 *
 * Measured on device 106 (Baby monitor, battery) on 2026-09-15 at 14:22, with
 * VLC pointed at `.../<token>/sentry`:
 *
 *   14:22:24  demand detected — resuming stream          ← before any session
 *   14:22:24  rfc4571: lazy URL — requesting publisher to materialize
 *   14:22:24  battery cam login while sleeping — this wakes the camera
 *   14:22:35  rfc4571: publisher materialized {materializeMs=11116}
 *   14:22:36  First keyframe received
 *   14:22:40  no demand — suspending stream
 *   14:23:08  battery sleep state committed {sleeping=true}
 *
 * Eleven seconds of battery spent on a wake nobody asked for, five seconds of
 * video, then a dead stream — the worst of every world.
 *
 * The cause is in `dispatch`: the DESCRIBE warm-up acquires a synthetic demand
 * consumer for EVERY dial, because a cold broker would otherwise answer with an
 * empty SDP. That is the right instinct for an ordinary dial and exactly wrong
 * for this one — `SENTRY_PATH_SUFFIX` is defined as "asking for the stream
 * WITHOUT asking for the camera", and D173 forbids self-waking a battery cam.
 *
 * These specs pin the rule at the only place that can hold it: the dial itself.
 */
import * as net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RtspListenServer } from '../rtsp-listen-server.js'
import type { RtspRestreamer } from '../rtsp-restreamer.js'
import { SENTRY_PATH_SUFFIX } from '../restream-intent.js'

const BROKER = '106/native:main'
const TOKEN = 'c1609d0c9ec63e76852da48e3be1593e'
/** Enough of an SDP that DESCRIBE has something to answer with. */
const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H265/90000\r\n'

/** A restreamer that already HAS an SDP — the warm-up is the thing under test,
 *  so the SDP wait must not be what decides the outcome. */
function fakeRestreamer(): RtspRestreamer {
  const r: Partial<RtspRestreamer> = {
    getSdp: () => SDP,
    getMutedSdp: () => SDP,
    // The variant switch the dispatch reads (D525). A sentry now asks for its
    // own SDP, so a stub that answered only the two older variants would fail
    // the DESCRIBE this file exists to prove still happens.
    getSdpFor: () => SDP,
    addSession: () => {},
    removeSession: () => {},
  }
  return r as RtspRestreamer
}

async function describeOnce(port: number, path: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `DESCRIBE rtsp://127.0.0.1:${port}/${path} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: vitest\r\n\r\n`,
      )
    })
    socket.once('data', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', () => {
      socket.destroy()
      resolve()
    })
    // The refusal path may answer nothing at all; do not hang the suite on it.
    setTimeout(() => {
      socket.destroy()
      resolve()
    }, 2_000).unref?.()
  })
}

describe('a sentry dial never wakes the camera', () => {
  let server: RtspListenServer
  let warmUp: ReturnType<typeof vi.fn>
  let release: ReturnType<typeof vi.fn>
  let openWindow: ReturnType<typeof vi.fn>
  let closeWindow: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    release = vi.fn()
    warmUp = vi.fn(() => release)
    closeWindow = vi.fn()
    openWindow = vi.fn(() => closeWindow)
    server = new RtspListenServer()
    server.registerRestreamer(BROKER, fakeRestreamer(), warmUp, TOKEN, openWindow)
    await server.start(0)
  })

  afterEach(async () => {
    await server.stop()
  })

  it('does NOT acquire the broker warm-up — that is what dials the camera', async () => {
    await describeOnce(server.getPort(), `${TOKEN}${SENTRY_PATH_SUFFIX}`)
    expect(warmUp).not.toHaveBeenCalled()
  })

  // THE CONTROL, and the reason this cannot be "never warm up": an ordinary
  // dial still must, or ffprobe and every external RTSP integration get an
  // empty SDP — the failure the warm-up was written for.
  it('an ordinary dial still warms the broker', async () => {
    await describeOnce(server.getPort(), TOKEN)
    expect(warmUp).toHaveBeenCalledTimes(1)
  })

  it('a /muted dial still warms the broker — mute is not intent', async () => {
    await describeOnce(server.getPort(), `${TOKEN}/muted`)
    expect(warmUp).toHaveBeenCalledTimes(1)
  })

  // The DESCRIBE reads the SDP BEFORE `addSession` runs, so a window that only
  // opens when the session attaches is too late: ffmpeg gets an empty SDP and
  // gives up. Measured against the live hub on 2026-09-15 at 14:47 — the window
  // opened and closed 42 ms later having emitted 0 frames, because the client
  // had already quit. The picture has to be on its way before the SDP is read.
  it('opens the PICTURE window at DESCRIBE — the SDP is read before any session', async () => {
    await describeOnce(server.getPort(), `${TOKEN}${SENTRY_PATH_SUFFIX}`)
    expect(openWindow).toHaveBeenCalledTimes(1)
  })

  it('an ordinary dial opens no picture window — it is getting real media', async () => {
    await describeOnce(server.getPort(), TOKEN)
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('still answers the sentry DESCRIBE — refusing to wake is not refusing to serve', async () => {
    let answered = ''
    await new Promise<void>((resolve) => {
      const socket = net.connect(server.getPort(), '127.0.0.1', () => {
        socket.write(
          `DESCRIBE rtsp://127.0.0.1:${server.getPort()}/${TOKEN}${SENTRY_PATH_SUFFIX} RTSP/1.0\r\nCSeq: 1\r\n\r\n`,
        )
      })
      socket.once('data', (b) => {
        answered = b.toString()
        socket.destroy()
        resolve()
      })
      setTimeout(() => {
        socket.destroy()
        resolve()
      }, 2_000).unref?.()
    })
    expect(answered).toContain('RTSP/1.0 200')
  })
})
