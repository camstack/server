/**
 * D692 Task 13 — the AI analyst and the confirm gate judge a grouped message on its RAW tiles
 * (§6.2 item 9), never on the composite; and the cooldown rollback restores every class key.
 *
 *  - the tiles judged are the per-member stills the MOSAIC was composed from, resolved ONCE
 *    per delivery and shared by the gate, the analyst and the mosaic: the crop judged is the
 *    crop shipped (D52). Never a second read, never the composite;
 *  - a grouped row whose every tile failed to land is judged on NO image (the gate's own
 *    no-image policy) and narrated not at all — the composite is never the fallback;
 *  - each tile is asked about ITS member's class;
 *  - the confirm gate runs per tile, sequentially, inside ONE `confirm.timeoutMs` for the
 *    whole pass: CONFIRMED if ANY tile is, rejected only if EVERY tile answered rejected;
 *  - a rejection hands back EVERY `payload.cooldowns` key, each only if no later fire has
 *    replaced it (§3.6).
 *
 * The rows the dispatcher cases deliver are the ones the REAL centre closes and persists.
 */
import type { MediaFile } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  type NcConfirmGateInput,
  type NcCooldownRelease,
  NcDispatcher,
  type NcSendInput,
} from '../dispatcher.js'
import type { NcOutboxConfirmVerdict, NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import type { NcRuleAiInput } from '../rule-ai-analyst.js'
import {
  type MosaicRenderRequest,
  type MosaicRenderResult,
  mosaicLayout,
} from '../summary/mosaic-renderer.js'
import {
  boot,
  DEVICE,
  event,
  type Harness,
  type LoggedLine,
  makeHarness,
  makeLogRecorder,
  payloads,
  rule,
  T0,
} from './grouped-harness.js'

const COMPOSITE = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9, 9])
/** The byte a picture OTHER than the tile carries — the one a second media read would pick. */
const OTHER = 77

/** A distinct tile per track: the byte after the JPEG magic is the track's number. */
function tileBytes(trackId: string): Buffer {
  const n = Number(trackId.replace(/\D/g, ''))
  return Buffer.from([0xff, 0xd8, 0xff, 0xdb, n])
}

function file(kind: MediaFile['kind'], bytes: Buffer, mediaId: number): MediaFile {
  return {
    mediaId,
    kind,
    base64: bytes.toString('base64'),
    sizeBytes: bytes.byteLength,
    timestamp: T0,
    url: `http://media/${String(mediaId)}`,
  }
}

function trackFiles(trackId: string): readonly MediaFile[] {
  return [
    // The ladder's pick for the mosaic tile (the clean source, D897)…
    file('keyFrame', tileBytes(trackId), 1),
    // …and a DIFFERENT picture of the same owner: a judge that reads the owner a second
    // time on a ladder of its own (a stored subject crop) judges this one, not what ships.
    file('thumbnail', Buffer.from([0xff, 0xd8, 0xff, 0xdb, OTHER]), 2),
  ]
}

const CONFIRMED: NcOutboxConfirmVerdict = {
  decision: 'confirmed',
  reason: 'two people at the door',
  count: 2,
  latencyMs: 100,
  at: 1,
}
const REJECTED: NcOutboxConfirmVerdict = {
  decision: 'suppressed',
  reason: 'the door is empty',
  count: 0,
  latencyMs: 100,
  at: 1,
}
const FAILED_OPEN: NcOutboxConfirmVerdict = {
  decision: 'failed-open',
  reason: 'no verdict within 8000ms',
  failOpen: 'timeout',
  latencyMs: 8000,
  at: 1,
}
/** No answer, under `onTimeout: 'suppress'` — the gate's own suppressing no-answer. */
const NO_ANSWER_SUPPRESSED: NcOutboxConfirmVerdict = {
  decision: 'suppressed',
  reason: 'no verdict within 8000ms',
  failOpen: 'timeout',
  latencyMs: 8000,
  at: 1,
}

