/**
 * TimelapseScheduler — the post-hoc producer's only stateful piece.
 *
 * It owns five decisions and nothing else: has a window CLOSED, has it
 * SETTLED, is it above the (rule, device) ELIGIBILITY FLOOR, has this pair
 * ALREADY produced it, and — only after a render AND an enqueue both
 * succeeded — stamping it.
 */
import type { InMemoryRecords } from '@camstack/types'
import { ncRecordKinds } from '../../record-kinds.js'
import type { TimelapseRule } from '@camstack/types'
import { readTimelapseGeneratedAt } from '@camstack/types'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import { NcTextCatalog } from '../../text-catalog.js'
import { footageCoverage } from '../footage-coverage.js'
import { TimelapseRenderError } from '../timelapse-renderer.js'
import {
  TIMELAPSE_SETTLE_MS,
  TimelapseScheduler,
  type TimelapseSchedulerDeps,
} from '../timelapse-scheduler.js'
import { TimelapseStore } from '../timelapse-store.js'
import { testTimelapsePreviewMode, makeNcRecords } from '../../__tests__/support/nc-test-deps.js'

/** Mon 2026-01-05 … nightly 22:00→06:00 UTC. */
const MON = Date.UTC(2026, 0, 5)
const at = (dayOffset: number, hour: number, minute = 0): number =>
  MON + dayOffset * 86_400_000 + hour * 3600_000 + minute * 60_000
const NIGHTLY = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 22 * 60, endMinute: 6 * 60 }],
  timezone: 'UTC',
}
const CLOSED = { startMs: at(0, 22), endMs: at(1, 6) }

/**
 * Default rule birth: the Sunday BEFORE the fixture week, so every window the
 * scheduler tests reason about closed after the rule existed. A rule created
 * later than the window it is being offered is its own scenario — see the
 * eligibility-floor block.
 */
const CREATED_BEFORE = at(-1, 12)

interface Harness {
  readonly world: InMemoryRecords
  readonly store: TimelapseStore
  readonly scheduler: TimelapseScheduler
  readonly render: Mock<TimelapseSchedulerDeps['render']>
  readonly enqueue: Mock<TimelapseSchedulerDeps['enqueue']>
  now: () => number
  setNow: (ms: number) => void
}

async function makeHarness(over: Partial<TimelapseSchedulerDeps> = {}): Promise<Harness> {
  const { render: overRender, enqueue: overEnqueue, ...restOver } = over
  const world = makeNcRecords()
  let now = at(1, 6, 10)
  const store = new TimelapseStore({
    kind: world.records.kind(ncRecordKinds['timelapse-rules']),
    logger: makeSilentLogger(),
    now: () => now,
    newId: () => 'tl-1',
  })
  const render = vi.fn<TimelapseSchedulerDeps['render']>(
    overRender ??
      (async () => ({
        exportId: 'exp-1',
        profile: 'main',
        coverage: footageCoverage(
          [{ startMs: CLOSED.startMs, endMs: CLOSED.endMs }],
          CLOSED.startMs,
          CLOSED.endMs,
        ),
        plan: { ranges: [], capped: false, mergedCount: 0, denseSec: 0 },
        detections: { total: 0, byClass: {}, classes: [] },
        artifact: { url: 'https://hub/a.mp4', mime: 'video/mp4', name: 'a.mp4' },
        preview: { url: 'https://hub/a.jpg', mime: 'image/jpeg', name: 'timelapse-preview.jpg' },
        downloadUrl: 'https://hub/addon/recorder/exports/exp-1.mp4',
        fileBytes: 1_000,
      })),
  )
  const enqueue = vi.fn<TimelapseSchedulerDeps['enqueue']>(overEnqueue ?? (async () => 1))
  const scheduler = new TimelapseScheduler({
    logger: makeSilentLogger(),
    now: () => now,
    // The producer freezes its words AT ENQUEUE, language included — so the
    // scheduler is where the hub language reaches a timelapse row.
    texts: new NcTextCatalog({ language: 'it' }),
    store,
    render,
    enqueue,
    ...restOver,
  })
  return { world, store, scheduler, render, enqueue, now: () => now, setNow: (ms) => (now = ms) }
}

