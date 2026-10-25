import type { IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { ncRecordKinds } from '../../record-kinds.js'
import { makeNcRecords } from '../../__tests__/support/nc-test-deps.js'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callDeferredRelease } from '../../../__tests__/support/vitest-mock.js'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcArtifactPublishMeta } from '../../artifact-index.js'
import type { NcOutboxEnqueueInput } from '../../outbox.js'
import type { NcSummaryAiInput, NcSummaryAiOutcome } from '../summary-ai.js'
import { NcSummaryCollector } from '../summary-collector.js'
import {
  NcSummaryProducer,
  type NcSummaryProducerDeps,
  type SummarySubjectShot,
  summaryEligibilityFloor,
} from '../summary-producer.js'
import { NcSummaryRuleInputSchema } from '../summary-rule.js'
import type { SummaryCandidate, SummaryMediaRow } from '../summary-selection.js'
import { NcSummaryStore } from '../summary-store.js'

/**
 * A deterministic media ROW id for a track's fixture row (D482).
 *
 * Distinct per track, and that matters: the producer's ladders de-duplicate and
 * re-rank BY id, so one shared value would collapse several tracks' tiles into
 * one. The fixtures used to carry `m-<trackId>` as a composite key, which
 * carried the distinctness for free.
 */
function mediaIdForTrack(trackId: string): number {
  let hash = 0
  for (const ch of trackId) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000
  return 10_000 + hash
}

async function jpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 160, height: 90, channels: 3, background: '#334455' },
  })
    .jpeg()
    .toBuffer()
}

/** A motion rule: the window closes 5 min after the last motion, ceiling 30 min. */
function motionRuleInput(over: Record<string, unknown> = {}) {
  return NcSummaryRuleInputSchema.parse({
    name: 'esterni',
    deviceIds: [636, 637],
    window: { kind: 'motion', quietSeconds: 300, maxWindowSeconds: 1_800 },
    targets: [{ targetId: 'zentik-1' }],
    barrierSeconds: 120,
    ...over,
  })
}

function candidate(over: Partial<SummaryCandidate> & { trackId: string }): SummaryCandidate {
  return {
    deviceId: 636,
    className: 'person',
    firstSeen: 1_000,
    lastSeen: 5_000,
    importance: 0.5,
    zones: [],
    ...over,
  }
}

interface Harness {
  readonly producer: NcSummaryProducer
  readonly store: NcSummaryStore
  readonly collector: NcSummaryCollector
  readonly enqueued: NcOutboxEnqueueInput[][]
  readonly published: number[]
  /** The index metadata each publish carried — a digest must be filed under
   *  its rule and its cameras, or the viewer's library cannot find it. */
  readonly publishedMeta: NcArtifactPublishMeta[]
  readonly filed: string[]
  setNow(ms: number): void
  setTracks(rows: readonly SummaryCandidate[]): void
  setMedia(rows: readonly SummaryMediaRow[]): void
  readMediaCalls(): number
}

async function makeHarness(over: Partial<NcSummaryProducerDeps> = {}): Promise<Harness> {
  const world = makeNcRecords()
  let seq = 0
  let now = 100_000
  let tracks: readonly SummaryCandidate[] = []
  let media: readonly SummaryMediaRow[] = [
    { mediaId: 8005, kind: 'thumbnail', timestamp: 3_000, sizeBytes: null },
  ]
  let readMediaCalls = 0
  const bytes = await jpeg()
  const store = new NcSummaryStore({
    kind: world.records.kind(ncRecordKinds['summary-rules']),
    logger: makeSilentLogger(),
    now: () => now,
    newId: () => `sum-${(seq += 1)}`,
  })
  const collector = new NcSummaryCollector()
  const enqueued: NcOutboxEnqueueInput[][] = []
  const published: number[] = []
  const publishedMeta: NcArtifactPublishMeta[] = []
  const filed: string[] = []
  const producer = new NcSummaryProducer({
    logger: makeSilentLogger(),
    now: () => now,
    store,
    collector,
    enqueue: async (rows) => {
      enqueued.push([...rows])
      return rows.length
    },
    listTracks: async ({ deviceId }) => tracks.filter((t) => t.deviceId === deviceId),
    listMediaInfo: async () => media,
    readMedia: async () => {
      readMediaCalls += 1
      return bytes
    },
    publish: async (b, _mime, meta) => {
      published.push(b.byteLength)
      publishedMeta.push(meta)
      return { url: 'https://hub/artifact/x.jpg', artifactId: 'art-1' }
    },
    storeMosaic: async ({ ruleId }) => {
      filed.push(ruleId)
      return 9001
    },
    ...over,
  })
  return {
    producer,
    store,
    collector,
    enqueued,
    published,
    publishedMeta,
    filed,
    setNow: (ms) => {
      now = ms
    },
    setTracks: (rows) => {
      tracks = rows
    },
    setMedia: (rows) => {
      media = rows
    },
    readMediaCalls: () => readMediaCalls,
  }
}

describe('summaryEligibilityFloor', () => {
  it('is the later of the rule birth and its last delivered window', () => {
    expect(summaryEligibilityFloor({ createdAt: 500, generatedAt: 900 } as never)).toBe(900)
    expect(summaryEligibilityFloor({ createdAt: 5_000 } as never)).toBe(5_000)
  })
})

