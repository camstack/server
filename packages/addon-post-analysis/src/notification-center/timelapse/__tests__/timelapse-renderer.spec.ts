/**
 * TimelapseRenderer — one closed window, one camera, one export.
 *
 * It builds nothing of its own: the render is `recordingExport.createExport`,
 * which already runs on the node that owns the footage, already has retention
 * and already knows how to drive ffmpeg. This module only decides WHAT to ask
 * for (profile, cadence, dense ranges) and reports what it got.
 */
import { type ExportRecord, ExportTimelapseSchema, type IScopedLogger } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockFirstCall } from '../../../__tests__/support/vitest-mock.js'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import {
  TIMELAPSE_EXPORT_LIFE_MS,
  TimelapseRenderError,
  TimelapseRenderer,
  type TimelapseRenderPorts,
} from '../timelapse-renderer.js'
import { buildTestMp4 } from './mp4-fixture.js'

const WINDOW = {
  startMs: Date.UTC(2026, 0, 5, 22),
  endMs: Date.UTC(2026, 0, 6, 6),
}
const HOUR = 3600_000

function makeExport(over: Partial<ExportRecord> = {}): ExportRecord {
  return {
    id: 'exp-1',
    deviceId: 1441,
    profile: 'main',
    fromMs: WINDOW.startMs,
    toMs: WINDOW.endMs,
    options: { includeAudio: false, maxLifeMs: 1, deleteAfterDownload: false },
    state: 'ready',
    progressPct: null,
    fileBytes: 4_000_000,
    expiresAt: 0,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: 0,
    createdBy: 'nc',
    error: null,
    ...over,
  }
}

interface Harness {
  readonly ports: TimelapseRenderPorts
  readonly created: unknown[]
  states: ExportRecord[]
}

function makeHarness(over: Partial<TimelapseRenderPorts> = {}): Harness {
  const created: unknown[] = []
  const h: Harness = {
    created,
    states: [makeExport()],
    ports: {
      logger: makeSilentLogger(),
      now: () => WINDOW.endMs + 300_000,
      sleep: async () => undefined,
      getAvailability: async () => ({
        ranges: [{ profile: 'main', startMs: WINDOW.startMs, endMs: WINDOW.endMs }],
        profilesWithFootage: ['main'],
      }),
      listTracks: async () => [],
      listDetectionEvents: async () => [],
      listExports: async () => [],
      exportLifeMs: async () => TIMELAPSE_EXPORT_LIFE_MS,
      createExport: async (input) => {
        created.push(input)
        return h.states[0] ?? makeExport({ state: 'queued' })
      },
      getExport: async () => h.states[Math.min(1, h.states.length - 1)] ?? makeExport(),
      ...over,
    },
  }
  return h
}

