/**
 * The SYNTHETIC producer — the third caller of the intake seam
 * (`event-intake.ts`), and the proof that the seam is real.
 *
 * It builds an {@link NcIncomingEvent} out of what an operator typed and hands
 * it to the same `consumeEvent` the tracker and the sensor ingest call. It
 * persists NOTHING: no track row, no object-event row, no sensor row, no media
 * blob. That is not a limitation of the tester, it is the contract the seam
 * draws — persistence belongs to the producer, and this producer's answer is
 * "none".
 *
 * What it DOES produce is a real still: a live snapshot of the camera, taken at
 * injection time, held in RAM for the few minutes the outbox needs to drain and
 * served to the dispatcher through the ordinary media-owner lookup. The
 * dispatcher therefore runs its ordinary ladder — it is not told the event is
 * synthetic and has no branch for it.
 *
 * Everything here is pure except {@link deriveSyntheticMedia}, which shells out
 * to sharp for the crop and the drawn box.
 */

import type { MediaFileBytes, MediaFileKind } from '@camstack/types'
import { NcSystemEventKindSchema } from '@camstack/types'
import { z } from 'zod'
import type { BboxRect } from '../pipeline-analytics/pipeline/zones/geometry.js'
import type { NcIncomingEvent, NcIntakeControls } from './event-intake.js'
import { NC_SYSTEM_DEVICE_ID, type NcRuleSubject, type NcSubjectKind } from './rule-engine.js'
import { nextUnstoredMediaId } from './unstored-media-id.js'

/** Normalized 0..1 rectangle, top-left origin — the subject bbox space. */
const BboxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
})

/**
 * Which trigger to simulate. One value per {@link NcSubjectKind}, because the
 * kind is what decides the delivery a rule must declare to be a candidate at
 * all — picking the wrong one is the single most common reason an operator's
 * rule "does not fire", and making it an explicit choice is half the point of
 * the tester.
 *
 * It is now EVERY kind, without exception, because the per-rule Test button
 * (`nc.testRule`) plans its injection from the rule and must be able to test
 * any rule an operator can author. The two that arrived last are the two whose
 * rules were previously untestable end-to-end: a SOUND rule fires only on a
 * confirmed sampling window (`audio-window`, not the single classified sample
 * `audio-event` stands for), and a SYSTEM rule fires on no record at all.
 */
const TriggerSchema = z.enum([
  'object-event',
  'track-end',
  'device-event',
  'package-event',
  'audio-event',
  'audio-window',
  'occupancy-event',
  'system-event',
])

/**
 * What the operator typed. Every field maps onto exactly one field of
 * {@link NcRuleSubject} — there is no test-only condition input, because a
 * condition the tester could set and a real record could not is a condition the
 * test result would lie about.
 */