describe('NcSummaryProducer — the motion window and its barrier', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  it('does nothing at all before any motion', async () => {
    await h.store.create(motionRuleInput(), 'admin')
    expect(await h.producer.tick()).toMatchObject({ idle: 1, produced: 0 })
    expect(h.enqueued).toHaveLength(0)
  })

  it('collects while motion keeps arriving', async () => {
    await h.store.create(motionRuleInput(), 'admin')
    h.collector.observeMotion({ deviceId: 636, atMs: 200_000 })
    h.setNow(400_000)
    expect(await h.producer.tick()).toMatchObject({ collecting: 1 })
  })

  it('HOLDS the closed window while a track it opened is still running', async () => {
    await h.store.create(motionRuleInput(), 'admin')
    h.collector.observeMotion({
      deviceId: 636,
      atMs: 200_000,
      trackId: 'walking',
    })
    // 200 s + 300 s quiet = closed at 500 s; the barrier runs to 620 s.
    h.setNow(550_000)
    expect(await h.producer.tick()).toMatchObject({ barrier: 1, produced: 0 })
    // No media is touched while the barrier holds — the cheap question first.
    expect(h.readMediaCalls()).toBe(0)
  })

  it('produces the moment the last track closes', async () => {
    const rule = await h.store.create(motionRuleInput(), 'admin')
    h.collector.observeMotion({
      deviceId: 636,
      atMs: 200_000,
      trackId: 'walking',
    })
    h.setTracks([candidate({ trackId: 'walking', firstSeen: 200_000, lastSeen: 260_000 })])
    h.setNow(550_000)
    expect(await h.producer.tick()).toMatchObject({ barrier: 1 })
    h.collector.observeTrackClosed('walking')
    expect(await h.producer.tick()).toMatchObject({ produced: 1 })
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]?.[0]?.recordKind).toBe('ai-summary')
    expect(h.store.get(rule.id)?.generatedAt).toBe(500_000)
  })

  it('NEUTRALISED BARRIER: with barrierSeconds 0 the same window renders while the track runs', async () => {
    // The proof that the test above is testing the barrier and not the clock.
    const h2 = await makeHarness()
    await h2.store.create(motionRuleInput({ barrierSeconds: 0 }), 'admin')
    h2.collector.observeMotion({
      deviceId: 636,
      atMs: 200_000,
      trackId: 'walking',
    })
    h2.setTracks([candidate({ trackId: 'walking', firstSeen: 200_000, lastSeen: 260_000 })])
    h2.setNow(550_000)
    expect(await h2.producer.tick()).toMatchObject({ produced: 1, barrier: 0 })
  })

  it('gives up at the barrier bound rather than never delivering', async () => {
    await h.store.create(motionRuleInput(), 'admin')
    h.collector.observeMotion({
      deviceId: 636,
      atMs: 200_000,
      trackId: 'never-closes',
    })
    h.setTracks([
      candidate({
        trackId: 'never-closes',
        firstSeen: 200_000,
        lastSeen: 260_000,
      }),
    ])
    h.setNow(650_000) // past close(500 s) + barrier(120 s)
    expect(await h.producer.tick()).toMatchObject({ produced: 1 })
  })

  it('hard-closes a permanently busy window at the ceiling', async () => {
    await h.store.create(motionRuleInput(), 'admin')
    // Motion every minute for an hour — the quiet period never elapses.
    for (let t = 200_000; t <= 3_800_000; t += 60_000) {
      h.collector.observeMotion({ deviceId: 636, atMs: t })
    }
    h.setTracks([candidate({ trackId: 'a', firstSeen: 200_000, lastSeen: 260_000 })])
    h.setNow(3_900_000)
    expect(await h.producer.tick()).toMatchObject({ produced: 1 })
    // opened 200 s + ceiling 1800 s = 2000 s.
    expect(h.enqueued[0]?.[0]?.recordId).toContain(':2000000')
  })

  it('starts the NEXT window after a production instead of re-delivering the same one', async () => {
    await h.store.create(motionRuleInput(), 'admin')
    h.collector.observeMotion({ deviceId: 636, atMs: 200_000 })
    h.setTracks([candidate({ trackId: 'a', firstSeen: 200_000, lastSeen: 260_000 })])
    h.setNow(550_000)
    expect(await h.producer.tick()).toMatchObject({ produced: 1 })
    expect(await h.producer.tick()).toMatchObject({ produced: 0, idle: 1 })
    expect(h.enqueued).toHaveLength(1)
  })
})

