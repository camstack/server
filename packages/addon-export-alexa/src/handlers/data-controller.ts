/**
 * R4 (D779) directives on a camera endpoint:
 *
 *  - `Alexa.SmartVision.ObjectDetectionSensor/SetObjectDetectionClasses` — the
 *    user turned a class on/off in the Alexa app. Persisted per camera; a class
 *    turned off is neither posted nor listed.
 *  - `Alexa.DataController/ReportData` (instance `Camera.SmartVisionData`) —
 *    the camera's detection history, from the pipeline's persisted tracks: by
 *    identifier or by time range, newest first, at most 10 per page, with a
 *    `nextToken` cursor. Image URIs are minted afresh on EVERY read, so Amazon
 *    never holds a long-lived link (they live ten minutes and are fetched with
 *    the account-link token, `snapshots/snapshot-route.ts`).
 *  - `Alexa.DataController/DeleteData` — hides events from Alexa ONLY. Deleting
 *    CamStack footage is not something a voice assistant may do.
 *
 * Amazon lists both interfaces for en-US only; this is the experiment that
 * finds out what an it-IT account does with them.
 */
import { randomUUID } from 'node:crypto'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import { readConnectivity } from '../connectivity.js'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { detectionClassOf } from '../detection-sensors/detection-tracker.js'
import {
  SMART_VISION_CLASSES,
  SMART_VISION_DATA_INSTANCE,
  type SmartVisionClass,
} from '../endpoints/builder.js'
import { eventIdentifierFor, objectIdentifierFor } from '../vision/vision-ids.js'
import {
  reportableVisionClasses,
  type VisionIndexEntry,
  type VisionStateStore,
} from '../vision/vision-state.js'
import { parseCameraEndpointId } from './endpoint-id.js'
import { errorEnvelope } from './error-envelope.js'
import type { DirectiveHeader } from './types.js'

/** Amazon: `maxResults` 1..10; `ids` at most 10. */
export const MAX_RESULTS = 10
/** Rows read per round while filling a page, and rounds per page. */
const FETCH_ROWS = 50
const MAX_ROUNDS = 5
/** Rows a time-range DeleteData hides at most. */
const MAX_DELETE_ROWS = 500

/** One persisted track as the history reads it. */
export interface VisionTrack {
  readonly trackId: string
  readonly className: string
  readonly firstSeen: number
  readonly lastSeen: number
}

export interface VisionImageUris {
  readonly frameImageUri?: string
  readonly croppedImageUri?: string
}

export interface VisionContext {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  readonly vision: VisionStateStore
  /** Classes the camera declares; empty when the feature is off for it. */
  readonly declaredClasses: (deviceId: number) => Promise<readonly SmartVisionClass[]>
  readonly namespace: () => string
  /** Completed tracks whose `lastSeen` is in `[since, until]`, ordered
   *  (`lastSeen` DESC, `trackId` DESC). */
  readonly listTracks: (
    deviceId: number,
    query: { readonly since: number; readonly until: number; readonly limit: number },
  ) => Promise<readonly VisionTrack[]>
  readonly getTrack: (deviceId: number, trackId: string) => Promise<VisionTrack | null>
  /** Fresh image URIs for one event (detected at `at`), minted for this user
   *  (empty when the snapshot switch is off or the hub has no public HTTPS
   *  address). */
  readonly imagesFor: (
    userId: string,
    deviceId: number,
    trackId: string,
    at: number,
  ) => VisionImageUris
}

const QuerySchema = z.object({
  ids: z.array(z.string()).max(MAX_RESULTS).optional(),
  fromTime: z.string().optional(),
  toTime: z.string().optional(),
})

const ReportDataPayloadSchema = z.object({
  queryType: z.enum(['QUERY_BY_IDENTIFIER', 'QUERY_BY_TIMESTAMP_RANGE', 'QUERY_ALL']),
  query: QuerySchema.optional(),
  maxResults: z.number().int().optional(),
  nextToken: z.string().optional(),
})

const DeleteDataPayloadSchema = ReportDataPayloadSchema.omit({ maxResults: true, nextToken: true })

const SetClassesPayloadSchema = z.object({
  objectDetectionClasses: z.array(z.object({ imageNetClass: z.string() })),
})

const CursorSchema = z.object({ l: z.number(), t: z.string() })
type Cursor = z.infer<typeof CursorSchema>

function encodeCursor(cursor: Cursor): string {
  return `v1.${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`
}

