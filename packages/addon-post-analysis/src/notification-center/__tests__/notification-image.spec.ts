/**
 * D897 — the ONE render stage of a notification picture.
 *
 * Pixel-level: a solid frame is rendered and the output is SAMPLED, so a
 * renderer that returned the source untouched, or drew every box the same,
 * fails here. The stage half pins the memo (N targets, one render), the
 * fallback reasons, and that a box is read at the SOURCE frame's instant.
 */
import type { IScopedLogger } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  imageLabelText,
  NC_IMAGE_OTHER_COLOR,
  NC_IMAGE_SUBJECT_COLOR,
  NC_IMAGE_ZONE_COLOR,
  type NcImageRenderRequest,
  NcNotificationImageStage,
  type NcRenderedImage,
  type NcTrackAtInstant,
  notificationOverlaySvg,
  otherTracks,
  overlayStrokes,
  payloadImageMode,
  payloadZoneOverlayIds,
  primaryImageCamera,
  renderNotificationImage,
} from '../notification-image.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'

const W = 640
const H = 360
const T0 = 1_792_593_648_000

async function solidJpeg(r: number, g: number, b: number): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await sharp({
    create: { width: W, height: H, channels: 3, background: { r, g, b } },
  })
    .jpeg({ quality: 95 })
    .toBuffer()
  const out = new Uint8Array(buf.byteLength)
  out.set(buf)
  return out
}

interface Decoded {
  readonly width: number
  readonly height: number
  pixel(x: number, y: number): readonly [number, number, number]
}

async function decode(bytes: Uint8Array): Promise<Decoded> {
  const { data, info } = await sharp(Buffer.from(bytes)).raw().toBuffer({ resolveWithObject: true })
  return {
    width: info.width,
    height: info.height,
    pixel: (x, y) => {
      const i = (y * info.width + x) * info.channels
      return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]
    },
  }
}

function hexRgb(hex: string): readonly [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function near(px: readonly number[], rgb: readonly number[], tol = 40): boolean {
  return px.every((v, i) => Math.abs(v - (rgb[i] ?? 0)) <= tol)
}

/** Subject box: 100..260 × 100..300 px; other box: 400..560 × 60..200 px. */
const SUBJECT = {
  x: 100 / W,
  y: 100 / H,
  w: 160 / W,
  h: 200 / H,
  label: 'person 91%',
}
const OTHER = {
  x: 400 / W,
  y: 60 / H,
  w: 160 / W,
  h: 140 / H,
  label: 'dog 87%',
}

describe('the caption', () => {
  it('is class and confidence, language-free', () => {
    expect(imageLabelText('dog', 0.87)).toBe('dog 87%')
    expect(imageLabelText('person', 0.9149)).toBe('person 91%')
    expect(imageLabelText('car', undefined)).toBe('car')
  })
})

describe('the overlay', () => {
  it('draws the subject THICK in the accent colour and every other track THIN', () => {
    const strokes = overlayStrokes(W, H)
    const svg = notificationOverlaySvg({
      width: W,
      height: H,
      boxes: [
        {
          x: 100,
          y: 100,
          w: 160,
          h: 200,
          role: 'subject',
          label: 'person 91%',
        },
        { x: 400, y: 60, w: 160, h: 140, role: 'other', label: 'dog 87%' },
      ],
      zones: [],
    })
    expect(strokes.subject).toBeGreaterThan(strokes.other)
    expect(svg).toContain(
      `data-role="subject" x="100" y="100" width="160" height="200" fill="none" stroke="${NC_IMAGE_SUBJECT_COLOR}" stroke-width="${String(strokes.subject)}"`,
    )
    expect(svg).toContain(
      `data-role="other" x="400" y="60" width="160" height="140" fill="none" stroke="${NC_IMAGE_OTHER_COLOR}" stroke-width="${String(strokes.other)}"`,
    )
    expect(svg).toContain('>person 91%</text>')
    expect(svg).toContain('>dog 87%</text>')
    // The subject is drawn LAST, so a crowd never covers it.
    expect(svg.indexOf('data-role="subject"')).toBeGreaterThan(svg.indexOf('data-role="other"'))
    expect(svg).not.toContain('data-role="zone"')
  })

  it('strokes a named class in the palette colour it is given', () => {
    const svg = notificationOverlaySvg({
      width: W,
      height: H,
      boxes: [
        {
          x: 100,
          y: 100,
          w: 160,
          h: 200,
          role: 'subject',
          label: 'person 91%',
          className: 'person',
        },
      ],
      zones: [],
      paintClass: (kind) => (kind === 'person' ? '#11a64c' : '#000000'),
    })
    expect(svg).toContain('stroke="#11a64c"')
    expect(svg).not.toContain(`stroke="${NC_IMAGE_SUBJECT_COLOR}"`)
  })

  it('outlines a zone only when it is given one', () => {
    const svg = notificationOverlaySvg({
      width: W,
      height: H,
      boxes: [],
      zones: [
        [
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.1 },
          { x: 0.5, y: 0.5 },
        ],
      ],
    })
    expect(svg).toContain('data-role="zone" points="64,36 320,36 320,180"')
  })
})

