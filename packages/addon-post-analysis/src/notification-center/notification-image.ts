/**
 * notificationImage — ONE stage renders every notification picture (D897).
 *
 * ## The defect this replaces
 *
 * A rule's picture used to be a STORED kind picked by a ladder: `best` walked
 * subject crops and ended in the boxed `firstFrame`, so one rule shipped a
 * crop on one event and a boxed scene on the next depending on what had
 * landed; boxes were burnt only at WRITE time and only around the track's own
 * box; `zoneCrop` was a third mechanism, and the sensor, sound, linked-camera
 * and mosaic paths each had their own rules for what "the picture" was.
 *
 * ## The stage
 *
 * The dispatcher resolves a CLEAN source frame of the trigger moment
 * (`cleanSourcePreference`: keyFrame → sceneFrame → lastSceneFrame, after the
 * MOMENT and PLACE filters), and this stage renders it by the rule's mode:
 *
 *  - `scene-boxes` — the whole scene; the subject outlined THICK in the accent
 *    colour, every OTHER track visible at that instant outlined THIN, each
 *    captioned with the class vocabulary in the hub language ("Cane 87%") on a
 *    dark plate that reads on any background. Boxes are the tracks' trail
 *    boxes AT
 *    the source frame's timestamp — never the track envelope — scaled to the
 *    JPEG.
 *  - `crop`  — the subject cut out of the clean frame around its box at that
 *    instant.
 *  - `clean` — the scene, nothing drawn.
 *  - `showTriggerZone` adds the zone that fired the rule to a scene mode.
 *  - `showSubjectPath` (D903) adds the subject's path — a line in the
 *    subject's colour through its trail centres up to the frame shown — to
 *    every mode; on a `crop` it is mapped into the crop and clipped. The
 *    geometry is `buildSubjectPath` / `projectSubjectPath` from
 *    `@camstack/types`, the same the debug views draw.
 *
 * A mode that cannot be honoured ships `clean` and says why, once per record
 * (D400: "a branch that fails to produce media names the reason"): no subject
 * box at that instant, no track visible at that instant, a source that is
 * already annotated (a track that holds no clean frame), a composite.
 *
 * ## Once per record
 *
 * N targets and every outbox retry resolve the same row; the render is
 * memoised per record + subject + mode + zone flag + camera + hub language
 * for {@link NC_IMAGE_MEMO_TTL_MS}, so a 4K decode happens once, not once per
 * phone. The hub has one notification language, so every recipient of a row
 * shares that picture. It runs in the process that hosts the Notification
 * Center (the pipeline-analytics runner), which already carries `sharp`.
 */
import {
  buildSubjectPath,
  bundledCamstack,
  eventKindLabel,
  type EventKindLabelLocale,
  type IScopedLogger,
  isDrawableSubjectPath,
  isEventKindLabelKey,
  type MediaFileKind,
  type NcMediaImage,
  paintHex,
  projectSubjectPath,
  type SubjectPathPoint,
  type SubjectPathRect,
  subjectPathSampleFromBox,
  subjectPathSvgPoints,
} from '@camstack/types'
import type { NcOutboxEntry, NcOutboxPayload } from './outbox.js'
import { isLinkedStillId } from './linked-stills.js'
import { isStillShelfId } from './still-shelf.js'
import { layoutBoxLabels, NC_LABEL_MIN_FONT_PX } from './notification-label-layout.js'
import { type NcSubjectTrailPoint, type NcZonePolygon, trailAt } from './trigger-zone-still.js'

/** A box in the normalised 0..1 space the trail and the zones share. */
export interface NcNormBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** One track visible on a camera at an instant, with its trail box AT that instant. */
export interface NcTrackAtInstant {
  readonly trackId: string
  readonly className: string
  /** Display label (identity / plate / sub-class) when the track has one. */
  readonly label?: string
  /** Detection score of the box at that instant, else the track's. 0..1. */
  readonly confidence?: number
  readonly bbox: NcNormBox
  /** Signed ms from the instant to the nearest trail position. */
  readonly dtMs?: number
  /** True when the box is interpolated between two bracketing positions. */
  readonly interpolated?: boolean
}

/** The clean frame the picture is rendered from. */
export interface NcImageSource {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly kind: MediaFileKind
  /** The instant the frame shows — the boxes are read AT this instant. */
  readonly timestamp: number
  /** True when the stored kind already carries a burnt-in box (D654 last rung). */
  readonly annotated: boolean
}

/** Why a picture shipped as something other than the mode the rule asked for. */
export type NcImageFallbackReason =
  | 'no-subject-box'
  | 'no-tracks-at-instant'
  | 'annotated-source'
  | 'composite-source'
  | 'render-failed'