describe('NcSummaryProducer — what it delivers', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })

  async function produceOne(over: Record<string, unknown> = {}): Promise<void> {
    await h.store.create(motionRuleInput(over), 'admin')
    h.collector.observeMotion({ deviceId: 636, atMs: 200_000 })
    h.setNow(550_000)
    await h.producer.tick()
  }

  it('publishes a real mosaic and attaches it as a URL', async () => {
    h.setTracks([
      candidate({
        trackId: 'a',
        deviceId: 636,
        firstSeen: 210_000,
        lastSeen: 240_000,
      }),
      candidate({
        trackId: 'b',
        deviceId: 637,
        firstSeen: 260_000,
        lastSeen: 300_000,
      }),
    ])
    await produceOne()
    expect(h.published).toHaveLength(1)
    expect(h.published[0]).toBeGreaterThan(1_000)
    // The viewer's library is the reason this metadata exists: a mosaic filed
    // under no rule and no camera is a mosaic no filter can reach. `deviceId`
    // is the RULE's first camera (the same one its outbox row uses), and
    // `capturedAt` is the WINDOW's end, never the render clock.
    expect(h.publishedMeta[0]).toMatchObject({
      kind: 'summary-mosaic',
      deviceId: 636,
      deviceIds: [636, 637],
      ruleName: 'esterni',
    })
    expect(h.publishedMeta[0]?.capturedAt).toBeLessThanOrEqual(550_000)
    expect(h.enqueued[0]?.[0]?.payload.artifacts?.[0]).toMatchObject({
      mediaType: 'image',
      url: 'https://hub/artifact/x.jpg',
    })
  })

  it('files the mosaic under its RULE, never a synthetic owner id', async () => {
    h.setTracks([candidate({ trackId: 'a', firstSeen: 210_000, lastSeen: 240_000 })])
    await produceOne()
    // It used to hand over `summary-<ruleId>-<windowEndMs>` as an OWNER ID —
    // a string no table has ever held, which is what made 675 delivered
    // mosaics unresolvable and uncollectable (D480). The producer now names
    // the rule and the wiring owns the mapping.
    expect(h.filed[0]).toBe('sum-1')
  })

  it('reads exactly ONE blob per tile', async () => {
    h.setTracks([
      candidate({
        trackId: 'a',
        deviceId: 636,
        firstSeen: 210_000,
        lastSeen: 240_000,
      }),
      candidate({
        trackId: 'b',
        deviceId: 637,
        firstSeen: 260_000,
        lastSeen: 300_000,
      }),
    ])
    await produceOne()
    expect(h.readMediaCalls()).toBe(2)
  })

  it('drops a track with no clean media instead of rendering a blank cell', async () => {
    h.setMedia([{ mediaId: 8006, kind: 'fullFrameBoxed', timestamp: 1, sizeBytes: 1_000 }])
    h.setTracks([candidate({ trackId: 'a', firstSeen: 210_000, lastSeen: 240_000 })])
    await produceOne()
    // Delivered, with the counts, and with no mosaic — never a black square.
    expect(h.enqueued).toHaveLength(1)
    expect(h.published).toHaveLength(0)
    expect(h.enqueued[0]?.[0]?.payload).not.toHaveProperty('artifacts')
  })

  it('does not deliver an empty window unless the rule asked for it', async () => {
    h.setTracks([])
    await produceOne()
    expect(h.enqueued).toHaveLength(0)
    // …but it IS stamped, so an empty range is not re-scanned every minute.
    expect(h.store.get('sum-1')?.generatedAt).toBe(500_000)
  })

  it('delivers an empty window when the rule asked for it', async () => {
    h.setTracks([])
    await produceOne({ deliverEmpty: true })
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]?.[0]?.payload.template?.body).toContain('nothing was seen')
  })

  it('applies the rule filters before any media is read', async () => {
    h.setTracks([
      candidate({ trackId: 'car', className: 'car', firstSeen: 210_000 }),
      candidate({ trackId: 'person', className: 'person', firstSeen: 220_000 }),
    ])
    await produceOne({ filters: { classes: ['person'] } })
    expect(h.readMediaCalls()).toBe(1)
  })

  it('honours the tile budget with the per-camera quota', async () => {
    h.setTracks([
      ...[0.9, 0.8, 0.7].map((importance, i) =>
        candidate({
          trackId: `busy-${i}`,
          deviceId: 636,
          importance,
          firstSeen: 210_000 + i,
        }),
      ),
      candidate({
        trackId: 'quiet',
        deviceId: 637,
        importance: 0.05,
        firstSeen: 260_000,
      }),
    ])
    await produceOne({ maxTiles: 2 })
    expect(h.readMediaCalls()).toBe(2)
    const body = h.enqueued[0]?.[0]?.payload.template?.body ?? ''
    expect(body).toContain('2 cameras')
    expect(body).toContain('most relevant of 4')
  })
})

describe('NcSummaryProducer — failure posture', () => {
  it('leaves the window eligible when the enqueue fails', async () => {
    const h = await makeHarness({
      enqueue: async () => {
        throw new Error('outbox down')
      },
    })
    await h.store.create(motionRuleInput(), 'admin')
    h.collector.observeMotion({ deviceId: 636, atMs: 200_000 })
    h.setTracks([candidate({ trackId: 'a', firstSeen: 210_000, lastSeen: 240_000 })])
    h.setNow(550_000)
    expect(await h.producer.tick()).toMatchObject({ failed: 1, produced: 0 })
    expect(h.store.get('sum-1')?.generatedAt).toBeUndefined()
  })

  it('delivers the counts when no public link can be minted', async () => {
    const h = await makeHarness({ publish: async () => ({ url: null, artifactId: null }) })
    await h.store.create(motionRuleInput(), 'admin')
    h.collector.observeMotion({ deviceId: 636, atMs: 200_000 })
    h.setTracks([candidate({ trackId: 'a', firstSeen: 210_000, lastSeen: 240_000 })])
    h.setNow(550_000)
    expect(await h.producer.tick()).toMatchObject({ produced: 1 })
    expect(h.enqueued[0]?.[0]?.payload).not.toHaveProperty('artifacts')
  })

  it('one unreadable camera does not cost the whole digest', async () => {
    const rows = [candidate({ trackId: 'a', deviceId: 636, firstSeen: 210_000 })]
    const h = await makeHarness({
      listTracks: async ({ deviceId }) => {
        if (deviceId === 637) throw new Error('store unreachable')
        return rows
      },
    })
    await h.store.create(motionRuleInput(), 'admin')
    h.collector.observeMotion({ deviceId: 636, atMs: 200_000 })
    h.setNow(550_000)
    expect(await h.producer.tick()).toMatchObject({ produced: 1 })
  })

  it('is single-flight — a second tick during the first does nothing', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await makeHarness({
      listTracks: async () => {
        await gate
        return []
      },
    })
    await h.store.create(motionRuleInput({ deliverEmpty: true }), 'admin')
    h.collector.observeMotion({ deviceId: 636, atMs: 200_000 })
    h.setNow(550_000)
    const first = h.producer.tick()
    const second = await h.producer.tick()
    expect(second).toMatchObject({ produced: 0, collecting: 0, idle: 0 })
    callDeferredRelease(release)
    await first
  })
})

describe('NcSummaryProducer — the eligibility floor', () => {
  it('never reaches back to a schedule window that closed before the rule existed', async () => {
    const h = await makeHarness()
    // Born at 100_000, i.e. after any window the schedule closed before it.
    const rule = await h.store.create(
      NcSummaryRuleInputSchema.parse({
        name: 'night',
        deviceIds: [636],
        window: {
          kind: 'schedule',
          schedule: {
            windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 60 }],
          },
        },
        targets: [{ targetId: 't' }],
      }),
      'admin',
    )
    // Well past the window and past the settle, but the rule was born after it.
    h.setNow(rule.createdAt + 10 * 3600_000)
    const report = await h.producer.tick()
    expect(report.produced).toBe(0)
    expect(h.enqueued).toHaveLength(0)
  })
})