describe('renderNotificationImage — sampled pixels', () => {
  it('scene-boxes: accent on the subject edge, light on the other track, the scene untouched between', async () => {
    const out = await renderNotificationImage({
      mode: 'scene-boxes',
      bytes: await solidJpeg(0, 0, 0),
      subject: SUBJECT,
      others: [OTHER],
      zones: [],
    })
    expect(out.rendered).toBe('scene-boxes')
    const img = await decode(out.bytes)
    expect(img.width).toBe(W)
    // Left edge of the subject box, mid-height: the accent colour.
    expect(near(img.pixel(100, 200), hexRgb(NC_IMAGE_SUBJECT_COLOR))).toBe(true)
    // Left edge of the other box, mid-height: the thin light outline.
    expect(near(img.pixel(400, 150), hexRgb(NC_IMAGE_OTHER_COLOR))).toBe(true)
    // Inside both boxes, and between them: the black scene.
    expect(near(img.pixel(180, 220), [0, 0, 0], 20)).toBe(true)
    expect(near(img.pixel(480, 150), [0, 0, 0], 20)).toBe(true)
    expect(near(img.pixel(330, 330), [0, 0, 0], 20)).toBe(true)
  })

  it('clean: nothing is drawn, even with a subject and a zone in hand', async () => {
    const out = await renderNotificationImage({
      mode: 'clean',
      bytes: await solidJpeg(0, 0, 0),
      subject: SUBJECT,
      others: [OTHER],
      zones: [],
    })
    expect(out.rendered).toBe('clean')
    const img = await decode(out.bytes)
    expect(near(img.pixel(100, 200), [0, 0, 0], 20)).toBe(true)
    expect(near(img.pixel(400, 150), [0, 0, 0], 20)).toBe(true)
  })

  it('clean + zone: the trigger zone is drawn', async () => {
    const out = await renderNotificationImage({
      mode: 'clean',
      bytes: await solidJpeg(0, 0, 0),
      subject: null,
      others: [],
      zones: [
        [
          { x: 0.25, y: 0.25 },
          { x: 0.75, y: 0.25 },
          { x: 0.75, y: 0.75 },
          { x: 0.25, y: 0.75 },
        ],
      ],
    })
    const img = await decode(out.bytes)
    // The zone's translucent fill tints its inside towards the zone colour.
    const inside = img.pixel(320, 180)
    const [, , zb] = hexRgb(NC_IMAGE_ZONE_COLOR)
    expect(inside[2]).toBeGreaterThan(20)
    expect(inside[2]).toBeLessThan(zb)
    expect(near(img.pixel(40, 20), [0, 0, 0], 20)).toBe(true)
  })

  it('crop: the subject is CUT out of the frame — never the whole scene, never a zone', async () => {
    const out = await renderNotificationImage({
      mode: 'crop',
      bytes: await solidJpeg(90, 90, 90),
      subject: SUBJECT,
      others: [OTHER],
      zones: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      ],
    })
    expect(out.rendered).toBe('crop')
    const img = await decode(out.bytes)
    // 160 × 200 box, padded 25% (40 / 50 px) each side: 240 × 300.
    expect(img.width).toBe(240)
    expect(img.height).toBe(300)
    expect(near(img.pixel(120, 150), [90, 90, 90], 20)).toBe(true)
    expect(near(img.pixel(5, 5), [90, 90, 90], 20)).toBe(true)
  })

  it('crop with no subject box degrades to the clean scene', async () => {
    const out = await renderNotificationImage({
      mode: 'crop',
      bytes: await solidJpeg(90, 90, 90),
      subject: null,
      others: [],
      zones: [],
    })
    expect(out.rendered).toBe('clean')
    expect((await decode(out.bytes)).width).toBe(W)
  })
})