/** A box to draw, in OUTPUT pixels. */
export interface NcOverlayBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly role: 'subject' | 'other'
  readonly label: string
  /** Detector class. When set, the stroke is that palette colour. */
  readonly className?: string
  /** The track's confidence — orders the captions that compete for room. */
  readonly score?: number
}

/** A normalised box with its caption and, when known, the score that ranks it. */
export interface NcLabelledNormBox extends NcNormBox {
  readonly label: string
  readonly confidence?: number
  /** Detector class. When set, the stroke is that palette colour. */
  readonly className?: string
}

/** How many captions a picture carries, and how many had nowhere clear to go. */
export interface NcLabelCounts {
  readonly placed: number
  readonly dropped: number
}

/** What the renderer is asked to produce. */
export interface NcImageRenderRequest {
  readonly mode: Exclude<NcMediaImage, 'none'>
  readonly bytes: Uint8Array<ArrayBuffer>
  /** Subject box at the source instant (`crop` cuts it; `scene-boxes` draws it). */
  readonly subject: NcLabelledNormBox | null
  /** Every other track visible at that instant (`scene-boxes` only). */
  readonly others: readonly NcLabelledNormBox[]
  /** Zones to outline (a scene mode with `showTriggerZone`). */
  readonly zones: readonly NcZonePolygon[]
  /**
   * The subject's path, normalised in the SOURCE frame (`showSubjectPath`).
   * Absent or fewer than two points = no path.
   */
  readonly path?: readonly SubjectPathPoint[]
  /** Class → palette hex. Absent: the bundled CamStack preset. */
  readonly paintClass?: (kind: string) => string
}

/** A rendered picture. `rendered` is what it SHOWS; `reason` says why it differs from the ask. */
export interface NcRenderedImage {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly name: string
  readonly rendered: Exclude<NcMediaImage, 'none'>
  readonly reason?: NcImageFallbackReason
  /** Present when boxes were drawn: the caption layout's outcome. */
  readonly labels?: NcLabelCounts
}

/** How long a rendered picture is reused for the same record (N targets, retries). */
const NC_IMAGE_MEMO_TTL_MS = 15 * 60_000
/** At most this many rendered pictures are held. */
const NC_IMAGE_MEMO_MAX = 128
/** How far a trail point may sit from the source frame's instant and still be its box. */
const NC_IMAGE_BOX_MATCH_MAX_MS = 750
/** A scene picture is downscaled to at most this width (a phone shows it). */
const NC_IMAGE_SCENE_MAX_WIDTH = 1920
/** A crop is downscaled to at most this long edge. */
const NC_IMAGE_CROP_MAX_EDGE = 1280
/** Padding around the subject box of a crop, as a fraction of the box's side. */
const NC_IMAGE_CROP_PAD = 0.25
/** The subject's outline. */
export const NC_IMAGE_SUBJECT_COLOR = '#ffb300'
/** Every other track's outline. */
export const NC_IMAGE_OTHER_COLOR = '#f2f2f2'
/** The trigger zone's outline. */
export const NC_IMAGE_ZONE_COLOR = '#29b6f6'
/** Two tracks whose boxes overlap this much at one instant are the same subject (a fused id). */
const SAME_SUBJECT_IOU = 0.8
/**
 * A box of the SUBJECT'S CLASS overlapping the subject this much at one
 * instant is the subject itself — an unfused piece L2 has not joined yet
 * (D683 fuses 10–20 s later; a push leaves ~6 s after the trigger). The
 * detector's per-class NMS (`NMS_IOU_DEFAULT` 0.45) keeps one of two
 * same-class boxes above 0.45 in a frame, so two REAL subjects of one class
 * cannot overlap past it; 0.5 leaves a margin over that.
 */
const NC_IMAGE_SAME_CLASS_SUBJECT_IOU = 0.5
const JPEG_QUALITY = 85

// ── Pure helpers ─────────────────────────────────────────────────────

/** The caption of a box: a name and confidence — "Cane 87%". The name is already chosen. */
export function imageLabelText(name: string, confidence: number | undefined): string {
  if (confidence === undefined || !Number.isFinite(confidence)) return name
  const pct = Math.round(Math.min(1, Math.max(0, confidence)) * 100)
  return `${name} ${String(pct)}%`
}

/** What a box is captioned with, before confidence is appended. */
export interface NcImageCaption {
  readonly className: string
  /** Identity, plate, or a finer class id, when the track has one. */
  readonly label?: string
  /** A recognised person or a read plate is printed as written. */
  readonly labelKind?: 'identity' | 'plate'
  readonly confidence?: number
}

/**
 * The name drawn on a box, in the hub language.
 *
 * A class id — the coarse class, or a finer one riding `label` — is
 * {@link eventKindLabel}. An identity or a plate stays the word the
 * recogniser produced. A class the vocabulary does not know stays the wire
 * id, which is what `eventKindLabel` already returns.
 */