/**
 * Create the fixture rule AT `createdAt` (the store and the scheduler share one
 * clock, so the harness clock is rewound for the create and restored after).
 */
async function seed(
  h: Harness,
  over: Record<string, unknown> = {},
  createdAt: number = CREATED_BEFORE,
): Promise<TimelapseRule> {
  const resume = h.now()
  h.setNow(createdAt)
  const rule = await h.store.create(
    {
      name: 'Notte retro',
      enabled: true,
      deviceIds: [1441],
      schedule: NIGHTLY,
      cadenceSec: 30,
      framerate: 12,
      targets: [{ targetId: 'zentik' }],
      priority: 3,
      previewMode: testTimelapsePreviewMode,
      ...over,
    },
    'admin',
  )
  h.setNow(resume)
  return rule
}

describe('TimelapseScheduler.tick', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  it('renders and enqueues the window that closed, once settled', async () => {
    await seed(h)
    const report = await h.scheduler.tick()
    expect(h.render).toHaveBeenCalledTimes(1)
    expect(h.render.mock.calls[0]?.[0]).toMatchObject({
      deviceId: 1441,
      window: CLOSED,
      cadenceSec: 30,
      framerate: 12,
    })
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(report.produced).toBe(1)
  })

  it('WAITS the settle delay so in-flight tracks have persisted', async () => {
    // Rendering at the stroke of 06:00 misses every track that closed in the
    // last minutes of the window — exactly the ones the dense plan needs.
    await seed(h)
    h.setNow(CLOSED.endMs + TIMELAPSE_SETTLE_MS - 60_000)
    const report = await h.scheduler.tick()
    expect(h.render).not.toHaveBeenCalled()
    expect(report.waiting).toBe(1)
  })

  it('does not produce the same window twice', async () => {
    await seed(h)
    await h.scheduler.tick()
    const second = await h.scheduler.tick()
    expect(h.render).toHaveBeenCalledTimes(1)
    expect(second.produced).toBe(0)
    expect(second.alreadyDone).toBe(1)
  })

  it('stamps the pair ONLY after the render and the enqueue both succeeded', async () => {
    const rule = await seed(h)
    await h.scheduler.tick()
    expect(readTimelapseGeneratedAt(h.store.get(rule.id) ?? rule, 1441)).toBeGreaterThan(0)
  })

  it('a FAILED render does not burn the schedule guard — the next tick retries', async () => {
    // The defect this fixes: closing the window stamped the rule before the
    // render, so one ffmpeg failure cost the whole night, permanently.
    const failing = await makeHarness({
      render: vi.fn(async () => {
        throw new TimelapseRenderError('export-failed', 'ffmpeg exited 1')
      }),
    })
    const rule = await seed(failing)
    const first = await failing.scheduler.tick()
    expect(first.failed).toBe(1)
    expect(readTimelapseGeneratedAt(failing.store.get(rule.id) ?? rule, 1441)).toBe(0)

    const recovered = await makeHarness()
    // Same store contents, a renderer that works: the pair is still eligible.
    const rule2 = await seed(recovered)
    const second = await recovered.scheduler.tick()
    expect(second.produced).toBe(1)
    expect(readTimelapseGeneratedAt(recovered.store.get(rule2.id) ?? rule2, 1441)).toBeGreaterThan(
      0,
    )
  })

  it('a failed ENQUEUE leaves the pair unstamped too', async () => {
    const broken = await makeHarness({
      enqueue: vi.fn(async () => {
        throw new Error('settings store unreachable')
      }),
    })
    const rule = await seed(broken)
    const report = await broken.scheduler.tick()
    expect(report.failed).toBe(1)
    expect(readTimelapseGeneratedAt(broken.store.get(rule.id) ?? rule, 1441)).toBe(0)
  })

  it('keeps every OTHER camera of the rule eligible when one fails', async () => {
    const flaky = await makeHarness({
      render: vi.fn(async (req: { deviceId: number }) => {
        if (req.deviceId === 1441) throw new TimelapseRenderError('no-footage', 'nope')
        return {
          exportId: 'exp-2',
          profile: 'main',
          coverage: footageCoverage([], CLOSED.startMs, CLOSED.endMs),
          plan: { ranges: [], capped: false, mergedCount: 0, denseSec: 0 },
          detections: { total: 0, byClass: {}, classes: [] },
          artifact: null,
          preview: null,
          downloadUrl: null,
          fileBytes: null,
        }
      }),
    })
    const rule = await seed(flaky, { deviceIds: [1441, 101] })
    const report = await flaky.scheduler.tick()
    expect(report.produced).toBe(1)
    expect(report.failed).toBe(1)
    const stored = flaky.store.get(rule.id) ?? rule
    expect(readTimelapseGeneratedAt(stored, 1441)).toBe(0)
    expect(readTimelapseGeneratedAt(stored, 101)).toBeGreaterThan(0)
  })

  it('skips a disabled rule entirely', async () => {
    await seed(h, { enabled: false })
    const report = await h.scheduler.tick()
    expect(h.render).not.toHaveBeenCalled()
    expect(report.produced).toBe(0)
  })

  /**
   * RESTART. The post-hoc design makes this cheap: "which window closed while
   * we were down" is a pure function of the schedule and the clock, and the
   * per-(rule,device) stamp says whether it was produced.
   */
  it('back-fills the window that closed while the hub was down', async () => {
    await seed(h)
    // Boot at 14:00 — the 22:00→06:00 window closed eight hours ago and was
    // never produced.
    h.setNow(at(1, 14))
    const report = await h.scheduler.tick()
    expect(h.render).toHaveBeenCalledTimes(1)
    expect(h.render.mock.calls[0]?.[0]).toMatchObject({ window: CLOSED })
    expect(report.produced).toBe(1)
  })

  it('back-fills AT MOST the most recent missed window, never a week of them', async () => {
    await seed(h)
    // Down for three days: only last night is produced.
    h.setNow(at(3, 14))
    await h.scheduler.tick()
    expect(h.render).toHaveBeenCalledTimes(1)
    expect(h.render.mock.calls[0]?.[0]).toMatchObject({
      window: { startMs: at(2, 22), endMs: at(3, 6) },
    })
  })

  /**
   * Live 2026-08-23: two cameras on two rules (or one rule) both closed at
   * 07:00. The producer awaited camera 1441's 30-minute ffmpeg, THEN started
   * 101. 101's export was created at 07:53 and notified at 08:46. Starting
   * every eligible pair in the same tick — without waiting for the first
   * render — is what makes each camera notify when ITS artefact is ready.
   */
  it('starts every eligible camera’s render without waiting for the first to finish', async () => {
    let release1441: (() => void) | undefined
    const started: number[] = []
    const hanging = await makeHarness({
      render: vi.fn(async (req: { deviceId: number }) => {
        started.push(req.deviceId)
        if (req.deviceId === 1441) {
          await new Promise<void>((resolve) => {
            release1441 = resolve
          })
        }
        return {
          exportId: `exp-${String(req.deviceId)}`,
          profile: 'main',
          coverage: footageCoverage(
            [{ startMs: CLOSED.startMs, endMs: CLOSED.endMs }],
            CLOSED.startMs,
            CLOSED.endMs,
          ),
          plan: { ranges: [], capped: false, mergedCount: 0, denseSec: 0 },
          detections: { total: 0, byClass: {}, classes: [] },
          artifact: null,
          preview: null,
          downloadUrl: null,
          fileBytes: null,
        }
      }),
    })
    const rule = await seed(hanging, { deviceIds: [1441, 101] })
    const tickP = hanging.scheduler.tick()
    await vi.waitFor(() => expect(started).toEqual(expect.arrayContaining([1441, 101])))
    expect(hanging.enqueue).toHaveBeenCalledTimes(1)
    expect(readTimelapseGeneratedAt(hanging.store.get(rule.id) ?? rule, 101)).toBeGreaterThan(0)
    expect(readTimelapseGeneratedAt(hanging.store.get(rule.id) ?? rule, 1441)).toBe(0)
    release1441?.()
    const report = await tickP
    expect(report.produced).toBe(2)
    expect(readTimelapseGeneratedAt(hanging.store.get(rule.id) ?? rule, 1441)).toBeGreaterThan(0)
  })

  it('a tick while a pair is rendering skips that pair and still scans the rest', async () => {
    let release: (() => void) | undefined
    const hanging = await makeHarness({
      render: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return {
          exportId: 'exp-1',
          profile: 'main',
          coverage: footageCoverage(
            [{ startMs: CLOSED.startMs, endMs: CLOSED.endMs }],
            CLOSED.startMs,
            CLOSED.endMs,
          ),
          plan: { ranges: [], capped: false, mergedCount: 0, denseSec: 0 },
          detections: { total: 0, byClass: {}, classes: [] },
          artifact: null,
          preview: null,
          downloadUrl: null,
          fileBytes: null,
        }
      }),
    })
    await seed(hanging)
    const first = hanging.scheduler.tick()
    await vi.waitFor(() => expect(hanging.render).toHaveBeenCalledTimes(1))
    const overlapping = await hanging.scheduler.tick()
    expect(overlapping.skippedInFlight).toBe(1)
    expect(overlapping.produced).toBe(0)
    expect(hanging.render).toHaveBeenCalledTimes(1)
    release?.()
    const done = await first
    expect(done.produced).toBe(1)
  })
})