describe('otherTracks', () => {
  const track = (trackId: string, x: number): NcTrackAtInstant => ({
    trackId,
    className: 'person',
    bbox: { x, y: 0.2, w: 0.2, h: 0.4 },
  })
  it('leaves out the subject — by id, and by its box when a fused id names it differently', () => {
    const subjectBox = { x: 0.1, y: 0.2, w: 0.2, h: 0.4 }
    const out = otherTracks(
      [track('trk-1', 0.1), track('survivor', 0.1), track('trk-2', 0.6)],
      'trk-1',
      subjectBox,
    )
    expect(out.map((t) => t.trackId)).toEqual(['trk-2'])
  })

  it('leaves out a SAME-CLASS box over the subject past the NMS overlap — a second piece of it', () => {
    // IoU 0.6 with the subject: two detections of one class in ONE frame cannot
    // overlap that much (NMS keeps one of them above 0.45), so this is the
    // subject's own unfused piece, not another dog.
    const subjectBox = { x: 0.1, y: 0.2, w: 0.2, h: 0.4 }
    const piece: NcTrackAtInstant = {
      trackId: 'piece',
      className: 'animal',
      bbox: { x: 0.15, y: 0.2, w: 0.2, h: 0.4 },
    }
    const person: NcTrackAtInstant = { ...piece, trackId: 'walker', className: 'person' }
    const out = otherTracks([piece, person], 'trk-1', subjectBox, 'animal')
    expect(out.map((t) => t.trackId)).toEqual(['walker'])
  })
})

// ── Row-level reads ──────────────────────────────────────────────────

function payload(overrides: Partial<NcOutboxPayload> = {}): NcOutboxPayload {
  return {
    ruleName: 'Persona su Uscio',
    delivery: 'immediate',
    priority: 3,
    media: 'best',
    subject: {
      deviceId: 101,
      trackId: 'trk-1',
      eventId: 'ev-1',
      className: 'person',
      confidence: 0.91,
      zones: ['zone-uscio'],
      timestamp: T0,
    },
    ...overrides,
  }
}