function imageBoxName(input: NcImageCaption, locale: EventKindLabelLocale): string {
  if (input.labelKind === 'identity' || input.labelKind === 'plate') {
    const written = input.label?.trim()
    if (written !== undefined && written.length > 0) return written
  }
  const label = input.label?.trim()
  if (label !== undefined && label.length > 0) {
    const key = label.toLowerCase()
    if (isEventKindLabelKey(key)) return eventKindLabel(key, locale)
    if (key !== input.className.trim().toLowerCase()) return label
  }
  return eventKindLabel(input.className, locale)
}

/** Class vocabulary in `locale`, plus confidence — the string the overlay draws. */
export function imageBoxCaption(input: NcImageCaption, locale: EventKindLabelLocale): string {
  return imageLabelText(imageBoxName(input, locale), input.confidence)
}

/** Stroke widths for an output of this size: the subject's is the thick one. */
export function overlayStrokes(
  width: number,
  height: number,
): {
  readonly subject: number
  readonly other: number
} {
  const subject = Math.max(4, Math.round(Math.min(width, height) / 110))
  return { subject, other: Math.max(2, Math.round(subject / 2.5)) }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function clampPx(value: number, max: number): number {
  return Math.max(0, Math.min(Math.round(value), max))
}

/** Scale a normalised box to an output of `width` × `height`, clamped inside it. */
function toPixels(
  box: NcNormBox,
  width: number,
  height: number,
): {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
} {
  const x = clampPx(box.x * width, width - 1)
  const y = clampPx(box.y * height, height - 1)
  const w = Math.max(1, Math.min(Math.round(box.w * width), width - x))
  const h = Math.max(1, Math.min(Math.round(box.h * height), height - y))
  return { x, y, w, h }
}

/** What is drawn over a picture of `width` × `height`. */
export interface NcOverlayInput {
  readonly width: number
  readonly height: number
  readonly boxes: readonly NcOverlayBox[]
  readonly zones: readonly NcZonePolygon[]
  /** Path runs already projected into THIS picture's 0..1 space. */
  readonly paths?: ReadonlyArray<readonly SubjectPathPoint[]>
  /** Class → palette hex. Absent: the bundled CamStack preset. */
  readonly paintClass?: (kind: string) => string
}

const BUNDLED_PALETTE = bundledCamstack()

function bundledPaint(kind: string): string {
  return paintHex(BUNDLED_PALETTE.swatches, BUNDLED_PALETTE.fallbacks, kind)
}

function boxStroke(
  box: NcOverlayBox | undefined,
  paint: ((kind: string) => string) | undefined,
): string {
  if (box?.className !== undefined && box.className.length > 0) {
    return (paint ?? bundledPaint)(box.className)
  }
  return box?.role === 'other' ? NC_IMAGE_OTHER_COLOR : NC_IMAGE_SUBJECT_COLOR
}

/** The overlay SVG and what became of its captions. */
export interface NcOverlay {
  readonly svg: string
  readonly labels: NcLabelCounts
}

/** {@link notificationOverlay}'s SVG alone. */
export function notificationOverlaySvg(input: NcOverlayInput): string {
  return notificationOverlay(input).svg
}

/**
 * The SVG drawn over a picture of `width` × `height`. The subject is drawn
 * LAST so a crowd never hides it. Captions sit on a dark plate, white text,
 * where `layoutBoxLabels` puts them — outside above, outside below, inside a
 * box only when it covers a thin band of it, never on another box or caption,
 * and nowhere at all rather than over the subject.
 */
function notificationOverlay(input: NcOverlayInput): NcOverlay {
  const { width, height } = input
  const strokes = overlayStrokes(width, height)
  const fontSize = Math.max(NC_LABEL_MIN_FONT_PX, Math.round(height / 36))
  const parts: string[] = []
  for (const zone of input.zones) {
    if (zone.length < 3) continue
    const points = zone
      .map((p) => `${String(clampPx(p.x * width, width))},${String(clampPx(p.y * height, height))}`)
      .join(' ')
    parts.push(
      `<polygon data-role="zone" points="${points}" fill="${NC_IMAGE_ZONE_COLOR}" fill-opacity="0.18" stroke="${NC_IMAGE_ZONE_COLOR}" stroke-width="${String(strokes.other)}" stroke-dasharray="${String(strokes.subject * 2)},${String(strokes.subject)}"/>`,
    )
  }
  const subjectBox = input.boxes.find((b) => b.role === 'subject')
  const pathColor = boxStroke(subjectBox, input.paintClass)
  for (const run of input.paths ?? []) {
    if (run.length < 2) continue
    parts.push(
      `<polyline data-role="subject-path" points="${subjectPathSvgPoints(run, width, height)}" fill="none" stroke="${pathColor}" stroke-width="${String(strokes.subject)}" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.9"/>`,
    )
  }
  const ordered = [
    ...input.boxes.filter((b) => b.role === 'other'),
    ...input.boxes.filter((b) => b.role === 'subject'),
  ]
  const layout = layoutBoxLabels({ width, height, fontSize, boxes: ordered })
  const plates: string[] = []
  ordered.forEach((box, i) => {
    const subject = box.role === 'subject'
    const color = boxStroke(box, input.paintClass)
    const stroke = subject ? strokes.subject : strokes.other
    parts.push(
      `<rect data-role="${box.role}" x="${String(box.x)}" y="${String(box.y)}" width="${String(box.w)}" height="${String(box.h)}" fill="none" stroke="${color}" stroke-width="${String(stroke)}"/>`,
    )
    const plate = layout.placements[i]
    if (plate === null || plate === undefined) return
    plates.push(
      `<rect data-role="${box.role}-plate" x="${String(plate.x)}" y="${String(plate.y)}" width="${String(plate.w)}" height="${String(plate.h)}" fill="#000000" fill-opacity="0.72" stroke="${color}" stroke-width="${String(subject ? 2 : 1)}"/>`,
      `<text data-role="${box.role}-label" x="${String(plate.x + Math.round(fontSize * 0.4))}" y="${String(plate.y + Math.round(plate.h * 0.75))}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${String(fontSize)}" font-weight="${subject ? '700' : '400'}" fill="#ffffff">${escapeXml(box.label)}</text>`,
    )
  })
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">${[...parts, ...plates].join('')}</svg>`,
    labels: { placed: layout.placed, dropped: layout.dropped },
  }
}