describe('NcSummaryProducer — runNow', () => {
  it('delivers an arbitrary window and does NOT stamp', async () => {
    const h = await makeHarness()
    const rule = await h.store.create(motionRuleInput(), 'admin')
    h.setTracks([candidate({ trackId: 'a', firstSeen: 210_000, lastSeen: 240_000 })])
    const out = await h.producer.runNow({
      ruleId: rule.id,
      window: { startMs: 200_000, endMs: 300_000 },
    })
    expect(out.produced).toBe(1)
    expect(out.tiles).toBe(1)
    expect(h.enqueued).toHaveLength(1)
    // Pressing Test at noon must not cancel tonight's run.
    expect(h.store.get(rule.id)?.generatedAt).toBeUndefined()
  })

  it('delivers even an EMPTY window, because the operator asked a question', async () => {
    const h = await makeHarness()
    const rule = await h.store.create(motionRuleInput(), 'admin')
    h.setTracks([])
    const out = await h.producer.runNow({
      ruleId: rule.id,
      window: { startMs: 200_000, endMs: 300_000 },
    })
    expect(out.produced).toBe(1)
    expect(h.enqueued).toHaveLength(1)
  })

  it('refuses an unknown rule honestly', async () => {
    const h = await makeHarness()
    await expect(h.producer.runNow({ ruleId: 'nope' })).rejects.toThrow(/not found/)
  })
})

/**
 * The operator's report: *"le ultime summaries includono ancora tantissime
 * track stazionarie"*.
 *
 * Since D161 a track promoted to the stationary registry is PERSISTED instead
 * of forgotten (its media, events and vector needed an owner the retention
 * sweep could reach). The side effect was that the car parked in front of 102
 * started entering every window it overlapped, and — ranked on importance, and
 * guaranteed a tile by the per-camera quota — it took the tiles the digest
 * exists for. The measured digest went from 1-2 tiles to 10.
 *
 * The three cases below are one experiment: the SAME window, the same tracks,
 * only the rule's `includeStationary` moving. If the filter is removed, the
 * first case reports 4 tiles and goes red — the fake supplies the parked tracks
 * either way, so nothing here can pass on a fixture that forgot them.
 */
describe('NcSummaryProducer — a digest is a record of PASSAGES', () => {
  /** One passage and three parked objects, the parked ones ranking higher. */
  const window = { startMs: 200_000, endMs: 300_000 } as const
  const mixed = [
    candidate({ trackId: 'passing', importance: 0.4, firstSeen: 210_000, lastSeen: 240_000 }),
    candidate({
      trackId: 'parked-1',
      className: 'car',
      importance: 0.95,
      stationary: true,
      firstSeen: 205_000,
      lastSeen: 299_000,
    }),
    candidate({
      trackId: 'parked-2',
      className: 'car',
      importance: 0.9,
      stationary: true,
      firstSeen: 206_000,
      lastSeen: 299_000,
    }),
    candidate({
      trackId: 'parked-3',
      className: 'car',
      importance: 0.85,
      stationary: true,
      firstSeen: 207_000,
      lastSeen: 299_000,
    }),
  ]

  /** WHICH tracks became tiles — `listMediaInfo` is called once per tile. */
  async function runMixed(over: Record<string, unknown>) {
    const tiled: string[] = []
    const h = await makeHarness({
      listMediaInfo: async (trackId) => {
        tiled.push(trackId)
        return [
          {
            mediaId: mediaIdForTrack(trackId),
            kind: 'thumbnail',
            timestamp: 3_000 + trackId.charCodeAt(trackId.length - 1) * 1_000,
            sizeBytes: null,
          },
        ]
      },
    })
    const rule = await h.store.create(motionRuleInput(over), 'admin')
    h.setTracks(mixed)
    const out = await h.producer.runNow({ ruleId: rule.id, window })
    return { out, tiled: tiled.toSorted() }
  }

  it('leaves parked objects out by default, and SAYS how many', async () => {
    const { out, tiled } = await runMixed({})
    expect(tiled).toEqual(['passing'])
    expect(out.tiles).toBe(1)
    expect(out.matched).toBe(1)
    // A branch that drops work silently reads as "it never happened".
    expect(out.droppedStationary).toBe(3)
  })

  it('leaves them out on a rule that already carries other filters', async () => {
    // The default must not depend on `filters` being absent: a rule with a
    // class list is still a rule about passages.
    const { out, tiled } = await runMixed({ filters: { classesExclude: ['bicycle'] } })
    expect(tiled).toEqual(['passing'])
    expect(out.droppedStationary).toBe(3)
  })

  it('TOGGLE ON: the same window renders every one of them', async () => {
    const { out, tiled } = await runMixed({ filters: { includeStationary: true } })
    expect(tiled).toEqual(['parked-1', 'parked-2', 'parked-3', 'passing'])
    expect(out.tiles).toBe(4)
    expect(out.droppedStationary).toBe(0)
  })
})