describe('TimelapseRenderer', () => {
  let harness: Harness

  beforeEach(() => {
    harness = makeHarness()
  })

  const render = async (
    h: Harness = harness,
    over: {
      readonly previewText?: string
      readonly previewMode?: 'image' | 'gif'
      readonly reportClasses?: readonly string[]
      readonly denseCadenceSec?: number
      readonly minDwellSec?: number
      readonly timezone?: string
    } = {},
  ): Promise<Awaited<ReturnType<TimelapseRenderer['render']>>> =>
    new TimelapseRenderer(h.ports).render({
      ruleId: 'tl-1',
      ruleName: 'Notte retro',
      deviceId: 1441,
      window: WINDOW,
      cadenceSec: 30,
      framerate: 12,
      ...over,
    })

  it('asks the export engine for a timelapse at the rule’s cadence and framerate', async () => {
    await render()
    expect(harness.created[0]).toMatchObject({
      deviceId: 1441,
      profile: 'main',
      fromMs: WINDOW.startMs,
      toMs: WINDOW.endMs,
      options: {
        includeAudio: false,
        timelapse: { everyMs: 30_000, outputFps: 12 },
      },
    })
  })

  it('attaches dense ranges derived from the window’s tracks', async () => {
    const h = makeHarness({
      listTracks: async () => [
        {
          firstSeen: WINDOW.startMs + 600_000,
          lastSeen: WINDOW.startMs + 620_000,
        },
      ],
    })
    const out = await render(h)
    expect(out.plan.ranges).toEqual([{ fromSec: 595, toSec: 625 }])
    expect(h.created[0]).toMatchObject({
      options: {
        timelapse: { dense: { ranges: [{ fromSec: 595, toSec: 625 }] } },
      },
    })
  })

  /**
   * The operator's report of 2026-08-14, reproduced. Camera 101's night of
   * 13→14 August had ZERO persisted tracks over ten hours — the confirmation
   * gate had retracted the 23:31 person as a suspected false positive
   * (`bestIncompatibleClass=animal 0.6187`) before the store ever saw it — while
   * the two object-event rows for that same pass survived. The delivered video
   * therefore never slowed down. The events alone must be enough.
   */
  it('slows down over a detection the track store never persisted', async () => {
    const at = WINDOW.startMs + 600_000
    const h = makeHarness({
      listTracks: async () => [],
      listDetectionEvents: async () => [
        { trackId: '0e6a91ad', timestamp: at, className: 'person' },
        { trackId: '0e6a91ad', timestamp: at + 3000, className: 'person' },
      ],
    })
    const out = await render(h)
    expect(out.plan.ranges).toEqual([{ fromSec: 595, toSec: 608 }])
    expect(h.created[0]).toMatchObject({
      options: {
        timelapse: { dense: { ranges: [{ fromSec: 595, toSec: 608 }] } },
      },
    })
    // And the caption that rides along must agree with the video: the same
    // merged array is what the counts come from.
    expect(out.detections.total).toBe(1)
    expect(out.detections.byClass['person']).toBe(1)
  })

  it('counts one subject once when the store AND the events both hold it', async () => {
    const at = WINDOW.startMs + 600_000
    const h = makeHarness({
      listTracks: async () => [
        {
          trackId: 't1',
          firstSeen: at,
          lastSeen: at + 7000,
          className: 'person',
        },
      ],
      listDetectionEvents: async () => [
        { trackId: 't1', timestamp: at, className: 'person' },
        { trackId: 't1', timestamp: at + 7000, className: 'person' },
      ],
    })
    const out = await render(h)
    expect(out.detections.total).toBe(1)
    expect(out.plan.ranges).toEqual([{ fromSec: 595, toSec: 612 }])
  })

  it('still plans from the tracks when the EVENT read fails, and says so', async () => {
    const warn = vi.fn()
    const logger = { ...makeSilentLogger(), warn }
    const h = makeHarness({
      logger,
      listTracks: async () => [
        {
          firstSeen: WINDOW.startMs + 600_000,
          lastSeen: WINDOW.startMs + 607_000,
        },
      ],
      listDetectionEvents: async () => {
        throw new Error('UDS request timed out after 60000ms')
      },
    })
    const out = await render(h)
    expect(out.plan.ranges).toEqual([{ fromSec: 595, toSec: 612 }])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('detection-event read failed'),
      expect.anything(),
    )
  })

  describe('the export title an operator reads', () => {
    /**
     * TWO zones, and the assertion is that BOTH are honoured — deliberately.
     * `Europe/Rome` alone proves nothing on a developer machine that already
     * runs on Rome: the pre-fix host-local derivation gives the identical string
     * there, so the case was green with the fix removed. No single host zone can
     * satisfy Tokyo and New York at once.
     *
     * The window is 22:00→06:00 UTC. Tokyo is UTC+9, New York UTC-5 in January.
     */
    it('clocks the window in the RULE’s timezone, not the host’s', async () => {
      for (const [timezone, title] of [
        ['Asia/Tokyo', 'Notte retro 07:00→15:00'],
        ['America/New_York', 'Notte retro 17:00→01:00'],
        ['UTC', 'Notte retro 22:00→06:00'],
        // What this deployment actually runs: a 21:00→07:00 Rome window used to
        // be titled 19:00→05:00 because the hub container is on UTC.
        ['Europe/Rome', 'Notte retro 23:00→07:00'],
      ] as const) {
        const h = makeHarness()
        await render(h, { timezone })
        expect(h.created[0]).toMatchObject({ options: { title } })
      }
    })

    it('falls back to the host zone for a zone it cannot resolve', async () => {
      const h = makeHarness()
      await render(h, { timezone: 'Mars/Olympus_Mons' })
      const created = h.created[0] as { options: { title: string } }
      expect(created.options.title).toMatch(/^Notte retro \d\d:\d\d→\d\d:\d\d$/)
    })
  })

  describe('dense cadence — the operator’s density controls', () => {
    /** A 7 s person pass — the case the whole feature was tuned on. */
    const renderPass = async (over: {
      readonly denseCadenceSec?: number
      readonly minDwellSec?: number
    }): Promise<{
      readonly everyMs: number
      readonly dense?: { readonly everyMs: number }
    }> => {
      const h = makeHarness({
        listTracks: async () => [
          {
            firstSeen: WINDOW.startMs + 600_000,
            lastSeen: WINDOW.startMs + 607_000,
          },
        ],
      })
      await render(h, over)
      const created = h.created[0] as {
        options: {
          timelapse: { everyMs: number; dense?: { everyMs: number } }
        }
      }
      // Whatever this module asks for must survive the cap that will receive
      // it — including the "dense must be denser" refinement.
      expect(() => ExportTimelapseSchema.parse(created.options.timelapse)).not.toThrow()
      return created.options.timelapse
    }

    it('gives a rule with NO density fields the NEW default — 1 s, not 3 s', async () => {
      // The operator's `front door` rule shape exactly: base 30 s, 12 fps, and
      // neither new field. It must render DENSER than it did before without
      // being edited — the old derivation (base/10) put 3000 here, which made
      // this 7 s pass 2 frames.
      const timelapse = await renderPass({})
      expect(timelapse.everyMs).toBe(30_000)
      expect(timelapse.dense?.everyMs).toBe(1000)
    })

    it('honours an explicit denseCadenceSec override', async () => {
      const timelapse = await renderPass({ denseCadenceSec: 0.5 })
      expect(timelapse.dense?.everyMs).toBe(500)
    })

    /**
     * The RENDERED range is the pass PLUS its context padding — a 7 s pass with
     * `DENSE_PAD_SEC` either side is 17 s of video, and the dwell is measured on
     * what the operator actually watches, padding included.
     */
    const RENDERED_RANGE_MS = 17_000

    it('already clears a 1 s dwell at the new default — the guarantee is not free work', async () => {
      const timelapse = await renderPass({ minDwellSec: 1 })
      const everyMs = timelapse.dense?.everyMs ?? 0
      // 17 s / 1 s = 17 frames ≈ 1.42 s at 12 fps: past the dwell already, so
      // the cadence must NOT be pulled tighter than the default.
      expect(everyMs).toBe(1000)
      expect(Math.floor(RENDERED_RANGE_MS / everyMs) / 12).toBeGreaterThanOrEqual(1)
    })

    it('densifies until the pass fills minDwellSec of OUTPUT video', async () => {
      // The operator's arithmetic, asserted end-to-end on the export input.
      const minDwellSec = 3
      const timelapse = await renderPass({ minDwellSec })
      const everyMs = timelapse.dense?.everyMs ?? 0
      expect(everyMs).toBe(472)
      expect(everyMs).toBeLessThan(1000)
      const outputSeconds = Math.floor(RENDERED_RANGE_MS / everyMs) / 12
      expect(outputSeconds).toBeGreaterThanOrEqual(minDwellSec)
    })

    it('still refuses to ask for a dense rate that is not denser than the base', async () => {
      // A rule persisted before the upsert guard can carry a bad pair. It must
      // degrade to a UNIFORM video, never to an export the cap rejects.
      const h = makeHarness({
        listTracks: async () => [
          {
            firstSeen: WINDOW.startMs + 600_000,
            lastSeen: WINDOW.startMs + 607_000,
          },
        ],
      })
      await render(h, { denseCadenceSec: 60 })
      const created = h.created[0] as {
        options: { timelapse: { everyMs: number; dense?: unknown } }
      }
      expect(created.options.timelapse.dense).toBeUndefined()
      expect(() => ExportTimelapseSchema.parse(created.options.timelapse)).not.toThrow()
    })
  })

  it('picks the profile with the MOST footage over the window', async () => {
    const h = makeHarness({
      getAvailability: async () => ({
        ranges: [
          {
            profile: 'sub',
            startMs: WINDOW.startMs,
            endMs: WINDOW.startMs + HOUR,
          },
          { profile: 'main', startMs: WINDOW.startMs, endMs: WINDOW.endMs },
        ],
        profilesWithFootage: ['main'],
      }),
    })
    const out = await render(h)
    expect(out.profile).toBe('main')
    expect(out.coverage.fraction).toBe(1)
  })

  it('measures coverage against the CHOSEN profile only', async () => {
    const h = makeHarness({
      getAvailability: async () => ({
        ranges: [
          {
            profile: 'main',
            startMs: WINDOW.startMs,
            endMs: WINDOW.startMs + 2 * HOUR,
          },
        ],
        profilesWithFootage: ['main'],
      }),
    })
    const out = await render(h)
    expect(out.coverage.percent).toBe(25)
    expect(out.coverage.complete).toBe(false)
  })

  it('refuses before touching the export engine when there is no footage at all', async () => {
    // The cheap question first: never queue a render that cannot possibly work.
    const h = makeHarness({
      getAvailability: async () => ({ ranges: [], profilesWithFootage: [] }),
    })
    await expect(render(h)).rejects.toThrow(TimelapseRenderError)
    expect(h.created).toHaveLength(0)
  })

  it('polls until the export is ready and reports its size', async () => {
    const h = makeHarness()
    h.states = [makeExport({ state: 'queued' }), makeExport({ state: 'ready' })]
    const getExport = vi
      .fn<() => Promise<ExportRecord>>()
      .mockResolvedValueOnce(makeExport({ state: 'rendering', progressPct: 40 }))
      .mockResolvedValueOnce(makeExport({ state: 'ready', fileBytes: 12_345 }))
    const h2 = makeHarness({
      getExport,
      createExport: async () => makeExport({ state: 'queued' }),
    })
    const out = await render(h2)
    expect(getExport).toHaveBeenCalledTimes(2)
    expect(out.fileBytes).toBe(12_345)
  })

  it('throws with the engine’s own reason when the render fails', async () => {
    const h = makeHarness({
      createExport: async () => makeExport({ state: 'queued' }),
      getExport: async () => makeExport({ state: 'failed', error: 'ffmpeg exited 1' }),
    })
    await expect(render(h)).rejects.toThrow('ffmpeg exited 1')
  })

  /**
   * The bound belongs to the RENDER, not to one poll of it.
   *
   * 2026-08-14, camera 1441: export `6b037b37-…` was queued at 05:06:16 and
   * reached `ready` at 05:23:47 with 12.5 MB on disk. At 05:10:47 a single
   * `getExport` had failed with `UDS request timed out after 60000ms` — the hub
   * event loop was stalling for minutes at a time — and that one transport
   * hiccup threw straight out of the wait. The window was declared "not
   * produced", the finished video was never collected, and the next tick
   * queued a duplicate export of the same ten hours.
   */
  it('keeps waiting when ONE poll fails on the transport — the render is still owed', async () => {
    const getExport = vi
      .fn<() => Promise<ExportRecord>>()
      .mockRejectedValueOnce(new Error('UDS request timed out after 60000ms'))
      .mockResolvedValueOnce(makeExport({ state: 'rendering', progressPct: 40 }))
      .mockRejectedValueOnce(new Error('UDS request timed out after 60000ms'))
      .mockResolvedValueOnce(makeExport({ state: 'ready', fileBytes: 12_508_670 }))
    const h = makeHarness({
      getExport,
      createExport: async () => makeExport({ state: 'queued' }),
    })
    const out = await render(h)
    expect(out.fileBytes).toBe(12_508_670)
    expect(getExport).toHaveBeenCalledTimes(4)
  })

  it('still gives up under the bound when EVERY poll fails, and says the polls failed', async () => {
    let t = 0
    const h = makeHarness({
      now: () => {
        t += 60_000
        return t
      },
      createExport: async () => makeExport({ state: 'queued' }),
      getExport: async () => {
        throw new Error('UDS request timed out after 60000ms')
      },
      timeoutMs: 300_000,
    })
    await expect(render(h)).rejects.toThrow(/timed out.*poll/is)
  })

  /**
   * The retry that made things worse.
   *
   * A failed attempt leaves the (rule, camera) pair eligible, and the next tick
   * called `createExport` again — for the SAME ten hours. Renders are
   * serialised one ffmpeg at a time and each took 17–25 minutes, so on
   * 2026-08-14 camera 1441 accumulated five exports of one window while camera
   * 101 never got a lane. A retry must JOIN the render already owed.
   */
  describe('adopting an export that already covers the window', () => {
    const inFlight = (over: Partial<ExportRecord> = {}): ExportRecord =>
      makeExport({
        id: 'already-going',
        state: 'rendering',
        profile: 'main',
        fileBytes: null,
        expiresAt: WINDOW.endMs + 7 * 86_400_000,
        options: {
          includeAudio: false,
          maxLifeMs: 7 * 86_400_000,
          deleteAfterDownload: false,
          timelapse: { everyMs: 30_000, outputFps: 12 },
        },
        ...over,
      })

    it('adopts an in-flight export of the same window instead of queueing another', async () => {
      const createExport = vi.fn(async () => makeExport({ state: 'queued' }))
      const h = makeHarness({
        listExports: async () => [inFlight()],
        createExport,
        getExport: async () => makeExport({ id: 'already-going', state: 'ready', fileBytes: 99 }),
      })
      const out = await render(h)
      expect(createExport).not.toHaveBeenCalled()
      expect(out.exportId).toBe('already-going')
      expect(out.fileBytes).toBe(99)
    })

    it('adopts a READY export of the same window without polling at all', async () => {
      const getExport = vi.fn(async () => makeExport())
      const createExport = vi.fn(async () => makeExport({ state: 'queued' }))
      const h = makeHarness({
        listExports: async () => [inFlight({ state: 'ready', fileBytes: 12_507_434 })],
        createExport,
        getExport,
      })
      const out = await render(h)
      expect(createExport).not.toHaveBeenCalled()
      expect(getExport).not.toHaveBeenCalled()
      expect(out.fileBytes).toBe(12_507_434)
    })

    it('never adopts a different window, profile or cadence', async () => {
      for (const wrong of [
        inFlight({ fromMs: WINDOW.startMs - HOUR }),
        inFlight({ toMs: WINDOW.endMs + HOUR }),
        inFlight({ profile: 'sub' }),
        inFlight({
          options: {
            includeAudio: false,
            maxLifeMs: 1,
            deleteAfterDownload: false,
            timelapse: { everyMs: 60_000, outputFps: 12 },
          },
        }),
        // A plain (non-timelapse) export of the same range is a different video.
        inFlight({
          options: {
            includeAudio: false,
            maxLifeMs: 1,
            deleteAfterDownload: false,
          },
        }),
      ]) {
        const createExport = vi.fn(async () => makeExport({ state: 'queued' }))
        const h = makeHarness({
          listExports: async () => [wrong],
          createExport,
        })
        await render(h)
        expect(createExport).toHaveBeenCalledTimes(1)
      }
    })

    it('never adopts a terminal or expired row', async () => {
      for (const dead of [
        inFlight({ state: 'failed' }),
        inFlight({ state: 'deleted' }),
        inFlight({ state: 'expired' }),
        // `ready`, but the file is already past its life — nothing to fetch.
        inFlight({ state: 'ready', fileBytes: 10, expiresAt: 1 }),
        // `ready` with no file behind it.
        inFlight({ state: 'ready', fileBytes: null }),
      ]) {
        const createExport = vi.fn(async () => makeExport({ state: 'queued' }))
        const h = makeHarness({
          listExports: async () => [dead],
          createExport,
        })
        await render(h)
        expect(createExport).toHaveBeenCalledTimes(1)
      }
    })

    /**
     * The trap this closes. Attempt one reads the detections while the store is
     * unreachable, plans nothing and queues a UNIFORM ten-hour export. Every
     * retry then plans the ranges correctly, finds that uniform row alive under
     * the same (profile, range, base cadence, fps) key and adopts it — so the
     * night is delivered without a single slowdown however many retries run, and
     * the notification still captions it "2 persone".
     */
    it('refuses to adopt an export with NO dense overlay when it planned one', async () => {
      const createExport = vi.fn<TimelapseRenderPorts['createExport']>(async () =>
        makeExport({ state: 'queued' }),
      )
      const h = makeHarness({
        listExports: async () => [inFlight()],
        createExport,
        listTracks: async () => [
          {
            firstSeen: WINDOW.startMs + 600_000,
            lastSeen: WINDOW.startMs + 607_000,
          },
        ],
      })
      await render(h)
      expect(createExport).toHaveBeenCalledTimes(1)
      expect(mockFirstCall(createExport)[0]).toMatchObject({
        options: {
          timelapse: { dense: { ranges: [{ fromSec: 595, toSec: 612 }] } },
        },
      })
    })

    /** The refusal is a function of the PLAN, so the export ordered after it
     *  carries the overlay and the next retry adopts it. Bounded, not a loop. */
    it('adopts the export the refusal ordered on the next attempt', async () => {
      const withDense = inFlight({
        options: {
          includeAudio: false,
          maxLifeMs: 7 * 86_400_000,
          deleteAfterDownload: false,
          timelapse: {
            everyMs: 30_000,
            outputFps: 12,
            dense: { everyMs: 1000, ranges: [{ fromSec: 595, toSec: 612 }] },
          },
        },
      })
      const createExport = vi.fn(async () => makeExport({ state: 'queued' }))
      const h = makeHarness({
        listExports: async () => [withDense],
        createExport,
        listTracks: async () => [
          {
            firstSeen: WINDOW.startMs + 600_000,
            lastSeen: WINDOW.startMs + 607_000,
          },
        ],
        getExport: async () => makeExport({ id: 'already-going', state: 'ready', fileBytes: 42 }),
      })
      const out = await render(h)
      expect(createExport).not.toHaveBeenCalled()
      expect(out.exportId).toBe('already-going')
    })

    it('still adopts a dense-less export when it planned no slowdown either', async () => {
      const createExport = vi.fn(async () => makeExport({ state: 'queued' }))
      const h = makeHarness({
        listExports: async () => [inFlight()],
        createExport,
        getExport: async () => makeExport({ id: 'already-going', state: 'ready', fileBytes: 7 }),
      })
      const out = await render(h)
      expect(createExport).not.toHaveBeenCalled()
      expect(out.exportId).toBe('already-going')
    })

    /** More slowdown than asked for is not a defect — re-ordering ten hours to
     *  reduce it would be. */
    it('adopts an export DENSER than the plan asked for', async () => {
      const createExport = vi.fn(async () => makeExport({ state: 'queued' }))
      const h = makeHarness({
        listExports: async () => [
          inFlight({
            options: {
              includeAudio: false,
              maxLifeMs: 7 * 86_400_000,
              deleteAfterDownload: false,
              timelapse: {
                everyMs: 30_000,
                outputFps: 12,
                dense: { everyMs: 200, ranges: [{ fromSec: 1, toSec: 2 }] },
              },
            },
          }),
        ],
        createExport,
        listTracks: async () => [
          {
            firstSeen: WINDOW.startMs + 600_000,
            lastSeen: WINDOW.startMs + 607_000,
          },
        ],
        getExport: async () => makeExport({ id: 'already-going', state: 'ready', fileBytes: 5 }),
      })
      await render(h)
      expect(createExport).not.toHaveBeenCalled()
    })

    it('orders its own export when the adoption lookup itself fails', async () => {
      const createExport = vi.fn(async () => makeExport({ state: 'queued' }))
      const h = makeHarness({
        listExports: async () => {
          throw new Error('UDS request timed out after 60000ms')
        },
        createExport,
      })
      await render(h)
      expect(createExport).toHaveBeenCalledTimes(1)
    })
  })

  it('gives up under a bound rather than polling forever', async () => {
    let t = 0
    const h = makeHarness({
      now: () => {
        t += 60_000
        return t
      },
      createExport: async () => makeExport({ state: 'queued' }),
      getExport: async () => makeExport({ state: 'rendering' }),
      timeoutMs: 300_000,
    })
    await expect(render(h)).rejects.toThrow(/timed out/i)
  })

  it('publishes the finished video as a public artifact when the seam is wired', async () => {
    const publishArtifact = vi.fn(async () => ({
      video: {
        url: 'https://hub/nc-artifact/x.mp4?sig=1',
        mime: 'video/mp4',
        name: 'timelapse-1441.mp4',
      },
      preview: {
        url: 'https://hub/nc-artifact/x.jpg?sig=2',
        mime: 'image/jpeg',
        name: 'timelapse-preview.jpg',
      },
    }))
    const out = await render(makeHarness({ publishArtifact }))
    expect(publishArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ exportId: 'exp-1', deviceId: 1441 }),
    )
    expect(out.artifact?.url).toContain('nc-artifact')
    expect(out.preview?.mime).toBe('image/jpeg')
  })

  it('forwards the ALREADY-RENDERED caption to the publisher, and only when asked', async () => {
    const publishArtifact = vi.fn<NonNullable<TimelapseRenderPorts['publishArtifact']>>(
      async () => ({ video: null, preview: null }),
    )
    await render(makeHarness({ publishArtifact }), {
      previewText: 'Timelapse front door',
    })
    expect(publishArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ previewText: 'Timelapse front door' }),
    )
    publishArtifact.mockClear()
    await render(makeHarness({ publishArtifact }))
    expect(mockFirstCall(publishArtifact)[0]).not.toHaveProperty('previewText')
  })

  it('forwards the preview MODE to the publisher, and defaults it to the still', async () => {
    const publishArtifact = vi.fn(async () => ({ video: null, preview: null }))
    await render(makeHarness({ publishArtifact }), {
      previewText: 'x',
      previewMode: 'gif',
    })
    expect(publishArtifact).toHaveBeenCalledWith(expect.objectContaining({ previewMode: 'gif' }))
    publishArtifact.mockClear()
    await render(makeHarness({ publishArtifact }), { previewText: 'x' })
    // An old rule that names no mode must not start producing animations.
    expect(publishArtifact).toHaveBeenCalledWith(expect.objectContaining({ previewMode: 'image' }))
  })

  it('counts the window per class from the SAME tracks the dense plan used', async () => {
    const listTracks = vi.fn(async () => [
      {
        firstSeen: WINDOW.startMs + 1000,
        lastSeen: WINDOW.startMs + 2000,
        className: 'person',
      },
      {
        firstSeen: WINDOW.startMs + 3000,
        lastSeen: WINDOW.startMs + 4000,
        className: 'person',
      },
      {
        firstSeen: WINDOW.startMs + 5000,
        lastSeen: WINDOW.startMs + 6000,
        className: 'vehicle',
      },
    ])
    const out = await render(makeHarness({ listTracks }))
    // ONE read: a count from its own query could disagree with the ranges the
    // video was actually cut from.
    expect(listTracks).toHaveBeenCalledTimes(1)
    expect(out.detections.total).toBe(3)
    expect(out.detections.byClass).toEqual({ person: 2, vehicle: 1 })
  })

  it('honours the rule’s reportClasses when counting', async () => {
    const out = await render(
      makeHarness({
        listTracks: async () => [
          {
            firstSeen: WINDOW.startMs + 1000,
            lastSeen: WINDOW.startMs + 2000,
            className: 'person',
          },
          {
            firstSeen: WINDOW.startMs + 3000,
            lastSeen: WINDOW.startMs + 4000,
            className: 'vehicle',
          },
        ],
      }),
      { reportClasses: ['person'] },
    )
    expect(out.detections.total).toBe(1)
    expect(out.detections.byClass).toEqual({ person: 1 })
  })

  it('counts ZERO — never undefined — when the track read failed', async () => {
    // A failed track read already costs the dense overlay; it must not make the
    // counts absent in a way a template would render as literal braces.
    const out = await render(
      makeHarness({
        listTracks: async () => {
          throw new Error('store is gone')
        },
      }),
    )
    expect(out.detections.total).toBe(0)
    expect(out.detections.classes).toEqual([])
  })

  it('still succeeds with a null artifact when publishing is unavailable or fails', async () => {
    // A render that produced a video but no reachable link is still news: the
    // operator gets the text, and the failure is logged rather than swallowed.
    const out = await render(
      makeHarness({
        publishArtifact: async () => {
          throw new Error('no public base url')
        },
      }),
    )
    expect(out.artifact).toBeNull()
    expect(out.preview).toBeNull()
    expect(out.exportId).toBe('exp-1')
  })

  it('resolves the session-gated download link as a TAP-THROUGH, never as an attachment', async () => {
    // The export route is served `access: 'authenticated'`. It is a perfectly
    // good link for the person holding the phone and a useless one for a
    // notifier backend, which holds no session — so it must not become the
    // artifact URL.
    const out = await render(
      makeHarness({
        resolveDownloadUrl: async () => 'https://hub.example/addon/recorder/exports/exp-1.mp4',
      }),
    )
    expect(out.downloadUrl).toBe('https://hub.example/addon/recorder/exports/exp-1.mp4')
    expect(out.artifact).toBeNull()
  })

  it('survives a download-link resolver that throws', async () => {
    const out = await render(
      makeHarness({
        resolveDownloadUrl: async () => {
          throw new Error('no endpoints')
        },
      }),
    )
    expect(out.downloadUrl).toBeNull()
    expect(out.exportId).toBe('exp-1')
  })

  it('renders a UNIFORM timelapse and reports it when the dense plan is capped', async () => {
    const tracks = Array.from({ length: 250 }, (_, i) => ({
      firstSeen: WINDOW.startMs + i * 100_000,
      lastSeen: WINDOW.startMs + i * 100_000 + 1000,
    }))
    const h = makeHarness({ listTracks: async () => tracks })
    const out = await render(h)
    expect(out.plan.capped).toBe(true)
    expect(h.created[0]).toMatchObject({
      options: { timelapse: { everyMs: 30_000 } },
    })
    expect(
      (h.created[0] as { options: { timelapse: { dense?: unknown } } }).options.timelapse.dense,
    ).toBeUndefined()
  })

  it('never asks for a dense cadence that is not denser than the base', async () => {
    // `ExportTimelapseSchema` refuses `dense.everyMs >= everyMs`, so an
    // unclamped derivation would make every export of a fast-cadence rule fail
    // at the cap boundary — hours after the window, with nothing left to
    // retry. At the schema's minimum cadence (2 s) the derived tenth floors to
    // 1 s and must still be STRICTLY denser.
    const h = makeHarness({
      listTracks: async () => [
        {
          firstSeen: WINDOW.startMs + 600_000,
          lastSeen: WINDOW.startMs + 620_000,
        },
      ],
    })
    await new TimelapseRenderer(h.ports).render({
      ruleId: 'tl-1',
      ruleName: 'r',
      deviceId: 1441,
      window: WINDOW,
      cadenceSec: 2,
      framerate: 12,
    })
    const created = h.created[0] as {
      options: { timelapse: { everyMs: number; dense?: { everyMs: number } } }
    }
    expect(created.options.timelapse.everyMs).toBe(2000)
    expect(created.options.timelapse.dense?.everyMs).toBe(1000)
    // The pair the renderer emits must survive the cap's own validation.
    expect(() => ExportTimelapseSchema.parse(created.options.timelapse)).not.toThrow()
  })
})

