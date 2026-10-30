/**
 * The Stage-0 defect, asserted on what reaches the CAMERA TRANSPORT.
 *
 * `TalkPcmTranscoder` owns the feed, so these tests never assert "a helper was
 * called": the fake transport is the camera's `feedPcm`, and every case says
 * either "these exact bytes arrived" or "nothing arrived". The fake
 * `audio-codec` cap returns bytes that are recognisably NOT the input, so a
 * passthrough regression — the frame reaching the camera unconverted, at the
 * wrong rate — fails here rather than sounding like a chipmunk in production.
 *
 * Disarm check: revert `feedResampled`'s conversion branch to `return REASON…`
 * and the first three tests go red on the transport assertion, not on a spy.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { IntercomAudioCodecApi } from '../intercom-orchestrator.js'
import {
  REASON_PCM_CLOSED,
  REASON_PCM_CONVERT_FAILED,
  REASON_PCM_NO_CODEC_CAP,
  REASON_PCM_ODD_BYTES,
  REASON_PCM_SESSION_OPEN_FAILED,
  TalkPcmTranscoder,
} from '../talk-pcm-transcoder.js'

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly deviceId: unknown
  readonly meta: Record<string, unknown>
}

interface LogCapture {
  readonly logger: IScopedLogger
  readonly lines: LoggedLine[]
}

function recordingLogger(): LogCapture {
  const lines: LoggedLine[] = []
  const capture =
    (level: LoggedLine['level']) =>
    (message: string, ctx?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> }) => {
      lines.push({
        level,
        message,
        deviceId: ctx?.tags?.['deviceId'],
        meta: ctx?.meta ?? {},
      })
    }
  const logger: IScopedLogger = {
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

interface CreateCall {
  readonly codec: string
  readonly sourceSampleRate: number
  readonly targetSampleRate: number
  readonly targetFormat: string | undefined
  readonly sourceChannels: number
  readonly targetChannels: number
  readonly tag: string | undefined
}

interface FakeCodecOptions {
  readonly onPush?: () => void
  readonly onCreate?: () => void
  /** Bytes `pullPcm` hands back, per successful push. */
  readonly pcmOut?: Uint8Array
}

interface FakeCodec {
  readonly api: IntercomAudioCodecApi
  readonly created: CreateCall[]
  readonly closed: string[]
  readonly pushed: Uint8Array[]
}

/** An `audio-codec` cap whose output is deliberately unlike its input. */
function fakeCodec(opts: FakeCodecOptions = {}): FakeCodec {
  const created: CreateCall[] = []
  const closed: string[] = []
  const pushed: Uint8Array[] = []
  let nextId = 1
  const pcmOut = opts.pcmOut ?? new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd])
  const api: IntercomAudioCodecApi = {
    createDecodeSession: async (input) => {
      opts.onCreate?.()
      created.push({
        codec: input.codec,
        sourceSampleRate: input.sourceSampleRate,
        targetSampleRate: input.targetSampleRate,
        targetFormat: input.targetFormat,
        sourceChannels: input.sourceChannels,
        targetChannels: input.targetChannels,
        tag: input.tag,
      })
      return { sessionId: `dec-${nextId++}`, nodeId: 'hub' }
    },
    pushEncodedFrame: async (input) => {
      opts.onPush?.()
      pushed.push(input.data)
    },
    pullPcm: async () => [{ data: pcmOut, sampleRate: 16000, channels: 1, pts: 0 }],
    closeSession: async (input) => {
      closed.push(input.sessionId)
    },
  }
  return { api, created, closed, pushed }
}

interface Harness {
  readonly transcoder: TalkPcmTranscoder
  readonly fed: Buffer[]
  readonly lines: LoggedLine[]
  readonly codec: FakeCodec
}

const DEVICE_ID = 102
const CAMERA_RATE = 16000

function harness(codec: FakeCodec, resolve?: () => IntercomAudioCodecApi): Harness {
  const fed: Buffer[] = []
  const { logger, lines } = recordingLogger()
  const transcoder = new TalkPcmTranscoder({
    deviceId: DEVICE_ID,
    logger,
    resolveAudioCodec: resolve ?? (() => codec.api),
    targetSampleRate: CAMERA_RATE,
    tag: 'test-talk',
    feed: (pcm) => fed.push(pcm),
  })
  return { transcoder, fed, lines, codec }
}

/** 20 ms of mono s16le at 22 050 Hz — 441 samples, 882 bytes. */
function frame22050(fill = 1): Buffer {
  return Buffer.alloc(882, fill)
}

