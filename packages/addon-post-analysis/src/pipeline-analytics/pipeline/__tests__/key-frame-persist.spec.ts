import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  persistTrackKeyFrame,
  type KeyFrameMediaWriter,
  type KeyFramePersistDeps,
  type ParkedKeyFrame,
} from '../key-frame-persist.js'

/**
 * The exec body of `persistKeyFrames`, lifted out of the addon so its drop
 * branches can be asserted. Since D422 it reads the track's PARKED key frame
 * by `(deviceId, trackId)` — there is no handle in this file, so there is no
 * miss on age to assert. What is left to pin: the parcel is written verbatim
 * (one encode, on the node), the companion is derived from the same bytes,
 * and the two ways this can still lose media — no parcel, or a throw — are
 * each one `deviceId`-tagged line with the owning node.
 */

const parcel: ParkedKeyFrame = {
  jpeg: Buffer.from('native-jpeg-from-the-node'),
  width: 3840,
  height: 2160,
  timestamp: 1_000,
  nodeId: 'alice-laptop',
}

interface LoggerSpy {
  readonly logger: IScopedLogger
  readonly calls: { level: string; message: string; extras?: unknown }[]
}

function makeLoggerSpy(): LoggerSpy {
  const calls: { level: string; message: string; extras?: unknown }[] = []
  const record =
    (level: string) =>
    (message: string, extras?: unknown): void => {
      calls.push({ level, message, ...(extras !== undefined ? { extras } : {}) })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, calls }
}

/** The row id `putReplacing` would hand back for a `(kind, timestamp)` write
 *  — deterministic and never `0`, so a test can assert the SAME value the
 *  fixture wrote without hard-coding an arbitrary rowid. */
function mediaIdFor(kind: string, timestamp: number): number {
  let hash = 0
  for (const ch of kind) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000
  return hash + timestamp + 1
}

function makeWriter(): {
  writer: KeyFrameMediaWriter
  written: { kind: string; timestamp: number; data: Buffer }[]
} {
  const written: { kind: string; timestamp: number; data: Buffer }[] = []
  return {
    written,
    writer: {
      putReplacing: async (input) => {
        written.push({ kind: input.kind, timestamp: input.timestamp, data: input.data })
        return mediaIdFor(input.kind, input.timestamp)
      },
    },
  }
}

function makeDeps(
  overrides: Partial<KeyFramePersistDeps> & { readonly logger: IScopedLogger },
): KeyFramePersistDeps {
  const { writer } = makeWriter()
  return {
    fetchParkedKeyFrame: async (): Promise<ParkedKeyFrame | null> => parcel,
    deriveSmall: async () => Buffer.from('small'),
    media: writer,
    ...overrides,
  }
}

const request = { deviceId: 101, trackId: 't-1', retry: false } as const