/**
 * ELIGIBILITY FLOOR — the boundary between "the hub was down" and "the rule did
 * not exist yet".
 *
 * The back-fill above is right for a restart and wrong for a NEW rule: with no
 * stamp to compare against, a rule created this morning reached back to a
 * window that closed BEFORE it existed, found no footage it was ever going to
 * find, and warn-logged the same failure every minute (live: rule 16fa78ac,
 * camera 1441, created ~10:45, endlessly retrying 21:00→07:00).
 */
describe('TimelapseScheduler eligibility floor (a rule never predates itself)', () => {
  it('never attempts a window that closed BEFORE the rule was created', async () => {
    const h = await makeHarness()
    // Created at 10:45, hours after the 22:00→06:00 window closed.
    await seed(h, {}, at(1, 10, 45))
    h.setNow(at(1, 11))
    const report = await h.scheduler.tick()
    expect(h.render).not.toHaveBeenCalled()
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(report.produced).toBe(0)
    expect(report.failed).toBe(0)
    expect(report.beforeFloor).toBe(1)
  })

  it('stays quiet across repeated ticks instead of re-attempting every minute', async () => {
    const h = await makeHarness()
    await seed(h, {}, at(1, 10, 45))
    h.setNow(at(1, 11))
    await h.scheduler.tick()
    h.setNow(at(1, 11, 1))
    await h.scheduler.tick()
    h.setNow(at(1, 11, 2))
    const third = await h.scheduler.tick()
    expect(h.render).not.toHaveBeenCalled()
    expect(third.beforeFloor).toBe(1)
  })

  it('produces the FIRST window that closes after the rule was created', async () => {
    const h = await makeHarness()
    await seed(h, {}, at(1, 10, 45))
    // Tonight's window closes at 06:00 the next morning; settle, then produce.
    h.setNow(at(2, 6) + TIMELAPSE_SETTLE_MS)
    const report = await h.scheduler.tick()
    expect(report.produced).toBe(1)
    expect(h.render.mock.calls[0]?.[0]).toMatchObject({
      window: { startMs: at(1, 22), endMs: at(2, 6) },
    })
  })

  it('the floor is the window CLOSE, so a rule born mid-window still gets it', async () => {
    const h = await makeHarness()
    // Created at 23:00, an hour into the 22:00→06:00 window: the footage the
    // window covers exists, and the close is what the guard compares against.
    await seed(h, {}, at(0, 23))
    const report = await h.scheduler.tick()
    expect(report.produced).toBe(1)
    expect(h.render.mock.calls[0]?.[0]).toMatchObject({ window: CLOSED })
  })

  it('a per-device stamp still wins when it is NEWER than the rule birth', async () => {
    const h = await makeHarness()
    const rule = await seed(h)
    await h.scheduler.tick()
    h.render.mockClear()
    // Same window, next tick: the stamp — not the birth — is what blocks it.
    const second = await h.scheduler.tick()
    expect(h.render).not.toHaveBeenCalled()
    expect(second.alreadyDone).toBe(1)
    expect(readTimelapseGeneratedAt(h.store.get(rule.id) ?? rule, 1441)).toBeGreaterThan(
      rule.createdAt,
    )
  })

  /**
   * ACCEPTED GAP, stated so nobody reads it as a bug: the floor is RULE-level.
   * `TimelapseRule` records no per-device add time (`deviceIds` is a plain
   * array a patch replaces wholesale), so a camera added to an old rule is
   * offered the last closed window even though it joined afterwards. That
   * over-produces at most ONE window for the new camera — the failure mode the
   * floor exists to stop is the opposite one, an endless retry of a window no
   * footage can satisfy.
   */
  it('a camera added later inherits the RULE-level floor (documented limitation)', async () => {
    const h = await makeHarness()
    const rule = await seed(h)
    h.setNow(at(1, 7))
    await h.store.update(rule.id, { deviceIds: [1441, 101] })
    h.setNow(at(1, 8))
    const report = await h.scheduler.tick()
    // Both cameras are offered the 22:00→06:00 window that closed at 06:00,
    // including the one added at 07:00.
    expect(report.produced).toBe(2)
    expect(h.render.mock.calls.map((c) => c[0]?.deviceId).sort((a, b) => a - b)).toEqual([
      101, 1441,
    ])
  })

  /**
   * LEGACY ROWS. `createdAt` has always been a required field, so a row without
   * one is a pre-schema artefact; it is read as "born now" rather than skipped,
   * which keeps the rule alive AND stops it back-filling an ancient window.
   */
  it('a legacy rule with no persisted createdAt does not back-fill at load', async () => {
    const h = await makeHarness()
    const rule = await seed(h)
    const { createdAt: _dropped, id: _id, ...legacy } = rule
    h.world.seed('timelapse-rules', { id: rule.id, data: legacy })
    // Loaded at 11:00, long after the 22:00→06:00 window closed.
    h.setNow(at(1, 11))
    await h.store.load()
    const report = await h.scheduler.tick()
    expect(h.store.get(rule.id)).not.toBeNull()
    expect(h.render).not.toHaveBeenCalled()
    expect(report.beforeFloor).toBe(1)
  })
})

