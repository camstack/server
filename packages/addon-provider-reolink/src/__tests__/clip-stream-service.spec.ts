/**
 * The stream route, wired through the REAL service: the shared gates, the
 * catalog row, the library's own BcMedia decoder, a spawned child in place of
 * ffmpeg, and the data-plane handler — no producer fake in the loop.
 *
 * The camera is a fake that hands BcMedia packets to `onChunk` in slices that
 * cut across packet boundaries, because that is how a socket delivers them
 * and the decoder's buffering is the thing this path relies on.
 */
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveCameraUid } from '../clips/clip-addressing.js'
import { clipKeyFor } from '../clips/clip-identity.js'
import { createClipService } from '../clips/clip-service.js'
import type { ClipDeviceRef } from '../clips/reolink-videoclips-provider.js'
import { REOLINK_ADDON_ID } from '../schema.js'
import { createRecordingLogger, type RecordingSink } from './clip-test-logger.js'

// ── BcMedia on the wire ───────────────────────────────────────────────────

const MAGIC_IFRAME = 0x63643030
const MAGIC_PFRAME = 0x63643130
const MAGIC_AAC = 0x62773530
const PAD = 8
const START_CODE = Buffer.from([0, 0, 0, 1])

const pad = (length: number): Buffer => Buffer.alloc(length % PAD === 0 ? 0 : PAD - (length % PAD))

/** One video packet as `BcMediaParser` reads it: magic, "H264", sizes, µs, unknown, payload, pad. */
function videoPacket(kind: 'I' | 'P', microseconds: number, body: Buffer): Buffer {
  const nal = Buffer.concat([START_CODE, Buffer.from([kind === 'I' ? 0x65 : 0x41]), body])
  const head = Buffer.alloc(24)
  head.writeUInt32LE(kind === 'I' ? MAGIC_IFRAME : MAGIC_PFRAME, 0)
  head.write('H264', 4, 'ascii')
  head.writeUInt32LE(nal.length, 8)
  head.writeUInt32LE(0, 12)
  head.writeUInt32LE(microseconds, 16)
  head.writeUInt32LE(0, 20)
  return Buffer.concat([head, nal, pad(nal.length)])
}

function aacPacket(body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32LE(MAGIC_AAC, 0)
  head.writeUInt16LE(body.length, 4)
  head.writeUInt16LE(body.length, 6)
  return Buffer.concat([head, body, pad(body.length)])
}

const FRAME_US = 66_667

/** `n` access units at 15 fps, a keyframe first, an AAC frame after each. */
function clipOnTheWire(n: number): { wire: Buffer; bodies: Buffer[] } {
  const bodies: Buffer[] = []
  const packets: Buffer[] = []
  for (let i = 0; i < n; i += 1) {
    const body = Buffer.from(`unit-${String(i).padStart(3, '0')}-`)
    bodies.push(body)
    packets.push(videoPacket(i === 0 ? 'I' : 'P', i * FRAME_US, body))
    packets.push(aacPacket(Buffer.from('adts-frame')))
  }
  return { wire: Buffer.concat(packets), bodies }
}

/** Slices that do not respect packet boundaries — a socket's delivery. */
function slices(wire: Buffer, size: number): Buffer[] {
  const out: Buffer[] = []
  for (let at = 0; at < wire.length; at += size) out.push(wire.subarray(at, at + size))
  return out
}

// ── the fixture ───────────────────────────────────────────────────────────

const SINCE = Date.parse('2026-09-22T00:00:00Z')
const UNTIL = Date.parse('2026-09-22T23:59:59Z')
const CLOSED_FILE =
  '/mnt/sda/Mp4Record/2026-09-22/RecS03_DST20260922_111313_111338_2B1E808_AE17B.mp4'
const OPEN_FILE =
  '/mnt/sda/Mp4Record/2026-09-22/RecS03_DST20260922_113000_000000_2B1E808_000000.mp4'
const CLIP_START = new Date('2026-09-22T11:13:13+02:00')
const CLIP_END = new Date('2026-09-22T11:13:38+02:00')

const scratchDirs: string[] = []
afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

interface DownloadCall {
  readonly fileName: string
  readonly onChunk?: (chunk: Buffer) => void
}