describe('persistTrackKeyFrame', () => {
  it('writes the parcel VERBATIM as keyFrame, derives keyFrameSmall from the same bytes, stamps the parked instant', async () => {
    const spy = makeLoggerSpy()
    const { writer, written } = makeWriter()
    const deriveSmall = vi.fn(async () => Buffer.from('small'))
    const fetchParkedKeyFrame = vi.fn(async () => parcel)
    const outcome = await persistTrackKeyFrame(
      makeDeps({ logger: spy.logger, media: writer, deriveSmall, fetchParkedKeyFrame }),
      request,
    )
    expect(outcome.kind).toBe('landed')
    expect(written.map((w) => w.kind)).toEqual(['keyFrame', 'keyFrameSmall'])
    // One encode, on the node: the bytes stored are the bytes retrieved.
    expect(written[0]?.data).toBe(parcel.jpeg)
    expect(deriveSmall).toHaveBeenCalledWith(parcel.jpeg)
    // The media row carries the instant the frame SHOWS, not the wall clock
    // the write happened at.
    expect(written[0]?.timestamp).toBe(1_000)
    expect(written[1]?.timestamp).toBe(1_000)
    // Retrieval is by track — the only two things the fetch is told.
    expect(fetchParkedKeyFrame).toHaveBeenCalledWith(101, 't-1')
    if (outcome.kind === 'landed')
      expect(outcome.keyFrameMediaId).toBe(mediaIdFor('keyFrame', 1_000))
  })

  it('no parcel is a `parcel-missing` outcome, writes nothing, and says so at ERROR with the deviceId', async () => {
    const spy = makeLoggerSpy()
    const { writer, written } = makeWriter()
    const outcome = await persistTrackKeyFrame(
      makeDeps({ logger: spy.logger, media: writer, fetchParkedKeyFrame: async () => null }),
      request,
    )
    expect(outcome.kind).toBe('parcel-missing')
    expect(written).toEqual([])
    const errors = spy.calls.filter((c) => c.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.extras).toMatchObject({
      tags: { deviceId: 101 },
      meta: { trackId: 't-1', retry: false },
    })
  })

  it('a THROWN retrieval failure logs at WARN, not debug, naming the camera', async () => {
    const spy = makeLoggerSpy()
    const outcome = await persistTrackKeyFrame(
      makeDeps({
        logger: spy.logger,
        fetchParkedKeyFrame: async () => {
          throw new Error(
            'pipelineRunner.getParkedTrackFrame not routable to node alice-laptop: node-offline',
          )
        },
      }),
      request,
    )
    expect(outcome.kind).toBe('error')
    const warned = spy.calls.filter((c) => c.level === 'warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]!.extras).toMatchObject({ tags: { deviceId: 101 }, meta: { trackId: 't-1' } })
    expect(spy.calls.some((c) => c.level === 'debug')).toBe(false)
  })

  it('a landed write carries the OWNING NODE, so a per-node gap can be read off the logs', async () => {
    const spy = makeLoggerSpy()
    await persistTrackKeyFrame(makeDeps({ logger: spy.logger }), request)
    const landed = spy.calls.filter((c) => c.level === 'debug')
    expect(landed).toHaveLength(1)
    expect(landed[0]!.extras).toMatchObject({
      tags: { deviceId: 101 },
      meta: { trackId: 't-1', nodeId: 'alice-laptop', width: 3840, height: 2160 },
    })
  })

  it('names the path (retry vs new-best) so a fix can be read off the logs', async () => {
    const spy = makeLoggerSpy()
    await persistTrackKeyFrame(
      makeDeps({ logger: spy.logger, fetchParkedKeyFrame: async () => null }),
      { ...request, retry: true },
    )
    expect(spy.calls[0]!.extras).toMatchObject({ meta: { retry: true } })
  })

  it('a failure of the SECOND write still reports the landed keyFrame media id', async () => {
    // `keyFrameSmall` is the web companion; losing it must not lose the native
    // key frame the rebuild reads, nor re-arm a retry that would re-shoot it.
    const spy = makeLoggerSpy()
    const putReplacing = vi
      .fn<KeyFrameMediaWriter['putReplacing']>()
      .mockResolvedValueOnce(mediaIdFor('keyFrame', 1_000))
      .mockRejectedValueOnce(new Error('disk full'))
    const outcome = await persistTrackKeyFrame(
      makeDeps({ logger: spy.logger, media: { putReplacing } }),
      request,
    )
    expect(outcome).toEqual({ kind: 'landed', keyFrameMediaId: mediaIdFor('keyFrame', 1_000) })
    expect(spy.calls.filter((c) => c.level === 'warn')).toHaveLength(1)
  })

  it('a failure of the FIRST write is an error — nothing landed', async () => {
    const spy = makeLoggerSpy()
    const putReplacing = vi
      .fn<KeyFrameMediaWriter['putReplacing']>()
      .mockRejectedValueOnce(new Error('disk full'))
    const outcome = await persistTrackKeyFrame(
      makeDeps({ logger: spy.logger, media: { putReplacing } }),
      request,
    )
    expect(outcome.kind).toBe('error')
  })
})
