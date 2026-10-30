/**
 * `videoclips.dialClipStream` through the REAL service (D597): the gates the
 * file path runs, then a one-shot URL on the dial listener that serves the
 * stream route — the library's BcMedia decoder, a spawned child in place of
 * ffmpeg, the data-plane handler — with no producer fake in the loop.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { get as httpGet, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CLIP_SOURCE_ONBOARD, mintClipId } from '../clips/clip-identity.js'
import { type ClipService, createClipService } from '../clips/clip-service.js'
import type { ClipDeviceRef } from '../clips/reolink-videoclips-provider.js'
import { REOLINK_ADDON_ID } from '../schema.js'
import { createRecordingLogger, type RecordingSink } from './clip-test-logger.js'

// ── BcMedia on the wire (the same shape `clip-stream-service.spec.ts` builds) ──

const MAGIC_IFRAME = 0x63643030
const MAGIC_PFRAME = 0x63643130
const PAD = 8
const START_CODE = Buffer.from([0, 0, 0, 1])
const FRAME_US = 66_667

const pad = (length: number): Buffer => Buffer.alloc(length % PAD === 0 ? 0 : PAD - (length % PAD))

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

function clipOnTheWire(n: number): { wire: Buffer; bodies: Buffer[] } {
  const bodies: Buffer[] = []
  const packets: Buffer[] = []
  for (let i = 0; i < n; i += 1) {
    const body = Buffer.from(`unit-${String(i).padStart(3, '0')}-`)
    bodies.push(body)
    packets.push(videoPacket(i === 0 ? 'I' : 'P', i * FRAME_US, body))
  }
  return { wire: Buffer.concat(packets), bodies }
}

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

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

function fakeApi(wire: Buffer) {
  const download = vi.fn(
    async ({ onChunk }: { fileName: string; onChunk?: (c: Buffer) => void }) => {
      for (const slice of slices(wire, 8)) {
        onChunk?.(slice)
        await Promise.resolve()
      }
      return wire
    },
  )
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
                startTime: new Date('2026-09-22T11:13:13+02:00'),
                endTime: new Date('2026-09-22T11:13:38+02:00'),
                sizeBytes: 421_472,
                supportSub: true,
                recordType: 'md',
              },
              {
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
        throw new Error('the FILE path must not be called by the dial')
      }),
      fileInfoListReplayBinaryDownload: download,
    },
  }
}

function fetchOnce(
  url: string,
): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      )
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function harness(options: { device?: Partial<ClipDeviceRef> } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'camstack-clip-dial-service-'))
  const catScript = join(dataDir, 'ffmpeg-as-cat.sh')
  await writeFile(catScript, '#!/bin/sh\nexec /bin/cat\n')
  await chmod(catScript, 0o755)
  const { wire, bodies } = clipOnTheWire(40)
  const { api, download } = fakeApi(wire)
  const logger: RecordingSink = createRecordingLogger()
  const getApi = vi.fn(async () => api)
  /** Flipped by a test AFTER the row is listed: a camera that fell asleep. */
  const state = { isBattery: false, sleeping: false }
  const device: ClipDeviceRef = {
    deviceId: 107,
    channel: 0,
    uid: undefined,
    isHubChild: false,
    get isBattery() {
      return state.isBattery
    },
    get sleeping() {
      return state.sleeping
    },
    timeZone: 'Europe/Rome',
    hostKey: '192.168.60.226',
    getApi,
    ...options.device,
  }
  const service: ClipService = createClipService({
    dataDir,
    logger,
    resolveDevice: async () => device,
    resolveFfmpeg: async () => catScript,
  })
  cleanups.push(async () => {
    await service.disposeClipStreamDial()
    await rm(dataDir, { recursive: true, force: true })
  })
  const list = async (): Promise<string> => {
    const clips = await service.provider.listClips({
      provider: REOLINK_ADDON_ID,
      deviceId: 107,
      since: SINCE,
      until: UNTIL,
    })
    return clips[0]?.id ?? ''
  }
  const dial = (clipId: string, profile?: 'high' | 'low' | 'mid') =>
    service.provider.dialClipStream?.({
      deviceId: 107,
      clipId,
      provider: REOLINK_ADDON_ID,
      ...(profile ? { profile } : {}),
    })
  const fallAsleep = (): void => {
    state.isBattery = true
    state.sleeping = true
  }
  return { service, list, dial, download, getApi, logger, bodies, fallAsleep }
}