function fakeApi(wire: Buffer, sliceBytes: number) {
  const download = vi.fn(async ({ onChunk }: DownloadCall) => {
    for (const slice of slices(wire, sliceBytes)) {
      onChunk?.(slice)
      await Promise.resolve()
    }
    return wire
  })
  return {
    download,
    api: {
      getHddInfoList: vi.fn(async () => ({
        body: { HddInfoList: { HddInfo: { number: 0, capacity: 238, mount: 1 } } },
      })),
      getDayRecords: vi.fn(async () => ({
        index: 0,
        channelId: 0,
        days: [{ day: 22, type: 'normal' }],
      })),
      getVideoclips: vi.fn(async ({ streamType }: { streamType?: string }) =>
        streamType === 'mainStream'
          ? []
          : [
              {
                fileName: 'RecS03_DST20260922_111313_111338_2B1E808_AE17B.mp4',
                id: CLOSED_FILE,
                startTime: CLIP_START,
                endTime: CLIP_END,
                sizeBytes: 421_472,
                supportSub: true,
                recordType: 'md',
              },
              {
                // Still being written: the open end stamp and no size.
                fileName: 'RecS03_DST20260922_113000_000000_2B1E808_000000.mp4',
                id: OPEN_FILE,
                startTime: new Date('2026-09-22T11:30:00+02:00'),
                endTime: new Date('2026-09-22T11:30:00+02:00'),
                sizeBytes: 0,
                supportSub: true,
                recordType: 'md',
              },
            ],
      ),
      searchAlarmVideos: vi.fn(async () => []),
      getVideoclipThumbnailJpeg: vi.fn(async () => Buffer.from('jpeg')),
      downloadRecordingDemuxed: vi.fn(async () => {
        throw new Error('the FILE path must not be called by the stream route')
      }),
      fileInfoListReplayBinaryDownload: download,
    },
  }
}

interface Exchange {
  readonly status: number
  readonly headers: Record<string, unknown>
  readonly body: Buffer
}

/**
 * Every packet built above is a multiple of 8 bytes, so 8-byte slices cut
 * INSIDE every packet (a 40-byte video packet arrives in five pieces) while
 * never leaving the parser a partial header of 20–23 bytes — see the hazard
 * test below for what that does.
 */
const SLICE_SAFE = 8
/** Leaves a 20-byte partial video header at one boundary. */
const SLICE_HAZARD = 97

async function harness(
  options: { device?: Partial<ClipDeviceRef>; units?: number; sliceBytes?: number } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'camstack-clip-stream-service-'))
  scratchDirs.push(dataDir)
  // ffmpeg as `cat`: a real child process, so the stdin/stdout/close wiring
  // is the one production drives. It ignores its arguments.
  const catScript = join(dataDir, 'ffmpeg-as-cat.sh')
  await writeFile(catScript, '#!/bin/sh\nexec /bin/cat\n')
  await chmod(catScript, 0o755)
  const { wire, bodies } = clipOnTheWire(options.units ?? 40)
  const { api, download } = fakeApi(wire, options.sliceBytes ?? SLICE_SAFE)
  const logger: RecordingSink = createRecordingLogger()
  const device: ClipDeviceRef = {
    deviceId: 107,
    channel: 0,
    uid: undefined,
    isHubChild: false,
    isBattery: false,
    sleeping: false,
    timeZone: 'Europe/Rome',
    hostKey: '192.168.60.226',
    getApi: async () => api,
    ...options.device,
  }
  const service = createClipService({
    dataDir,
    logger,
    resolveDevice: async () => device,
    resolveFfmpeg: async () => catScript,
  })
  const list = async (): Promise<string> => {
    const clips = await service.provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    return clips[0]?.thumbnailMint?.split('/').at(-1) ?? ''
  }
  const get = async (clipKey: string): Promise<Exchange> => {
    const res = new PassThrough()
    const chunks: Buffer[] = []
    let status = 0
    let headers: Record<string, unknown> = {}
    const done = new Promise<void>((resolve) => {
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('finish', resolve)
      res.on('close', resolve)
    })
    Object.assign(res, {
      headersSent: false,
      writeHead(code: number, extra?: Record<string, unknown>) {
        status = code
        headers = extra ?? {}
        Object.assign(res, { headersSent: true })
        return res
      },
    })
    const req = { url: `/107/${clipKey}.mp4`, method: 'GET', headers: {} }
    await service.streamHandler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    await done
    return { status, headers, body: Buffer.concat(chunks) }
  }
  return { service, list, get, download, logger, bodies, dataDir }
}

// ── the tests ─────────────────────────────────────────────────────────────

