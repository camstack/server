/**
 * A sensor notification of a LINKED SET (ADR 0632) at the dispatcher.
 *
 * The evaluation froze shelf owners onto the row (Task 5); here they turn into
 * what ships and what the model reads:
 *  - `each`: the primary still, the primary's footage (its precedence is
 *    unchanged), THEN one image per OTHER linked camera, in camera order — the
 *    degrade engine drops by position, so a small target keeps the primary's
 *    still and footage and the other cameras fill whatever room is left;
 *  - each extra still names the camera the SHELF photographed, carried on the
 *    row — never inferred from its index (a mute between capture and
 *    evaluation shifts the index);
 *  - an extra camera whose picture never landed is skipped and named on THAT
 *    camera — never a blank attachment;
 *  - the artefact is indexed against every linked camera;
 *  - the narration model reads the RAW tiles, never the mosaic; the confirm
 *    gate keeps its single-image contract and judges the image that ships.
 */

import {
  type IScopedLogger,
  type MediaFile,
  prepareNotification,
  type TargetKindCaps,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { withNcNotificationFormat } from './support/nc-test-deps.js'
import type { NcArtifactPublishMeta } from '../artifact-index.js'
import type { NcConfirmGateInput } from '../confirm-gate.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxConfirmVerdict, NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import type { NcRuleAiInput, NcRuleAiOutcome } from '../rule-ai-analyst.js'

const T0 = 1_753_000_000_000

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly msg: string
  readonly deviceId: unknown
  readonly meta: Record<string, unknown>
}