function trackOf(bytes: Uint8Array): string {
  return `trk-${bytes[4]}`
}

/** Close ONE window over `members` (track id, class) on the real centre; its persisted row. */
async function closedRow(
  h: Harness,
  members: ReadonlyArray<{ readonly trackId: string; readonly className?: string }>,
): Promise<NcOutboxPayload> {
  await boot(
    h,
    rule({
      conditions: { classes: ['person', 'dog'] },
      throttle: { cooldownSec: 600, scope: 'rule-device' },
      confirm: { enabled: true },
      media: { attach: 'best' },
    }),
  )
  for (const [i, m] of members.entries()) {
    h.outlooks.set(m.trackId, { final: true })
    h.center.onObjectEventPersisted(
      event({
        trackId: m.trackId,
        ...(m.className !== undefined ? { className: m.className } : {}),
        timestamp: T0 + i * 100,
      }),
    )
  }
  await h.settle()
  await h.tick(T0 + 5_000)
  const row = payloads(h.world)[0]
  if (row === undefined) throw new Error('the window did not close into a row')
  return row
}

function entryOf(payload: NcOutboxPayload): NcOutboxEntry {
  return {
    id: 'rule-1:grp:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: DEVICE,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: payload.subject.trackId,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: T0,
    updatedAt: T0,
    payload,
  }
}

interface DispatchHarness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
  readonly gateCalls: NcConfirmGateInput[]
  readonly aiCalls: NcRuleAiInput[]
  readonly releases: NcCooldownRelease[]
  /** The tiles the MOSAIC was composed from, in order. */
  readonly mosaicTiles: Buffer[]
  readonly lines: LoggedLine[]
  linesOf(msg: string): LoggedLine[]
}

interface DispatchOptions {
  /** The media store read (default: {@link trackFiles} for every track owner). */
  readonly getMediaForOwner?: (kind: 'object' | 'track', id: string) => readonly MediaFile[]
  /** How far the clock moves while the gate judges one tile (default 100 ms). */
  readonly gateMs?: number
  /** Replaces the composition (default: composes every tile it is offered). */
  readonly renderMosaic?: (input: MosaicRenderRequest) => Promise<MosaicRenderResult>
}

type TileAnswer = (trackId: string, input: NcConfirmGateInput) => NcOutboxConfirmVerdict | 'throw'