/** The pixel rectangle a `crop` cuts from a `width` × `height` frame, or null when too small. */
function subjectCropRect(
  box: NcNormBox,
  width: number,
  height: number,
): {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
} | null {
  const px = toPixels(box, width, height)
  const padX = Math.max(16, Math.round(px.w * NC_IMAGE_CROP_PAD))
  const padY = Math.max(16, Math.round(px.h * NC_IMAGE_CROP_PAD))
  const left = Math.max(0, px.x - padX)
  const top = Math.max(0, px.y - padY)
  const right = Math.min(width, px.x + px.w + padX)
  const bottom = Math.min(height, px.y + px.h + padY)
  if (right - left < 16 || bottom - top < 16) return null
  return { left, top, width: right - left, height: bottom - top }
}

function iou(a: NcNormBox, b: NcNormBox): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.w * a.h + b.w * b.h - inter
  return union <= 0 ? 0 : inter / union
}

/**
 * The tracks to draw thin: every track at the instant except the subject —
 * the same id, a box that is the subject's (a fused id reads under its
 * survivor's name), or a box of the subject's class over it past what NMS
 * lets two real subjects share (an unfused piece of the same subject).
 */
export function otherTracks(
  tracks: readonly NcTrackAtInstant[],
  subjectTrackId: string | undefined,
  subjectBox: NcNormBox | null,
  subjectClassName?: string,
): readonly NcTrackAtInstant[] {
  return tracks.filter((t) => {
    if (t.trackId === subjectTrackId) return false
    if (subjectBox === null) return true
    const overlap = iou(t.bbox, subjectBox)
    if (overlap >= SAME_SUBJECT_IOU) return false
    return !(t.className === subjectClassName && overlap >= NC_IMAGE_SAME_CLASS_SUBJECT_IOU)
  })
}

/**
 * What picture a ROW asks for. A row written since D897 carries `mediaImage`;
 * an older row (still in the outbox across the upgrade) is read through what
 * its legacy fields meant — the same mapping the rule migration applies.
 */
export function payloadImageMode(payload: NcOutboxPayload): NcMediaImage {
  if (payload.media === 'none') return 'none'
  if (payload.mediaImage !== undefined) return payload.mediaImage
  if (payload.mediaZoneIds !== undefined && payload.mediaZoneIds.length > 0) return 'clean'
  if (payload.mediaFrame === 'full') return 'clean'
  if (payload.mediaFrame === 'boxed') return 'scene-boxes'
  if (payload.mediaFrame === 'cropped') return 'crop'
  if (payload.media === 'keyFrame') return 'clean'
  return 'crop'
}

/**
 * The zone ids a row's picture outlines: the zone(s) THIS event triggered,
 * when it asked — never every zone the rule lists (a dog in Uscio drew Aiuola
 * too). A row that asked but froze no `matchedZoneIds` (written before the
 * field) draws none: an outline of a zone the subject never entered is a
 * picture that lies about its own reason.
 */