export const NcTestEventInputSchema = z.object({
  trigger: TriggerSchema,
  /** The CAMERA the event is attributed to (what a notification shows). */
  deviceId: z.number().int(),
  /** DEVICE-EVENT: the linked device whose state changed — the contact, the
   *  button, the doorbell — when that is not the camera. */
  sourceDeviceId: z.number().int().optional(),
  /** Detection class ids, from the NC taxonomy (`person`, `car`, `audio-…`). */
  classNames: z.array(z.string()).default([]),
  /** Collapsed display label — an identity name, a plate, a subclass. */
  label: z.string().optional(),
  /** Detection confidence [0,1]. ABSENT is meaningful: a `minConfidence`
   *  condition FAILS on an absent confidence, and the tester must be able to
   *  reproduce that. */
  confidence: z.number().min(0).max(1).optional(),
  /** Identity/plate MATCH confidence — distinct from `confidence`. */
  labelConfidence: z.number().min(0).max(1).optional(),
  /** Key-event importance [0,1] (track-end only, in practice). */
  importance: z.number().min(0).max(1).optional(),
  /** Track lifespan in seconds (track-end only). */
  dwellSeconds: z.number().min(0).optional(),
  /** Admin zone ids the subject is in (object) / visited (track). */
  zones: z.array(z.string()).default([]),
  /** OBJECT-EVENT: simulate a confirmed zone crossing. */
  crossing: z.object({ zoneId: z.string(), direction: z.enum(['enter', 'exit']) }).optional(),
  /** DEVICE-EVENT: the taxonomy kind id (`doorbell`, `contact`, `button`, …). */
  sensorKind: z.string().optional(),
  /** DEVICE-EVENT: the raw device event-type token, when the source is an
   *  event-emitter slice. */
  eventType: z.string().optional(),
  /** DEVICE-EVENT: which edge a boolean sensor moved on — true raised, false
   *  cleared (D640). Absent = the slice could not say, which production
   *  answers for a doorbell press or an unreadable read. */
  sensorRaised: z.boolean().optional(),
  /** PACKAGE-EVENT: which lifecycle phase. */
  packagePhase: z.enum(['delivered', 'picked-up']).optional(),
  /** Detection provenance. Absent = `pipeline` (what a record with no stamped
   *  source reads as). */
  source: z.enum(['pipeline', 'onboard', 'sensor', 'audio']).optional(),
  /** Normalized bbox — feeds `customZones`, AND is what lets the still be
   *  cropped / boxed the way the rule's media policy asks. */
  bbox: BboxSchema.optional(),
  /** OCCUPANCY-EVENT: the committed count edge. */
  occupancy: z
    .object({
      zoneId: z.string().optional(),
      zoneName: z.string().optional(),
      className: z.string().optional(),
      count: z.number().int().min(0),
      previousCount: z.number().int().min(0).default(0),
      occupied: z.boolean(),
      threshold: z.number().int().min(1),
    })
    .optional(),
  /**
   * AUDIO: the confirmed match, in the MODE the rule is in (D157).
   *
   * Every field of the engine's {@link NcAudioWindowSubject}, because
   * `matchesAudio` pairs a rule to the evidence that BELONGS to it — the spec
   * fields (the labels in label mode; `samplingSeconds` + `dbThreshold` in
   * level mode) are compared for equality, so a match built from anything but
   * the rule's own condition fails closed and the test would report a working
   * rule as broken. The discriminant is required: a payload that does not say
   * which mode it is cannot be paired with anything.
   */
  audioWindow: z
    .discriminatedUnion('mode', [
      z.object({
        mode: z.literal('label'),
        specLabels: z.array(z.string().min(1)).min(1),
        labels: z.array(z.string().min(1)).default([]),
        peakDbfs: z.number().optional(),
      }),
      z.object({
        mode: z.literal('level'),
        hitPercent: z.number().min(0).max(100),
        samplingSeconds: z.number().int().min(1).max(300),
        samples: z.number().int().min(0),
        hits: z.number().int().min(0),
        dbThreshold: z.number(),
        peakDbfs: z.number().optional(),
        labels: z.array(z.string().min(1)).default([]),
      }),
    ])
    .optional(),
  /**
   * SYSTEM-EVENT: the normalized infrastructure event.
   *
   * The catalog KEYS travel, never the sentence — exactly as the live intake
   * freezes them (`event-intake.ts`), so a tested system notification is
   * worded by the same text catalog, in the same language, as the real one. A
   * tester that froze English prose here would be testing its own prose.
   */
  systemEvent: z
    .object({
      kind: NcSystemEventKindSchema,
      /** The dedup subject (`device:102`, `node:agent-1`, …). */
      subject: z.string().min(1),
      titleKey: z.string().min(1),
      bodyKey: z.string().min(1),
      textParams: z.record(z.string(), z.string()).default({}),
      /** The device the event is ABOUT; absent = an event with no device. */
      deviceId: z.number().int().optional(),
      /** `DeviceType` value — what a `deviceTypes` condition is judged against. */
      deviceType: z.string().min(1).optional(),
      nodeId: z.string().min(1).optional(),
      packageName: z.string().min(1).optional(),
    })
    .optional(),
  /** The instant the event happened. Absent = now. Set it to test a schedule
   *  condition without waiting for the hour. */
  timestamp: z.number().int().optional(),

  // ── Side gates (never conditions — see NcIntakeControls) ──────────
  /** Evaluate only this rule (what the per-rule Test button sends). */
  onlyRuleId: z.string().optional(),
  bypassCooldown: z.boolean().default(false),
  bypassMute: z.boolean().default(false),
  /** Run the matched rule's `onTrigger` sequences. OFF by default: a test must
   *  not open a gate the operator did not ask to open. */
  runActions: z.boolean().default(false),
  /** Where the still comes from. `live` takes a snapshot of the camera NOW;
   *  `none` sends the notification without one. */
  still: z.enum(['live', 'none']).default('live'),
})
export type NcTestEventInput = z.infer<typeof NcTestEventInputSchema>

/** Per-rule verdict, as the tester reports it. */
const NcTestEventRuleOutcomeSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  matched: z.boolean(),
  failedCondition: z.string().optional(),
  matchedOn: z.array(z.string()).optional(),
  cooldown: z.enum(['n/a', 'clear', 'suppressed', 'bypassed']),
  enqueued: z.number().int(),
  targetIds: z.array(z.string()),
})

