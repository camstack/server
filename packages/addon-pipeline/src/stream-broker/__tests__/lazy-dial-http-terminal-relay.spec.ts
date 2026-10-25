/**
 * A terminal-style camera must cost ZERO with no consumers.
 *
 * Live evidence (2026-08-12): the broker held a permanent `libx264` transcode
 * of the terminal addon's glances MJPEG relay — ~12% of a core — and kept the
 * relay's PTY open for hours with zero viewers. Two independent causes, both
 * exercised here:
 *
 *  1. `pull-http` maps to `type: 'http'` (`buildSourceFromCamStream`), and
 *     `http` was missing from `LAZY_DIAL_SOURCE_TYPES` — so the
 *     `isLazyDialSource(source.type) && !this.hasDemand()` guard in `start()`
 *     never fired for it and the source was dialed eagerly on every broker
 *     (re)start.
 *  2. `hasDemand()` returns true on `_preBufferEnabled` ALONE, and the
 *     high-profile warm default switched it on — permanent synthetic demand.
 *     Covered in `prebuffer-high-default.spec.ts`.
 *
 * The observable used here is deliberate: `status === 'idle'` is the ONLY
 * state `start()` can return in having taken the lazy-dial branch — every
 * other exit sets `'connecting'` or `'streaming'` first. And an ffmpeg-parser
 * source logs `starting ffmpeg source reader` the instant it spawns, so
 * asserting that line is ABSENT is direct proof no reader was spawned, not a
 * proxy for it.
 */