describe('what a ROW asks for', () => {
  it.each<[string, Partial<NcOutboxPayload>, string]>([
    ['a D897 row says it', { mediaImage: 'scene-boxes' }, 'scene-boxes'],
    ['no still', { media: 'none', mediaImage: 'crop' }, 'none'],
    ['legacy zone crop', { mediaZoneIds: ['z'] }, 'clean'],
    ['legacy full', { mediaFrame: 'full' }, 'clean'],
    ['legacy boxed', { mediaFrame: 'boxed' }, 'scene-boxes'],
    ['legacy keyFrame', { media: 'keyFrame' }, 'clean'],
    ['legacy best', {}, 'crop'],
  ])('%s', (_label, overrides, mode) => {
    expect(payloadImageMode(payload(overrides))).toBe(mode)
  })

  it('outlines the trigger zones only when the row asked to', () => {
    expect(payloadZoneOverlayIds(payload({ mediaImage: 'clean', triggerZoneIds: ['z'] }))).toEqual(
      [],
    )
    expect(
      payloadZoneOverlayIds(
        payload({
          mediaImage: 'clean',
          triggerZoneIds: ['z'],
          matchedZoneIds: ['z'],
          mediaShowTriggerZone: true,
        }),
      ),
    ).toEqual(['z'])
  })

  it('outlines only the zone(s) THIS event triggered, never every zone the rule lists', () => {
    // Prod 2026-10-22, rule "Animale su Aiuola o Uscio": the dog was in Uscio
    // only, and both Aiuola and Uscio were drawn.
    const row = payload({
      mediaImage: 'scene-boxes',
      mediaShowTriggerZone: true,
      triggerZoneIds: ['zone-aiuola', 'zone-uscio'],
      matchedZoneIds: ['zone-uscio'],
    })
    expect(payloadZoneOverlayIds(row)).toEqual(['zone-uscio'])
    // Unknown (a row frozen before the field): nothing, never all.
    const unknown = payload({
      mediaImage: 'scene-boxes',
      mediaShowTriggerZone: true,
      triggerZoneIds: ['zone-aiuola', 'zone-uscio'],
    })
    expect(payloadZoneOverlayIds(unknown)).toEqual([])
  })

  it('a sensor row shows its LINKED camera; a mosaic of several is a composite', () => {
    const subject = payload().subject
    expect(primaryImageCamera(payload({ subject: { ...subject, deviceId: 900 } }))).toBe(900)
    expect(
      primaryImageCamera(
        payload({
          subject: { ...subject, deviceId: 900, linkedCameraIds: [620] },
        }),
      ),
    ).toBe(620)
    expect(
      primaryImageCamera(
        payload({
          subject: { ...subject, deviceId: 900, linkedCameraIds: [620, 621] },
        }),
      ),
    ).toBe('composite')
    expect(
      primaryImageCamera(
        payload({
          subject: {
            ...subject,
            deviceId: 900,
            linkedCameraIds: [620, 621],
            extraStills: [{ ownerId: 'o', cameraId: 621 }],
          },
        }),
      ),
    ).toBe(620)
  })
})

// ── The stage ────────────────────────────────────────────────────────

interface Line {
  readonly level: string
  readonly message: string
  readonly tags: Record<string, unknown>
  readonly meta: Record<string, unknown>
}

