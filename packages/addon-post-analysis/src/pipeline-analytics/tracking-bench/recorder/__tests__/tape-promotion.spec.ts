/**
 * Promotion (decision 11): a window of the last 24 h becomes a promoted tape,
 * its tracks are pinned, and the budgets REFUSE rather than evict.
 *
 * Task 12 additions — the row and the pins live in two tables, so no write
 * makes them atomic. The row is the intent log (`pinsSettled`, owned by
 * `tape-pin-ledger.ts`): written unsettled before any pin, settled only when
 * every pin it implies has landed, and finished by `reconcileTapePins` before
 * every tape operation. A shelf that cannot be listed refuses
 * (`shelf-unreadable`), never reads as "not recorded" (D393). Operations are
 * serialised, so two promotions racing for the last budget slot cannot both
 * win.
 *
 * Fix round: an insert that reports a failure after committing keeps its file
 * (L1); a segment the listing saw but could not stat is placed by its name
 * and becomes a gap, not a refusal of the whole camera (L4); the window's
 * segments are read with the identity lookback (M3, `tape-window-read.spec`).
 *
 * Disarms:
 *  - (Task 12) in `readWindowSegments`, read a failed listing as an empty one
 *    — "refuses when the shelf cannot be listed" must fail;
 *  - (Task 12) in `settleRow`, mark the row settled whatever the pin count —
 *    "a short pin leaves the row unsettled and the next operation finishes
 *    it" must fail;
 *  - (Task 12) drop the rollback after a failed index insert — "a failed
 *    index write leaves no file and no pin" must fail;
 *  - (Task 12) bypass `TapeOperationQueue` (call `op()` directly) — "two
 *    promotions racing for the last slot" must fail;
 *  - (fix round, L1) treat every insert failure as "absent" — "an insert that
 *    committed before it failed keeps its file and pins" must fail;
 *  - (fix round, L4) drop the unstatted origins from the shelf entries — "a
 *    segment seen but not sized becomes a gap" must fail.
 *  - (fix round, M2) `cutWindow` and `encodeTapeGzipAsync` are awaited on the
 *    promotion path — a window dense enough to cross every yield threshold
 *    (`cutWindow`'s, `decodeTapeTextAsync`'s) still promotes correctly. The
 *    yield-vs-block contract itself is disarm-tested where a marker can
 *    actually discriminate it: `cut-window.spec.ts` and `tape-codec.spec.ts`
 *    — not here, where this world's fake `index.list` already yields on its
 *    own `setTimeout(0)` and would mask the disarm.
 */
import { gunzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../../__tests__/test-helpers.js'
import { sampleEnd, sampleFrame, sampleHeader } from '../../__tests__/tape-fixtures.js'
import { decodeTapeText } from '../../tape-codec.js'
import { reconcileTapePins } from '../tape-pin-ledger.js'
import { TapeOperationQueue } from '../tape-operation-queue.js'
import { MAX_PROMOTED_TAPES, promoteTapeWindow } from '../tape-promotion.js'
import { NOW, ORIGIN, oldRow, type World, world } from './promotion-world.js'

describe('promoteTapeWindow', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('promotes a recorded window, writes it, indexes it and pins its tracks', async () => {
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: '101-door-groups',
    })
    expect(r).toMatchObject({
      ok: true,
      tapeId: 'promo-0001',
      state: 'complete',
      frames: 2,
      pinnedTracks: 2,
    })
    expect(w.rotated).toEqual([101])
    expect(w.written.has('101/promoted/promo-0001')).toBe(true)
    expect(w.pins).toEqual(
      new Map([
        ['trk-a', true],
        ['trk-b', true],
      ]),
    )
    const indexed = await w.index.get('promo-0001')
    expect(indexed?.trackIds.toSorted()).toEqual(['trk-a', 'trk-b'])
    expect(indexed?.pinsSettled).toBe(true)
  })

  it('refuses a window longer than 30 minutes, an invalid slug and a future window', async () => {
    expect(
      await promoteTapeWindow(w.deps, {
        deviceId: 101,
        fromMs: ORIGIN,
        toMs: ORIGIN + 31 * 60_000,
        scenario: 'ok-slug',
      }),
    ).toMatchObject({ ok: false, reason: 'window-too-long' })
    expect(
      await promoteTapeWindow(w.deps, {
        deviceId: 101,
        fromMs: ORIGIN,
        toMs: ORIGIN + 1_000,
        scenario: 'Bad Slug',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-scenario' })
    expect(
      await promoteTapeWindow(w.deps, {
        deviceId: 101,
        fromMs: NOW + 1_000,
        toMs: NOW + 2_000,
        scenario: 'ok-slug',
      }),
    ).toMatchObject({ ok: false, reason: 'window-in-future' })
  })

  it('refuses a window no segment covers', async () => {
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN - 600_000,
      toMs: ORIGIN - 300_000,
      scenario: 'ok-slug',
    })
    expect(r).toMatchObject({ ok: false, reason: 'window-not-recorded' })
  })

  it('refuses when the shelf cannot be listed — never "not recorded" (D393)', async () => {
    w.faults.listing = { ok: false, reason: 'EIO: i/o error' }
    const failed = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'ok-slug',
    })
    expect(failed).toMatchObject({ ok: false, reason: 'shelf-unreadable' })
    expect(w.written.size).toBe(0)
    expect(w.pins.size).toBe(0)
  })

  it('a segment seen but not sized becomes a gap, not a refusal of the camera (fix round, L4)', async () => {
    // seg-1 holds ORIGIN … ORIGIN+1000; the next segment's file could be
    // listed but not stat-ed. Its origin is in its name.
    w.faults.listing = {
      ok: true,
      segments: [{ deviceId: 101, originMs: ORIGIN, file: 'seg-1', bytes: 10 }],
      unstatted: [ORIGIN + 2_000, ORIGIN - 5 * 3_600_000],
    }
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 3_000,
      scenario: 'ok-slug',
    })
    expect(r).toMatchObject({ ok: true, state: 'incomplete', gaps: 1 })
    const [file] = [...w.written.values()]
    if (file === undefined) throw new Error('expected a promoted file')
    const tape = decodeTapeText(gunzipSync(file).toString('utf8'))
    expect(tape.body).toContainEqual({ kind: 'gap', fromT: 2_000, toT: 3_000, reason: 'restart' })
  })

  it('refuses over budget without writing or pinning anything', async () => {
    for (let i = 0; i < MAX_PROMOTED_TAPES; i += 1) await w.index.insert(oldRow(i))
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'ok-slug',
    })
    expect(r).toMatchObject({ ok: false, reason: 'promotion-budget' })
    expect(w.written.size).toBe(0)
    expect(w.pins.size).toBe(0)
  })

  it('a failed index write leaves no file and no pin (Task 12)', async () => {
    w.faults.failInsert = true
    await expect(
      promoteTapeWindow(w.deps, {
        deviceId: 101,
        fromMs: ORIGIN,
        toMs: ORIGIN + 1_000,
        scenario: 'ok-slug',
      }),
    ).rejects.toThrow('settings store unavailable')
    expect(w.written.size).toBe(0)
    expect(w.pins.size).toBe(0)
  })

  it('an insert that committed before it failed keeps its file and pins (fix round, L1)', async () => {
    w.faults.insertCommitsThenThrows = true
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'ok-slug',
    })
    expect(r).toMatchObject({ ok: true, tapeId: 'promo-0001', pinnedTracks: 2 })
    expect(w.written.has('101/promoted/promo-0001')).toBe(true)
    expect(await w.index.get('promo-0001')).toMatchObject({ pinsSettled: true })
  })

  it('a short pin leaves the row unsettled and the next operation finishes it (Task 12)', async () => {
    w.faults.failingPins.add('trk-b')
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'first-one',
    })
    expect(r).toMatchObject({ ok: true, pinnedTracks: 1 })
    expect((await w.index.get('promo-0001'))?.pinsSettled).toBe(false)
    expect(w.pins.get('trk-b')).toBeUndefined()

    w.faults.failingPins.clear()
    expect(await reconcileTapePins(w.deps)).toEqual({ settled: 1, unsettled: 0 })
    expect(w.pins.get('trk-b')).toBe(true)
    expect((await w.index.get('promo-0001'))?.pinsSettled).toBe(true)
  })

  it('two promotions racing for the last slot: one wins, one is refused (Task 12)', async () => {
    for (let i = 0; i < MAX_PROMOTED_TAPES - 1; i += 1) await w.index.insert(oldRow(i))
    const queue = new TapeOperationQueue({ logger: makeLogRecorder().logger })
    const input = { deviceId: 101, fromMs: ORIGIN, toMs: ORIGIN + 1_000, scenario: 'ok-slug' }
    const context = { name: 'promote', deviceId: 101 }
    const results = await Promise.all([
      queue.run(() => promoteTapeWindow(w.deps, input), context),
      queue.run(() => promoteTapeWindow(w.deps, input), context),
    ])
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['ok', 'promotion-budget'])
    expect((await w.index.list()).length).toBe(MAX_PROMOTED_TAPES)
  })
})

describe('promoteTapeWindow — event-loop yield (fix round, M2)', () => {
  // Not a `setImmediate`-marker race like `cutWindow`'s and
  // `decodeTapeTextAsync`'s own specs: this world's fake `index.list` already
  // does a real `setTimeout(0)`, which alone lets a scheduled `setImmediate`
  // fire — so a marker here would read `true` whether or not `cutWindow`
  // yields, proving nothing (tried it; it stayed green with the yield
  // disarmed). The yield contract itself is proved where it can actually be
  // disarmed: `cut-window.spec.ts` and `tape-codec.spec.ts`. This checks the
  // one thing specific to the promotion path: it still produces the right
  // tape once `cutWindow` and `encodeTapeGzipAsync` are both awaited through
  // a window dense enough to cross every yield threshold at least twice.
  it('a dense window — enough records to cross every yield threshold — still promotes correctly', async () => {
    const w = await world()
    const frameCount = 1_010
    w.tapes.set('seg-1', {
      header: sampleHeader(),
      body: Array.from({ length: frameCount }, (_, i) =>
        sampleFrame(i * 100, {
          live: [{ trk: 'trk-a', det: `d-${String(i)}`, m: true, st: 'moving' }],
        }),
      ),
      end: sampleEnd({ durationMs: frameCount * 100 }),
    })
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + frameCount * 100,
      scenario: 'dense-window',
    })
    expect(r).toMatchObject({ ok: true, state: 'complete', frames: frameCount })
    const [file] = [...w.written.values()]
    if (file === undefined) throw new Error('expected a promoted file')
    const promoted = decodeTapeText(gunzipSync(file).toString('utf8'))
    expect(promoted.end?.frames).toBe(frameCount)
    expect(promoted.body.filter((x) => x.kind === 'frame')).toHaveLength(frameCount)
  })
})