export function payloadZoneOverlayIds(payload: NcOutboxPayload): readonly string[] {
  if (payload.mediaShowTriggerZone === true) return payload.matchedZoneIds ?? []
  // A pre-D897 zone-crop row: its zone is drawn instead of cut.
  if (payload.mediaImage === undefined) return payload.mediaZoneIds ?? []
  return []
}

/** True when a row's picture draws the subject's path (D903). */
function payloadShowsSubjectPath(payload: NcOutboxPayload): boolean {
  return payload.mediaShowSubjectPath === true
}

/**
 * Which camera the primary still SHOWS, or `composite` when it is a composed
 * mosaic of several. A sensor row of a linked set names its cameras primary
 * first; in `each` mode the primary's still is that first camera's alone.
 */
export function primaryImageCamera(payload: NcOutboxPayload): number | 'composite' {
  const linked = payload.subject.linkedCameraIds
  if (linked === undefined || linked.length === 0) return payload.subject.deviceId
  if (linked.length > 1 && payload.subject.extraStills === undefined) return 'composite'
  return linked[0] ?? payload.subject.deviceId
}

/** True when the row's subject is a tracked subject (not a RAM photograph owner). */
function hasTrackedSubject(trackId: string | undefined): trackId is string {
  return trackId !== undefined && !isLinkedStillId(trackId) && !isStillShelfId(trackId)
}

// ── The renderer (sharp) ─────────────────────────────────────────────

function toArrayBufferBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength)
  out.set(buf)
  return out
}

/**
 * Render one picture from a clean JPEG. A `crop` with no box, and every
 * `clean`, are the scene with nothing drawn. Throws on undecodable bytes; the
 * stage turns that into the source shipped as it is.
 */