function decodeCursor(token: string): Cursor | null {
  if (!token.startsWith('v1.')) return null
  try {
    const parsed = CursorSchema.safeParse(
      JSON.parse(Buffer.from(token.slice(3), 'base64url').toString('utf8')),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Before the cursor in (`lastSeen` DESC, `trackId` DESC) order? */
function isAfterCursor(row: VisionTrack, cursor: Cursor | null): boolean {
  if (cursor === null) return true
  return row.lastSeen < cursor.l || (row.lastSeen === cursor.l && row.trackId < cursor.t)
}

function cameraOf(endpoint: { readonly endpointId: string } | undefined): number | null {
  if (endpoint === undefined) return null
  const parsed = parseCameraEndpointId(endpoint.endpointId)
  return parsed.kind === 'camera' ? parsed.deviceId : null
}

function isVisionClass(cls: string | null): cls is SmartVisionClass {
  return (SMART_VISION_CLASSES as readonly (string | null)[]).includes(cls)
}

interface Prepared {
  readonly deviceId: number
  readonly reportable: readonly SmartVisionClass[]
  readonly hidden: ReadonlySet<string>
}

async function prepare(ctx: VisionContext, deviceId: number): Promise<Prepared> {
  const state = await ctx.vision.get(deviceId)
  return {
    deviceId,
    reportable: reportableVisionClasses(await ctx.declaredClasses(deviceId), state),
    hidden: new Set(state.hidden),
  }
}

/** A track as a history entry, or null when it is not one this camera shows. */
function entryOf(ctx: VisionContext, p: Prepared, track: VisionTrack): VisionIndexEntry | null {
  const cls = detectionClassOf(track.className)
  if (!isVisionClass(cls) || !p.reportable.includes(cls)) return null
  const e = eventIdentifierFor(ctx.namespace(), p.deviceId, track.trackId, cls)
  if (p.hidden.has(e)) return null
  return { e, t: track.trackId, c: cls, at: track.firstSeen }
}

function dataItem(
  ctx: VisionContext,
  p: Prepared,
  entry: VisionIndexEntry,
  userId: string,
): Record<string, string> {
  return {
    eventIdentifier: entry.e,
    imageNetClass: entry.c,
    objectIdentifier: objectIdentifierFor(ctx.namespace(), p.deviceId, entry.t),
    ...ctx.imagesFor(userId, p.deviceId, entry.t, entry.at),
  }
}

function rangeOf(
  payload: z.infer<typeof DeleteDataPayloadSchema>,
): { from: number; to: number } | null {
  if (payload.queryType === 'QUERY_ALL') return { from: 0, to: Date.now() }
  const from = Date.parse(payload.query?.fromTime ?? '')
  const to = Date.parse(payload.query?.toTime ?? '')
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null
  return { from, to }
}

function dataControllerEvent(
  header: DirectiveHeader,
  endpointId: string,
  name: 'DataReport' | 'DataDeleted',
  payload: Record<string, unknown>,
): unknown {
  return {
    event: {
      header: {
        namespace: 'Alexa.DataController',
        name,
        instance: header.instance ?? SMART_VISION_DATA_INSTANCE,
        messageId: randomUUID(),
        ...(header.correlationToken !== undefined
          ? { correlationToken: header.correlationToken }
          : {}),
        payloadVersion: '1.0',
      },
      endpoint: { endpointId },
      payload,
    },
  }
}

/** One page of the time-range history, starting after `start`. */
async function rangePage(
  ctx: VisionContext,
  p: Prepared,
  range: { from: number; to: number },
  start: Cursor | null,
  max: number,
): Promise<{ entries: VisionIndexEntry[]; next: Cursor | null }> {
  const entries: VisionIndexEntry[] = []
  let cursor = start
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const rows = await ctx.listTracks(p.deviceId, {
      since: range.from,
      until: cursor === null ? range.to : Math.min(cursor.l, range.to),
      limit: FETCH_ROWS,
    })
    for (const row of rows) {
      if (!isAfterCursor(row, cursor)) continue
      cursor = { l: row.lastSeen, t: row.trackId }
      const entry = entryOf(ctx, p, row)
      if (entry === null) continue
      entries.push(entry)
      if (entries.length === max) return { entries, next: cursor }
    }
    if (rows.length < FETCH_ROWS) return { entries, next: null }
  }
  // Out of rounds without filling the page: let Alexa continue from here.
  return { entries, next: cursor }
}

export async function handleReportData(
  header: DirectiveHeader,
  endpoint: { readonly endpointId: string } | undefined,
  payloadRaw: unknown,
  ctx: VisionContext,
  caller: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const deviceId = cameraOf(endpoint)
  if (deviceId === null || endpoint === undefined) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      'event history is served for camera endpoints',
    )
  }
  const parsed = ReportDataPayloadSchema.safeParse(payloadRaw)
  if (!parsed.success) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'ReportData payload shape unexpected')
  }
  const payload = parsed.data
  const max = Math.min(Math.max(payload.maxResults ?? MAX_RESULTS, 1), MAX_RESULTS)
  const p = await prepare(ctx, deviceId)
  let entries: VisionIndexEntry[] = []
  let next: Cursor | null = null

  if (payload.queryType === 'QUERY_BY_IDENTIFIER') {
    for (const id of (payload.query?.ids ?? []).slice(0, max)) {
      const known = await ctx.vision.lookup(deviceId, id)
      if (known === null) continue
      const track = await ctx.getTrack(deviceId, known.t)
      const entry = track === null ? null : entryOf(ctx, p, track)
      if (entry !== null && entry.e === id) entries.push(entry)
    }
  } else {
    const range = rangeOf(payload)
    if (range === null) {
      return errorEnvelope(header, 'INVALID_DIRECTIVE', 'fromTime/toTime missing or invalid')
    }
    const start = payload.nextToken === undefined ? null : decodeCursor(payload.nextToken)
    if (payload.nextToken !== undefined && start === null) {
      return errorEnvelope(header, 'INVALID_DIRECTIVE', 'nextToken not recognised')
    }
    const page = await rangePage(ctx, p, range, start, max)
    entries = page.entries
    next = page.next
    await ctx.vision.remember(deviceId, entries)
  }

  ctx.logger.info('alexa data controller: history served', {
    tags: { deviceId },
    meta: {
      userId: caller.userId,
      queryType: payload.queryType,
      items: entries.length,
      more: next !== null,
    },
  })
  return dataControllerEvent(header, endpoint.endpointId, 'DataReport', {
    ...(next !== null ? { paginationContext: { nextToken: encodeCursor(next) } } : {}),
    dataSchema: { type: 'JSON', schema: 'SmartVisionData' },
    data: entries.map((e) => dataItem(ctx, p, e, caller.userId)),
  })
}