describe('TimelapseScheduler preview caption', () => {
  it('resolves {{camera}} against the DISPLAY name and hands it to the render', async () => {
    const h = await makeHarness({ getDeviceName: async () => 'Camera front door' })
    await seed(h)
    h.setNow(at(1, 6, 10))
    await h.scheduler.tick()
    expect(h.render).toHaveBeenCalledWith(
      expect.objectContaining({ previewText: 'Timelapse Camera front door' }),
    )
  })

  it('uses the rule’s own caption when it has one', async () => {
    const h = await makeHarness({ getDeviceName: async () => 'front door' })
    await seed(h, { previewText: '{{camera}} {{from}}→{{to}}' })
    h.setNow(at(1, 6, 10))
    await h.scheduler.tick()
    expect(h.render).toHaveBeenCalledWith(
      expect.objectContaining({ previewText: expect.stringContaining('front door ') }),
    )
  })

  it('hands the rule’s preview MODE and reportClasses to the render', async () => {
    const h = await makeHarness({ getDeviceName: async () => 'front door' })
    await seed(h, { previewMode: 'gif', reportClasses: ['person'] })
    h.setNow(at(1, 6, 10))
    await h.scheduler.tick()
    expect(h.render).toHaveBeenCalledWith(
      expect.objectContaining({ previewMode: 'gif', reportClasses: ['person'] }),
    )
  })

  it('forwards the counts to the outbox row, so the body can name them', async () => {
    const h = await makeHarness({
      render: vi.fn(async () => ({
        exportId: 'exp-1',
        profile: 'main',
        coverage: footageCoverage(
          [{ startMs: CLOSED.startMs, endMs: CLOSED.endMs }],
          CLOSED.startMs,
          CLOSED.endMs,
        ),
        plan: { ranges: [], capped: false, mergedCount: 0, denseSec: 0 },
        detections: { total: 3, byClass: { person: 3 }, classes: ['person'] },
        artifact: null,
        preview: null,
        downloadUrl: null,
        fileBytes: null,
      })),
    })
    await seed(h)
    h.setNow(at(1, 6, 10))
    await h.scheduler.tick()
    const rows = h.enqueue.mock.calls[0]?.[0] as ReadonlyArray<{
      payload: { template?: { body?: string } }
    }>
    expect(rows[0]?.payload.template?.body).toContain('3 persone')
  })

  it('attaches the preview the render produced alongside the video', async () => {
    const h = await makeHarness()
    await seed(h)
    h.setNow(at(1, 6, 10))
    await h.scheduler.tick()
    const rows = h.enqueue.mock.calls[0]?.[0] as
      | ReadonlyArray<{ payload: { artifacts?: ReadonlyArray<{ mediaType: string }> } }>
      | undefined
    expect(rows?.[0]?.payload.artifacts?.map((a) => a.mediaType)).toEqual(['image', 'video'])
  })
})

