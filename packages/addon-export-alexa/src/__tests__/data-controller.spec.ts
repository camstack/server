/**
 * R4 (D779): `SetObjectDetectionClasses`, `DataController.ReportData` and
 * `DataController.DeleteData` on a camera endpoint.
 */
import { describe, expect, it } from 'vitest'
import type { SmartVisionClass } from '../endpoints/builder.js'
import {
  handleDeleteData,
  handleReportData,
  handleSetObjectDetectionClasses,
  type VisionContext,
  type VisionTrack,
} from '../handlers/data-controller.js'
import { eventIdentifierFor, objectIdentifierFor } from '../vision/vision-ids.js'
import { VisionStateStore } from '../vision/vision-state.js'
import { quietLogger } from './helpers/fake-device-api.js'

const NS = '6f1c2a54-1d0e-4c8b-9a52-0c3f7d2e9b11'
const CAM = 101
const T0 = Date.parse('2026-10-08T10:00:00.000Z')

/** 25 tracks, one a minute, alternating person / package, plus a car. */
const TRACKS: readonly VisionTrack[] = [
  ...Array.from({ length: 25 }, (_, i) => ({
    trackId: `t${String(i).padStart(2, '0')}`,
    className: i % 2 === 0 ? 'person' : 'package',
    firstSeen: T0 + i * 60_000,
    lastSeen: T0 + i * 60_000 + 5_000,
  })),
  { trackId: 'car', className: 'car', firstSeen: T0, lastSeen: T0 + 30_000 },
]

function context(
  over: { declared?: readonly SmartVisionClass[]; tracks?: readonly VisionTrack[] } = {},
) {
  const blobs = new Map<number, Record<string, unknown>>()
  const vision = new VisionStateStore({
    read: async (id) => ({ ...blobs.get(id) }),
    write: async (id, patch) => {
      blobs.set(id, { ...blobs.get(id), ...patch })
    },
  })
  const tracks = over.tracks ?? TRACKS
  const minted: string[] = []
  const ctx: VisionContext = {
    ctx: {
      api: { deviceStatus: { getStatus: { query: async () => ({ online: true }) } } },
    } as never,
    logger: quietLogger,
    vision,
    declaredClasses: async () => over.declared ?? ['person', 'package'],
    namespace: () => NS,
    listTracks: async (_deviceId, q) =>
      tracks
        .filter((t) => t.lastSeen >= q.since && t.lastSeen <= q.until)
        .toSorted((a, b) => b.lastSeen - a.lastSeen || (a.trackId < b.trackId ? 1 : -1))
        .slice(0, q.limit),
    getTrack: async (_d, id) => tracks.find((t) => t.trackId === id) ?? null,
    imagesFor: (userId, _d, trackId) => {
      minted.push(`${userId}:${trackId}`)
      return {
        frameImageUri: `https://hub/f/${trackId}?n=${minted.length}`,
        croppedImageUri: `https://hub/c/${trackId}?n=${minted.length}`,
      }
    },
  }
  return { ctx, vision, minted }
}

const caller = { userId: 'alice', username: 'alice', scopes: [] }

function header(name: string) {
  return {
    namespace: 'Alexa.DataController',
    name,
    payloadVersion: '1.0',
    instance: 'Camera.SmartVisionData',
    messageId: 'm',
    correlationToken: 'c',
  }
}

type Report = {
  event: {
    header: Record<string, unknown>
    endpoint: { endpointId: string }
    payload: {
      paginationContext?: { nextToken: string }
      dataSchema: unknown
      data: Array<Record<string, string>>
    }
  }
}

async function report(ctx: VisionContext, payload: unknown): Promise<Report> {
  return (await handleReportData(
    header('ReportData'),
    { endpointId: String(CAM) },
    payload,
    ctx,
    caller,
  )) as Report
}

const RANGE = {
  queryType: 'QUERY_BY_TIMESTAMP_RANGE',
  query: { fromTime: new Date(T0).toISOString(), toTime: new Date(T0 + 3_600_000).toISOString() },
}