function recordingLogger(): { logger: IScopedLogger; lines: Line[] } {
  const lines: Line[] = []
  const at =
    (level: string) =>
    (
      message: string,
      extras?: {
        tags?: Record<string, unknown>
        meta?: Record<string, unknown>
      },
    ): void => {
      lines.push({
        level,
        message,
        tags: extras?.tags ?? {},
        meta: extras?.meta ?? {},
      })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

function entry(overrides: Partial<NcOutboxPayload> = {}, targetId = 'tgt-1'): NcOutboxEntry {
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
    payload: payload(overrides),
  }
}

const SOURCE_TS = T0 + 120

describe('NcNotificationImageStage', () => {
  it('renders ONCE for a record delivered to three targets (and its retries)', async () => {
    const requests: NcImageRenderRequest[] = []
    const { logger } = recordingLogger()
    const stage = new NcNotificationImageStage({
      logger,
      now: () => T0,
      getSubjectTrail: async () => [{ timestamp: SOURCE_TS, bbox: SUBJECT }],
      getTracksAt: async () => [],
      render: async (req): Promise<NcRenderedImage> => {
        requests.push(req)
        return {
          bytes: req.bytes,
          name: 'scene-boxes.jpg',
          rendered: 'scene-boxes',
        }
      },
    })
    const bytes = await solidJpeg(0, 0, 0)
    const source = {
      bytes,
      kind: 'keyFrame' as const,
      timestamp: SOURCE_TS,
      annotated: false,
    }
    for (const target of ['tgt-1', 'tgt-2', 'tgt-3', 'tgt-1']) {
      const out = await stage.notificationImage({
        entry: entry({ mediaImage: 'scene-boxes' }, target),
        source,
        camera: 101,
        withSubject: true,
      })
      expect(out?.name).toBe('scene-boxes.jpg')
    }
    expect(requests).toHaveLength(1)
  })

  it('reads the subject box and the other tracks AT the source frame instant, on the camera it shows', async () => {
    const asked: Array<{ deviceId: number; timestamp: number }> = []
    const trailAsked: number[] = []
    const requests: NcImageRenderRequest[] = []
    const stage = new NcNotificationImageStage({
      logger: recordingLogger().logger,
      now: () => T0,
      getSubjectTrail: async (deviceId) => {
        trailAsked.push(deviceId)
        return [
          { timestamp: T0 - 3_000, bbox: { x: 0.9, y: 0.9, w: 0.05, h: 0.05 } },
          { timestamp: SOURCE_TS, bbox: SUBJECT },
        ]
      },
      getTracksAt: async (deviceId, timestamp) => {
        asked.push({ deviceId, timestamp })
        return [
          { trackId: 'trk-1', className: 'person', bbox: SUBJECT },
          {
            trackId: 'trk-9',
            className: 'animal',
            label: 'dog',
            confidence: 0.87,
            bbox: OTHER,
          },
        ]
      },
      render: async (req) => {
        requests.push(req)
        return {
          bytes: req.bytes,
          name: 'scene-boxes.jpg',
          rendered: 'scene-boxes',
        }
      },
    })
    await stage.notificationImage({
      entry: entry({ mediaImage: 'scene-boxes' }),
      source: {
        bytes: await solidJpeg(0, 0, 0),
        kind: 'keyFrame',
        timestamp: SOURCE_TS,
        annotated: false,
      },
      camera: 101,
      withSubject: true,
    })
    expect(asked).toEqual([{ deviceId: 101, timestamp: SOURCE_TS }])
    expect(trailAsked).toEqual([101])
    expect(requests[0]?.subject).toEqual({
      ...SUBJECT,
      label: 'person 91%',
      className: 'person',
    })
    expect(requests[0]?.others).toEqual([
      { ...OTHER, label: 'dog 87%', confidence: 0.87, className: 'animal' },
    ])
  })

  it('scene-boxes with nothing visible at that instant ships CLEAN and names the reason once, per camera', async () => {
    const { logger, lines } = recordingLogger()
    const stage = new NcNotificationImageStage({
      logger,
      now: () => T0,
      getSubjectTrail: async () => [],
      getTracksAt: async () => [],
    })
    const source = {
      bytes: await solidJpeg(0, 0, 0),
      kind: 'keyFrame' as const,
      timestamp: SOURCE_TS,
      annotated: false,
    }
    for (const target of ['tgt-1', 'tgt-2']) {
      const out = await stage.notificationImage({
        entry: entry({ mediaImage: 'scene-boxes' }, target),
        source,
        camera: 101,
        withSubject: true,
      })
      expect(out?.rendered).toBe('clean')
      expect(out?.reason).toBe('no-tracks-at-instant')
    }
    const said = lines.filter(
      (l) => l.message === 'notification picture shipped without the mode the rule asked for',
    )
    expect(said).toHaveLength(1)
    expect(said[0]?.tags).toEqual({ deviceId: 101 })
    expect(said[0]?.meta).toMatchObject({
      asked: 'scene-boxes',
      reason: 'no-tracks-at-instant',
    })
  })

  it('crop with no box at that instant ships clean, reason no-subject-box', async () => {
    const stage = new NcNotificationImageStage({
      logger: recordingLogger().logger,
      now: () => T0,
      // The only trail point is 3 s away: not the box of THIS frame.
      getSubjectTrail: async () => [{ timestamp: SOURCE_TS - 3_000, bbox: SUBJECT }],
    })
    const out = await stage.notificationImage({
      entry: entry({ mediaImage: 'crop' }),
      source: {
        bytes: await solidJpeg(9, 9, 9),
        kind: 'keyFrame',
        timestamp: SOURCE_TS,
        annotated: false,
      },
      camera: 101,
      withSubject: true,
    })
    expect(out?.rendered).toBe('clean')
    expect(out?.reason).toBe('no-subject-box')
  })

  it('an ANNOTATED source (no clean frame stored) ships as stored, with its reason', async () => {
    const bytes = await solidJpeg(9, 9, 9)
    let rendered = 0
    const stage = new NcNotificationImageStage({
      logger: recordingLogger().logger,
      now: () => T0,
      render: async (req) => {
        rendered += 1
        return { bytes: req.bytes, name: 'x.jpg', rendered: 'clean' }
      },
    })
    const out = await stage.notificationImage({
      entry: entry({ mediaImage: 'crop' }),
      source: {
        bytes,
        kind: 'firstFrame',
        timestamp: SOURCE_TS,
        annotated: true,
      },
      camera: 101,
      withSubject: true,
    })
    expect(rendered).toBe(0)
    expect(out?.bytes).toBe(bytes)
    expect(out?.reason).toBe('annotated-source')
  })

  it('draws the trigger zone on a scene mode the row asked it for — and never on a crop', async () => {
    const requests: NcImageRenderRequest[] = []
    const polygon = [
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.1 },
      { x: 0.4, y: 0.4 },
    ]
    const stage = new NcNotificationImageStage({
      logger: recordingLogger().logger,
      now: () => T0,
      getSubjectTrail: async () => [{ timestamp: SOURCE_TS, bbox: SUBJECT }],
      getZonePolygons: async () => [polygon],
      render: async (req) => {
        requests.push(req)
        return { bytes: req.bytes, name: 'n.jpg', rendered: req.mode }
      },
    })
    const source = {
      bytes: await solidJpeg(9, 9, 9),
      kind: 'keyFrame' as const,
      timestamp: SOURCE_TS,
      annotated: false,
    }
    const zoneRow = {
      triggerZoneIds: ['zone-uscio'],
      matchedZoneIds: ['zone-uscio'],
      mediaShowTriggerZone: true as const,
    }
    await stage.notificationImage({
      entry: entry({ mediaImage: 'clean', ...zoneRow }),
      source,
      camera: 101,
      withSubject: true,
    })
    await stage.notificationImage({
      entry: { ...entry({ mediaImage: 'crop', ...zoneRow }), recordId: 'ev-2' },
      source,
      camera: 101,
      withSubject: true,
    })
    await stage.notificationImage({
      entry: {
        ...entry({ mediaImage: 'clean', triggerZoneIds: ['zone-uscio'] }),
        recordId: 'ev-3',
      },
      source,
      camera: 101,
      withSubject: true,
    })
    expect(requests.map((r) => r.zones.length)).toEqual([1, 0, 0])
  })

  it('draws NO zone when the row asked for the overlay but never froze which fired — said once', async () => {
    const requests: NcImageRenderRequest[] = []
    const asked: string[][] = []
    const { logger, lines } = recordingLogger()
    const stage = new NcNotificationImageStage({
      logger,
      now: () => T0,
      getSubjectTrail: async () => [{ timestamp: SOURCE_TS, bbox: SUBJECT }],
      getZonePolygons: async (_deviceId, ids) => {
        asked.push([...ids])
        return ids.map(() => [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.4, y: 0.4 },
        ])
      },
      render: async (req) => {
        requests.push(req)
        return { bytes: req.bytes, name: 'n.jpg', rendered: req.mode }
      },
    })
    const source = {
      bytes: await solidJpeg(9, 9, 9),
      kind: 'keyFrame' as const,
      timestamp: SOURCE_TS,
      annotated: false,
    }
    const row = entry({
      mediaImage: 'clean',
      mediaShowTriggerZone: true,
      triggerZoneIds: ['zone-aiuola', 'zone-uscio'],
    })
    await stage.notificationImage({ entry: row, source, camera: 101, withSubject: true })
    await stage.notificationImage({
      entry: { ...row, targetId: 'tgt-2' },
      source,
      camera: 101,
      withSubject: true,
    })
    expect(requests.map((r) => r.zones.length)).toEqual([0])
    expect(asked).toEqual([])
    const said = lines.filter((l) => l.message.includes('trigger zone not drawn'))
    expect(said).toHaveLength(1)
    expect(said[0]?.tags['deviceId']).toBe(101)
  })
})