describe('TimelapseScheduler.runNow (the operator’s Test button)', () => {
  it('produces the last closed window even when the guard says it is done', async () => {
    const h = await makeHarness()
    const rule = await seed(h)
    await h.scheduler.tick()
    h.render.mockClear()
    const out = await h.scheduler.runNow({ ruleId: rule.id, deviceId: 1441 })
    expect(h.render).toHaveBeenCalledTimes(1)
    expect(out.produced).toBe(1)
  })

  it('does NOT consume the guard, so the scheduled run still happens', async () => {
    const h = await makeHarness()
    const rule = await seed(h)
    await h.scheduler.runNow({ ruleId: rule.id, deviceId: 1441 })
    expect(readTimelapseGeneratedAt(h.store.get(rule.id) ?? rule, 1441)).toBe(0)
  })

  it('refuses a device the rule does not cover', async () => {
    const h = await makeHarness()
    const rule = await seed(h)
    await expect(h.scheduler.runNow({ ruleId: rule.id, deviceId: 999 })).rejects.toThrow(/999/)
  })

  it('refuses an unknown rule', async () => {
    const h = await makeHarness()
    await expect(h.scheduler.runNow({ ruleId: 'nope', deviceId: 1 })).rejects.toThrow(/not found/)
  })

  it('reports the failure reason rather than swallowing it', async () => {
    const h = await makeHarness({
      render: vi.fn(async () => {
        throw new TimelapseRenderError('no-footage', 'no footage for 1441')
      }),
    })
    const rule = await seed(h)
    const out = await h.scheduler.runNow({ ruleId: rule.id, deviceId: 1441 })
    expect(out.produced).toBe(0)
    expect(out.error).toContain('no footage')
  })
})