describe('videoclips.dialClipStream through the real service', () => {
  it('mints a one-shot URL that serves the stream — every unit, forward-only, no file path', async () => {
    const h = await harness()
    const id = await h.list()
    expect(id.startsWith(`${CLIP_SOURCE_ONBOARD}:`)).toBe(true)
    h.getApi.mockClear()
    const dialed = await h.dial(id)
    expect(dialed).toMatchObject({ transport: 'forward-only', served: 'low' })
    if (dialed === undefined) throw new Error('the provider has no dial')
    // Nothing touched the camera to mint the URL.
    expect(h.getApi).not.toHaveBeenCalled()
    const out = await fetchOnce(dialed.url)
    expect(out.status).toBe(200)
    expect(out.headers['x-camstack-clip-transport']).toBe('forward-only')
    expect(out.headers['content-length']).toBeUndefined()
    const text = out.body.toString('latin1')
    let at = -1
    for (const body of h.bodies) {
      const next = text.indexOf(body.toString('latin1'), at + 1)
      expect(next).toBeGreaterThan(at)
      at = next
    }
    expect(h.download).toHaveBeenCalledTimes(1)
    expect(h.download.mock.calls[0]?.[0]?.fileName).toBe(CLOSED_FILE)
    const minted = h.logger.infos.find((l) => l.message.includes('dial minted'))
    expect(minted?.extras.tags).toEqual({ deviceId: 107 })
  })

  it('ACCEPTS `high` and says which twin it is actually carrying (D599)', async () => {
    // It used to refuse `high` outright, which made the profile look
    // unsupported rather than unavailable for this recording, and left two
    // transports behind one pointer. This catalog has no main twin, so the
    // sub copy is streamed — and `served` says `low`, which is the thing that
    // makes accepting honest. A silent substitution is what D576 forbids;
    // refusing was the other way of getting it wrong.
    const h = await harness()
    const id = await h.list()
    const dialed = await h.dial(id, 'high')
    expect(dialed).toMatchObject({ transport: 'forward-only', served: 'low' })
    expect(
      h.logger.warns.find((l) => l.message.includes('no main twin'))?.extras.meta,
    ).toMatchObject({ branch: 'no-main-twin', asked: 'high' })
  })

  it('refuses an id nobody minted, and a clip still being written, in the clip vocabulary', async () => {
    const h = await harness()
    await h.list()
    await expect(h.dial('native:reolink:onboard:0:AAAA')).rejects.toThrow(/^catalog-miss:/)
    const open = mintClipId({ source: CLIP_SOURCE_ONBOARD, channel: 0, fileName: OPEN_FILE })
    await expect(h.dial(open)).rejects.toThrow(/^clip-in-progress:/)
    expect(h.download).not.toHaveBeenCalled()
  })

  it('refuses a sleeping standalone battery camera BEFORE any URL exists, and opens no session', async () => {
    const h = await harness()
    const id = await h.list()
    h.getApi.mockClear()
    h.fallAsleep()
    await expect(h.dial(id)).rejects.toThrow(/^sleeping:/)
    // On UDP the login IS the wake: the gate sits in front of it.
    expect(h.getApi).not.toHaveBeenCalled()
    expect(h.logger.infos.find((l) => l.message.includes('dial minted'))).toBeUndefined()
    expect(
      h.logger.warns.find((l) => l.message.includes('refusing a clip stream dial'))?.extras.meta?.[
        'branch'
      ],
    ).toBe('sleeping')
  })
})