import type { IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

interface LoggerHarness {
  readonly logger: IScopedLogger
  readonly infoMessages: () => readonly string[]
}

function createLogger(): LoggerHarness {
  const messages: string[] = []
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn((msg: string) => {
      messages.push(msg)
    }),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  return { logger, infoMessages: () => messages }
}

/** The exact source shape `buildSourceFromCamStream` emits for `pull-http`. */
function makePullHttpSource(): StreamSource {
  return {
    type: 'http',
    url: 'http://127.0.0.1:8099/glances.mjpeg',
    videoCodec: 'h264',
    ffmpegParser: {
      transport: 'tcp',
      outputArgs: ['-c:v', 'libx264'],
    },
  }
}

describe('lazy dial — a pull-http (terminal relay) source never dials without demand', () => {
  let broker: StreamBroker | null = null

  afterEach(async () => {
    if (broker) await broker.stop()
    broker = null
  })

  it('registers idle and spawns no reader when the pre-buffer is off and nobody is subscribed', async () => {
    const { logger, infoMessages } = createLogger()
    broker = new StreamBroker('102/terminal', logger)
    // Terminal-style source: not default-warm, so no synthetic pre-buffer
    // demand. Zero subscribers of any plane.
    broker.setPreBufferEnabled(false)

    await broker.start(makePullHttpSource())

    expect(broker.status).toBe('idle')
    expect(broker.suspended).toBe(true)
    // No ffmpeg — this is the 12%-of-a-core transcode that used to run for
    // an audience of nobody.
    expect(infoMessages()).not.toContain('starting ffmpeg source reader')
    expect(infoMessages()).toContain('Broker registered idle — no demand, source dial deferred')
  })

  it('dials the same pull-http source the moment there IS demand', async () => {
    const { logger, infoMessages } = createLogger()
    broker = new StreamBroker('102/terminal', logger)
    // The pre-buffer flag is one of the things `hasDemand()` reads — the
    // operator opting a terminal camera into "keep warm" must still work.
    broker.setPreBufferEnabled(true)

    await broker.start(makePullHttpSource())

    expect(broker.status).not.toBe('idle')
    expect(infoMessages()).toContain('starting ffmpeg source reader')
  })

  it("leaves an rtsp source's behaviour exactly as it is today", async () => {
    const { logger } = createLogger()
    broker = new StreamBroker('101/main', logger)

    // Warm (the high-profile default for a real camera) → dials, as before.
    broker.setPreBufferEnabled(true)
    await broker.start({ type: 'rtsp', url: 'rtsp://cam/main', videoCodec: 'h264' })
    expect(broker.suspended).toBe(false)
    expect(broker.status).not.toBe('idle')

    await broker.stop()

    // Cold + unwatched → deferred, as before.
    broker = new StreamBroker('101/main', logger)
    broker.setPreBufferEnabled(false)
    await broker.start({ type: 'rtsp', url: 'rtsp://cam/main', videoCodec: 'h264' })
    expect(broker.status).toBe('idle')
    expect(broker.suspended).toBe(true)
  })
})

// ── The two halves together, through the manager ─────────────────────────
// Neither fix is sufficient alone: without the `isDefaultWarm` exclusion the
// high-profile warm default sets `_preBufferEnabled`, `hasDemand()` returns
// true on that flag alone and the lazy-dial guard never fires; without `http`
// in the lazy set the guard is not consulted at all. This publishes a
// terminal camera exactly as the terminal addon does and asserts the end
// state the operator asked for: "0 prebuffer, nessun carico di default" [0 prebuffer, no load by default].

/**
 * The RTSP restream provider/server are the manager's only hard external
 * dependencies for broker creation; stubbing them is the established pattern
 * in `prebuffer-high-default.spec.ts`.
 */
function stubRtsp(manager: StreamBrokerManager): void {
  ;(manager as unknown as { rtspProvider: unknown }).rtspProvider = {
    getEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    getInternalEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    setEnabled: vi.fn(),
    isEnabled: vi.fn(() => true),
    setTokenPersister: vi.fn(),
    setEnabledPersister: vi.fn(),
    getAllEntries: vi.fn(() => []),
    regenerateToken: vi.fn(),
    getRtspPort: vi.fn(() => 8554),
    persistTokens: vi.fn(),
  }
  ;(manager as unknown as { rtspServer: unknown }).rtspServer = {
    registerRestreamer: vi.fn(),
    unregisterRestreamer: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getPort: vi.fn(() => 8554),
    loadEnabled: vi.fn(),
  }
}

describe('a published terminal camera costs nothing by default', () => {
  it('a pull-http high-profile stream ends up idle: no warm default, no dial', async () => {
    const logger = createLogger().logger
    const manager = new StreamBrokerManager(logger)
    stubRtsp(manager)

    await manager.publishCameraStream({
      deviceId: 102,
      camStreamId: 'terminal',
      kind: 'pull-http',
      url: 'http://127.0.0.1:8099/glances.mjpeg',
      label: 'Terminal',
      resolution: { width: 1280, height: 720 },
    })
    await manager.assignProfile({ deviceId: 102, profile: 'high', camStreamId: 'terminal' })
    await manager.restartProfile({ deviceId: 102, profile: 'high' })

    const broker = await manager.getBroker({ brokerId: '102/terminal' })
    expect(broker).not.toBeNull()
    expect(broker!.getPreBufferDuration()).toBe(0)
    expect(broker!.suspended).toBe(true)
    expect(broker!.status).toBe('idle')

    await manager.destroyAll()
  })

  it('a real (pull-rtsp) camera is still default-warm and still dials', async () => {
    const logger = createLogger().logger
    const manager = new StreamBrokerManager(logger)
    stubRtsp(manager)

    await manager.publishCameraStream({
      deviceId: 101,
      camStreamId: 'main',
      kind: 'pull-rtsp',
      url: 'rtsp://cam/main',
      label: 'Main',
      resolution: { width: 1920, height: 1080 },
    })
    await manager.assignProfile({ deviceId: 101, profile: 'high', camStreamId: 'main' })
    await manager.restartProfile({ deviceId: 101, profile: 'high' })

    const broker = await manager.getBroker({ brokerId: '101/main' })
    expect(broker).not.toBeNull()
    expect(broker!.getPreBufferDuration()).toBeGreaterThan(0)
    expect(broker!.suspended).toBe(false)
    expect(broker!.status).not.toBe('idle')

    await manager.destroyAll()
  })
})