/**
 * The post-render pacing check. Born of export `3a62ec17` (camera 101, night of
 * 2026-08-20→21): the scheduler logged `timelapse produced … denseRanges=9`,
 * every number true of the PLAN, while the delivered file held 594 frames where
 * ~1250 were selected and the person at 06:26 played at full speed. The check
 * asks the one question the log never did — does the FILE match the plan — from
 * the same plan, coverage rows and cadences the render was built from (one
 * authority), and it is best-effort: no wiring, a failed read or a garbled file
 * degrade to a log line, never to a failed window.
 */
describe('TimelapseRenderer — pacing check', () => {
  /** One 30 s person pass ⇒ plan [595,625]s dense at 1 s; 8 h window fully
   *  covered ⇒ 959 base + 30 dense = 989 expected frames, 960 baseline. */
  const trackPorts = {
    listTracks: async () => [
      {
        trackId: 't-1',
        firstSeen: WINDOW.startMs + 600_000,
        lastSeen: WINDOW.startMs + 620_000,
        className: 'person',
      },
    ],
  }
  const fileOfFrames = (frames: number): { base64: string } => ({
    base64: Buffer.from(buildTestMp4({ durationMs: Math.round((frames / 12) * 1000) })).toString(
      'base64',
    ),
  })

  const renderWith = async (over: Partial<TimelapseRenderPorts>): Promise<Harness> => {
    const h = makeHarness({ ...trackPorts, ...over })
    await new TimelapseRenderer(h.ports).render({
      ruleId: 'tl-1',
      ruleName: 'Notte retro',
      deviceId: 1441,
      window: WINDOW,
      cadenceSec: 30,
      framerate: 12,
    })
    return h
  }

  it('verifies a file that delivered the plan, and says so', async () => {
    const info = vi.fn()
    await renderWith({
      logger: { ...makeSilentLogger(), info } as unknown as IScopedLogger,
      readExportBytes: async () => fileOfFrames(989),
    })
    expect(info).toHaveBeenCalledWith(
      'timelapse pacing verified',
      expect.objectContaining({
        tags: { deviceId: 1441 },
        meta: expect.objectContaining({ exportId: 'exp-1', actualFrames: 989 }),
      }),
    )
  })

  it('WARNs, with who and when, when a detection window received no slowdown', async () => {
    const warn = vi.fn()
    await renderWith({
      logger: { ...makeSilentLogger(), warn } as unknown as IScopedLogger,
      // Exactly the uniform baseline — the dense overlay never reached the file.
      readExportBytes: async () => fileOfFrames(960),
    })
    expect(warn).toHaveBeenCalledWith(
      'timelapse pacing check: detection windows received no slowdown',
      expect.objectContaining({
        tags: { deviceId: 1441 },
        meta: expect.objectContaining({
          exportId: 'exp-1',
          actualFrames: 960,
          unservedWindows: [
            expect.objectContaining({
              expectedDenseFrames: 30,
              classes: ['person'],
              subjects: 1,
            }),
          ],
        }),
      }),
    )
  })

  it('never fails the render over a check that throws — but names the failure', async () => {
    const warn = vi.fn()
    const h = makeHarness({
      ...trackPorts,
      logger: { ...makeSilentLogger(), warn } as unknown as IScopedLogger,
      readExportBytes: async () => {
        throw new Error('UDS request timed out')
      },
    })
    const out = await new TimelapseRenderer(h.ports).render({
      ruleId: 'tl-1',
      ruleName: 'Notte retro',
      deviceId: 1441,
      window: WINDOW,
      cadenceSec: 30,
      framerate: 12,
    })
    expect(out.exportId).toBe('exp-1')
    expect(warn).toHaveBeenCalledWith(
      'timelapse pacing check failed — delivery unaffected',
      expect.objectContaining({
        tags: { deviceId: 1441 },
        meta: expect.objectContaining({ exportId: 'exp-1' }),
      }),
    )
  })

  it('renders exactly as before when no byte reader is wired', async () => {
    const h = makeHarness(trackPorts)
    const out = await new TimelapseRenderer(h.ports).render({
      ruleId: 'tl-1',
      ruleName: 'Notte retro',
      deviceId: 1441,
      window: WINDOW,
      cadenceSec: 30,
      framerate: 12,
    })
    expect(out.exportId).toBe('exp-1')
  })
})