describe('the stream route through the real service', () => {
  it('serves every access unit the library decoded, through a spawned child, as a 200 stream', async () => {
    const h = await harness({ units: 40 })
    const key = await h.list()
    const out = await h.get(key)

    expect(out.status).toBe(200)
    expect(out.headers['accept-ranges']).toBe('none')
    expect(out.headers['content-length']).toBeUndefined()
    // Every unit, in order, and no audio: the decoder handed the AAC frames
    // over and the stream forwarded none of them.
    const text = out.body.toString('latin1')
    let at = -1
    for (const body of h.bodies) {
      const next = text.indexOf(body.toString('latin1'), at + 1)
      expect(next).toBeGreaterThan(at)
      at = next
    }
    expect(text).not.toContain('adts-frame')
    expect(h.download).toHaveBeenCalledTimes(1)
    expect(h.download.mock.calls[0]?.[0]?.fileName).toBe(CLOSED_FILE)

    const muxing = h.logger.infos.find((l) => l.message.includes('is muxing'))
    expect(muxing?.extras.tags).toEqual({ deviceId: 107 })
    expect(muxing?.extras.meta?.['fps']).toBe(15)
    expect(muxing?.extras.meta?.['fpsSource']).toBe('timestamps')
    expect(muxing?.extras.meta?.['videoType']).toBe('H264')
    // Forty units at 15 fps are 2.6 s against a 25 s row: the judge names
    // it short AFTER serving it, with the numbers, and nothing retried.
    const short = h.logger.warns.find((l) => l.message.includes('came up short'))
    expect(short?.extras.tags).toEqual({ deviceId: 107 })
    expect(short?.extras.meta?.['accessUnits']).toBe(40)
    expect(short?.extras.meta?.['branch']).toBe('stream-short')
    expect(short?.extras.meta?.['retried']).toBe(false)
    // The data-plane path negotiates with nobody, so it asks for `none` and
    // the silence is a fact, not a fault: an INFO line that still carries the
    // count of frames it was handed and did not carry (D391, D600).
    const silent = h.logger.infos.find((l) => l.message.includes('without sound'))
    expect(silent?.extras.meta?.['branch']).toBe('stream-video-only')
    expect(silent?.extras.meta?.['audioAsked']).toBe('none')
    expect(silent?.extras.meta?.['audioFramesDropped']).toBe(40)
  })

  it('serves a clip whose video header lands ON a chunk boundary', async () => {
    // This slice cuts a video header so that exactly 20-23 bytes of it are
    // in the buffer when the parser is called. `BcMediaParser.parseIframe`
    // used to guard `buf.length < 20` and then read the `unknown` u32 at
    // offset 20-23, so that boundary THREW and the stream answered 502 by
    // name. `@apocaliss92/nodelink-js` 0.9.0 guards `< 24` and waits, which
    // is why this now serves - and the whole-file path never saw it,
    // because it pushes the entire buffer at once. The 502 branch this
    // replaces was a trigger for a hazard that no longer exists.
    const h = await harness({ units: 40, sliceBytes: SLICE_HAZARD })
    const key = await h.list()
    const out = await h.get(key)
    expect(out.status).toBe(200)
    expect(out.body.byteLength).toBeGreaterThan(0)
    // Every unit still arrives, in order: waiting for more bytes must not
    // cost a frame.
    const text = out.body.toString('latin1')
    let at = -1
    for (const body of h.bodies) {
      const next = text.indexOf(body.toString('latin1'), at + 1)
      expect(next).toBeGreaterThan(at)
      at = next
    }
    expect(h.logger.warns.some((l) => l.extras.meta?.['branch'] === 'decode-failed')).toBe(false)
    expect(h.download).toHaveBeenCalledTimes(1)
  })

  it('writes nothing to the scratch — the stream is not a file', async () => {
    const h = await harness()
    const key = await h.list()
    await h.get(key)
    const entries = await readdir(h.dataDir, { recursive: true })
    expect(entries.filter((e) => String(e).endsWith('.mp4'))).toEqual([])
  })

  it('answers 404 `no-catalog-row` for a key nobody listed, and never opens the camera', async () => {
    const h = await harness()
    const out = await h.get('f'.repeat(40))
    expect(out.status).toBe(404)
    expect(out.headers['x-camstack-reason-code']).toBe('no-catalog-row')
    expect(h.download).not.toHaveBeenCalled()
    const warn = h.logger.warns.find((l) =>
      l.message.includes('no catalog row for this clip stream'),
    )
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
  })

  it('refuses a clip the camera is still writing, by name, even though the listing hid it', async () => {
    const h = await harness()
    const listed = await h.list()
    const openKey = clipKeyFor(0, OPEN_FILE)
    expect(openKey).not.toBe(listed)
    const out = await h.get(openKey)
    expect(out.status).toBe(409)
    expect(out.headers['x-camstack-reason-code']).toBe('clip-in-progress')
    expect(h.download).not.toHaveBeenCalled()
    const warn = h.logger.warns.find((l) => l.message.includes('still writing'))
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
    expect(warn?.extras.meta?.['branch']).toBe('clip-in-progress')
  })

  it('never wakes a sleeping standalone battery camera — the same gate the file path runs', async () => {
    const h = await harness({ device: { isBattery: true, sleeping: true } })
    const out = await h.get('a'.repeat(40))
    expect(out.status).toBe(409)
    expect(out.headers['x-camstack-reason-code']).toBe('sleeping')
    expect(h.download).not.toHaveBeenCalled()
    const warn = h.logger.warns.find((l) => l.message.includes('sleeping camera'))
    expect(warn?.extras.tags).toEqual({ deviceId: 107 })
    expect(warn?.extras.meta?.['path']).toBe('stream')
  })

  it('serves a hub child through the parent — the sleeping gate does not apply there', async () => {
    const h = await harness({
      device: {
        isHubChild: true,
        isBattery: true,
        sleeping: true,
        uid: resolveCameraUid({ metadataUid: '9527000HXOHJ142G', configUid: undefined }),
        hostKey: '192.168.10.161',
      },
      units: 20,
    })
    const key = await h.list()
    const out = await h.get(key)
    expect(out.status).toBe(200)
    expect(h.download).toHaveBeenCalledTimes(1)
  })
})