export async function renderNotificationImage(req: NcImageRenderRequest): Promise<NcRenderedImage> {
  const { default: sharp } = await import('sharp')
  const meta = await sharp(Buffer.from(req.bytes)).metadata()
  const srcW = meta.width ?? 0
  const srcH = meta.height ?? 0
  if (srcW === 0 || srcH === 0) throw new Error('source frame has no dimensions')
  if (req.mode === 'crop' && req.subject !== null) {
    const rect = subjectCropRect(req.subject, srcW, srcH)
    if (rect !== null) {
      const view: SubjectPathRect = {
        x: rect.left / srcW,
        y: rect.top / srcH,
        w: rect.width / srcW,
        h: rect.height / srcH,
      }
      const paths = projectSubjectPath(req.path ?? [], view)
      const cut = sharp(Buffer.from(req.bytes)).extract(rect).resize({
        width: NC_IMAGE_CROP_MAX_EDGE,
        height: NC_IMAGE_CROP_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      if (paths.length === 0) {
        const out = await cut.jpeg({ quality: JPEG_QUALITY }).toBuffer()
        return {
          bytes: toArrayBufferBytes(out),
          name: 'crop.jpg',
          rendered: 'crop',
        }
      }
      // The overlay must match the RESIZED crop exactly, so it is sized from
      // the cut itself rather than from a re-derivation of sharp's rounding.
      const { data, info } = await cut.raw().toBuffer({ resolveWithObject: true })
      const svg = notificationOverlaySvg({
        width: info.width,
        height: info.height,
        boxes: [],
        zones: [],
        paths,
      })
      const out = await sharp(data, {
        raw: {
          width: info.width,
          height: info.height,
          channels: info.channels,
        },
      })
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer()
      return {
        bytes: toArrayBufferBytes(out),
        name: 'crop.jpg',
        rendered: 'crop',
      }
    }
  }
  const scale = Math.min(1, NC_IMAGE_SCENE_MAX_WIDTH / srcW)
  const outW = Math.max(1, Math.round(srcW * scale))
  const outH = Math.max(1, Math.round(srcH * scale))
  const boxes: NcOverlayBox[] =
    req.mode === 'scene-boxes'
      ? [
          ...req.others.map((o) => ({
            ...toPixels(o, outW, outH),
            role: 'other' as const,
            label: o.label,
            ...(o.confidence !== undefined ? { score: o.confidence } : {}),
            ...(o.className !== undefined ? { className: o.className } : {}),
          })),
          ...(req.subject !== null
            ? [
                {
                  ...toPixels(req.subject, outW, outH),
                  role: 'subject' as const,
                  label: req.subject.label,
                  ...(req.subject.className !== undefined
                    ? { className: req.subject.className }
                    : {}),
                },
              ]
            : []),
        ]
      : []
  const zones = req.mode === 'crop' ? [] : req.zones
  const paths = projectSubjectPath(req.path ?? [], { x: 0, y: 0, w: 1, h: 1 })
  let pipeline = sharp(Buffer.from(req.bytes)).resize({
    width: outW,
    height: outH,
    fit: 'fill',
  })
  let labels: NcLabelCounts | undefined
  if (boxes.length > 0 || zones.length > 0 || paths.length > 0) {
    const overlay = notificationOverlay({
      width: outW,
      height: outH,
      boxes,
      zones,
      paths,
      ...(req.paintClass !== undefined ? { paintClass: req.paintClass } : {}),
    })
    if (boxes.length > 0) labels = overlay.labels
    pipeline = pipeline.composite([{ input: Buffer.from(overlay.svg), top: 0, left: 0 }])
  }
  const out = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer()
  const rendered = req.mode === 'scene-boxes' && boxes.length > 0 ? 'scene-boxes' : 'clean'
  return {
    bytes: toArrayBufferBytes(out),
    name: `${rendered}.jpg`,
    rendered,
    ...(labels !== undefined ? { labels } : {}),
  }
}

// ── The stage ────────────────────────────────────────────────────────

export interface NcImageStageDeps {
  readonly logger: IScopedLogger
  readonly now: () => number
  /** The subject's normalised trail — `NcDispatcherDeps.getSubjectTrail`. */
  readonly getSubjectTrail?: (
    deviceId: number,
    trackId: string,
  ) => Promise<readonly NcSubjectTrailPoint[]>
  /** Every track visible on a camera at an instant — `NcDispatcherDeps.getTracksAt`. */
  readonly getTracksAt?: (
    deviceId: number,
    timestamp: number,
    toleranceMs: number,
  ) => Promise<readonly NcTrackAtInstant[]>
  readonly getZonePolygons?: (
    deviceId: number,
    zoneIds: readonly string[],
  ) => Promise<ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>>
  /** Class → palette hex. Absent: the bundled CamStack preset (D939). */
  readonly paintClass?: (kind: string) => string
  /** The renderer — {@link renderNotificationImage} unless a spec counts calls. */
  readonly render?: (req: NcImageRenderRequest) => Promise<NcRenderedImage>
}

/** One picture the stage is asked for. */
export interface NcImageStageInput {
  readonly entry: NcOutboxEntry
  readonly source: NcImageSource
  /** The camera the source frame SHOWS (a sensor row's linked camera), or a composite. */
  readonly camera: number | 'composite'
  /** False for a linked camera's extra still: no subject of its own on that camera. */
  readonly withSubject: boolean
  /**
   * The hub's notification language. Every target of a row shares it — there
   * is no per-recipient locale — and it is part of the memo key so a language
   * change does not reuse a picture captioned in the previous one.
   */
  readonly locale?: EventKindLabelLocale
}

interface MemoEntry {
  readonly at: number
  readonly value: Promise<NcRenderedImage>
}

export class NcNotificationImageStage {
  private readonly memo = new Map<string, MemoEntry>()
  private readonly render: (req: NcImageRenderRequest) => Promise<NcRenderedImage>

  constructor(private readonly deps: NcImageStageDeps) {
    this.render = deps.render ?? renderNotificationImage
  }

  /** Rendered pictures currently held (spec + diagnostics). */
  size(): number {
    return this.memo.size
  }

  /**
   * The picture for this row from this source, rendered once per record +
   * subject + mode + zone flag + camera + language and reused for every
   * target and retry. Null when the row ships no still.
   */
  async notificationImage(input: NcImageStageInput): Promise<NcRenderedImage | null> {
    const payload = input.entry.payload
    const mode = payloadImageMode(payload)
    if (mode === 'none') return null
    const zoneIds = input.withSubject ? payloadZoneOverlayIds(payload) : []
    const withPath = input.withSubject && payloadShowsSubjectPath(payload)
    const locale = input.locale ?? 'en'
    const key = [
      input.entry.recordId,
      payload.subject.trackId ?? '',
      mode,
      zoneIds.length > 0 ? 'z' : '-',
      withPath ? 'p' : '-',
      String(input.camera),
      locale,
    ].join('|')
    const now = this.deps.now()
    const hit = this.memo.get(key)
    if (hit !== undefined && now - hit.at <= NC_IMAGE_MEMO_TTL_MS) {
      this.memo.delete(key)
      this.memo.set(key, hit)
      return hit.value
    }
    const value = this.compute(input, mode, zoneIds, withPath)
    this.remember(key, { at: now, value })
    // A failed render is not remembered: the next target tries again.
    value.then(
      (image) => {
        if (image.reason === 'render-failed') this.memo.delete(key)
      },
      () => this.memo.delete(key),
    )
    return value
  }

  private remember(key: string, entry: MemoEntry): void {
    const now = this.deps.now()
    for (const [k, v] of this.memo) {
      if (now - v.at > NC_IMAGE_MEMO_TTL_MS) this.memo.delete(k)
    }
    while (this.memo.size >= NC_IMAGE_MEMO_MAX) {
      const oldest = this.memo.keys().next()
      if (oldest.done === true) break
      this.memo.delete(oldest.value)
    }
    this.memo.set(key, entry)
  }

  private async compute(
    input: NcImageStageInput,
    mode: Exclude<NcMediaImage, 'none'>,
    zoneIds: readonly string[],
    withPath: boolean,
  ): Promise<NcRenderedImage> {
    const { entry, source, camera } = input
    const payload = entry.payload
    // An annotated source already shows a box: drawing more, or cutting it,
    // would be a second opinion over the first. It ships as stored.
    if (source.annotated) {
      return this.asStored(input, mode, 'annotated-source')
    }
    if (camera === 'composite') {
      return mode === 'clean'
        ? this.asStored(input, mode)
        : this.asStored(input, mode, 'composite-source')
    }
    const subjectTrackId = input.withSubject ? payload.subject.trackId : undefined
    const trail = hasTrackedSubject(subjectTrackId)
      ? await this.subjectTrail(camera, subjectTrackId)
      : []
    const subjectBox = trailAt(trail, source.timestamp, NC_IMAGE_BOX_MATCH_MAX_MS)?.bbox ?? null
    const path = withPath ? this.subjectPath(input, trail) : []
    const locale = input.locale ?? 'en'
    const subject =
      subjectBox !== null
        ? {
            ...subjectBox,
            label: imageBoxCaption(
              {
                className: payload.subject.className,
                ...(payload.subject.label !== undefined ? { label: payload.subject.label } : {}),
                ...(payload.subject.labelKind !== undefined
                  ? { labelKind: payload.subject.labelKind }
                  : {}),
                ...(payload.subject.confidence !== undefined
                  ? { confidence: payload.subject.confidence }
                  : {}),
              },
              locale,
            ),
            className: payload.subject.className,
          }
        : null
    const othersDrawn =
      mode === 'scene-boxes'
        ? otherTracks(
            await this.tracksAt(camera, source.timestamp),
            subjectTrackId,
            subjectBox,
            payload.subject.className,
          )
        : []
    if (mode === 'scene-boxes') {
      this.deps.logger.info('scene-boxes: other boxes drawn', {
        tags: { deviceId: camera },
        meta: {
          ruleId: entry.ruleId,
          recordId: entry.recordId,
          instant: source.timestamp,
          drawn: othersDrawn
            .map(
              (t) =>
                `${t.trackId}/${t.className}/dt=${t.dtMs ?? '?'}ms/${t.interpolated === true ? 'interpolated' : 'exact'}`,
            )
            .join(','),
        },
      })
    }
    const others =
      mode === 'scene-boxes'
        ? othersDrawn.map((t) => ({
            ...t.bbox,
            label: imageBoxCaption(
              {
                className: t.className,
                ...(t.label !== undefined ? { label: t.label } : {}),
                ...(t.confidence !== undefined ? { confidence: t.confidence } : {}),
              },
              locale,
            ),
            className: t.className,
            ...(t.confidence !== undefined ? { confidence: t.confidence } : {}),
          }))
        : []
    if (
      mode !== 'crop' &&
      input.withSubject &&
      payload.mediaShowTriggerZone === true &&
      payload.matchedZoneIds === undefined
    ) {
      // Once per picture (this runs once per memo key): unknown draws nothing,
      // never every zone the rule lists.
      this.deps.logger.info('trigger zone not drawn — the row never froze which zone fired', {
        tags: { deviceId: camera },
        meta: {
          ruleId: entry.ruleId,
          recordId: entry.recordId,
          ruleZoneIds: (payload.triggerZoneIds ?? []).join(','),
        },
      })
    }
    const zones =
      mode === 'crop' || zoneIds.length === 0 ? [] : await this.zonePolygons(camera, zoneIds)
    try {
      const image = await this.render({
        mode,
        bytes: source.bytes,
        subject,
        others,
        zones,
        ...(path.length > 0 ? { path } : {}),
        ...(this.deps.paintClass !== undefined ? { paintClass: this.deps.paintClass } : {}),
      })
      const reason: NcImageFallbackReason | undefined =
        image.rendered === mode
          ? undefined
          : mode === 'crop'
            ? 'no-subject-box'
            : 'no-tracks-at-instant'
      if (reason !== undefined) this.reportFallback(input, mode, reason)
      if (image.labels !== undefined) this.reportLabels(input, image.labels)
      return reason !== undefined ? { ...image, reason } : image
    } catch (err) {
      this.deps.logger.warn('notification picture render failed — shipping the source frame', {
        tags: { deviceId: camera },
        meta: {
          ruleId: entry.ruleId,
          recordId: entry.recordId,
          asked: mode,
          kind: source.kind,
          error: String(err),
        },
      })
      return {
        bytes: source.bytes,
        name: `${source.kind}.jpg`,
        rendered: 'clean',
        reason: 'render-failed',
      }
    }
  }

  private asStored(
    input: NcImageStageInput,
    mode: Exclude<NcMediaImage, 'none'>,
    reason?: NcImageFallbackReason,
  ): NcRenderedImage {
    if (reason !== undefined) this.reportFallback(input, mode, reason)
    return {
      bytes: input.source.bytes,
      name: `${input.source.kind}.jpg`,
      rendered: input.source.annotated ? 'scene-boxes' : 'clean',
      ...(reason !== undefined ? { reason } : {}),
    }
  }

  /** ONE line per rendered record (the memo makes it so): what was asked, what ships, why. */
  private reportFallback(
    input: NcImageStageInput,
    asked: Exclude<NcMediaImage, 'none'>,
    reason: NcImageFallbackReason,
  ): void {
    const camera =
      input.camera === 'composite' ? input.entry.payload.subject.deviceId : input.camera
    this.deps.logger.info('notification picture shipped without the mode the rule asked for', {
      tags: { deviceId: camera },
      meta: {
        ruleId: input.entry.ruleId,
        recordId: input.entry.recordId,
        ...(input.entry.payload.subject.trackId !== undefined
          ? { trackId: input.entry.payload.subject.trackId }
          : {}),
        asked,
        reason,
        kind: input.source.kind,
        offsetMs: input.source.timestamp - input.entry.payload.subject.timestamp,
      },
    })
  }

  /** ONE line per rendered picture: how many captions it carries and how many had no clear spot. */
  private reportLabels(input: NcImageStageInput, labels: NcLabelCounts): void {
    const camera =
      input.camera === 'composite' ? input.entry.payload.subject.deviceId : input.camera
    this.deps.logger.debug('notification picture captions laid out', {
      tags: { deviceId: camera },
      meta: {
        ruleId: input.entry.ruleId,
        recordId: input.entry.recordId,
        placed: labels.placed,
        dropped: labels.dropped,
      },
    })
  }

  /** The subject's trail, read once per render for its box AND its path. */
  private async subjectTrail(
    camera: number,
    trackId: string,
  ): Promise<readonly NcSubjectTrailPoint[]> {
    const read = this.deps.getSubjectTrail
    if (read === undefined) return []
    try {
      return await read(camera, trackId)
    } catch (err) {
      this.deps.logger.debug('subject trail read failed — no subject box or path on the picture', {
        tags: { deviceId: camera },
        meta: { trackId, error: String(err) },
      })
      return []
    }
  }

  /**
   * The subject's path up to the frame shown, normalised in that frame, or
   * empty when the trail has fewer than two drawable points — then the
   * picture ships without it, and the line below says so (D400: a branch
   * that produces nothing names why).
   */
  private subjectPath(
    input: NcImageStageInput,
    trail: readonly NcSubjectTrailPoint[],
  ): readonly SubjectPathPoint[] {
    const path = buildSubjectPath(
      trail.map((p) => subjectPathSampleFromBox(p.bbox, p.timestamp)),
      { untilTimestamp: input.source.timestamp },
    )
    if (isDrawableSubjectPath(path)) return path.nodes.map((n) => ({ x: n.x, y: n.y }))
    const camera =
      input.camera === 'composite' ? input.entry.payload.subject.deviceId : input.camera
    this.deps.logger.debug('subject path not drawn — fewer than two trail points', {
      tags: { deviceId: camera },
      meta: {
        ruleId: input.entry.ruleId,
        recordId: input.entry.recordId,
        trailPoints: trail.length,
        nodes: path.nodes.length,
        unlocalized: path.unlocalized,
      },
    })
    return []
  }

  private async tracksAt(camera: number, timestamp: number): Promise<readonly NcTrackAtInstant[]> {
    const read = this.deps.getTracksAt
    if (read === undefined) return []
    try {
      return await read(camera, timestamp, NC_IMAGE_BOX_MATCH_MAX_MS)
    } catch (err) {
      this.deps.logger.debug('tracks-at-instant read failed — no other boxes on the picture', {
        tags: { deviceId: camera },
        meta: { timestamp, error: String(err) },
      })
      return []
    }
  }

  private async zonePolygons(
    camera: number,
    zoneIds: readonly string[],
  ): Promise<readonly NcZonePolygon[]> {
    const read = this.deps.getZonePolygons
    if (read === undefined) return []
    try {
      return await read(camera, zoneIds)
    } catch (err) {
      this.deps.logger.debug('zone polygon read failed — the trigger zone is not drawn', {
        tags: { deviceId: camera },
        meta: { zoneIds: zoneIds.join(','), error: String(err) },
      })
      return []
    }
  }
}
