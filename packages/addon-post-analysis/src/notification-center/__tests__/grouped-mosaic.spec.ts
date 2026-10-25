/**
 * D692 Task 12 — a grouped message carries a MOSAIC, one tile per subject (§6.2).
 *
 *  - N = 1 is a plain immediate row, byte for byte (zone crop, `frame: 'full'`);
 *  - N ≥ 2 → one `mosaic.jpg`, first, at most `NC_GROUPED_MOSAIC_MAX_TILES` tiles, every
 *    member still counted in the text;
 *  - ONE shared still wait across the members, not one per member;
 *  - a member whose still never lands is left out and named; a composition that fails ships
 *    the first subject's still;
 *  - D694: each tile reads ITS OWN event generation (an event id is a reusable rowid).
 *
 * The harness is the one of `grouped-dispatch-text.spec.ts` (copied, not imported).
 */
import type { IScopedLogger, MediaFile } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  buildTemplateVars,
  NC_STILL_WAIT_INTERVAL_MS,
  NC_STILL_WAIT_MS,
  NcDispatcher,
  type NcDispatcherDeps,
  type NcSendInput,
  type NcTargetRef,
} from '../dispatcher.js'
import {
  groupedTileEntry,
  groupedTileMembers,
  NC_GROUPED_MOSAIC_MAX_TILES,
} from '../grouped/grouped-mosaic.js'
import type {
  NcOutboxGroupLegacy,
  NcOutboxGroupMemberV2,
  NcOutboxGroupV2,
} from '../grouped/grouped-payload.js'
import { readOutboxGroup } from '../grouped/grouped-payload.js'
import type { NcEventMediaScope } from '../outbox-key.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'
import {
  type MosaicRenderRequest,
  type MosaicRenderResult,
  mosaicLayout,
  renderMosaic,
} from '../summary/mosaic-renderer.js'

const DEVICE = 104
const OTHER_DEVICE = 591
const SEC = 1_000
const CLOSED_AT = 1_786_185_854_852
const OPENED_AT = CLOSED_AT - 6 * SEC

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

function recordingLogger(lines: LoggedLine[]): IScopedLogger {
  const at =
    (level: string) =>
    (
      message: string,
      extras?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> },
    ): void => {
      lines.push({ level, message, meta: extras?.meta ?? {}, tags: extras?.tags ?? {} })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const PUSH: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
]
const TELEGRAM: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'Chat', kind: 'telegram', enabled: true },
]

/** A small, DISTINCT jpeg per seed — tiles can be told apart by their bytes. */
async function jpegOf(seed: number, width = 64, height = 48): Promise<Buffer> {
  const shade = (seed * 37) % 256
  return sharp({
    create: { width, height, channels: 3, background: { r: shade, g: 255 - shade, b: 90 } },
  })
    .jpeg()
    .toBuffer()
}

/**
 * Two JPEGs show the same scene: a tile is RENDERED by the image stage (D897),
 * a re-encode of its source, so bytes differ while the picture does not.
 */
async function sameScene(a: Uint8Array | undefined, b: Uint8Array | undefined): Promise<boolean> {
  if (a === undefined || b === undefined) return false
  const centre = async (bytes: Uint8Array): Promise<readonly number[]> => {
    const { data, info } = await sharp(Buffer.from(bytes))
      .raw()
      .toBuffer({ resolveWithObject: true })
    const i =
      (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]
  }
  const [pa, pb] = [await centre(a), await centre(b)]
  return pa.every((v, i) => Math.abs(v - (pb[i] ?? 0)) <= 12)
}

async function sameScenes(
  actual: ReadonlyArray<Uint8Array> | undefined,
  expected: ReadonlyArray<Uint8Array>,
): Promise<boolean> {
  if (actual === undefined || actual.length !== expected.length) return false
  for (const [i, a] of actual.entries()) if (!(await sameScene(a, expected[i]))) return false
  return true
}

function mediaFile(kind: MediaFile['kind'], jpeg: Buffer, timestamp: number): MediaFile {
  return {
    mediaId: 1,
    kind,
    base64: jpeg.toString('base64'),
    sizeBytes: jpeg.length,
    timestamp,
    url: 'http://media/1',
  }
}

function member(
  index: number,
  overrides: Partial<NcOutboxGroupMemberV2> = {},
): NcOutboxGroupMemberV2 {
  return {
    trackId: `trk-${index}`,
    className: 'person',
    triggerAt: OPENED_AT + index * SEC,
    ...overrides,
  }
}