export async function handleDeleteData(
  header: DirectiveHeader,
  endpoint: { readonly endpointId: string } | undefined,
  payloadRaw: unknown,
  ctx: VisionContext,
  caller: VerifiedDirectiveIdentity,
): Promise<unknown> {
  const deviceId = cameraOf(endpoint)
  if (deviceId === null || endpoint === undefined) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      'event history is served for camera endpoints',
    )
  }
  const parsed = DeleteDataPayloadSchema.safeParse(payloadRaw)
  if (!parsed.success) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'DeleteData payload shape unexpected')
  }
  const payload = parsed.data
  let ids: readonly string[]
  if (payload.queryType === 'QUERY_BY_IDENTIFIER') {
    ids = payload.query?.ids ?? []
  } else {
    const range = rangeOf(payload)
    if (range === null) {
      return errorEnvelope(header, 'INVALID_DIRECTIVE', 'fromTime/toTime missing or invalid')
    }
    const p = await prepare(ctx, deviceId)
    const rows = await ctx.listTracks(deviceId, {
      since: range.from,
      until: range.to,
      limit: MAX_DELETE_ROWS,
    })
    ids = rows.map((r) => entryOf(ctx, p, r)?.e).filter((e): e is string => e !== undefined)
  }
  await ctx.vision.hide(deviceId, ids)
  ctx.logger.info('alexa data controller: events hidden from Alexa (CamStack keeps them)', {
    tags: { deviceId },
    meta: { userId: caller.userId, queryType: payload.queryType, hidden: ids.length },
  })
  return dataControllerEvent(header, endpoint.endpointId, 'DataDeleted', {
    queryType: payload.queryType,
    ...(payload.query !== undefined ? { query: payload.query } : {}),
  })
}

export async function handleSetObjectDetectionClasses(
  header: DirectiveHeader,
  endpoint: { readonly endpointId: string } | undefined,
  payloadRaw: unknown,
  ctx: VisionContext,
): Promise<unknown> {
  const deviceId = cameraOf(endpoint)
  if (deviceId === null || endpoint === undefined) {
    return errorEnvelope(header, 'INVALID_DIRECTIVE', 'object detection lives on camera endpoints')
  }
  const parsed = SetClassesPayloadSchema.safeParse(payloadRaw)
  if (!parsed.success) {
    return errorEnvelope(
      header,
      'INVALID_DIRECTIVE',
      'SetObjectDetectionClasses payload unexpected',
    )
  }
  const wanted = new Set(parsed.data.objectDetectionClasses.map((c) => c.imageNetClass))
  const classes = SMART_VISION_CLASSES.filter((c) => wanted.has(c))
  await ctx.vision.setClasses(deviceId, classes)
  ctx.logger.info('alexa object detection: classes set from the Alexa app', {
    tags: { deviceId },
    meta: { classes },
  })
  const connectivity = await readConnectivity(ctx.ctx.api, deviceId, ctx.logger)
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'Response',
        messageId: randomUUID(),
        ...(header.correlationToken !== undefined
          ? { correlationToken: header.correlationToken }
          : {}),
        payloadVersion: '3',
      },
      endpoint: { endpointId: endpoint.endpointId },
      payload: {},
    },
    context: {
      properties: [
        {
          namespace: 'Alexa.EndpointHealth',
          name: 'connectivity',
          value: { value: connectivity },
          timeOfSample: new Date().toISOString(),
          uncertaintyInMilliseconds: 0,
        },
      ],
    },
  }
}