interface LogExtras {
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

function makeRecordingLogger(): { readonly logger: IScopedLogger; readonly lines: LoggedLine[] } {
  const lines: LoggedLine[] = []
  const at =
    (level: LoggedLine['level']) =>
    (msg: string, extras?: LogExtras): void => {
      lines.push({ level, msg, deviceId: extras?.tags?.['deviceId'], meta: extras?.meta ?? {} })
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

/** A shelf still: every kind, the same bytes — `stillShelfMedia`'s shape. */
function shelfStill(label: string): readonly MediaFile[] {
  const base64 = Buffer.from(label).toString('base64')
  return (['keyFrameSmall', 'keyFrame', 'fullFrame'] as const).map((kind, i) =>
    makeTestMediaFile({
      mediaId: 9000 + i,
      kind,
      base64,
      sizeBytes: label.length,
      timestamp: T0,
    }),
  )
}

const OWNER_A = 'nc-linked:a'
const OWNER_B = 'nc-linked:b'
const OWNER_C = 'nc-linked:c'
const MOSAIC = 'nc-mosaic:m'

/** Distinct lengths, so a frame list is identified by its byte lengths. */
const PICTURES: Readonly<Record<string, string>> = {
  [OWNER_A]: 'tile-a',
  [OWNER_B]: 'tile-bb',
  [OWNER_C]: 'tile-ccc',
  [MOSAIC]: 'mosaic-composed-picture',
}

function makeEntry(
  subject: Partial<NcOutboxPayload['subject']>,
  payload: Partial<NcOutboxPayload> = {},
): NcOutboxEntry {
  return {
    id: 'rule-1:sev-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 101,
    recordKind: 'device-event',
    recordId: 'sev-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: T0,
    updatedAt: T0,
    payload: {
      ruleName: 'Porta front door',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      subject: {
        deviceId: 101,
        className: 'contact',
        zones: [],
        timestamp: T0,
        ...subject,
      },
      ...payload,
    },
  }
}

/** `each`: the primary's still, then the other two cameras'. */
const EACH_SUBJECT: Partial<NcOutboxPayload['subject']> = {
  trackId: OWNER_A,
  extraStills: [
    { ownerId: OWNER_B, cameraId: 102 },
    { ownerId: OWNER_C, cameraId: 620 },
  ],
  analysisTiles: [
    { ownerId: OWNER_A, cameraId: 101 },
    { ownerId: OWNER_B, cameraId: 102 },
    { ownerId: OWNER_C, cameraId: 620 },
  ],
  linkedCameraIds: [101, 102, 620],
}

/** `mosaic`: the composed picture ships; the model reads the raw tiles. */
const MOSAIC_SUBJECT: Partial<NcOutboxPayload['subject']> = {
  trackId: MOSAIC,
  analysisTiles: [
    { ownerId: OWNER_A, cameraId: 101 },
    { ownerId: OWNER_B, cameraId: 102 },
  ],
  linkedCameraIds: [101, 102],
}

const TARGET: NcTargetRef = {
  id: 'tgt-1',
  addonId: 'notifiers',
  name: 'phone',
  kind: 'ntfy',
  enabled: true,
  bodyMaxLen: 4_096,
}

interface HarnessOptions {
  /** Owners that answer nothing (their picture never landed). */
  readonly missing?: readonly string[]
  /** Owners whose read THROWS. */
  readonly throwing?: readonly string[]
  readonly withIndex?: boolean
  /** The primary camera's footage renders a gif. */
  readonly withFootage?: boolean
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  readonly aiCalls: NcRuleAiInput[]
  readonly gateCalls: NcConfirmGateInput[]
  readonly indexedMeta: NcArtifactPublishMeta[]
}

const CONFIRMED: NcOutboxConfirmVerdict = {
  decision: 'confirmed',
  reason: 'ok',
  latencyMs: 1,
  at: T0,
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const { logger, lines } = makeRecordingLogger()
  const sends: NcSendInput[] = []
  const aiCalls: NcRuleAiInput[] = []
  const gateCalls: NcConfirmGateInput[] = []
  const indexedMeta: NcArtifactPublishMeta[] = []
  const missing = new Set(options.missing ?? [])
  const throwing = new Set(options.throwing ?? [])
  const dispatcher = new NcDispatcher({
    logger,
    listTargets: async () => [TARGET],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async (_kind, ownerId) => {
      if (throwing.has(ownerId)) throw new Error('shelf read exploded')
      const label = PICTURES[ownerId]
      return label === undefined || missing.has(ownerId) ? [] : shelfStill(label)
    },
    getDeviceName: async () => 'Front door',
    now: () => T0 + 500,
    sleep: async () => undefined,
    ruleAi: async (input: NcRuleAiInput): Promise<NcRuleAiOutcome> => {
      aiCalls.push(input)
      return { text: 'La porta è aperta.', latencyMs: 10, images: input.frames.length }
    },
    ruleAiStats: () => ({ described: 1, failedOpen: 0, refuted: 0 }),
    confirmGate: async (input: NcConfirmGateInput): Promise<NcOutboxConfirmVerdict> => {
      gateCalls.push(input)
      return CONFIRMED
    },
    ...(options.withFootage === true
      ? { renderEventMedia: async () => ({ gif: Uint8Array.from([7, 7]), mp4: null }) }
      : {}),
    ...(options.withIndex === true
      ? {
          indexArtifact: async (_bytes: Uint8Array, _mime: string, meta: NcArtifactPublishMeta) => {
            indexedMeta.push(meta)
            return { url: null, artifactId: null }
          },
        }
      : {}),
  })
  return { dispatcher, sends, lines, aiCalls, gateCalls, indexedMeta }
}

function attachmentNames(h: Harness): readonly string[] {
  return (h.sends[0]?.notification.attachments ?? [])
    .map((a) => a.name)
    .filter((name): name is string => name !== undefined)
}

describe('NcDispatcher — the stills of a linked set (ADR 0632)', () => {
  it('each: ships the primary still, then one image per other camera', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry(EACH_SUBJECT))
    expect(attachmentNames(h)).toEqual(['keyFrame.jpg', 'camera-102.jpg', 'camera-620.jpg'])
    const bytes = (h.sends[0]?.notification.attachments ?? []).map((a) => a.bytes?.byteLength)
    expect(bytes).toEqual([
      PICTURES[OWNER_A]!.length,
      PICTURES[OWNER_B]!.length,
      PICTURES[OWNER_C]!.length,
    ])
  })

  it('an extra camera with no picture is skipped and named, never a blank attachment', async () => {
    const h = makeHarness({ missing: [OWNER_B] })
    await h.dispatcher.deliver(makeEntry(EACH_SUBJECT))
    expect(attachmentNames(h)).toEqual(['keyFrame.jpg', 'camera-620.jpg'])
    expect(h.lines).toContainEqual(
      expect.objectContaining({
        level: 'info',
        msg: 'linked camera picture missing at send — skipped',
        deviceId: 102,
      }),
    )
  })

  it('each, primary missing but the other cameras landed: never claims text-only', async () => {
    const h = makeHarness({ missing: [OWNER_A] })
    await h.dispatcher.deliver(makeEntry(EACH_SUBJECT))
    expect(attachmentNames(h)).toEqual(['camera-102.jpg', 'camera-620.jpg'])
    expect(h.lines.some((l) => l.msg.includes('ships text-only'))).toBe(false)
    expect(h.lines).toContainEqual(
      expect.objectContaining({
        level: 'info',
        msg: "no still of the primary camera could be resolved — the other linked cameras' stills ship without it",
        deviceId: 101,
      }),
    )
  })

  it('each, nothing landed at all: still says text-only', async () => {
    const h = makeHarness({ missing: [OWNER_A, OWNER_B, OWNER_C] })
    await h.dispatcher.deliver(makeEntry(EACH_SUBJECT))
    expect(attachmentNames(h)).toEqual([])
    expect(h.lines.some((l) => l.msg.includes('ships text-only'))).toBe(true)
  })

  it("a picture read that THROWS is said on that picture's camera", async () => {
    const h = makeHarness({ throwing: [OWNER_B] })
    await h.dispatcher.deliver(makeEntry(EACH_SUBJECT))
    expect(attachmentNames(h)).toEqual(['keyFrame.jpg', 'camera-620.jpg'])
    expect(h.lines).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        msg: 'linked camera picture read failed',
        deviceId: 102,
      }),
    )
  })

  it('names the camera the shelf photographed, never the one at its index', async () => {
    // 102 was muted between capture and evaluation: the row lists [101, 620]
    // while the shelf's extra still is still 102's. Index 1 of the row is 620.
    const h = makeHarness({ missing: [OWNER_C] })
    await h.dispatcher.deliver(
      makeEntry({
        trackId: OWNER_A,
        extraStills: [
          { ownerId: OWNER_B, cameraId: 102 },
          { ownerId: OWNER_C, cameraId: 620 },
        ],
        analysisTiles: [
          { ownerId: OWNER_A, cameraId: 101 },
          { ownerId: OWNER_B, cameraId: 102 },
          { ownerId: OWNER_C, cameraId: 620 },
        ],
        linkedCameraIds: [101, 620],
      }),
    )
    expect(attachmentNames(h)).toEqual(['keyFrame.jpg', 'camera-102.jpg'])
    expect(h.lines).toContainEqual(
      expect.objectContaining({
        msg: 'linked camera picture missing at send — skipped',
        deviceId: 620,
      }),
    )
  })

  it("the primary's footage keeps its precedence: the other cameras come after it", async () => {
    const h = makeHarness({ withFootage: true })
    await h.dispatcher.deliver(makeEntry(EACH_SUBJECT, { mediaGif: true }))
    const attachments = h.sends[0]?.notification.attachments ?? []
    expect(attachments.map((a) => a.mediaType)).toEqual(['image', 'gif', 'image', 'image'])
    expect(attachments[0]?.name).toBe('keyFrame.jpg')
    expect(attachments.slice(2).map((a) => a.name)).toEqual(['camera-102.jpg', 'camera-620.jpg'])
  })

  it('a two-attachment target keeps the still and the video; the other cameras fill only room left', async () => {
    const h = makeHarness({ withFootage: true })
    await h.dispatcher.deliver(makeEntry(EACH_SUBJECT, { mediaGif: true }))
    const sent = withNcNotificationFormat(h.sends[0]!.notification)
    const caps: TargetKindCaps = {
      attachments: { mediaTypes: ['image', 'gif'], mode: 'bytes', max: 2 },
      actions: 0,
      levels: [],
      format: ['text'],
      clickUrl: false,
      sound: false,
      ttl: false,
      bodyMaxLen: 4_096,
    }
    const twoSlots = prepareNotification(caps, sent)
    expect(twoSlots.attachments.map((a) => a.mediaType)).toEqual(['image', 'gif'])
    // A target that takes no footage gives its room to the other cameras.
    const stillsOnly = prepareNotification(
      { ...caps, attachments: { ...caps.attachments, mediaTypes: ['image'], max: 3 } },
      sent,
    )
    expect(stillsOnly.attachments.map((a) => a.name)).toEqual([
      'keyFrame.jpg',
      'camera-102.jpg',
      'camera-620.jpg',
    ])
  })

  it('a row with no extra owners ships exactly one still', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry(MOSAIC_SUBJECT))
    expect(attachmentNames(h)).toEqual(['keyFrame.jpg'])
  })

  it('indexes the artefact against EVERY linked camera', async () => {
    const h = makeHarness({ withIndex: true })
    await h.dispatcher.deliver(makeEntry(EACH_SUBJECT))
    expect(h.indexedMeta[0]!.deviceIds).toEqual([101, 102, 620])
    expect(h.indexedMeta[0]!.deviceId).toBe(101)
  })

  it('a row with no linked set indexes against its own camera only', async () => {
    const h = makeHarness({ withIndex: true })
    await h.dispatcher.deliver(makeEntry({ trackId: OWNER_A }))
    expect(h.indexedMeta[0]!.deviceIds).toEqual([101])
  })

  it('the narration model reads the raw tiles, not the mosaic', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry(MOSAIC_SUBJECT, { ai: { shape: 'detection-immediate' } }))
    expect(h.aiCalls).toHaveLength(1)
    expect(h.aiCalls[0]!.frames.map((f) => f.bytes.byteLength)).toEqual([
      PICTURES[OWNER_A]!.length,
      PICTURES[OWNER_B]!.length,
    ])
  })

  it('a tile with no picture is left out of the narration, never an empty frame', async () => {
    const h = makeHarness({ missing: [OWNER_A] })
    await h.dispatcher.deliver(makeEntry(MOSAIC_SUBJECT, { ai: { shape: 'detection-immediate' } }))
    expect(h.aiCalls[0]!.frames.map((f) => f.bytes.byteLength)).toEqual([PICTURES[OWNER_B]!.length])
  })

  it("a tile read that THROWS is said on THAT tile's camera", async () => {
    const h = makeHarness({ throwing: [OWNER_B] })
    await h.dispatcher.deliver(makeEntry(MOSAIC_SUBJECT, { ai: { shape: 'detection-immediate' } }))
    expect(h.aiCalls[0]!.frames.map((f) => f.bytes.byteLength)).toEqual([PICTURES[OWNER_A]!.length])
    expect(h.lines).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        msg: 'linked camera picture read failed',
        deviceId: 102,
      }),
    )
  })

  it('no tile at all falls back to the shipped picture', async () => {
    const h = makeHarness({ missing: [OWNER_A, OWNER_B] })
    await h.dispatcher.deliver(makeEntry(MOSAIC_SUBJECT, { ai: { shape: 'detection-immediate' } }))
    expect(h.aiCalls[0]!.frames.map((f) => f.bytes.byteLength)).toEqual([PICTURES[MOSAIC]!.length])
  })

  it('the confirm gate judges the image that ships — the mosaic', async () => {
    const h = makeHarness()
    await h.dispatcher.deliver(makeEntry(MOSAIC_SUBJECT, { confirm: {} }))
    expect(h.gateCalls).toHaveLength(1)
    expect(h.gateCalls[0]!.image?.bytes.byteLength).toBe(PICTURES[MOSAIC]!.length)
  })
})
