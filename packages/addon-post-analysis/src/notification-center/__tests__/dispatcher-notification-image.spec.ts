/**
 * D897 at the dispatcher: every picture is rendered from the CLEAN frame.
 *
 * The track holds four stills, each a different solid colour so the shipped
 * bytes say which one they came from: the clean `keyFrame` (grey), the
 * annotated `firstFrame` (red — the old `best` ladder's last rung), a stored
 * subject `thumbnail` (blue — the old `crop` answer) and the event's `crop`
 * (green). Whatever the mode, the shipped picture must be grey: the old code
 * shipped the thumbnail for `crop`, the boxed firstFrame for `scene-boxes`
 * (`frame: 'boxed'`), and the keyFrame only for `clean`.
 */
import type { IScopedLogger, MediaFile, NcMediaImage } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcTrackAtInstant } from '../notification-image.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'

const T0 = 1_792_593_648_000
const W = 640
const H = 360
const GREY = [128, 128, 128] as const
const RED = [220, 20, 20] as const
const BLUE = [20, 20, 220] as const
const GREEN = [20, 200, 20] as const

async function solidBase64(rgb: readonly [number, number, number]): Promise<string> {
  const buf = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .jpeg({ quality: 95 })
    .toBuffer()
  return buf.toString('base64')
}

async function file(
  kind: MediaFile['kind'],
  rgb: readonly [number, number, number],
): Promise<MediaFile> {
  return makeTestMediaFile({ kind, base64: await solidBase64(rgb), sizeBytes: 1, timestamp: T0 })
}

async function centrePixel(bytes: Uint8Array): Promise<readonly number[]> {
  const { data, info } = await sharp(Buffer.from(bytes)).raw().toBuffer({ resolveWithObject: true })
  const x = Math.floor(info.width / 2)
  const y = Math.floor(info.height / 2) + Math.floor(info.height / 4)
  const i = (y * info.width + x) * info.channels
  return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]
}

const near = (px: readonly number[], rgb: readonly number[]): boolean =>
  px.every((v, i) => Math.abs(v - (rgb[i] ?? 0)) <= 30)

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'zentik', enabled: true },
  { id: 'tgt-2', addonId: 'notifiers', name: 'tablet', kind: 'zentik', enabled: true },
  { id: 'tgt-3', addonId: 'notifiers', name: 'watch', kind: 'zentik', enabled: true },
]

const silent: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
  withTags: () => silent,
}

/** The subject's box at T0, normalised. */
const SUBJECT_BOX = { x: 0.3, y: 0.3, w: 0.3, h: 0.5 }

function makeEntry(payload: Partial<NcOutboxPayload>, targetId = 'tgt-1'): NcOutboxEntry {
  return {
    id: `rule-1:ev-1:${targetId}`,
    ruleId: 'rule-1',
    targetId,
    deviceId: 101,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: T0,
    updatedAt: T0,
    payload: {
      ruleName: 'Persona su Uscio',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      subject: {
        deviceId: 101,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        confidence: 0.9,
        zones: [],
        timestamp: T0,
      },
      ...payload,
    },
  }
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly tracksAtCalls: Array<{ deviceId: number; timestamp: number }>
}

async function makeHarness(
  overrides: Partial<ConstructorParameters<typeof NcDispatcher>[0]> = {},
): Promise<Harness> {
  const trackFiles = [
    await file('firstFrame', RED),
    await file('thumbnail', BLUE),
    await file('keyFrame', GREY),
  ]
  const eventFiles = [await file('crop', GREEN)]
  const sends: NcSendInput[] = []
  const tracksAtCalls: Array<{ deviceId: number; timestamp: number }> = []
  const others: readonly NcTrackAtInstant[] = [
    {
      trackId: 'trk-9',
      className: 'animal',
      label: 'dog',
      confidence: 0.87,
      bbox: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 },
    },
  ]
  const dispatcher = new NcDispatcher({
    logger: silent,
    listTargets: async () => TARGETS,
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async (ownerKind) => (ownerKind === 'track' ? trackFiles : eventFiles),
    getSubjectTrail: async () => [{ timestamp: T0, bbox: SUBJECT_BOX }],
    getTracksAt: async (deviceId, timestamp) => {
      tracksAtCalls.push({ deviceId, timestamp })
      return others
    },
    getDeviceName: async () => 'Camera front door',
    now: () => T0,
    sleep: async () => {},
    ...overrides,
  })
  return { dispatcher, sends, tracksAtCalls }
}