describe('NcSummaryProducer — the timer', () => {
  it('start runs one tick immediately and then on the interval', async () => {
    vi.useFakeTimers()
    try {
      const h = await makeHarness({ tickMs: 1_000 })
      const spy = vi.spyOn(h.producer, 'tick')
      await h.producer.start()
      expect(spy).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)
      h.producer.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('NcSummaryProducer — the AI pass (#35 P2)', () => {
  /** A rule with AI on, and a producer whose analyst answers `answer`. */
  async function withAi(
    answer: (input: NcSummaryAiInput) => Promise<NcSummaryAiOutcome>,
    ruleOver: Record<string, unknown> = {},
  ): Promise<{ h: Harness; seen: NcSummaryAiInput[]; ruleId: string }> {
    const seen: NcSummaryAiInput[] = []
    const h = await makeHarness({
      analyseAi: async (input) => {
        seen.push(input)
        return answer(input)
      },
    })
    const rule = await h.store.create(
      motionRuleInput({ ai: { enabled: true }, maxAiImages: 2, ...ruleOver }),
      'admin',
    )
    h.setTracks([
      candidate({ trackId: 'a', deviceId: 636, firstSeen: 200_000, lastSeen: 210_000 }),
      candidate({ trackId: 'b', deviceId: 637, firstSeen: 220_000, lastSeen: 230_000 }),
      candidate({ trackId: 'c', deviceId: 636, firstSeen: 240_000, lastSeen: 250_000 }),
    ])
    return { h, seen, ruleId: rule.id }
  }

  const ok = (text: string) => async (): Promise<NcSummaryAiOutcome> => ({
    text,
    deliver: true,
    latencyMs: 5,
    images: 2,
  })

  it('the model sees the SAME frames the mosaic was built from, capped at maxAiImages', async () => {
    const { h, seen, ruleId } = await withAi(ok('Two people crossed the yard.'))
    const out = await h.producer.runNow({
      ruleId,
      window: { startMs: 200_000, endMs: 300_000 },
    })
    expect(out.produced).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.frames).toHaveLength(2)
    expect(seen[0]?.maxImages).toBe(2)
    // Every frame carries the facts the prompt places it with — and real bytes.
    for (const f of seen[0]?.frames ?? []) {
      expect(f.jpeg.byteLength).toBeGreaterThan(0)
      expect(f.deviceName.length).toBeGreaterThan(0)
    }
  })

  it('the sentence reaches the notification BODY', async () => {
    const { h, ruleId } = await withAi(ok('Two people crossed the yard.'))
    await h.producer.runNow({ ruleId, window: { startMs: 200_000, endMs: 300_000 } })
    expect(h.enqueued[0]?.[0]?.payload.template?.body).toContain('Two people crossed the yard.')
  })

  it('FAIL-OPEN: a model that gives nothing still delivers the digest and the mosaic', async () => {
    const { h, ruleId } = await withAi(async () => ({
      text: null,
      deliver: true,
      failure: 'error' as const,
      reason: 'ECONNREFUSED',
      latencyMs: 3,
      images: 2,
    }))
    const out = await h.producer.runNow({
      ruleId,
      window: { startMs: 200_000, endMs: 300_000 },
    })
    expect(out.produced).toBe(1)
    expect(h.enqueued).toHaveLength(1)
    expect(h.published).toHaveLength(1)
    expect(h.enqueued[0]?.[0]?.payload.artifacts).toBeDefined()
  })

  it("an analyst that THROWS is the same as one that says nothing — never the window's error", async () => {
    const { h, ruleId } = await withAi(async () => {
      throw new Error('the AI addon is not installed here')
    })
    const out = await h.producer.runNow({
      ruleId,
      window: { startMs: 200_000, endMs: 300_000 },
    })
    expect(out.produced).toBe(1)
    expect(out.error).toBeUndefined()
    expect(h.enqueued).toHaveLength(1)
  })

  it('`deliver: false` WITHHOLDS the digest — nothing is enqueued, and the tick says so', async () => {
    const { h, ruleId } = await withAi(async () => ({
      text: null,
      deliver: false,
      failure: 'timeout' as const,
      reason: 'no verdict',
      latencyMs: 3,
      images: 2,
    }))
    h.collector.observeMotion({ deviceId: 636, atMs: 200_000 })
    h.setNow(600_000)
    const report = await h.producer.tick()
    expect(report.skippedByAi).toBe(1)
    expect(h.enqueued).toHaveLength(0)
    // STAMPED anyway: `skip` is a policy the operator chose, not a production
    // failure, and leaving the window eligible would re-render it every minute
    // forever against a model that is still down.
    expect(h.store.get(ruleId)?.generatedAt).toBe(500_000)
  })

  it('a rule with `ai.enabled: false` never asks — and neither does one with no section', async () => {
    for (const ai of [{ enabled: false }, undefined]) {
      const seen: NcSummaryAiInput[] = []
      const h = await makeHarness({
        analyseAi: async (input) => {
          seen.push(input)
          return { text: 'x', deliver: true, latencyMs: 1, images: 1 }
        },
      })
      const rule = await h.store.create(motionRuleInput(ai === undefined ? {} : { ai }), 'admin')
      h.setTracks([candidate({ trackId: 'a', firstSeen: 200_000, lastSeen: 210_000 })])
      await h.producer.runNow({ ruleId: rule.id, window: { startMs: 200_000, endMs: 300_000 } })
      expect(seen).toHaveLength(0)
      expect(h.enqueued).toHaveLength(1)
    }
  })

  it('frames carry the camera LOCATION when the port answers one, and omit it when null', async () => {
    const seen: NcSummaryAiInput[] = []
    const h = await makeHarness({
      analyseAi: async (input) => {
        seen.push(input)
        return { text: 'x', deliver: true, latencyMs: 1, images: input.frames.length }
      },
      getDeviceLocation: async (deviceId) => (deviceId === 636 ? 'Garden' : null),
    })
    const rule = await h.store.create(
      motionRuleInput({ ai: { enabled: true }, maxAiImages: 2 }),
      'admin',
    )
    h.setTracks([
      candidate({ trackId: 'a', deviceId: 636, firstSeen: 200_000, lastSeen: 210_000 }),
      candidate({ trackId: 'b', deviceId: 637, firstSeen: 220_000, lastSeen: 230_000 }),
    ])
    await h.producer.runNow({ ruleId: rule.id, window: { startMs: 200_000, endMs: 300_000 } })
    const frames = seen[0]?.frames ?? []
    expect(frames).toHaveLength(2)
    expect(frames.find((f) => f.deviceId === 636)?.location).toBe('Garden')
    // A camera the operator gave no location: the field is ABSENT, never null.
    expect(frames.find((f) => f.deviceId === 637)?.location).toBeUndefined()
  })

  it('a producer with NO location port still produces frames — location simply absent', async () => {
    const { h, seen, ruleId } = await withAi(ok('x'))
    await h.producer.runNow({ ruleId, window: { startMs: 200_000, endMs: 300_000 } })
    for (const f of seen[0]?.frames ?? []) {
      expect(f.location).toBeUndefined()
    }
    expect(h.enqueued).toHaveLength(1)
  })

  it('an EMPTY window never asks the model — the cheap question comes first', async () => {
    const { h, seen, ruleId } = await withAi(ok('x'))
    h.setTracks([])
    await h.producer.runNow({ ruleId, window: { startMs: 200_000, endMs: 300_000 } })
    expect(seen).toHaveLength(0)
  })

  it('a producer with NO analyst wired delivers exactly the P1 digest', async () => {
    // The hub that has not deployed the AI addon, and every node that is not
    // the post-processing node. Nothing is dropped and nothing is logged as
    // broken: the rule simply produces what it always did.
    const h = await makeHarness()
    const rule = await h.store.create(motionRuleInput({ ai: { enabled: true } }), 'admin')
    h.setTracks([candidate({ trackId: 'a', firstSeen: 200_000, lastSeen: 210_000 })])
    const out = await h.producer.runNow({
      ruleId: rule.id,
      window: { startMs: 200_000, endMs: 300_000 },
    })
    expect(out.produced).toBe(1)
    expect(h.enqueued[0]?.[0]?.payload.template?.body ?? '').not.toContain('\n')
  })
})

/**
 * Tracker ID churn mints ten singletons of one driveway still. The mosaic
 * must not paint the same JPEG eleven times — drop the duplicate second and
 * refill from other kept candidates.
 */
describe('NcSummaryProducer — unique frames, not unique track ids', () => {
  it('skips a second tile of the same camera-second and refills the quota', async () => {
    const tiled: string[] = []
    const h = await makeHarness({
      listMediaInfo: async (trackId) => {
        tiled.push(trackId)
        const timestamp = trackId.startsWith('clone-')
          ? 210_000
          : 220_000 + Number(trackId.slice(-1)) * 2_000
        return [
          { mediaId: mediaIdForTrack(trackId), kind: 'thumbnail', timestamp, sizeBytes: null },
        ]
      },
    })
    const rule = await h.store.create(motionRuleInput({ maxTiles: 3 }), 'admin')
    h.setTracks([
      candidate({ trackId: 'clone-a', importance: 0.99, firstSeen: 210_000, lastSeen: 214_000 }),
      candidate({ trackId: 'clone-b', importance: 0.98, firstSeen: 210_100, lastSeen: 214_100 }),
      candidate({ trackId: 'clone-c', importance: 0.97, firstSeen: 210_200, lastSeen: 214_200 }),
      candidate({ trackId: 'other-1', importance: 0.4, firstSeen: 230_000, lastSeen: 234_000 }),
      candidate({ trackId: 'other-2', importance: 0.3, firstSeen: 250_000, lastSeen: 254_000 }),
    ])
    const out = await h.producer.runNow({
      ruleId: rule.id,
      window: { startMs: 200_000, endMs: 300_000 },
    })
    expect(out.tiles).toBe(3)
    expect(tiled.filter((id) => id.startsWith('clone-')).length).toBeGreaterThanOrEqual(1)
    expect(tiled).toContain('other-1')
    expect(tiled).toContain('other-2')
  })
})

/**
 * The digest's own referee.
 *
 * `droppedNoMedia` used to be `max(0, rule.maxTiles - loaded.length)` — the
 * count of EMPTY CELLS, which has nothing to do with media. A real production
 * line read `matched: 5, tiles: 5, droppedNoMedia: 7` with not one track
 * dropped: the rule's quota was 12 and the night was quiet. That number is the
 * first thing an operator reads when a digest looks thin, and it was lying.
 *
 * These assert the LOG LINE, not a return value, because the log line is the
 * production surface — including its LEVEL, which is why the drop reason was
 * invisible for three days at `debug`.
 */
describe('NcSummaryProducer — the honesty of the media accounting', () => {
  interface CapturedLog {
    readonly level: 'debug' | 'info' | 'warn' | 'error'
    readonly message: string
    readonly tags: LogTags | undefined
    readonly meta: Record<string, unknown> | undefined
  }

  function makeCapturingLogger(sink: CapturedLog[]): IScopedLogger {
    const at =
      (level: CapturedLog['level']) =>
      (message: string, extras?: LogExtras): void => {
        sink.push({ level, message, tags: extras?.tags, meta: extras?.meta })
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

  function producedLine(logs: readonly CapturedLog[]): Record<string, unknown> {
    const line = logs.find((l) => l.message === 'summary produced')
    expect(line, 'the producer must log "summary produced"').toBeDefined()
    return line?.meta ?? {}
  }

  const WINDOW = { startMs: 200_000, endMs: 300_000 }
  /** A real native-resolution subject crop — never a 112×112 face template. */
  const CROP_BYTES = 240_000

  it('a quiet night that dropped NOTHING reports droppedNoMedia: 0', async () => {
    // The exact production line: matched 5, tiles 5, quota 12. The old formula
    // said 7. Seven what? Nothing was dropped.
    const logs: CapturedLog[] = []
    const h = await makeHarness({
      logger: makeCapturingLogger(logs),
      listMediaInfo: async (trackId) => [
        {
          mediaId: mediaIdForTrack(trackId),
          kind: 'thumbnail',
          // Distinct seconds, or `frameDedupeKey` would collapse them.
          timestamp: 210_000 + trackId.charCodeAt(trackId.length - 1) * 3_000,
          sizeBytes: CROP_BYTES,
        },
      ],
    })
    const rule = await h.store.create(motionRuleInput({ maxTiles: 12 }), 'admin')
    h.setTracks([
      candidate({ trackId: 'a', firstSeen: 210_000, lastSeen: 214_000 }),
      candidate({ trackId: 'b', firstSeen: 220_000, lastSeen: 224_000 }),
      candidate({ trackId: 'c', firstSeen: 230_000, lastSeen: 234_000 }),
      candidate({ trackId: 'd', firstSeen: 240_000, lastSeen: 244_000 }),
      candidate({ trackId: 'e', firstSeen: 250_000, lastSeen: 254_000 }),
    ])
    const out = await h.producer.runNow({ ruleId: rule.id, window: WINDOW })
    expect(out.tiles).toBe(5)
    const meta = producedLine(logs)
    expect(meta.matched).toBe(5)
    expect(meta.tiles).toBe(5)
    expect(meta.droppedNoMedia).toBe(0)
  })

  it('counts the TRACKS the ladder could not serve, not the unfilled cells', async () => {
    const logs: CapturedLog[] = []
    const h = await makeHarness({
      logger: makeCapturingLogger(logs),
      // 'c' carries a crop; 'a' and 'b' carry only a boxed frame, which the
      // ladder refuses — a drawn rectangle is a permanent lie in a tile.
      listMediaInfo: async (trackId) =>
        trackId === 'c'
          ? [{ mediaId: 8007, kind: 'thumbnail', timestamp: 230_000, sizeBytes: CROP_BYTES }]
          : [
              {
                mediaId: mediaIdForTrack(trackId),
                kind: 'fullFrameBoxed',
                timestamp: 210_000,
                sizeBytes: 900_000,
              },
            ],
    })
    const rule = await h.store.create(motionRuleInput({ maxTiles: 12 }), 'admin')
    h.setTracks([
      candidate({ trackId: 'a', firstSeen: 210_000, lastSeen: 214_000 }),
      candidate({ trackId: 'b', firstSeen: 220_000, lastSeen: 224_000 }),
      candidate({ trackId: 'c', firstSeen: 230_000, lastSeen: 234_000 }),
    ])
    const out = await h.producer.runNow({ ruleId: rule.id, window: WINDOW })
    expect(out.tiles).toBe(1)
    // TWO tracks had no usable media. Not 11 (12 − 1), which is what the
    // unfilled-cell formula would have said.
    expect(producedLine(logs).droppedNoMedia).toBe(2)
  })

  it('counts a track whose blob could not be READ as a media drop too', async () => {
    const logs: CapturedLog[] = []
    const h = await makeHarness({
      logger: makeCapturingLogger(logs),
      listMediaInfo: async (trackId) => [
        {
          mediaId: mediaIdForTrack(trackId),
          kind: 'thumbnail',
          timestamp: 210_000 + trackId.charCodeAt(0) * 1_000,
          sizeBytes: CROP_BYTES,
        },
      ],
      readMedia: async (mediaId) => (mediaId === mediaIdForTrack('b') ? null : await jpeg()),
    })
    const rule = await h.store.create(motionRuleInput({ maxTiles: 12 }), 'admin')
    h.setTracks([
      candidate({ trackId: 'a', firstSeen: 210_000, lastSeen: 214_000 }),
      candidate({ trackId: 'b', firstSeen: 220_000, lastSeen: 224_000 }),
    ])
    await h.producer.runNow({ ruleId: rule.id, window: WINDOW })
    expect(producedLine(logs).droppedNoMedia).toBe(1)
  })

  it('does NOT fold a deduped duplicate frame into droppedNoMedia', async () => {
    // Those tracks HAD a picture; we chose not to paint the same second twice.
    // Folding the two reasons together is what made the number unreadable.
    const logs: CapturedLog[] = []
    const h = await makeHarness({
      logger: makeCapturingLogger(logs),
      listMediaInfo: async (trackId) => [
        {
          mediaId: mediaIdForTrack(trackId),
          kind: 'thumbnail',
          timestamp: 210_000,
          sizeBytes: CROP_BYTES,
        },
      ],
    })
    const rule = await h.store.create(motionRuleInput({ maxTiles: 12 }), 'admin')
    h.setTracks([
      candidate({ trackId: 'a', importance: 0.9, firstSeen: 210_000, lastSeen: 214_000 }),
      candidate({ trackId: 'b', importance: 0.8, firstSeen: 210_100, lastSeen: 214_100 }),
      candidate({ trackId: 'c', importance: 0.7, firstSeen: 210_200, lastSeen: 214_200 }),
    ])
    const out = await h.producer.runNow({ ruleId: rule.id, window: WINDOW })
    expect(out.tiles).toBe(1)
    const meta = producedLine(logs)
    expect(meta.droppedNoMedia).toBe(0)
    expect(meta.droppedDuplicateFrame).toBe(2)
  })

  it('the drop line is INFO and carries tags.deviceId — the per-camera question', async () => {
    // "Why does 102 render fewer tiles than 101?" is only answerable if the
    // line reaches the pipeline AND can be grouped by camera. At `debug` it
    // reached nothing: three days of whole-frame digests, not one line.
    const logs: CapturedLog[] = []
    const h = await makeHarness({
      logger: makeCapturingLogger(logs),
      listMediaInfo: async () => [
        { mediaId: 8006, kind: 'fullFrameBoxed', timestamp: 210_000, sizeBytes: 900_000 },
      ],
    })
    const rule = await h.store.create(motionRuleInput({ deviceIds: [102] }), 'admin')
    h.setTracks([candidate({ trackId: 'a', deviceId: 102, firstSeen: 210_000, lastSeen: 214_000 })])
    await h.producer.runNow({ ruleId: rule.id, window: WINDOW })
    const drop = logs.find((l) => l.message.includes('the track carries no clean media'))
    expect(drop, 'a dropped track must produce a line').toBeDefined()
    expect(drop?.level).toBe('info')
    expect(drop?.tags?.deviceId).toBe(102)
    // WHAT the track actually carried — "9 rows the ladder refused" and
    // "nothing at all" are different faults and must be distinguishable.
    expect(drop?.meta?.mediaKinds).toEqual(['fullFrameBoxed'])
  })

  it('the face TEMPLATE path: a demoted thumbnail still yields a tile, not a drop', async () => {
    const logs: CapturedLog[] = []
    const readMediaIds: number[] = []
    const h = await makeHarness({
      logger: makeCapturingLogger(logs),
      listMediaInfo: async () => [
        // An ArcFace 112×112 template copied onto the track as `thumbnail`…
        { mediaId: 8008, kind: 'thumbnail', timestamp: 210_000, sizeBytes: 7_400 },
        // …and the clean scene below it on the ladder.
        { mediaId: 8009, kind: 'keyFrame', timestamp: 210_000, sizeBytes: 1_800_000 },
      ],
      readMedia: async (mediaId) => {
        readMediaIds.push(mediaId)
        return await jpeg()
      },
    })
    const rule = await h.store.create(motionRuleInput(), 'admin')
    h.setTracks([candidate({ trackId: 'a', firstSeen: 210_000, lastSeen: 214_000 })])
    const out = await h.producer.runNow({ ruleId: rule.id, window: WINDOW })
    expect(out.tiles).toBe(1)
    // ONE blob read, and it is the frame — the template was refused on the
    // INDEX row, so no wasted fetch and no face in the digest.
    // 8009 is the `keyFrame` row seeded above — the clean scene, not the
    // 112x112 face template that sits above it on the ladder.
    expect(readMediaIds).toEqual([8009])
    expect(producedLine(logs).droppedNoMedia).toBe(0)
  })
})

describe('NcSummaryProducer — the framing line says WHICH rule boxed, and why the rest did not', () => {
  // Both boxing paths end in a rectangle, so `boxed` alone cannot tell a digest
  // boxed at capture time (D510) from one boxed by the old snapshot pairing.
  // And the refusal reasons were being COUNTED and never logged, which is the
  // same blindness one level down: "some frames went unboxed" with no way to
  // ask which of four causes.
  interface Line {
    readonly message: string
    readonly meta: Record<string, unknown> | undefined
  }

  function capturing(sink: Line[]): IScopedLogger {
    const at =
      () =>
      (message: string, extras?: LogExtras): void => {
        sink.push({ message, meta: extras?.meta })
      }
    const logger: IScopedLogger = {
      debug: at(),
      info: at(),
      warn: at(),
      error: at(),
      child: () => logger,
      withTags: () => logger,
    }
    return logger
  }

  function framingLine(logs: readonly Line[]): Record<string, unknown> {
    const line = logs.find((l) => l.message === 'summary ai: subject framing')
    expect(line, 'the AI pass must log "summary ai: subject framing"').toBeDefined()
    return line?.meta ?? {}
  }

  async function runWith(
    shotFor: NcSummaryProducerDeps['subjectShotFor'],
  ): Promise<Record<string, unknown>> {
    const logs: Line[] = []
    const h = await makeHarness({
      logger: capturing(logs),
      analyseAi: async () => ({ text: 'x', deliver: true, latencyMs: 1, images: 2 }),
      subjectShotFor: shotFor,
    })
    const rule = await h.store.create(
      motionRuleInput({ ai: { enabled: true }, maxAiImages: 2 }),
      'admin',
    )
    h.setTracks([
      candidate({ trackId: 'a', deviceId: 636, firstSeen: 200_000, lastSeen: 210_000 }),
      candidate({ trackId: 'b', deviceId: 637, firstSeen: 220_000, lastSeen: 230_000 }),
    ])
    await h.producer.runNow({ ruleId: rule.id, window: { startMs: 200_000, endMs: 300_000 } })
    return framingLine(logs)
  }

  /** A box that really lands inside the harness's 160x90 frame. */
  const shot = (source: 'media-box' | 'snapshot'): SummarySubjectShot => ({
    mediaId: 8005,
    source,
    bbox: { x: 40, y: 20, w: 48, h: 40 },
    frameWidth: 160,
    frameHeight: 90,
  })

  it('separates the capture-time box from the snapshot pairing', async () => {
    let n = 0
    const meta = await runWith(async () => {
      n += 1
      return shot(n === 1 ? 'media-box' : 'snapshot')
    })
    expect(meta.boxed).toBe(2)
    expect(meta.fromMediaBox).toBe(1)
    expect(meta.fromSnapshot).toBe(1)
  })

  it('names the reason every unboxed frame went unboxed', async () => {
    const meta = await runWith(async () => null)
    expect(meta.boxed).toBe(0)
    expect(meta.unboxed).toBe(2)
    expect(meta.unboxedWhy).toEqual({ 'no-subject-box': 2 })
  })
})

describe('NcSummaryProducer — a place description is found by the FOLDED name', () => {
  // The description now hangs off the location itself (device-manager), keyed
  // by `locationIconKey` — trimmed, lower-cased. The camera carries the label
  // as the operator typed it. A lookup on the raw label misses on a
  // case-difference and the model is told the place NAME alone, which is
  // exactly the silent degradation the move was meant to end.
  it('matches a camera label that differs only in case and spacing', async () => {
    const seen: NcSummaryAiInput[] = []
    const h = await makeHarness({
      analyseAi: async (input) => {
        seen.push(input)
        return { text: 'x', deliver: true, latencyMs: 1, images: 1 }
      },
      getDeviceLocation: async () => '  Parking ',
      locationDescriptions: async () => new Map([['parking', 'Selciato e tre posti auto.']]),
    })
    const rule = await h.store.create(
      motionRuleInput({ ai: { enabled: true }, maxAiImages: 1 }),
      'admin',
    )
    h.setTracks([candidate({ trackId: 'a', deviceId: 636, firstSeen: 200_000, lastSeen: 210_000 })])
    await h.producer.runNow({ ruleId: rule.id, window: { startMs: 200_000, endMs: 300_000 } })
    expect(seen[0]?.frames[0]?.locationDescription).toBe('Selciato e tre posti auto.')
  })
})