// ── The subject's path (D903) ────────────────────────────────────────

/** A horizontal path across the frame at y = 0.5, x 0.1 → 0.9. */
const PATH_ACROSS = [
  { x: 0.1, y: 0.5 },
  { x: 0.5, y: 0.5 },
  { x: 0.9, y: 0.5 },
]

describe('renderNotificationImage — the subject path', () => {
  it('draws the path in the SUBJECT colour on a scene, only where it is given one', async () => {
    const withPath = await renderNotificationImage({
      mode: 'clean',
      bytes: await solidJpeg(0, 0, 0),
      subject: null,
      others: [],
      zones: [],
      path: PATH_ACROSS,
    })
    const img = await decode(withPath.bytes)
    expect(withPath.rendered).toBe('clean')
    expect(near(img.pixel(320, 180), hexRgb(NC_IMAGE_SUBJECT_COLOR))).toBe(true)
    // Off the line the scene is untouched.
    expect(near(img.pixel(320, 60), [0, 0, 0], 20)).toBe(true)

    const without = await renderNotificationImage({
      mode: 'clean',
      bytes: await solidJpeg(0, 0, 0),
      subject: null,
      others: [],
      zones: [],
    })
    expect(near((await decode(without.bytes)).pixel(320, 180), [0, 0, 0], 20)).toBe(true)
  })

  it('maps the path INTO a crop and clips it there', async () => {
    // The subject box spans x 100..260 px; the crop is 60..300 px wide (padded).
    const out = await renderNotificationImage({
      mode: 'crop',
      bytes: await solidJpeg(0, 0, 0),
      subject: SUBJECT,
      others: [],
      zones: [],
      path: [
        { x: 0, y: 200 / H },
        { x: 1, y: 200 / H },
      ],
    })
    expect(out.rendered).toBe('crop')
    const img = await decode(out.bytes)
    expect(img.width).toBe(240)
    // Crop top = 100 - 50 = 50 px → the line at y 200 sits at 150 in the crop.
    expect(near(img.pixel(120, 150), hexRgb(NC_IMAGE_SUBJECT_COLOR))).toBe(true)
    expect(near(img.pixel(120, 40), [0, 0, 0], 20)).toBe(true)
  })

  it('a path wholly outside the crop draws nothing and does not fail the picture', async () => {
    const out = await renderNotificationImage({
      mode: 'crop',
      bytes: await solidJpeg(0, 0, 0),
      subject: SUBJECT,
      others: [],
      zones: [],
      path: [
        { x: 0.9, y: 0.05 },
        { x: 0.95, y: 0.05 },
      ],
    })
    expect(out.rendered).toBe('crop')
    const img = await decode(out.bytes)
    expect(near(img.pixel(120, 150), [0, 0, 0], 20)).toBe(true)
  })
})