describe('ReportData by time range', () => {
  it('answers a DataReport: newest first, at most maxResults, SmartVisionData items', async () => {
    const { ctx } = context()
    const r = await report(ctx, { ...RANGE, maxResults: 10 })
    expect(r.event.header).toMatchObject({
      namespace: 'Alexa.DataController',
      name: 'DataReport',
      instance: 'Camera.SmartVisionData',
      correlationToken: 'c',
      payloadVersion: '1.0',
    })
    expect(r.event.endpoint.endpointId).toBe(String(CAM))
    expect(r.event.payload.dataSchema).toEqual({ type: 'JSON', schema: 'SmartVisionData' })
    expect(r.event.payload.data).toHaveLength(10)
    const first = r.event.payload.data[0]!
    expect(first).toMatchObject({
      eventIdentifier: eventIdentifierFor(NS, CAM, 't24', 'person'),
      imageNetClass: 'person',
      objectIdentifier: objectIdentifierFor(NS, CAM, 't24'),
    })
    expect(first.frameImageUri).toContain('/f/t24')
    expect(first.croppedImageUri).toContain('/c/t24')
  })

  it('pages 10 at a time until the range is exhausted, with no repeats and no car', async () => {
    const { ctx } = context()
    const seen: string[] = []
    let token: string | undefined
    let pages = 0
    do {
      const r = await report(ctx, {
        ...RANGE,
        maxResults: 10,
        ...(token ? { nextToken: token } : {}),
      })
      seen.push(...r.event.payload.data.map((d) => d.eventIdentifier!))
      token = r.event.payload.paginationContext?.nextToken
      pages += 1
    } while (token !== undefined && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  it("clamps maxResults to Amazon's 1..10", async () => {
    const { ctx } = context()
    expect((await report(ctx, { ...RANGE, maxResults: 50 })).event.payload.data).toHaveLength(10)
  })

  it('re-mints the image URIs on every read', async () => {
    const { ctx } = context()
    const a = await report(ctx, { ...RANGE, maxResults: 1 })
    const b = await report(ctx, { ...RANGE, maxResults: 1 })
    expect(a.event.payload.data[0]!.frameImageUri).not.toBe(b.event.payload.data[0]!.frameImageUri)
  })

  it('only the classes the camera reports: package off ⇒ person only', async () => {
    const { ctx } = context({ declared: ['person'] })
    const r = await report(ctx, { ...RANGE, maxResults: 10 })
    expect(new Set(r.event.payload.data.map((d) => d.imageNetClass))).toEqual(new Set(['person']))
  })

  it('switched off for the camera ⇒ an empty history, not an error', async () => {
    const { ctx } = context({ declared: [] })
    const r = await report(ctx, { ...RANGE, maxResults: 10 })
    expect(r.event.payload.data).toEqual([])
  })

  it('a malformed nextToken is refused, not trusted', async () => {
    const { ctx } = context()
    const r = (await handleReportData(
      header('ReportData'),
      { endpointId: String(CAM) },
      { ...RANGE, maxResults: 10, nextToken: '!!!' },
      ctx,
      caller,
    )) as { event: { header: { name: string } } }
    expect(r.event.header.name).toBe('ErrorResponse')
  })
})

describe('ReportData by identifier', () => {
  it('finds events the history handed out, by their eventIdentifier', async () => {
    const { ctx } = context()
    const page = await report(ctx, { ...RANGE, maxResults: 2 })
    const ids = page.event.payload.data.map((d) => d.eventIdentifier!)
    const r = await report(ctx, {
      queryType: 'QUERY_BY_IDENTIFIER',
      query: { ids },
      maxResults: 10,
    })
    expect(r.event.payload.data.map((d) => d.eventIdentifier)).toEqual(ids)
  })

  it('an id it never issued is simply absent', async () => {
    const { ctx } = context()
    const r = await report(ctx, {
      queryType: 'QUERY_BY_IDENTIFIER',
      query: { ids: ['2b3409df-d686-4a52-9bba-d361860bac61'] },
      maxResults: 1,
    })
    expect(r.event.payload.data).toEqual([])
  })
})

describe('DeleteData hides from Alexa only', () => {
  it('a deleted event disappears from the history; nothing in CamStack is touched', async () => {
    const { ctx } = context()
    const before = await report(ctx, { ...RANGE, maxResults: 10 })
    const victim = before.event.payload.data[0]!.eventIdentifier!
    const res = (await handleDeleteData(
      header('DeleteData'),
      { endpointId: String(CAM) },
      { queryType: 'QUERY_BY_IDENTIFIER', query: { ids: [victim] } },
      ctx,
      caller,
    )) as { event: { header: { name: string }; payload: unknown } }
    expect(res.event.header.name).toBe('DataDeleted')
    expect(res.event.payload).toEqual({
      queryType: 'QUERY_BY_IDENTIFIER',
      query: { ids: [victim] },
    })
    const after = await report(ctx, { ...RANGE, maxResults: 10 })
    expect(after.event.payload.data.map((d) => d.eventIdentifier)).not.toContain(victim)
    expect(
      (
        await report(ctx, {
          queryType: 'QUERY_BY_IDENTIFIER',
          query: { ids: [victim] },
          maxResults: 1,
        })
      ).event.payload.data,
    ).toEqual([])
  })

  it('by time range hides every event in the range', async () => {
    const { ctx } = context()
    await handleDeleteData(header('DeleteData'), { endpointId: String(CAM) }, RANGE, ctx, caller)
    expect((await report(ctx, { ...RANGE, maxResults: 10 })).event.payload.data).toEqual([])
  })
})

describe('SetObjectDetectionClasses', () => {
  it('persists the choice and answers Alexa.Response with connectivity', async () => {
    const { ctx, vision } = context()
    const res = (await handleSetObjectDetectionClasses(
      {
        namespace: 'Alexa.SmartVision.ObjectDetectionSensor',
        name: 'SetObjectDetectionClasses',
        payloadVersion: '1.0',
        messageId: 'm',
        correlationToken: 'c',
      },
      { endpointId: String(CAM) },
      { objectDetectionClasses: [{ imageNetClass: 'package' }] },
      ctx,
    )) as {
      event: { header: Record<string, unknown> }
      context: { properties: Array<{ namespace: string; name: string; value: unknown }> }
    }
    expect(res.event.header).toMatchObject({
      namespace: 'Alexa',
      name: 'Response',
      correlationToken: 'c',
      payloadVersion: '3',
    })
    expect(res.context.properties).toEqual([
      expect.objectContaining({
        namespace: 'Alexa.EndpointHealth',
        name: 'connectivity',
        value: { value: 'OK' },
      }),
    ])
    expect((await vision.get(CAM)).classes).toEqual(['package'])
  })

  it('a turned-off class is no longer in the history', async () => {
    const { ctx } = context()
    await handleSetObjectDetectionClasses(
      {
        namespace: 'Alexa.SmartVision.ObjectDetectionSensor',
        name: 'SetObjectDetectionClasses',
        payloadVersion: '1.0',
        messageId: 'm',
      },
      { endpointId: String(CAM) },
      { objectDetectionClasses: [{ imageNetClass: 'person' }] },
      ctx,
    )
    const r = await report(ctx, { ...RANGE, maxResults: 10 })
    expect(new Set(r.event.payload.data.map((d) => d.imageNetClass))).toEqual(new Set(['person']))
  })

  it('refuses a non-camera endpoint', async () => {
    const { ctx } = context()
    const res = (await handleSetObjectDetectionClasses(
      {
        namespace: 'Alexa.SmartVision.ObjectDetectionSensor',
        name: 'SetObjectDetectionClasses',
        payloadVersion: '1.0',
        messageId: 'm',
      },
      { endpointId: `${CAM}__det_person` },
      { objectDetectionClasses: [] },
      ctx,
    )) as { event: { header: { name: string } } }
    expect(res.event.header.name).toBe('ErrorResponse')
  })
})