function groupV2(members: readonly NcOutboxGroupMemberV2[]): NcOutboxGroupV2 {
  return {
    version: 2,
    key: 'grp:rule-1:104:trk-1@1',
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT,
    closeReason: 'all-final',
    members,
  }
}

function makeEntry(
  payload: Partial<NcOutboxPayload> = {},
  deviceId: number = DEVICE,
): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: CLOSED_AT,
    updatedAt: CLOSED_AT,
    payload: {
      ruleName: 'Persone',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      subject: {
        deviceId,
        eventId: 'ev-1',
        trackId: 'trk-1',
        className: 'person',
        zones: [],
        timestamp: CLOSED_AT,
      },
      ...payload,
    },
  }
}

/** What the fake store holds: track-owned files per track id, object files per scope. */
interface Store {
  readonly track: ReadonlyMap<string, readonly MediaFile[]>
  readonly object?: (id: string, scope: NcEventMediaScope | undefined) => readonly MediaFile[]
}

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly lines: LoggedLine[]
  readonly sleeps: number[]
  readonly renders: MosaicRenderRequest[]
  readonly objectReads: Array<{ readonly id: string; readonly scope?: NcEventMediaScope }>
  readonly trackReads: string[]
  readonly ringCuts: number[]
}

/** The line's context every grouped line carries (D391 + the review's M-1). */
function expectGroupedContext(line: LoggedLine | undefined, trackId?: string): void {
  expect(line).toBeDefined()
  expect(line?.tags['deviceId']).toBe(DEVICE)
  expect(line?.meta['ruleId']).toBe('rule-1')
  expect(line?.meta['rule']).toBe('Persone')
  expect(line?.meta['windowKey']).toBe('grp:rule-1:104:trk-1@1')
  if (trackId !== undefined) expect(line?.meta['trackId']).toBe(trackId)
}