describe('NcNotificationImageStage — the subject path', () => {
  const trail = [
    {
      timestamp: SOURCE_TS - 2_000,
      bbox: { x: 0.05, y: 0.45, w: 0.1, h: 0.1 },
    },
    {
      timestamp: SOURCE_TS - 1_000,
      bbox: { x: 0.25, y: 0.45, w: 0.1, h: 0.1 },
    },
    { timestamp: SOURCE_TS, bbox: SUBJECT },
    // AFTER the frame shown: never part of its path.
    {
      timestamp: SOURCE_TS + 1_000,
      bbox: { x: 0.85, y: 0.05, w: 0.1, h: 0.1 },
    },
  ]

  async function stageRequests(
    overrides: Partial<NcOutboxPayload>,
    trailPoints: typeof trail = trail,
  ): Promise<NcImageRenderRequest[]> {
    const requests: NcImageRenderRequest[] = []
    const stage = new NcNotificationImageStage({
      logger: recordingLogger().logger,
      now: () => T0,
      getSubjectTrail: async () => trailPoints,
      render: async (req) => {
        requests.push(req)
        return { bytes: req.bytes, name: 'n.jpg', rendered: req.mode }
      },
    })
    const out = await stage.notificationImage({
      entry: entry(overrides),
      source: {
        bytes: await solidJpeg(9, 9, 9),
        kind: 'keyFrame',
        timestamp: SOURCE_TS,
        annotated: false,
      },
      camera: 101,
      withSubject: true,
    })
    expect(out).not.toBeNull()
    return requests
  }

  it('hands the renderer the trail centres up to the frame shown — only when the row asked', async () => {
    const asked = await stageRequests({
      mediaImage: 'crop',
      mediaShowSubjectPath: true,
    })
    const path = asked[0]?.path ?? []
    expect(path).toHaveLength(3)
    expect(path[0]?.x).toBeCloseTo(0.1)
    expect(path[2]?.x).toBeCloseTo(SUBJECT.x + SUBJECT.w / 2)
    const notAsked = await stageRequests({ mediaImage: 'crop' })
    expect(notAsked[0]?.path ?? []).toEqual([])
  })

  it('a trail of one point draws no path and still renders the picture', async () => {
    const asked = await stageRequests({ mediaImage: 'clean', mediaShowSubjectPath: true }, [
      { timestamp: SOURCE_TS, bbox: SUBJECT },
    ])
    expect(asked).toHaveLength(1)
    expect(asked[0]?.path ?? []).toEqual([])
  })
})