const still = (h: Harness): Uint8Array | undefined =>
  h.sends[0]?.notification.attachments?.find((a) => a.mediaType === 'image')?.bytes

describe('NcDispatcher — every picture mode renders from the clean frame (D897)', () => {
  it.each<[NcMediaImage, string]>([
    ['crop', 'crop.jpg'],
    ['scene-boxes', 'scene-boxes.jpg'],
    ['clean', 'clean.jpg'],
  ])('%s ships the clean keyFrame’s pixels, rendered', async (mode, name) => {
    const h = await makeHarness()
    await h.dispatcher.deliver(makeEntry({ mediaImage: mode }))
    const bytes = still(h)
    expect(bytes).toBeDefined()
    expect(h.sends[0]?.notification.attachments?.[0]?.name).toBe(name)
    expect(near(await centrePixel(bytes ?? new Uint8Array()), GREY)).toBe(true)
  })

  it('a pre-D897 row (frame:boxed, no mediaImage) is read as scene-boxes and still starts clean', async () => {
    const h = await makeHarness()
    await h.dispatcher.deliver(makeEntry({ mediaFrame: 'boxed' }))
    expect(h.sends[0]?.notification.attachments?.[0]?.name).toBe('scene-boxes.jpg')
    expect(near(await centrePixel(still(h) ?? new Uint8Array()), GREY)).toBe(true)
  })

  it('scene-boxes asks for the other tracks on the camera AT the source frame instant', async () => {
    const h = await makeHarness()
    await h.dispatcher.deliver(makeEntry({ mediaImage: 'scene-boxes' }))
    expect(h.tracksAtCalls).toEqual([{ deviceId: 101, timestamp: T0 }])
  })

  it('three targets of one record render the picture ONCE', async () => {
    const h = await makeHarness()
    for (const target of ['tgt-1', 'tgt-2', 'tgt-3']) {
      await h.dispatcher.deliver(makeEntry({ mediaImage: 'scene-boxes' }, target))
    }
    expect(h.sends).toHaveLength(3)
    expect(h.tracksAtCalls).toHaveLength(1)
    const [a, b, c] = h.sends.map((s) => s.notification.attachments?.[0]?.bytes)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('a SENSOR row renders from its LINKED camera: the tracks asked for are that camera’s', async () => {
    const h = await makeHarness()
    const entry = makeEntry({ mediaImage: 'scene-boxes' })
    await h.dispatcher.deliver({
      ...entry,
      recordKind: 'device-event',
      recordId: 'sensor-ev-1',
      deviceId: 620,
      payload: {
        ...entry.payload,
        delivery: 'device-event',
        subject: {
          deviceId: 900,
          trackId: 'nc-linked:abc',
          className: 'contact',
          zones: [],
          timestamp: T0,
          linkedCameraIds: [620],
        },
      },
    })
    expect(h.tracksAtCalls).toEqual([{ deviceId: 620, timestamp: T0 }])
    expect(near(await centrePixel(still(h) ?? new Uint8Array()), GREY)).toBe(true)
  })

  it('`none` ships no still at all', async () => {
    const h = await makeHarness()
    await h.dispatcher.deliver(makeEntry({ media: 'none', mediaImage: 'none' }))
    expect(still(h)).toBeUndefined()
  })
})