export const NcTestEventResultSchema = z.object({
  /** The synthetic record id. It is `synthetic:<uuid>` and it is what to grep
   *  for in the logs, in the outbox and in the delivery history. */
  recordId: z.string(),
  /** Always `synthetic` — the marker the whole path carried. */
  origin: z.literal('synthetic'),
  /** The delivery the chosen trigger rides. A rule declaring anything else was
   *  never a candidate, which is the answer to most "it did not fire". */
  delivery: z.string(),
  candidates: z.number().int(),
  outcomes: z.array(NcTestEventRuleOutcomeSchema),
  /** What the still ended up being. `unattachable` means the chosen TRIGGER
   *  cannot carry one at all — an audio episode freezes no media owner, so
   *  those notifications ship text-only in production too, and that is a
   *  property of production, not of the test. A DEVICE event is no longer one
   *  of them (its press projects a marker track that owns the frame), and
   *  neither is an OCCUPANCY edge (it names one of the member tracks it
   *  counted). */
  still: z.enum(['live', 'none', 'unavailable', 'unattachable']),
  /** Everything the operator has to know to read the result honestly. */
  notes: z.array(z.string()),
  droppedBy: z.string().optional(),
})
export type NcTestEventResult = z.infer<typeof NcTestEventResultSchema>

/** The id shape every synthetic record carries. One prefix, everywhere. */
export const SYNTHETIC_ID_PREFIX = 'synthetic:'

/** True for a record id this module minted. Used by the media shim. */
export function isSyntheticId(id: string): boolean {
  return id.startsWith(SYNTHETIC_ID_PREFIX)
}

/**
 * Whether a subject of this kind can carry a still AT ALL, in production.
 *
 * The attachment ladder resolves media by OWNER, and `buildEntries` freezes an
 * owner onto the payload only for the kinds that have one:
 *
 *  - an `eventId` for object and package events;
 *  - a `trackId` for track-scoped ones — and, since 2026-08-08, for a
 *    DEVICE event too: the same state change projects a synthetic marker track
 *    carrying the camera's frame (`sensor-marker-projector.ts`), and the
 *    notification names it as its owner. An OCCUPANCY edge joins them: the
 *    snapshot that produced it lists the members being counted and the edge
 *    names one (`chooseOccupancyMediaOwner`), so the tester stands in for that
 *    member exactly as it stands in for the marker.
 *  - and, since 2026-08-15, a `trackId` for both AUDIO kinds: a sound owns no
 *    frame, so production photographs the camera at the match and holds the
 *    bytes on the still shelf under an owner id the subject names
 *    (`still-shelf.ts`). The tester's RAM-held frame stands in for exactly that
 *    photograph, and — unlike every other kind here — it is taken the same way
 *    production takes it, at the same moment, from the same cap.
 *
 * Only `system-event` remains: an infrastructure event is about no camera at
 * all, so there is nothing to photograph and a tester that invented a picture
 * for it would be advertising a feature that does not exist.
 */
export function triggerCanCarryStill(kind: NcSubjectKind): boolean {
  return kind !== 'system-event'
}

/** The detection provenance production stamps on a subject of this kind. */
function syntheticSource(kind: NcSubjectKind): NcRuleSubject['source'] {
  if (kind === 'device-event') return 'sensor'
  if (kind === 'audio-window') return 'audio'
  return 'pipeline'
}

/**
 * Copy the wire payload onto the engine's audio subject. One arm per mode,
 * because the two carry different evidence — see D157.
 */
function audioSubjectOf(
  input: NonNullable<NcTestEventInput['audioWindow']>,
): NonNullable<NcRuleSubject['audioWindow']> {
  if (input.mode === 'label') {
    return {
      mode: 'label',
      specLabels: input.specLabels,
      labels: input.labels,
      ...(input.peakDbfs !== undefined ? { peakDbfs: input.peakDbfs } : {}),
    }
  }
  return {
    mode: 'level',
    hitPercent: input.hitPercent,
    samplingSeconds: input.samplingSeconds,
    samples: input.samples,
    hits: input.hits,
    dbThreshold: input.dbThreshold,
    ...(input.peakDbfs !== undefined ? { peakDbfs: input.peakDbfs } : {}),
    labels: input.labels,
  }
}

/**
 * Build the synthetic envelope. Pure: same input + same id + same clock ⇒ same
 * event, so the red-green test can assert that this subject and a
 * producer-built one are indistinguishable.
 */