describe('NcNotificationImageStage — where the captions go', () => {
  // Subject touches the top edge and is short (40 px); a car sits right under it.
  const TOP_SUBJECT = { x: 100 / W, y: 0, w: 160 / W, h: 40 / H }
  const CAR_BELOW = { x: 90 / W, y: 45 / H, w: 200 / W, h: 200 / H }

  it('lays the captions out by the placement rule: none on another box, none inside a small box — said once', async () => {
    const { logger, lines } = recordingLogger()
    const stage = new NcNotificationImageStage({
      logger,
      now: () => T0,
      getSubjectTrail: async () => [{ timestamp: SOURCE_TS, bbox: TOP_SUBJECT }],
      getTracksAt: async () => [
        {
          trackId: 'trk-7',
          className: 'vehicle',
          label: 'car',
          confidence: 0.6,
          bbox: CAR_BELOW,
        },
      ],
    })
    const out = await stage.notificationImage({
      entry: entry({ mediaImage: 'scene-boxes' }),
      source: {
        bytes: await solidJpeg(255, 255, 255),
        kind: 'keyFrame',
        timestamp: SOURCE_TS,
        annotated: false,
      },
      camera: 101,
      withSubject: true,
    })
    expect(out?.rendered).toBe('scene-boxes')
    const img = await decode(out?.bytes ?? new Uint8Array())
    // Samples sit in a plate's left padding (before the text starts), so a
    // glyph never decides them. Inside the subject's top band: the scene, not
    // a plate covering the subject.
    expect(near(img.pixel(104, 10), [255, 255, 255], 30)).toBe(true)
    // Just above the car, where its caption would land on the subject: the scene.
    expect(near(img.pixel(94, 30), [255, 255, 255], 30)).toBe(true)
    // The car's caption went BELOW it, clear of every box: the dark plate.
    expect(near(img.pixel(94, 254), [0, 0, 0], 90)).toBe(true)
    const said = lines.filter((l) => l.message === 'notification picture captions laid out')
    expect(said).toHaveLength(1)
    expect(said[0]?.level).toBe('debug')
    expect(said[0]?.tags).toEqual({ deviceId: 101 })
    expect(said[0]?.meta).toMatchObject({ placed: 1, dropped: 1 })
  })
})