/**
 * 2026-09-03: a test render of a ten-hour window chose `profile=high` at 97%
 * coverage — 4K off a spinning disk. Decoding it made the machine stop
 * answering SSH and its own web UI for half an hour, and it was power-cycled.
 * The rule has been off since.
 *
 * `pickProfile` was rewritten then to take the CHEAPEST band, always. That fix
 * could never fire: it is handed `recording.getAvailability(...).ranges`, and
 * that method answers for ONE profile — the PREFERRED one, which is `high`
 * (D433). The safety rule could only choose from what it had been given, and
 * it had been given the expensive band and nothing else.
 */
describe('the cheapest band is ASKED for, not hoped for', () => {
  const request = {
    ruleId: 'tl-1',
    ruleName: 'Notte retro',
    deviceId: 1441,
    window: WINDOW,
    cadenceSec: 30,
    framerate: 12,
  }

  it('names the cheapest recorded band in the availability read', async () => {
    const asked: (string | undefined)[] = []
    const h = makeHarness({
      getAvailability: async (input) => {
        asked.push(input.profile)
        return {
          ranges: [
            { profile: input.profile ?? 'high', startMs: WINDOW.startMs, endMs: WINDOW.endMs },
          ],
          profilesWithFootage: ['high', 'low'],
        }
      },
    })
    await new TimelapseRenderer(h.ports).render(request).catch(() => undefined)

    // TWO reads before the export, and the second one is the fix: the first
    // learns which bands exist, the second asks the cheapest by name. Without
    // it the hub answers for its preferred band — `high` — and `pickProfile`
    // can only choose what it was handed. The third read is AFTER the export:
    // the window against the archive, on the band that was rendered.
    expect(asked, 'the read did not name a band, so the hub picked high').toEqual([
      undefined,
      'low',
      'low',
    ])
  })

  it('does NOT read twice when the preferred band is already the cheapest', async () => {
    const asked: (string | undefined)[] = []
    const h = makeHarness({
      getAvailability: async (input) => {
        asked.push(input.profile)
        return {
          ranges: [{ profile: 'low', startMs: WINDOW.startMs, endMs: WINDOW.endMs }],
          profilesWithFootage: ['low'],
        }
      },
    })
    await new TimelapseRenderer(h.ports).render(request).catch(() => undefined)

    // One read before the export; the `low` read is the post-export archive
    // measurement, not a second band lookup.
    expect(asked, 'a second read was spent on the band already in hand').toEqual([undefined, 'low'])
  })

  it('renders from that band, not from the hub preference', async () => {
    const h = makeHarness({
      getAvailability: async (input) => ({
        ranges: [
          { profile: input.profile ?? 'high', startMs: WINDOW.startMs, endMs: WINDOW.endMs },
        ],
        profilesWithFootage: ['high', 'low'],
      }),
    })
    await new TimelapseRenderer(h.ports).render(request).catch(() => undefined)

    expect(h.created[0]).toMatchObject({ profile: 'low' })
  })
})