/** `answer` decides each tile's verdict from the track whose still it was handed. */
function makeDispatcher(answer: TileAnswer, options: DispatchOptions = {}): DispatchHarness {
  const sends: NcSendInput[] = []
  const gateCalls: NcConfirmGateInput[] = []
  const aiCalls: NcRuleAiInput[] = []
  const releases: NcCooldownRelease[] = []
  const mosaicTiles: Buffer[] = []
  const recording = makeLogRecorder()
  let now = T0 + 6_000
  const read = options.getMediaForOwner ?? ((kind, id) => (kind === 'track' ? trackFiles(id) : []))
  const dispatcher = new NcDispatcher({
    logger: recording.logger,
    listTargets: async () => [
      { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async (kind, id) => read(kind, id),
    getDeviceName: async () => 'Front door',
    now: () => now,
    sleep: async () => undefined,
    renderMosaic:
      options.renderMosaic ??
      (async (input): Promise<MosaicRenderResult> => {
        for (const tile of input.tiles) mosaicTiles.push(tile.jpeg)
        return {
          jpeg: COMPOSITE,
          layout: mosaicLayout({ tileCount: input.tiles.length, withTitle: false }),
          droppedTiles: 0,
          composedSourceIds: input.tiles.map((t) => t.sourceId),
        }
      }),
    confirmGate: async (input) => {
      gateCalls.push(input)
      now += options.gateMs ?? 100
      const bytes = input.image?.bytes
      const verdict = answer(bytes === undefined ? 'none' : trackOf(bytes), input)
      if (verdict === 'throw') throw new Error('gate exploded')
      return verdict
    },
    confirmStats: () => ({ confirmed: 0, suppressed: 0, failedOpen: 0 }),
    ruleAi: async (input) => {
      aiCalls.push(input)
      return { text: 'Two people stand at the door.', latencyMs: 10, images: input.frames.length }
    },
    ruleAiStats: () => ({ described: 1, failedOpen: 0, refuted: 0 }),
    releaseCooldown: (input) => {
      releases.push(input)
    },
  })
  return {
    dispatcher,
    sends,
    gateCalls,
    aiCalls,
    releases,
    mosaicTiles,
    lines: recording.lines,
    linesOf: (msg) => recording.lines.filter((l) => l.msg === msg),
  }
}

function withAi(payload: NcOutboxPayload): NcOutboxPayload {
  return { ...payload, ai: { shape: 'detection-immediate' } }
}

function withConfirm(
  payload: NcOutboxPayload,
  confirm: NonNullable<NcOutboxPayload['confirm']>,
): NcOutboxPayload {
  return { ...payload, confirm: { ...payload.confirm, ...confirm } }
}

/** A grouped row with the analyst on, as the dispatcher is handed it. */
function withAiEntry(payload: NcOutboxPayload): NcOutboxEntry {
  return entryOf(withAi(payload))
}

function gateTracks(d: DispatchHarness): string[] {
  return d.gateCalls.map((c) => (c.image === null ? 'none' : trackOf(c.image.bytes)))
}

function isComposite(bytes: Uint8Array | undefined): boolean {
  return Buffer.from(bytes ?? []).equals(COMPOSITE)
}

const PEOPLE = [{ trackId: 'trk-1' }, { trackId: 'trk-2' }, { trackId: 'trk-3' }] as const
const NO_TILE_LINE = 'grouped confirm: no raw tile landed — the composite is never judged'
const NO_PICTURE_LINE = 'grouped confirm: the rule ships no picture'
const BUDGET_LINE = 'grouped confirm: the pass budget is spent — tiles left unjudged'

describe('grouped AI and confirm on the raw tiles (D692 Task 13)', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('(a) the analyst receives the MOSAIC tiles, one per subject, each with its class', async () => {
    h = makeHarness()
    const row = withAi(
      await closedRow(h, [
        { trackId: 'trk-1' },
        { trackId: 'trk-2', className: 'dog' },
        { trackId: 'trk-3' },
      ]),
    )
    const d = makeDispatcher(() => CONFIRMED)
    await d.dispatcher.deliver(entryOf(row))

    expect(d.aiCalls).toHaveLength(1)
    const input = d.aiCalls[0]
    const frames = input?.frames ?? []
    // The crop judged is the crop shipped (D52): the very bytes the mosaic was composed from.
    expect(d.mosaicTiles).toHaveLength(3)
    expect(frames.map((f) => Buffer.from(f.bytes))).toEqual(d.mosaicTiles)
    expect(frames.map((f) => trackOf(f.bytes))).toEqual(['trk-1', 'trk-2', 'trk-3'])
    expect(input?.subjects).toEqual(['person', 'dog', 'person'])
    // The shipped picture is the composite; the model never saw it.
    const shipped = d.sends[0]?.notification.attachments?.find((a) => a.mediaType === 'image')
    expect(isComposite(shipped?.bytes)).toBe(true)
    for (const f of frames) expect(isComposite(f.bytes)).toBe(false)
  })

  it('(a2) no raw tile landed → no narration at all, named grouped-no-raw-tile', async () => {
    h = makeHarness()
    const row = withAi(await closedRow(h, PEOPLE))
    const d = makeDispatcher(() => CONFIRMED, { getMediaForOwner: () => [] })
    await d.dispatcher.deliver(entryOf(row))
    expect(d.aiCalls).toHaveLength(0)
    const skipped = d.linesOf('notification AI skipped — no picture to describe')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.meta['reason']).toBe('grouped-no-raw-tile')
    expect(skipped[0]?.tags['deviceId']).toBe(DEVICE)
  })

  it('(b) confirm: tiles 1 and 2 rejected, tile 3 confirmed → DELIVERED, latency = the pass', async () => {
    h = makeHarness()
    const row = await closedRow(h, PEOPLE)
    const d = makeDispatcher((trackId) => (trackId === 'trk-3' ? CONFIRMED : REJECTED))
    const result = await d.dispatcher.deliver(entryOf(row))

    expect(gateTracks(d)).toEqual(['trk-1', 'trk-2', 'trk-3'])
    expect(d.gateCalls.map((c) => Buffer.from(c.image?.bytes ?? []))).toEqual(d.mosaicTiles)
    for (const c of d.gateCalls) expect(isComposite(c.image?.bytes)).toBe(false)
    expect(d.sends).toHaveLength(1)
    expect(d.releases).toHaveLength(0)
    expect(result).toMatchObject({
      ok: true,
      confirm: {
        decision: 'confirmed',
        // Three tiles at 100 ms each: the WHOLE pass, never the last tile's own call.
        latencyMs: 300,
        tiles: { confirmed: 1, rejected: 2, noAnswer: 0, unjudged: 0, untried: 0 },
      },
    })
    // L-1: the delivered line carries the tile counts.
    const delivered = d.linesOf('notification delivered')
    expect(delivered[0]?.meta['confirmTiles']).toEqual({
      confirmed: 1,
      rejected: 2,
      noAnswer: 0,
      unjudged: 0,
      untried: 0,
    })
    expect(delivered[0]?.meta['confirmMs']).toBe(300)
  })

  it('(b2) each tile is asked about ITS member class, never the primary class', async () => {
    h = makeHarness()
    const row = await closedRow(h, [{ trackId: 'trk-1' }, { trackId: 'trk-2', className: 'dog' }])
    const d = makeDispatcher(() => REJECTED)
    await d.dispatcher.deliver(entryOf(row))
    expect(d.gateCalls.map((c) => [gateTracks(d)[d.gateCalls.indexOf(c)], c.className])).toEqual([
      ['trk-1', 'person'],
      ['trk-2', 'dog'],
    ])
  })

  it('(c) every tile rejected → suppressed, and EVERY cooldown key is handed back', async () => {
    h = makeHarness()
    const row = await closedRow(h, [
      { trackId: 'trk-1' },
      { trackId: 'trk-2' },
      { trackId: 'trk-3', className: 'dog' },
    ])
    const stamps = row.cooldowns ?? []
    expect(stamps).toHaveLength(2)
    expect(row.cooldown).toBeUndefined()

    const d = makeDispatcher(() => REJECTED)
    const result = await d.dispatcher.deliver(entryOf(row))

    expect(d.gateCalls).toHaveLength(3)
    expect(d.sends).toHaveLength(0)
    expect(result).toMatchObject({
      ok: true,
      confirm: { decision: 'suppressed', tiles: { confirmed: 0, rejected: 3 } },
    })
    expect(d.releases).toEqual(
      stamps.map((s) => ({ key: s.key, at: s.at, ruleId: 'rule-1', deviceId: DEVICE })),
    )
  })

  it('(c2) a rollback that throws on one key still hands back the others', async () => {
    h = makeHarness()
    const row = await closedRow(h, [{ trackId: 'trk-1' }, { trackId: 'trk-3', className: 'dog' }])
    const seen: string[] = []
    const flaky = new NcDispatcher({
      logger: makeSilentLogger(),
      listTargets: async () => [
        { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
      ],
      send: async () => ({ success: true }),
      getMediaForOwner: async (_kind, id) => trackFiles(id),
      getDeviceName: async () => 'Front door',
      now: () => T0 + 6_000,
      sleep: async () => undefined,
      renderMosaic: async () => ({
        jpeg: COMPOSITE,
        layout: mosaicLayout({ tileCount: 2, withTitle: false }),
        droppedTiles: 0,
        composedSourceIds: ['trk-1', 'trk-3'],
      }),
      confirmGate: async () => REJECTED,
      releaseCooldown: (input) => {
        seen.push(input.key)
        if (seen.length === 1) throw new Error('boom')
      },
    })
    await flaky.deliver(entryOf(row))
    expect(seen).toEqual((row.cooldowns ?? []).map((s) => s.key))
  })

  it('(e) a tile whose gate THROWS among rejections → delivered, with a failed-open verdict', async () => {
    h = makeHarness()
    const row = await closedRow(h, PEOPLE)
    const d = makeDispatcher((trackId) => (trackId === 'trk-2' ? 'throw' : REJECTED))
    const result = await d.dispatcher.deliver(entryOf(row))
    expect(d.gateCalls).toHaveLength(3)
    expect(d.sends).toHaveLength(1)
    expect(d.releases).toHaveLength(0)
    // M-2: the row records that the gate ran and what it saw, not "no verdict".
    expect(result).toMatchObject({
      ok: true,
      confirm: {
        decision: 'failed-open',
        failOpen: 'error',
        latencyMs: 300,
        tiles: { confirmed: 0, rejected: 2, unjudged: 1 },
      },
    })
  })

  it('(f) a failed-open tile among rejections delivers, with the fail-open verdict', async () => {
    h = makeHarness()
    const row = await closedRow(h, PEOPLE)
    const d = makeDispatcher((trackId) => (trackId === 'trk-1' ? FAILED_OPEN : REJECTED))
    const result = await d.dispatcher.deliver(entryOf(row))
    expect(d.sends).toHaveLength(1)
    expect(result).toMatchObject({
      ok: true,
      confirm: { decision: 'failed-open', tiles: { rejected: 2, unjudged: 1 } },
    })
  })

  it('(g) the mosaic composes from stills a second owner read would not find → the gate judges THOSE tiles, never the composite', async () => {
    h = makeHarness()
    const row = await closedRow(h, PEOPLE)
    // Only the members' OBJECT events hold a still; their track owners hold nothing.
    const d = makeDispatcher(() => REJECTED, {
      getMediaForOwner: (kind, id) =>
        kind === 'object' ? [file('fullFrame', tileBytes(`trk-${id}`), 3)] : [],
    })
    await d.dispatcher.deliver(entryOf(row))
    // The mosaic DID compose: three raw tiles landed.
    expect(d.mosaicTiles).toHaveLength(3)
    expect(d.gateCalls).toHaveLength(3)
    for (const c of d.gateCalls) expect(isComposite(c.image?.bytes)).toBe(false)
    expect(d.gateCalls.map((c) => Buffer.from(c.image?.bytes ?? []))).toEqual(d.mosaicTiles)
  })

  it('(g2) no raw tile landed → ONE call with NO image, and the line says the composite is never judged', async () => {
    h = makeHarness()
    const row = await closedRow(h, PEOPLE)
    const d = makeDispatcher(() => FAILED_OPEN, { getMediaForOwner: () => [] })
    await d.dispatcher.deliver(entryOf(row))
    expect(d.gateCalls).toHaveLength(1)
    expect(d.gateCalls[0]?.image).toBeNull()
    const lines = d.linesOf(NO_TILE_LINE)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('info')
    expect(lines[0]?.tags['deviceId']).toBe(DEVICE)
    expect(lines[0]?.meta).toMatchObject({ ruleId: 'rule-1', tiles: 0 })
    expect(lines[0]?.meta['windowKey']).toBeTypeOf('string')
    expect(lines[0]?.meta['rule']).toBeTypeOf('string')
  })

  it('(g3) exactly ONE raw still landed → it is what ships, and the gate judges it, with its class', async () => {
    h = makeHarness()
    const row = await closedRow(h, [{ trackId: 'trk-1' }, { trackId: 'trk-2', className: 'dog' }])
    const d = makeDispatcher(() => CONFIRMED, {
      getMediaForOwner: (kind, id) => (kind === 'track' && id === 'trk-2' ? trackFiles(id) : []),
    })
    await d.dispatcher.deliver(entryOf(row))
    const shipped = d.sends[0]?.notification.attachments?.find((a) => a.mediaType === 'image')
    expect(trackOf(shipped?.bytes ?? new Uint8Array())).toBe('trk-2')
    expect(gateTracks(d)).toEqual(['trk-2'])
    expect(d.gateCalls[0]?.className).toBe('dog')
    expect(d.linesOf(NO_TILE_LINE)).toHaveLength(0)
  })

  it('(h) a linked-set row (tiles, no group) keeps its one gate call on what ships', async () => {
    h = makeHarness()
    const { group: _group, ...closed } = await closedRow(h, PEOPLE)
    const row: NcOutboxPayload = {
      ...closed,
      subject: {
        ...closed.subject,
        analysisTiles: [
          { ownerId: 'trk-1', cameraId: DEVICE },
          { ownerId: 'trk-2', cameraId: DEVICE + 1 },
        ],
      },
    }
    const d = makeDispatcher(() => REJECTED)
    await d.dispatcher.deliver(entryOf(row))
    expect(d.gateCalls).toHaveLength(1)
  })

  it('(i) H-1: the whole pass is bounded by ONE confirm.timeoutMs — no tile starts after it', async () => {
    h = makeHarness()
    const row = withConfirm(await closedRow(h, PEOPLE), { timeoutMs: 1_000 })
    const d = makeDispatcher(() => REJECTED, { gateMs: 600 })
    const result = await d.dispatcher.deliver(entryOf(row))
    // Tile 1 gets the whole budget, tile 2 what is left of it, tile 3 never starts.
    expect(d.gateCalls.map((c) => c.confirm.timeoutMs)).toEqual([1_000, 400])
    // An untried tile is not a rejection: fail-open by default.
    expect(d.sends).toHaveLength(1)
    expect(result).toMatchObject({
      ok: true,
      confirm: {
        decision: 'failed-open',
        failOpen: 'timeout',
        latencyMs: 1_200,
        tiles: { confirmed: 0, rejected: 2, unjudged: 1, untried: 1 },
      },
    })
    const budget = d.linesOf(BUDGET_LINE)
    expect(budget).toHaveLength(1)
    expect(budget[0]?.tags['deviceId']).toBe(DEVICE)
    expect(budget[0]?.meta).toMatchObject({ budgetMs: 1_000, untried: 1, judged: 2 })
  })

  it('(i2) under onTimeout:suppress an untried tile is a no-answer, and the pass suppresses', async () => {
    h = makeHarness()
    const row = withConfirm(await closedRow(h, PEOPLE), {
      timeoutMs: 1_000,
      onTimeout: 'suppress',
    })
    const d = makeDispatcher(() => REJECTED, { gateMs: 600 })
    const result = await d.dispatcher.deliver(entryOf(row))
    expect(d.sends).toHaveLength(0)
    expect(result).toMatchObject({
      confirm: {
        decision: 'suppressed',
        tiles: { confirmed: 0, rejected: 2, noAnswer: 1, untried: 1 },
      },
    })
  })

  it('(j) L-5: a suppressing no-answer tile is counted as noAnswer, never as a rejection', async () => {
    h = makeHarness()
    const row = await closedRow(h, PEOPLE)
    const d = makeDispatcher((trackId) => (trackId === 'trk-2' ? NO_ANSWER_SUPPRESSED : REJECTED))
    const result = await d.dispatcher.deliver(entryOf(row))
    expect(d.sends).toHaveLength(0)
    expect(result).toMatchObject({
      confirm: { decision: 'suppressed', tiles: { confirmed: 0, rejected: 2, noAnswer: 1 } },
    })
  })

  it('(k) M-A: the composition FAILS → the first still ships, and the gate judges ONLY that still', async () => {
    h = makeHarness()
    const row = await closedRow(h, PEOPLE)
    const failing = (): Promise<MosaicRenderResult> => Promise.reject(new Error('sharp exploded'))
    // Only tile 2 would confirm. The first still is what ships, so tile 2 must not be asked.
    const d = makeDispatcher((trackId) => (trackId === 'trk-2' ? CONFIRMED : REJECTED), {
      renderMosaic: failing,
    })
    const result = await d.dispatcher.deliver(withAiEntry(row))
    expect(gateTracks(d)).toEqual(['trk-1'])
    expect(d.sends).toHaveLength(0)
    expect(d.releases.length).toBeGreaterThan(0)
    expect(result).toMatchObject({
      ok: true,
      confirm: { decision: 'suppressed', tiles: { confirmed: 0, rejected: 1 } },
    })
    // …and the analyst, when the first still does ship, sees that still alone.
    const shipping = makeDispatcher(() => CONFIRMED, { renderMosaic: failing })
    await shipping.dispatcher.deliver(withAiEntry(row))
    expect(shipping.sends).toHaveLength(1)
    const shipped = shipping.sends[0]?.notification.attachments?.find(
      (a) => a.mediaType === 'image',
    )
    expect(trackOf(shipped?.bytes ?? new Uint8Array())).toBe('trk-1')
    expect(gateTracks(shipping)).toEqual(['trk-1'])
    expect(shipping.aiCalls[0]?.frames.map((f) => trackOf(f.bytes))).toEqual(['trk-1'])
    expect(shipping.aiCalls[0]?.subjects).toBeUndefined()
  })

  it('(k2) M-A: the renderer DROPS a tile → only the tiles actually composed are judged', async () => {
    h = makeHarness()
    const row = await closedRow(h, PEOPLE)
    const d = makeDispatcher((trackId) => (trackId === 'trk-2' ? CONFIRMED : REJECTED), {
      renderMosaic: async (input) => ({
        jpeg: COMPOSITE,
        layout: mosaicLayout({ tileCount: 2, withTitle: false }),
        droppedTiles: 1,
        composedSourceIds: input.tiles.filter((t) => t.sourceId !== 'trk-2').map((t) => t.sourceId),
      }),
    })
    await d.dispatcher.deliver(withAiEntry(row))
    // trk-2 is not in the picture, so its confirmation cannot ship the picture.
    expect(gateTracks(d)).toEqual(['trk-1', 'trk-3'])
    expect(d.sends).toHaveLength(0)
    expect(d.aiCalls).toHaveLength(0)
  })

  it('(l) R8: ONE landed tile with the AI on → the analyst is told the member class, no subjects', async () => {
    h = makeHarness()
    const row = withAi(
      await closedRow(h, [{ trackId: 'trk-1' }, { trackId: 'trk-2', className: 'dog' }]),
    )
    const d = makeDispatcher(() => CONFIRMED, {
      getMediaForOwner: (kind, id) => (kind === 'track' && id === 'trk-2' ? trackFiles(id) : []),
    })
    await d.dispatcher.deliver(entryOf(row))
    expect(d.aiCalls).toHaveLength(1)
    expect(d.aiCalls[0]?.className).toBe('dog')
    expect(d.aiCalls[0]?.subjects).toBeUndefined()
    expect(d.aiCalls[0]?.frames.map((f) => trackOf(f.bytes))).toEqual(['trk-2'])
  })

  it('(m) L-A: a tile is untried when what is left of the budget is under min(1s, budget/4)', async () => {
    h = makeHarness()
    const row = withConfirm(await closedRow(h, PEOPLE), { timeoutMs: 1_000 })
    // After tile 1, 200 ms remain: under the 250 ms floor, so tiles 2 and 3 never start.
    const d = makeDispatcher(() => REJECTED, { gateMs: 800 })
    const result = await d.dispatcher.deliver(entryOf(row))
    expect(d.gateCalls.map((c) => c.confirm.timeoutMs)).toEqual([1_000])
    expect(result).toMatchObject({
      confirm: { decision: 'failed-open', tiles: { rejected: 1, unjudged: 2, untried: 2 } },
    })
  })

  it('(n) L-B: the suppressed verdict names a REAL rejection even when a no-answer came first', async () => {
    h = makeHarness()
    const row = withConfirm(await closedRow(h, PEOPLE), { onTimeout: 'suppress' })
    const d = makeDispatcher((trackId) =>
      trackId === 'trk-1'
        ? NO_ANSWER_SUPPRESSED
        : trackId === 'trk-2'
          ? REJECTED
          : NO_ANSWER_SUPPRESSED,
    )
    const result = await d.dispatcher.deliver(entryOf(row))
    expect(d.sends).toHaveLength(0)
    expect(result).toMatchObject({
      confirm: {
        decision: 'suppressed',
        reason: REJECTED.reason,
        tiles: { rejected: 1, noAnswer: 2 },
      },
    })
    if (result.ok) expect(result.confirm?.failOpen).toBeUndefined()
    // With NO real rejection the no-answer is the representative, as before.
    const none = makeDispatcher(() => NO_ANSWER_SUPPRESSED)
    const r2 = await none.dispatcher.deliver(entryOf(row))
    expect(r2).toMatchObject({ confirm: { decision: 'suppressed', failOpen: 'timeout' } })
  })

  it('(o) L-C: media none → a DEBUG "the rule ships no picture", never the "no raw tile landed" INFO', async () => {
    h = makeHarness()
    const row: NcOutboxPayload = { ...(await closedRow(h, PEOPLE)), media: 'none' }
    const d = makeDispatcher(() => FAILED_OPEN)
    await d.dispatcher.deliver(entryOf(row))
    expect(d.gateCalls).toHaveLength(1)
    expect(d.gateCalls[0]?.image).toBeNull()
    expect(d.linesOf(NO_TILE_LINE)).toHaveLength(0)
    const none = d.linesOf(NO_PICTURE_LINE)
    expect(none).toHaveLength(1)
    expect(none[0]?.level).toBe('debug')
    expect(none[0]?.tags['deviceId']).toBe(DEVICE)
  })

  it('(d) the rollback hands back a key only while its fire is the latest', async () => {
    let release: (() => void) | undefined
    const verdictHeld = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: (() => void) | undefined
    const gateEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    h = makeHarness({
      getMediaForOwner: async (_kind, id) => trackFiles(id),
      confirmGate: async () => {
        entered?.()
        await verdictHeld
        return REJECTED
      },
    })
    await boot(
      h,
      rule({
        conditions: { classes: ['person', 'dog'] },
        throttle: { cooldownSec: 1, scope: 'rule-device' },
        confirm: { enabled: true },
      }),
    )
    for (const id of ['trk-1', 'trk-2', 'trk-d', 'trk-d2']) h.outlooks.set(id, { final: true })
    h.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 }))
    h.center.onObjectEventPersisted(
      event({ trackId: 'trk-2', className: 'dog', timestamp: T0 + 100 }),
    )
    await h.settle()

    // Window 1 closes at T0+5s and stamps person@T0+5s and dog@T0+5s; its row is held in the
    // gate while a LATER dog fire replaces only the dog key.
    await h.tick(T0 + 5_000)
    const firstDrain = h.tick(T0 + 5_000)
    await gateEntered
    h.setNow(T0 + 9_000)
    h.center.onObjectEventPersisted(
      event({ trackId: 'trk-d', className: 'dog', timestamp: T0 + 9_000 }),
    )
    await h.settle()
    await h.tick(T0 + 15_000)
    expect(h.center.groupedOpenWindows()).toHaveLength(0)

    release?.()
    await firstDrain

    const released = h.linesOf('cooldown released — the suppressed fire gives its window back')
    const kept = h.linesOf('cooldown NOT released — a later fire owns this window')
    expect(released).toHaveLength(1)
    expect(kept).toHaveLength(1)
    expect(String(released[0]?.meta['key'])).toContain('person')
    expect(String(kept[0]?.meta['key'])).toContain('dog')
    expect(released[0]?.tags['deviceId']).toBe(DEVICE)
  })
})