export function buildSyntheticEvent(
  input: NcTestEventInput,
  recordId: string,
  now: number,
): NcIncomingEvent {
  const kind: NcSubjectKind = input.trigger
  const timestamp = input.timestamp ?? now
  // Track-scoped kinds own a trackId; it doubles as the media owner and as the
  // outbox dedup key, so it must be unique per injection or a second test of
  // the same rule would be deduped into silence.
  //
  // A DEVICE event carries one too, and for the media-owner half only: in
  // production the press projects a synthetic marker track and the notification
  // names it (`subjectFromSensorEvent`), so the tester's record stands in for
  // exactly that marker. The dedup half is unaffected — `buildEntries` keys a
  // device event on its record id, not on a track. An OCCUPANCY edge is the
  // same case: production names one of the counted member tracks, so the
  // tester's record stands in for that member. An AUDIO kind is the third:
  // production photographs the camera at the match and names the still shelf's
  // owner id (`still-shelf.ts`), so the tester's record stands in for that
  // photograph.
  const carriesTrackId =
    kind === 'object-event' ||
    kind === 'track-end' ||
    kind === 'device-event' ||
    kind === 'occupancy-event' ||
    kind === 'audio-event' ||
    kind === 'audio-window'
  const subject: NcRuleSubject = {
    kind,
    recordId,
    // A system event is not about a camera: the live intake files it under the
    // reserved device id and carries the real device (when there is one) inside
    // `systemEvent.deviceId`, which is what a `deviceIds` condition reads. A
    // tester that put the camera at the top level would satisfy a scope the
    // live event never satisfies.
    deviceId: kind === 'system-event' ? NC_SYSTEM_DEVICE_ID : input.deviceId,
    ...(input.sourceDeviceId !== undefined && input.sourceDeviceId !== input.deviceId
      ? { sourceDeviceId: input.sourceDeviceId }
      : {}),
    timestamp,
    classNames: input.classNames,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    zones: input.zones,
    ...(carriesTrackId ? { trackId: recordId } : {}),
    // The provenance PRODUCTION stamps for this kind, when the operator has not
    // said otherwise: a sensor row is `sensor`, a confirmed sampling window is
    // `audio` (`subjectFromAudioWindow`), everything else is a pipeline product.
    // Guessing wrong here makes a `source`-scoped rule match a test the live
    // event could never satisfy.
    source: input.source ?? syntheticSource(kind),
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
    ...(input.dwellSeconds !== undefined ? { dwellSeconds: input.dwellSeconds } : {}),
    ...(input.labelConfidence !== undefined ? { labelConfidence: input.labelConfidence } : {}),
    ...(input.sensorKind !== undefined ? { sensorKind: input.sensorKind } : {}),
    ...(input.eventType !== undefined ? { eventType: input.eventType } : {}),
    ...(input.sensorRaised !== undefined ? { sensorRaised: input.sensorRaised } : {}),
    ...(input.packagePhase !== undefined ? { packagePhase: input.packagePhase } : {}),
    ...(input.bbox !== undefined ? { bbox: input.bbox } : {}),
    ...(input.crossing !== undefined ? { crossing: input.crossing } : {}),
    ...(input.audioWindow !== undefined ? { audioWindow: audioSubjectOf(input.audioWindow) } : {}),
    ...(input.systemEvent !== undefined
      ? {
          systemEvent: {
            kind: input.systemEvent.kind,
            subject: input.systemEvent.subject,
            titleKey: input.systemEvent.titleKey,
            bodyKey: input.systemEvent.bodyKey,
            textParams: input.systemEvent.textParams,
            ...(input.systemEvent.deviceId !== undefined
              ? { deviceId: input.systemEvent.deviceId }
              : {}),
            ...(input.systemEvent.deviceType !== undefined
              ? { deviceType: input.systemEvent.deviceType }
              : {}),
            ...(input.systemEvent.nodeId !== undefined ? { nodeId: input.systemEvent.nodeId } : {}),
            ...(input.systemEvent.packageName !== undefined
              ? { packageName: input.systemEvent.packageName }
              : {}),
            data: { category: 'synthetic.test' },
          },
        }
      : {}),
    ...(input.occupancy !== undefined
      ? {
          occupancy: {
            ...(input.occupancy.zoneId !== undefined ? { zoneId: input.occupancy.zoneId } : {}),
            ...(input.occupancy.zoneName !== undefined
              ? { zoneName: input.occupancy.zoneName }
              : {}),
            ...(input.occupancy.className !== undefined
              ? { className: input.occupancy.className }
              : {}),
            count: input.occupancy.count,
            previousCount: input.occupancy.previousCount,
            occupied: input.occupancy.occupied,
            threshold: input.occupancy.threshold,
          },
        }
      : {}),
  }

  const controls: NcIntakeControls = {
    ...(input.onlyRuleId !== undefined ? { onlyRuleId: input.onlyRuleId } : {}),
    bypassCooldown: input.bypassCooldown,
    bypassMute: input.bypassMute,
    // A synthetic event is always closed at once (D692 §10): the operator has no say.
    closeWindowImmediately: true,
    runActions: input.runActions,
  }

  return {
    subject,
    kind,
    origin: 'synthetic',
    controls,
    log: () => ({
      tags: { deviceId: input.deviceId },
      meta: {
        eventId: recordId,
        synthetic: true,
        trigger: input.trigger,
        ...(input.onlyRuleId !== undefined ? { onlyRuleId: input.onlyRuleId } : {}),
      },
    }),
  }
}