/**
 * Camera 4374, night of 2026-09-10→11 (D445): the planner read 2,362 s of
 * availability over a 36,000 s window, the export then WALKED the array and
 * found 11,986 s, and the file shipped with no statement of either figure.
 * `checkTimelapsePacing` measured the plan against the file and would have
 * called it fine — it never measured the window against the archive.
 *
 * The archive figure is the availability read AFTER the export: the export's
 * verified walk repairs the index the calendar serves from, so the second
 * read is what the file was actually rendered from.
 */
describe('the window against the archive', () => {
  const ROBOT_WINDOW = { startMs: Date.UTC(2026, 8, 10, 19), endMs: Date.UTC(2026, 8, 11, 5) }
  const PLANNED_MS = 2_362_000
  const ARCHIVE_MS = 11_986_000
  const request = {
    ruleId: 'tl-robot',
    ruleName: 'Robot notte',
    deviceId: 4374,
    window: ROBOT_WINDOW,
    cadenceSec: 30,
    framerate: 12,
  }

  /** Short rows until the export is ordered, the walked archive afterwards. */
  function robotHarness(over: Partial<TimelapseRenderPorts> = {}): Harness {
    let exported = false
    const h = makeHarness({
      getAvailability: async () => ({
        ranges: [
          {
            profile: 'low',
            startMs: ROBOT_WINDOW.startMs,
            endMs: ROBOT_WINDOW.startMs + (exported ? ARCHIVE_MS : PLANNED_MS),
          },
        ],
        profilesWithFootage: ['low'],
      }),
      ...over,
    })
    const createExport = h.ports.createExport
    return {
      ...h,
      ports: {
        ...h.ports,
        createExport: async (input) => {
          exported = true
          return createExport(input)
        },
      },
    }
  }

  it('WARNs with the ratio when the export found footage the plan never saw', async () => {
    const warn = vi.fn()
    const h = robotHarness({ logger: { ...makeSilentLogger(), warn } as unknown as IScopedLogger })
    const out = await new TimelapseRenderer(h.ports).render(request)

    expect(warn).toHaveBeenCalledWith(
      'timelapse coverage: the plan was cut from less footage than the archive holds',
      expect.objectContaining({
        tags: { deviceId: 4374 },
        meta: expect.objectContaining({
          exportId: 'exp-1',
          windowSec: 36_000,
          plannedSec: 2_362,
          archiveSec: 11_986,
          plannedOfArchive: 0.2,
          archiveOfWindow: 0.33,
        }),
      }),
    )
    // What the notification says it covers is what the FILE holds.
    expect(out.coverage.coveredMs).toBe(ARCHIVE_MS)
  })

  it('reports the same ratio at info when the archive agrees with the plan', async () => {
    const info = vi.fn()
    const warn = vi.fn()
    const h = makeHarness({
      logger: { ...makeSilentLogger(), info, warn } as unknown as IScopedLogger,
      getAvailability: async () => ({
        ranges: [
          {
            profile: 'low',
            startMs: ROBOT_WINDOW.startMs,
            endMs: ROBOT_WINDOW.startMs + ARCHIVE_MS,
          },
        ],
        profilesWithFootage: ['low'],
      }),
    })
    await new TimelapseRenderer(h.ports).render(request)

    // Always reported — a ratio of 1.00 is a fact worth one line, and it is
    // the line that says the night was measured at all.
    expect(info).toHaveBeenCalledWith(
      'timelapse coverage: the window against the archive',
      expect.objectContaining({
        tags: { deviceId: 4374 },
        meta: expect.objectContaining({ plannedOfArchive: 1, archiveOfWindow: 0.33 }),
      }),
    )
    expect(warn).not.toHaveBeenCalledWith(
      'timelapse coverage: the plan was cut from less footage than the archive holds',
      expect.anything(),
    )
  })

  it('measures pacing against the archive the file was rendered from', async () => {
    const info = vi.fn()
    // 11,986 s at one frame per 30 s ≈ 400 frames: right for the archive,
    // a five-fold SURPLUS against the 2,362 s plan.
    const h = robotHarness({
      logger: { ...makeSilentLogger(), info } as unknown as IScopedLogger,
      readExportBytes: async () => ({
        base64: Buffer.from(buildTestMp4({ durationMs: Math.round((400 / 12) * 1000) })).toString(
          'base64',
        ),
      }),
    })
    await new TimelapseRenderer(h.ports).render(request)

    expect(info).toHaveBeenCalledWith(
      'timelapse pacing verified',
      expect.objectContaining({ meta: expect.objectContaining({ expectedFrames: 400 }) }),
    )
  })

  it('keeps the plan figure and says so when the archive re-read fails', async () => {
    const warn = vi.fn()
    let calls = 0
    const h = robotHarness({
      logger: { ...makeSilentLogger(), warn } as unknown as IScopedLogger,
      getAvailability: async () => {
        calls += 1
        if (calls > 1) throw new Error('UDS request timed out')
        return {
          ranges: [
            {
              profile: 'low',
              startMs: ROBOT_WINDOW.startMs,
              endMs: ROBOT_WINDOW.startMs + PLANNED_MS,
            },
          ],
          profilesWithFootage: ['low'],
        }
      },
    })
    const out = await new TimelapseRenderer(h.ports).render(request)

    expect(warn).toHaveBeenCalledWith(
      'timelapse coverage: archive re-read failed — the window is reported against the plan only',
      expect.objectContaining({
        tags: { deviceId: 4374 },
        meta: expect.objectContaining({
          // A measurement that FAILED is null, never the plan's figure wearing
          // the archive's name (D393). The plan's OWN figure is still said.
          archiveSec: null,
          archiveOfWindow: null,
          plannedOfArchive: null,
          plannedSec: 2_362,
          plannedOfWindow: 0.07,
        }),
      }),
    )
    expect(out.coverage.coveredMs).toBe(PLANNED_MS)
  })

  it('always states what was asked against what was delivered', async () => {
    const warn = vi.fn()
    const h = robotHarness({ logger: { ...makeSilentLogger(), warn } as unknown as IScopedLogger })
    await new TimelapseRenderer(h.ports).render(request)

    // The operator's own question — "ten hours in, six seconds of video out" —
    // as a number, on the same line as the ratio that explains it. 2,362 s of
    // a 36,000 s window is 0.07; the archive held 0.33 of the window, and the
    // planner saw 0.20 of the archive. Three ratios, one line, always.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('timelapse coverage'),
      expect.objectContaining({
        meta: expect.objectContaining({
          windowSec: 36_000,
          plannedOfWindow: 0.07,
          archiveOfWindow: 0.33,
          plannedOfArchive: 0.2,
          shortfallSec: 9_624,
        }),
      }),
    )
  })
})