function makeHarness(
  store: Store,
  opts: {
    readonly targets?: readonly NcTargetRef[]
    readonly renderMosaic?: NcDispatcherDeps['renderMosaic']
    readonly zonePolygons?: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>
  } = {},
): Harness {
  const sends: NcSendInput[] = []
  const lines: LoggedLine[] = []
  const sleeps: number[] = []
  const renders: MosaicRenderRequest[] = []
  const objectReads: Array<{ readonly id: string; readonly scope?: NcEventMediaScope }> = []
  const trackReads: string[] = []
  const ringCuts: number[] = []
  const render =
    opts.renderMosaic ??
    ((request: MosaicRenderRequest, logger: IScopedLogger): Promise<MosaicRenderResult> =>
      renderMosaic(request, logger))
  const dispatcher = new NcDispatcher({
    logger: recordingLogger(lines),
    listTargets: async () => opts.targets ?? PUSH,
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async (kind, id, scope) => {
      if (kind === 'track') {
        trackReads.push(id)
        return store.track.get(id) ?? []
      }
      objectReads.push({ id, ...(scope !== undefined ? { scope } : {}) })
      return store.object?.(id, scope) ?? []
    },
    getDeviceName: async () => 'Front door',
    ...(opts.zonePolygons !== undefined
      ? { getZonePolygons: async () => opts.zonePolygons ?? [] }
      : {}),
    renderMosaic: (request, logger) => {
      renders.push(request)
      return render(request, logger)
    },
    renderEventMedia: async (req) => {
      ringCuts.push(req.aroundMs)
      return { gif: Uint8Array.from([1, 2, 3]), mp4: null }
    },
    now: () => CLOSED_AT + 2 * SEC,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { dispatcher, sends, lines, sleeps, renders, objectReads, trackReads, ringCuts }
}

async function deliver(h: Harness, entry: NcOutboxEntry): Promise<NcSendInput> {
  await h.dispatcher.deliver(entry)
  const sent = h.sends.at(-1)
  if (sent === undefined) throw new Error('nothing was sent')
  return sent
}

/** Track-owned clean key frames for members `1..n`, each at its own trigger instant. */
async function thumbnails(
  members: readonly NcOutboxGroupMemberV2[],
): Promise<Map<string, readonly MediaFile[]>> {
  const out = new Map<string, readonly MediaFile[]>()
  for (const [i, m] of members.entries()) {
    out.set(m.trackId, [mediaFile('keyFrame', await jpegOf(i + 1), m.triggerAt)])
  }
  return out
}

function images(sent: NcSendInput): NonNullable<NcSendInput['notification']['attachments']> {
  return (sent.notification.attachments ?? []).filter((a) => a.mediaType === 'image')
}

describe('groupedTileMembers / groupedTileEntry (pure)', () => {
  it('one member or none → null: the caller ships the single still', () => {
    expect(groupedTileMembers(undefined)).toBeNull()
    expect(groupedTileMembers(readOutboxGroup(groupV2([member(1)])))).toBeNull()
  })

  it('two or more → the members in order, at most the tile cap', () => {
    const many = Array.from({ length: 8 }, (_, i) => member(i + 1))
    const tiles = groupedTileMembers(readOutboxGroup(groupV2(many)))
    expect(tiles?.map((m) => m.trackId)).toEqual(
      many.slice(0, NC_GROUPED_MOSAIC_MAX_TILES).map((m) => m.trackId),
    )
  })

  it("a tile entry is the member's own subject, cropped, with no zone crop — and a NEW object", () => {
    const entry = makeEntry({
      media: 'best-matching',
      mediaFrame: 'full',
      mediaZoneIds: ['z-door'],
      triggerZoneIds: ['z-row'],
      matchedOn: ['class'],
    })
    const before = JSON.stringify(entry)
    const tile = groupedTileEntry(
      entry,
      member(2, {
        eventId: '42',
        eventDeviceId: OTHER_DEVICE,
        eventAt: OPENED_AT + 3 * SEC,
        triggerZoneIds: ['z-gate'],
        matchedOn: ['face'],
      }),
    )
    expect(JSON.stringify(entry)).toBe(before)
    expect(tile).not.toBe(entry)
    expect(tile.payload.subject.trackId).toBe('trk-2')
    expect(tile.payload.subject.eventId).toBe('42')
    expect(tile.payload.subject.deviceId).toBe(OTHER_DEVICE)
    expect(tile.payload.subject.timestamp).toBe(OPENED_AT + 3 * SEC)
    expect(tile.payload.triggerZoneIds).toEqual(['z-gate'])
    expect(tile.payload.matchedOn).toEqual(['face'])
    expect(tile.payload.mediaImage).toBe('crop')
    expect(tile.payload).not.toHaveProperty('mediaZoneIds')
  })

  it('a member with no event, zones or matchedOn carries none of the primary’s', () => {
    const entry = makeEntry({ triggerZoneIds: ['z-row'], matchedOn: ['face'] })
    const tile = groupedTileEntry(entry, member(3))
    expect(tile.payload.subject).not.toHaveProperty('eventId')
    expect(tile.payload.subject.deviceId).toBe(DEVICE)
    expect(tile.payload.subject.timestamp).toBe(OPENED_AT + 3 * SEC)
    expect(tile.payload).not.toHaveProperty('triggerZoneIds')
    expect(tile.payload).not.toHaveProperty('matchedOn')
  })
})

describe('the grouped mosaic at send (§6.2)', () => {
  it('1. N = 1 is byte-identical to the same row without a group (legacy frame full + zone crop: the zone is DRAWN on the clean scene)', async () => {
    const big = await jpegOf(9, 320, 240)
    const store: Store = {
      track: new Map([['trk-1', [mediaFile('keyFrame', big, CLOSED_AT)]]]),
    }
    const polygons = [
      [
        { x: 0.1, y: 0.1 },
        { x: 0.6, y: 0.1 },
        { x: 0.6, y: 0.7 },
      ],
    ]
    const payload: Partial<NcOutboxPayload> = { mediaFrame: 'full', mediaZoneIds: ['z-door'] }
    const grouped = await deliver(
      makeHarness(store, { zonePolygons: polygons }),
      makeEntry({
        ...payload,
        group: groupV2([member(1, { triggerAt: CLOSED_AT })]),
      }),
    )
    const plain = await deliver(makeHarness(store, { zonePolygons: polygons }), makeEntry(payload))
    expect(images(grouped).map((a) => a.name)).toEqual(['clean.jpg'])
    expect(grouped.notification.attachments).toEqual(plain.notification.attachments)
  })

  it('2. N = 3 → exactly one image, `mosaic.jpg`, first, at most 1920 px wide', async () => {
    const members = [member(1), member(2), member(3)]
    const h = makeHarness({ track: await thumbnails(members) })
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    const imgs = images(sent)
    expect(imgs).toHaveLength(1)
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
    expect(sent.notification.attachments?.[0]?.mime).toBe('image/jpeg')
    const bytes = imgs[0]?.bytes
    if (bytes === undefined) throw new Error('no bytes')
    const meta = await sharp(Buffer.from(bytes)).metadata()
    expect(meta.width ?? 0).toBeLessThanOrEqual(1920)
    expect(meta.width ?? 0).toBeGreaterThan(64)
    expect(h.renders).toHaveLength(1)
    expect(h.renders[0]?.purpose).toBe('grouped')
    expect(h.renders[0]?.captions).toBe('none')
    expect(h.renders[0]?.tiles).toHaveLength(3)
    const composed = h.lines.find((l) => l.message === 'grouped mosaic composed')
    expect(composed?.level).toBe('info')
    expectGroupedContext(composed)
    expect(composed?.meta).toMatchObject({ members: 3, tiles: 3, omitted: 0, capped: false })
  })

  it('2b. the mosaic is never written to the media store — it is bytes only', async () => {
    const members = [member(1), member(2)]
    const h = makeHarness({ track: await thumbnails(members) })
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    expect(sent.notification.attachments?.[0]?.bytes).toBeInstanceOf(Uint8Array)
  })

  it('3. N = 8 → 6 tiles, the capped line, and a body that counts 8', async () => {
    const members = Array.from({ length: 8 }, (_, i) => member(i + 1))
    const h = makeHarness({ track: await thumbnails(members) })
    const sent = await deliver(
      h,
      makeEntry({ group: groupV2(members), template: { body: '{{count}} soggetti' } }),
    )
    expect(sent.notification.body).toBe('8 soggetti')
    expect(h.renders[0]?.tiles).toHaveLength(NC_GROUPED_MOSAIC_MAX_TILES)
    const capped = h.lines.find((l) => l.message === 'grouped mosaic: tiles capped')
    expectGroupedContext(capped)
    expect(capped?.meta).toMatchObject({ members: 8, tiles: 6 })
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
  })

  it('4. a member with no media → its tile is omitted and named; the mosaic has 2 tiles', async () => {
    const members = [member(1), member(2), member(3)]
    const track = await thumbnails(members)
    track.delete('trk-2')
    const h = makeHarness({ track })
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    const omitted = h.lines.filter(
      (l) => l.message === 'grouped mosaic: no still for a member — tile omitted',
    )
    expect(omitted).toHaveLength(1)
    expectGroupedContext(omitted[0], 'trk-2')
    expect(omitted[0]?.meta).toMatchObject({ trackId: 'trk-2', reason: 'no-still' })
    expect(h.renders[0]?.tiles).toHaveLength(2)
    expect(h.renders[0]?.tiles.map((t) => t.sourceId)).toEqual(['trk-1', 'trk-3'])
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
    expect(h.lines.find((l) => l.message === 'grouped mosaic composed')?.meta).toMatchObject({
      members: 3,
      tiles: 2,
      omitted: 1,
    })
  })

  it('4b. only ONE still lands → it ships as is, not as a mosaic of one', async () => {
    const members = [member(1), member(2)]
    const track = await thumbnails(members)
    track.delete('trk-1')
    const h = makeHarness({ track })
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    expect(h.renders).toHaveLength(0)
    const first = sent.notification.attachments?.[0]
    expect(first?.name).toBe('clean.jpg')
    expect(await sameScene(first?.bytes, await jpegOf(2))).toBe(true)
  })

  it('5. the renderer throws → the WARN line, and the first subject’s still ships', async () => {
    const members = [member(1), member(2), member(3)]
    const h = makeHarness(
      { track: await thumbnails(members) },
      {
        renderMosaic: async () => {
          throw new Error('sharp exploded')
        },
      },
    )
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    const warn = h.lines.find(
      (l) => l.message === 'grouped mosaic could not be composed — shipping the first subject',
    )
    expect(warn?.level).toBe('warn')
    expectGroupedContext(warn, 'trk-1')
    expect(String(warn?.meta['error'])).toContain('sharp exploded')
    const first = sent.notification.attachments?.[0]
    expect(first?.name).toBe('clean.jpg')
    expect(await sameScene(first?.bytes, await jpegOf(1))).toBe(true)
  })

  it('5b. every tile dropped by the renderer → the first subject’s still ships', async () => {
    const members = [member(1), member(2)]
    const h = makeHarness(
      { track: await thumbnails(members) },
      {
        renderMosaic: async (request) => ({
          jpeg: Buffer.from([1, 2, 3]),
          layout: mosaicLayout({ tileCount: 1, withTitle: false }),
          droppedTiles: request.tiles.length,
          composedSourceIds: [],
        }),
      },
    )
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    expect(
      h.lines.some(
        (l) => l.message === 'grouped mosaic could not be composed — shipping the first subject',
      ),
    ).toBe(true)
    expect(sent.notification.attachments?.[0]?.name).toBe('clean.jpg')
  })

  it('6. a single-attachment target (telegram) receives the mosaic as its one image', async () => {
    const members = [member(1), member(2)]
    const h = makeHarness({ track: await thumbnails(members) }, { targets: TELEGRAM })
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    expect(sent.targetId).toBe(TELEGRAM[0]?.id)
    expect(images(sent)).toHaveLength(1)
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
  })

  it('7. ONE shared wait: three members that never land wait ≈ NC_STILL_WAIT_MS, not 3×', async () => {
    const members = [member(1), member(2), member(3)]
    const h = makeHarness({ track: new Map() })
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    const attempts = Math.floor(NC_STILL_WAIT_MS / NC_STILL_WAIT_INTERVAL_MS)
    const stillSleeps = h.sleeps.filter((ms) => ms === NC_STILL_WAIT_INTERVAL_MS)
    expect(stillSleeps.length).toBeGreaterThan(0)
    expect(stillSleeps.length).toBeLessThanOrEqual(attempts + 1)
    expect(images(sent)).toHaveLength(0)
    expect(
      h.lines.filter((l) => l.message === 'grouped mosaic: no still for a member — tile omitted'),
    ).toHaveLength(3)
    expect(
      h.lines.some(
        (l) => l.message === 'no still could be resolved — this notification ships text-only',
      ),
    ).toBe(true)
  })

  it('7b. a still that lands mid-wait stops the poll for that member, and the wait ends', async () => {
    const members = [member(1), member(2)]
    const files = await thumbnails(members)
    const track = new Map<string, readonly MediaFile[]>()
    let calls = 0
    const h = makeHarness({
      get track(): ReadonlyMap<string, readonly MediaFile[]> {
        calls += 1
        // Nothing on the first look; everything from the first poll on.
        if (calls > 2) for (const [k, v] of files) track.set(k, v)
        return track
      },
    })
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
    expect(h.sleeps.filter((ms) => ms === NC_STILL_WAIT_INTERVAL_MS)).toHaveLength(1)
  })

  it('8. D694: each tile reads ITS OWN generation of a reused event rowid', async () => {
    const T1 = OPENED_AT + 1 * SEC
    const T2 = OPENED_AT + 2 * SEC
    const T3 = OPENED_AT + 3 * SEC
    const byScope = new Map<string, Buffer>([
      [`${DEVICE}@${T1}`, await jpegOf(1)],
      [`${DEVICE}@${T2}`, await jpegOf(2)],
      [`${OTHER_DEVICE}@${T3}`, await jpegOf(3)],
    ])
    const store: Store = {
      track: new Map(),
      object: (id, scope) => {
        if (id !== '42' || scope === undefined) return []
        const jpeg = byScope.get(`${scope.deviceId}@${scope.recordAt}`)
        return jpeg !== undefined ? [mediaFile('fullFrame', jpeg, scope.recordAt)] : []
      },
    }
    const h = makeHarness(store)
    // Row 1, camera 104: two members whose event id is the SAME reused rowid.
    await deliver(
      h,
      makeEntry({
        group: groupV2([
          member(1, { eventId: '42', eventDeviceId: DEVICE, eventAt: T1, triggerAt: T1 }),
          member(2, { eventId: '42', eventDeviceId: DEVICE, eventAt: T2, triggerAt: T2 }),
        ]),
      }),
    )
    // Row 2, camera 591: its member reuses that rowid as well.
    await deliver(
      h,
      makeEntry(
        {
          group: groupV2([
            member(3, { eventId: '42', eventDeviceId: OTHER_DEVICE, eventAt: T3, triggerAt: T3 }),
            member(4, { triggerAt: T3 }),
          ]),
        },
        OTHER_DEVICE,
      ),
    )
    const scopes = h.objectReads.filter((r) => r.id === '42').map((r) => r.scope)
    expect(scopes).toContainEqual({ deviceId: DEVICE, recordAt: T1 })
    expect(scopes).toContainEqual({ deviceId: DEVICE, recordAt: T2 })
    expect(scopes).toContainEqual({ deviceId: OTHER_DEVICE, recordAt: T3 })
    // Never the primary's generation (the row's own subject instant).
    expect(scopes).not.toContainEqual({ deviceId: DEVICE, recordAt: CLOSED_AT })
    // Row 1's two tiles are the two generations' crops, in member order.
    const tiles = h.renders[0]?.tiles.map((t) => t.jpeg)
    expect(await sameScenes(tiles, [await jpegOf(1), await jpegOf(2)])).toBe(true)
  })

  it('9. a LEGACY D143 row with two members takes the same mosaic path (no boxes)', async () => {
    const legacy: NcOutboxGroupLegacy = {
      key: 'g',
      revision: 2,
      anchorTrackId: 'trk-1',
      members: [
        {
          trackId: 'trk-1',
          className: 'person',
          bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 },
          at: OPENED_AT + SEC,
        },
        {
          trackId: 'trk-2',
          className: 'person',
          bbox: { x: 0.6, y: 0.1, w: 0.2, h: 0.4 },
          at: OPENED_AT + 2 * SEC,
        },
      ],
    }
    const h = makeHarness({ track: await thumbnails([member(1), member(2)]) })
    const sent = await deliver(h, makeEntry({ group: legacy }))
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
    expect(h.renders[0]?.tiles).toHaveLength(2)
  })

  it('11. a grouped row that asks for a zone crop ships the mosaic UNCROPPED', async () => {
    const members = [member(1), member(2)]
    const h = makeHarness(
      { track: await thumbnails(members) },
      {
        zonePolygons: [
          [
            { x: 0.1, y: 0.1 },
            { x: 0.6, y: 0.1 },
            { x: 0.6, y: 0.7 },
          ],
        ],
      },
    )
    const sent = await deliver(h, makeEntry({ mediaZoneIds: ['z-door'], group: groupV2(members) }))
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
  })

  it('12. an undecodable tile is dropped and named by its TRACK, under the grouped purpose', async () => {
    const members = [member(1), member(2), member(3)]
    const track = await thumbnails(members)
    track.set('trk-2', [
      mediaFile('keyFrame', Buffer.from('not a jpeg'), members[1]?.triggerAt ?? 0),
    ])
    const h = makeHarness({ track })
    const sent = await deliver(h, makeEntry({ group: groupV2(members) }))
    const dropped = h.lines.find(
      (l) => l.message === 'grouped mosaic: a tile could not be decoded and was dropped',
    )
    expect(dropped?.tags['deviceId']).toBe(DEVICE)
    expect(dropped?.meta['trackId']).toBe('trk-2')
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
    expect(h.lines.find((l) => l.message === 'grouped mosaic composed')?.meta).toMatchObject({
      members: 3,
      tiles: 2,
      omitted: 1,
    })
  })

  it('13. L-1: a tile subject inherits nothing of the primary’s identity — only the member’s own', () => {
    const entry = makeEntry()
    const primary = {
      ...entry.payload.subject,
      label: 'Person A',
      labelKind: 'identity' as const,
      confidence: 0.93,
      zones: ['z-primary'],
    }
    const withPrimaryIdentity = { ...entry, payload: { ...entry.payload, subject: primary } }
    const plain = groupedTileEntry(withPrimaryIdentity, member(2)).payload.subject
    expect(plain).not.toHaveProperty('label')
    expect(plain).not.toHaveProperty('labelKind')
    expect(plain).not.toHaveProperty('confidence')
    expect(plain.zones).toEqual([])
    const own = groupedTileEntry(
      withPrimaryIdentity,
      member(3, { label: 'AB123CD', labelKind: 'plate' }),
    ).payload.subject
    expect(own.label).toBe('AB123CD')
    expect(own.labelKind).toBe('plate')
    expect(own).not.toHaveProperty('confidence')
    expect(own.zones).toEqual([])
  })

  it('14. L-2: a member whose only frame is a LATER one is named by its TRACK on the give-up line', async () => {
    const members = [member(1), member(2)]
    const track = await thumbnails(members)
    // trk-2's only frame is a minute after its qualifying instant: out of the band.
    track.set('trk-2', [
      mediaFile('keyFrame', await jpegOf(2), (members[1]?.triggerAt ?? 0) + 60 * SEC),
    ])
    const h = makeHarness({ track })
    await deliver(h, makeEntry({ group: groupV2(members) }))
    const giveUp = h.lines.filter(
      (l) => l.message === 'no still from the trigger instant — shipping a later frame',
    )
    expect(giveUp).toHaveLength(1)
    expect(giveUp[0]?.meta['trackId']).toBe('trk-2')
    expect(giveUp[0]?.tags['deviceId']).toBe(DEVICE)
  })

  it('14b. L-2: the text-only line of a mosaic names every member track', async () => {
    const members = [member(1), member(2), member(3)]
    const h = makeHarness({ track: new Map() })
    await deliver(h, makeEntry({ group: groupV2(members) }))
    const line = h.lines.find(
      (l) => l.message === 'no still could be resolved — this notification ships text-only',
    )
    expect(line?.meta['memberTrackIds']).toEqual(['trk-1', 'trk-2', 'trk-3'])
  })

  it('15. L-3: an AGED member is not polled — zero sleeps, exactly one `any` read each', async () => {
    const old = CLOSED_AT - 60 * SEC
    const members = [member(1, { triggerAt: old }), member(2, { triggerAt: old + SEC })]
    const h = makeHarness({ track: new Map() })
    await deliver(h, makeEntry({ group: groupV2(members) }))
    expect(h.sleeps.filter((ms) => ms === NC_STILL_WAIT_INTERVAL_MS)).toHaveLength(0)
    expect([...h.trackReads].sort()).toEqual(['trk-1', 'trk-2'])
  })

  it('15b. L-3: an aged member beside a fresh one — only the fresh one is polled', async () => {
    const members = [member(1, { triggerAt: CLOSED_AT - 60 * SEC }), member(2)]
    const h = makeHarness({ track: new Map() })
    await deliver(h, makeEntry({ group: groupV2(members) }))
    expect(h.trackReads.filter((id) => id === 'trk-1')).toHaveLength(1)
    expect(h.trackReads.filter((id) => id === 'trk-2').length).toBeGreaterThan(1)
  })

  it('16. M-1: the footage anchor line carries rule, windowKey and the camera tag', async () => {
    const h = makeHarness({ track: new Map() })
    await deliver(h, makeEntry({ mediaGif: true, group: groupV2([member(1), member(2)]) }))
    const line = h.lines.find(
      (l) => l.message === 'grouped row: footage anchored on the window opening',
    )
    expectGroupedContext(line)
    expect(line?.meta).not.toHaveProperty('groupKey')
    expect(h.ringCuts).toEqual([OPENED_AT])
  })

  it("10. media 'none' → no mosaic, no tile lines", async () => {
    const members = [member(1), member(2)]
    const h = makeHarness({ track: await thumbnails(members) })
    const sent = await deliver(h, makeEntry({ media: 'none', group: groupV2(members) }))
    expect(images(sent)).toHaveLength(0)
    expect(h.renders).toHaveLength(0)
    expect(h.lines.some((l) => l.message.startsWith('grouped mosaic'))).toBe(false)
  })
})

/**
 * D705 — the combined ALARM row carries the incident as a group and takes this very
 * path. Two things differ from a grouped detection row, and both are pinned here:
 * the row's system event names the SOURCE's event generation (a tile must read its
 * own), and a sensor member's owner is a RAM photograph with no subject crop.
 */
describe('an alarm incident takes the same mosaic path (D705)', () => {
  const SOURCE_AT = OPENED_AT
  const FOLLOWER_AT = OPENED_AT + 4 * SEC

  function alarmEntry(members: readonly NcOutboxGroupMemberV2[]): NcOutboxEntry {
    const base = makeEntry()
    return {
      ...base,
      recordKind: 'system-event',
      recordId: 'alarm:alarm-triggered:1',
      payload: {
        ...base.payload,
        ruleName: 'Allarme',
        delivery: 'system-event',
        media: 'best',
        group: groupV2(members),
        subject: {
          deviceId: DEVICE,
          eventId: '42',
          trackId: 'trk-1',
          className: 'event',
          zones: [],
          timestamp: CLOSED_AT,
          systemEvent: {
            kind: 'alarm-triggered',
            subject: 'alarm:1023',
            data: {},
            alarmSource: {
              ruleId: 'r-gate',
              ruleName: 'Intrusione',
              deviceId: DEVICE,
              recordId: '42',
              trackId: 'trk-1',
              eventId: '42',
              className: 'person',
              timestamp: SOURCE_AT,
            },
          },
        },
      },
    }
  }

  it('a tile drops the row’s system event, so its object read is ITS generation', () => {
    const entry = alarmEntry([])
    const tile = groupedTileEntry(
      entry,
      member(2, { eventId: '77', eventDeviceId: OTHER_DEVICE, eventAt: FOLLOWER_AT }),
    )
    expect(tile.payload.subject).not.toHaveProperty('systemEvent')
    expect(entry.payload.subject.systemEvent?.kind).toBe('alarm-triggered')
  })

  it('a member owned by a RAM photograph is tiled whole, never asked for a crop', () => {
    const entry = makeEntry()
    expect(groupedTileEntry(entry, member(1)).payload.mediaImage).toBe('crop')
    expect(
      groupedTileEntry(entry, member(2, { trackId: 'nc-mosaic:abc' })).payload.mediaImage,
    ).toBe('clean')
    expect(
      groupedTileEntry(entry, member(3, { trackId: 'nc-linked:def' })).payload.mediaImage,
    ).toBe('clean')
    expect(groupedTileEntry(entry, member(4, { trackId: 'nc-still:ghi' })).payload.mediaImage).toBe(
      'clean',
    )
  })

  it('the triggered notification ships ONE mosaic: the source’s crop and a follower on another camera', async () => {
    const byScope = new Map<string, Buffer>([
      [`${DEVICE}@${SOURCE_AT}`, await jpegOf(1)],
      [`${OTHER_DEVICE}@${FOLLOWER_AT}`, await jpegOf(2)],
    ])
    const store: Store = {
      track: new Map(),
      object: (_id, scope) => {
        if (scope === undefined) return []
        const jpeg = byScope.get(`${scope.deviceId}@${scope.recordAt}`)
        return jpeg !== undefined ? [mediaFile('fullFrame', jpeg, scope.recordAt)] : []
      },
    }
    const h = makeHarness(store)
    const sent = await deliver(
      h,
      alarmEntry([
        member(1, {
          eventId: '42',
          eventDeviceId: DEVICE,
          eventAt: SOURCE_AT,
          triggerAt: SOURCE_AT,
        }),
        member(2, {
          trackId: 'trk-follower',
          eventId: '77',
          eventDeviceId: OTHER_DEVICE,
          eventAt: FOLLOWER_AT,
          triggerAt: FOLLOWER_AT,
        }),
      ]),
    )
    expect(images(sent)).toHaveLength(1)
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
    expect(
      await sameScenes(
        h.renders[0]?.tiles.map((t) => t.jpeg),
        [await jpegOf(1), await jpegOf(2)],
      ),
    ).toBe(true)
    // The follower's read is ITS camera and instant — never the alarm source's.
    expect(h.objectReads).toContainEqual({
      id: '77',
      scope: { deviceId: OTHER_DEVICE, recordAt: FOLLOWER_AT },
    })
    expect(h.objectReads).not.toContainEqual({
      id: '77',
      scope: { deviceId: DEVICE, recordAt: SOURCE_AT },
    })
  })

  it('the group is the PICTURE: a classless (sensor) source keeps the alarm’s own subject', () => {
    const texts = new NcTextCatalog({ language: 'en' })
    const entry = alarmEntry([
      member(1),
      member(2, { trackId: 'nc-mosaic:abc', className: 'event' }),
    ])
    const systemEvent = entry.payload.subject.systemEvent
    if (systemEvent?.alarmSource === undefined) throw new Error('fixture')
    const { className: _class, ...classless } = systemEvent.alarmSource
    const sensorRow: NcOutboxEntry = {
      ...entry,
      payload: {
        ...entry.payload,
        subject: {
          ...entry.payload.subject,
          systemEvent: { ...systemEvent, alarmSource: classless },
        },
      },
    }
    // Never "1 person and 1 event": the row's sentence is the alarm's, as before D705.
    expect(buildTemplateVars(texts, sensorRow, 'Front door', [], 'UTC')['subject']).toBe(
      'alarm:1023',
    )
  })

  it('a sensor member’s shelf photograph lands as a tile beside a detection', async () => {
    const shelf = await jpegOf(5, 320, 240)
    const store: Store = {
      track: new Map([
        ['trk-1', [mediaFile('keyFrame', await jpegOf(1), SOURCE_AT)]],
        // What `stillShelfMedia` holds: scene kinds only, no subject crop.
        ['nc-mosaic:abc', [mediaFile('keyFrame', shelf, FOLLOWER_AT)]],
      ]),
    }
    const h = makeHarness(store)
    const sent = await deliver(
      h,
      alarmEntry([
        member(1, { triggerAt: SOURCE_AT }),
        member(2, { trackId: 'nc-mosaic:abc', className: 'event', triggerAt: FOLLOWER_AT }),
      ]),
    )
    expect(sent.notification.attachments?.[0]?.name).toBe('mosaic.jpg')
    expect(h.renders[0]?.tiles).toHaveLength(2)
    expect(await sameScene(h.renders[0]?.tiles[1]?.jpeg, shelf)).toBe(true)
  })
})