describe('a 22 050 Hz frame pushed at an 16 kHz camera is CONVERTED and reaches the transport', () => {
  it('feeds the camera the codec output, not the caller bytes', async () => {
    const codec = fakeCodec({ pcmOut: new Uint8Array([1, 2, 3, 4, 5, 6]) })
    const h = harness(codec)

    const refusal = await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 22050 })

    expect(refusal).toBeNull()
    // What the camera actually got — the whole point of the fix.
    expect(h.fed).toHaveLength(1)
    expect([...h.fed[0]!]).toEqual([1, 2, 3, 4, 5, 6])
    // And it is NOT the 882-byte caller frame smuggled through unconverted.
    expect(h.fed[0]!.length).not.toBe(882)
  })

  it('opens a linear-PCM decode session from the caller rate to the CAMERA rate', async () => {
    const codec = fakeCodec()
    const h = harness(codec)
    await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 22050 })

    expect(codec.created).toHaveLength(1)
    expect(codec.created[0]).toEqual({
      codec: 'pcm_s16le',
      sourceSampleRate: 22050,
      targetSampleRate: CAMERA_RATE,
      targetFormat: 's16le',
      sourceChannels: 1,
      targetChannels: 1,
      tag: 'test-talk',
    })
  })

  it('reuses one session across frames at the same rate', async () => {
    const codec = fakeCodec()
    const h = harness(codec)
    await h.transcoder.feedResampled({ pcm: frame22050(1), sourceSampleRate: 22050 })
    await h.transcoder.feedResampled({ pcm: frame22050(2), sourceSampleRate: 22050 })
    await h.transcoder.feedResampled({ pcm: frame22050(3), sourceSampleRate: 22050 })

    expect(codec.created).toHaveLength(1)
    expect(codec.pushed).toHaveLength(3)
    expect(h.fed).toHaveLength(3)
  })

  it('recreates the session when the caller renegotiates its rate', async () => {
    const codec = fakeCodec()
    const h = harness(codec)
    await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 16000 })
    await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 24000 })

    expect(codec.created.map((c) => c.sourceSampleRate)).toEqual([16000, 24000])
    // The stale session is CLOSED, not left to the idle reaper.
    expect(codec.closed).toEqual(['dec-1'])
    expect(h.fed).toHaveLength(2)
  })
})

describe('a frame that genuinely cannot be converted is still refused, loudly', () => {
  it('refuses when no audio-codec provider is mounted, and feeds nothing', async () => {
    const codec = fakeCodec()
    const h = harness(codec, () => {
      throw new Error('`audio-codec` capability is not mounted')
    })

    const refusal = await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 22050 })

    expect(refusal).toBe(REASON_PCM_NO_CODEC_CAP)
    expect(h.fed).toEqual([])
    const warn = h.lines.find((l) => l.level === 'warn')
    expect(warn).toBeDefined()
    // Per-camera, always — a refusal that cannot be grouped by camera cannot
    // answer "why is 102 worse than 101?".
    expect(warn!.deviceId).toBe(DEVICE_ID)
    expect(warn!.meta['reason']).toBe(REASON_PCM_NO_CODEC_CAP)
  })

  it('refuses when the codec cap will not open a linear-PCM session', async () => {
    const codec = fakeCodec({
      onCreate: () => {
        throw new Error("decode unsupported for codec 'pcm_s16le'")
      },
    })
    const h = harness(codec)

    const refusal = await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 22050 })

    expect(refusal).toBe(REASON_PCM_SESSION_OPEN_FAILED)
    expect(h.fed).toEqual([])
    expect(h.lines.some((l) => l.level === 'warn' && l.deviceId === DEVICE_ID)).toBe(true)
  })

  it('refuses a half-sample frame without opening any session', async () => {
    const codec = fakeCodec()
    const h = harness(codec)

    const refusal = await h.transcoder.feedResampled({
      pcm: Buffer.alloc(881),
      sourceSampleRate: 22050,
    })

    expect(refusal).toBe(REASON_PCM_ODD_BYTES)
    expect(h.fed).toEqual([])
    expect(codec.created).toEqual([])
  })
})

describe('the codec session is torn down with the talk session — and on error', () => {
  it('closes the session when the conversion throws, and reopens a fresh one', async () => {
    let failNext = true
    const codec = fakeCodec({
      onPush: () => {
        if (failNext) {
          failNext = false
          throw new Error('session not found')
        }
      },
    })
    const h = harness(codec)

    const refusal = await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 22050 })
    expect(refusal).toBe(REASON_PCM_CONVERT_FAILED)
    expect(h.fed).toEqual([])
    // Torn down on error — the next frame must not inherit a session of
    // unknown internal state.
    expect(codec.closed).toEqual(['dec-1'])

    const second = await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 22050 })
    expect(second).toBeNull()
    expect(codec.created).toHaveLength(2)
    expect(h.fed).toHaveLength(1)
  })

  it('closes the session on close(), is idempotent, and refuses afterwards', async () => {
    const codec = fakeCodec()
    const h = harness(codec)
    await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 22050 })
    expect(h.transcoder.sessionId).toBe('dec-1')

    await h.transcoder.close()
    await h.transcoder.close()

    expect(codec.closed).toEqual(['dec-1'])
    expect(h.transcoder.sessionId).toBeNull()

    const refusal = await h.transcoder.feedResampled({ pcm: frame22050(), sourceSampleRate: 22050 })
    expect(refusal).toBe(REASON_PCM_CLOSED)
    expect(h.fed).toHaveLength(1) // still just the one from before close()
    expect(codec.created).toHaveLength(1)
  })

  it('close() on a transcoder that never converted anything opens nothing', async () => {
    const codec = fakeCodec()
    const h = harness(codec)
    await h.transcoder.close()
    expect(codec.created).toEqual([])
    expect(codec.closed).toEqual([])
  })
})