/**
 * Turn one live JPEG into the media set the dispatcher's ladders look for.
 *
 * Every entry is the SAME photograph, differing only in how it was cut — which
 * is exactly what the ladders mean by their kind names, so nothing here claims
 * a frame it does not have:
 *
 *   - `fullFrame` / `keyFrame` / `firstFrame` — the clean scene, verbatim.
 *   - `fullFrameBoxed` — the clean scene with the operator's bbox drawn on it.
 *   - `crop` / `thumbnail` — that bbox, cut out.
 *
 * With NO bbox only the clean-scene kinds are produced, so a rule asking for
 * `frame: 'cropped'` correctly finds nothing rather than being handed a whole
 * scene it did not ask for. sharp failures degrade the same way: the clean
 * scene always survives.
 */
export async function deriveSyntheticMedia(
  jpeg: Uint8Array,
  bbox: BboxRect | undefined,
  timestamp: number,
): Promise<readonly MediaFileBytes[]> {
  const base64 = Buffer.from(jpeg).toString('base64')
  const clean = (kind: MediaFileKind): MediaFileBytes => ({
    mediaId: nextUnstoredMediaId(),
    kind,
    base64,
    sizeBytes: jpeg.byteLength,
    timestamp,
  })
  const files: MediaFileBytes[] = [clean('fullFrame'), clean('keyFrame'), clean('firstFrame')]
  if (bbox === undefined) return files

  try {
    const { default: sharp } = await import('sharp')
    const meta = await sharp(Buffer.from(jpeg)).metadata()
    const W = meta.width ?? 0
    const H = meta.height ?? 0
    if (W === 0 || H === 0) return files
    const left = Math.max(0, Math.min(W - 1, Math.floor(bbox.x * W)))
    const top = Math.max(0, Math.min(H - 1, Math.floor(bbox.y * H)))
    const width = Math.max(1, Math.min(W - left, Math.ceil(bbox.w * W)))
    const height = Math.max(1, Math.min(H - top, Math.ceil(bbox.h * H)))

    const cropBuf = await sharp(Buffer.from(jpeg))
      .extract({ left, top, width, height })
      .jpeg({ quality: 85 })
      .toBuffer()
    const cropB64 = cropBuf.toString('base64')
    files.push(
      {
        mediaId: nextUnstoredMediaId(),
        kind: 'crop',
        base64: cropB64,
        sizeBytes: cropBuf.byteLength,
        timestamp,
      },
      {
        mediaId: nextUnstoredMediaId(),
        kind: 'thumbnail',
        base64: cropB64,
        sizeBytes: cropBuf.byteLength,
        timestamp,
      },
    )

    const stroke = Math.max(2, Math.round(Math.min(W, H) / 240))
    const overlay = Buffer.from(
      `<svg width="${W}" height="${H}"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="none" stroke="#22d3ee" stroke-width="${stroke}"/></svg>`,
    )
    const boxedBuf = await sharp(Buffer.from(jpeg))
      .composite([{ input: overlay, top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toBuffer()
    files.push({
      mediaId: nextUnstoredMediaId(),
      kind: 'fullFrameBoxed',
      base64: boxedBuf.toString('base64'),
      sizeBytes: boxedBuf.byteLength,
      timestamp,
    })
  } catch {
    // The clean scene is already in `files` — a failed cut costs the crop, never
    // the still. The caller logs; this must not throw into an injection.
    return files
  }
  return files
}
